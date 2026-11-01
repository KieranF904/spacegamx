// Ship generator, headless. From game-v2:
//   npx tsx scripts/shipgen/cli.ts --list
//   npx tsx scripts/shipgen/cli.ts --model gemma4:12b --role starter --rounds 3
//   npx tsx scripts/shipgen/cli.ts --mode evolve --model qwen3:4b --role gunship --generations 3 --population 4 --keep 2
//   npx tsx scripts/shipgen/cli.ts --mode evolve --model qwen3:4b --seed data/ships/blueprints/dev/review-wren.json
//   npx tsx scripts/shipgen/cli.ts --mode compare --models qwen3:4b,gemma4:12b --role starter --trials 3 --rounds 4
//   npx tsx scripts/shipgen/cli.ts --model gemma4:12b --role gunship --build staged --rounds 3   (skeleton, then power, guns, engines, armour)
//   ... --contract auto|grid-text|grid-json|parts (auto: the model's measured best, loop/modelPrefs.ts)  --no-mirror (draw the whole ship)
//   ... --critic qwen3-vl:8b (optional: a vision model rates valid designs' looks; --critic-weight 0.1 to count it, default 0)
//   ... --render auto|valid|all|off  --out <dir>  --brief "a needle-nosed interceptor"  --think  --temperature 0.6  --timeout 600 --verbose
// Mirror mode is on by default: the model writes the left half and the centre line, the tool mirrors it.
// LM Studio models are listed only: nothing is sent to LM Studio (it would load the model) unless LMSTUDIO_CHAT=1.
// Models: "gemma4:12b" (Ollama), "ollama/<name>" or "lmstudio/<name>". Results (designs as blueprints, metrics.json and
// events.jsonl) go to scripts/shipgen/out/<time>-<mode>-<role>/ (gitignored). Ctrl+C stops cleanly and still writes them.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseBlueprint, serializeBlueprint, type Blueprint } from '../../common/src/ships/index';
import { loadContext } from './core/index';
import {
  type Attempt, type LoopDeps, type Renderer, type RunOptions, type ShipgenEvent,
  autoContract, createLlm, defaultModel, nativeRenderer, parseContract, run,
} from './loop/index';

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = 'true';
}
const num = (k: string) => (flags[k] !== undefined ? Number(flags[k]) : undefined);

async function main(): Promise<void> {
  const llm = createLlm();
  if (flags.list) {
    for (const m of await llm.list()) {
      const tags = [m.cloud ? 'cloud' : 'local', m.chat ? 'chat' : 'no-chat', m.vision && 'vision', m.thinking && 'thinking', m.structured && 'schema', m.params, m.off, m.chat && !m.off && `auto: ${autoContract(m.id, m).contract}`].filter(Boolean);
      console.log(`${m.id.padEnd(44)} ${tags.join(', ')}`);
    }
    if (!(await llm.list()).some((m) => m.provider === 'lmstudio')) console.log('(LM Studio: nothing listed: not running, or no LM_API_TOKEN in the environment or game-v2/.env)');
    return;
  }
  const mode = (flags.mode ?? 'design') as RunOptions['mode'];
  const ctx = loadContext();
  const models = await llm.list().catch(() => []);
  const pick = (id: string | undefined, vision = false) => {
    if (id) return id;
    const d = defaultModel(models, { vision });
    if (!d) throw new Error(`no local ${vision ? 'vision ' : ''}model found: name one with --model`);
    return d.id;
  };
  const role = flags.role ?? 'starter';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(flags.out ?? join(__dirname, 'out', `${stamp}-${mode}-${role}`));
  mkdirSync(out, { recursive: true });

  const ac = new AbortController();
  process.on('SIGINT', () => { if (ac.signal.aborted) process.exit(130); console.error('\n[shipgen] stopping (Ctrl+C again to quit now)'); ac.abort(); });

  const renderMode = (flags.render ?? 'auto') as 'off' | 'valid' | 'all' | 'auto';
  let renderer: Renderer | undefined;
  if (renderMode !== 'off') {
    try { renderer = await nativeRenderer({ keep: !!flags['keep-render'] }); } catch (e) { console.error(`[shipgen] no renders: ${(e as Error).message}`); }
  }
  const deps: LoopDeps = { ctx, llm, models, renderer };
  const contract = parseContract(flags.contract ?? 'auto');
  if (!contract) throw new Error(`--contract ${flags.contract}: use auto, grid-text, grid-json or parts`);
  const build = (flags.build ?? (flags.staged ? 'staged' : 'oneshot')) as 'oneshot' | 'staged';
  if (build !== 'oneshot' && build !== 'staged') throw new Error(`--build ${flags.build}: use oneshot or staged`);
  const common = {
    brief: { role, ...(flags.brief ? { text: flags.brief } : {}), ...(flags.name ? { name: flags.name } : {}) },
    rounds: num('rounds'), contract, mirror: !flags['no-mirror'], build, temperature: num('temperature'), think: flags.think === 'true',
    critic: flags.critic, criticWeight: num('critic-weight'), render: renderMode, outDir: out, signal: ac.signal,
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
  };
  const opts: RunOptions = mode === 'compare'
    ? { mode, ...common, models: (flags.models ?? '').split(',').filter(Boolean), trials: num('trials') }
    : mode === 'evolve'
      ? { mode, ...common, model: pick(flags.model), population: num('population'), keep: num('keep'), generations: num('generations'), seedRounds: num('seed-rounds'), childRounds: num('child-rounds'), ...(flags.seed ? { seed: parseBlueprint(readFileSync(flags.seed, 'utf8')) } : {}) }
      : { mode: 'design', ...common, model: pick(flags.model) };
  if (opts.mode === 'compare' && !opts.models.length) throw new Error('compare needs --models a,b (or one model, for its trials alone)');
  for (const m of opts.mode === 'compare' ? opts.models : [opts.model]) {
    if (models.find((x) => x.id === (m.includes('/') ? m : `ollama/${m}`))?.cloud) console.error(`[shipgen] note: ${m} is a CLOUD model (runs on an outside service)`);
  }

  const events = join(out, 'events.jsonl');
  const verbose = !!flags.verbose;
  let tokens = 0;
  const print = (e: ShipgenEvent) => {
    if (e.type !== 'token') appendFileSync(events, JSON.stringify(e) + '\n');
    const L = e.lane ? `[${e.lane}] ` : '';
    const s = (x: number) => `${(x / 1000).toFixed(1)}s`;
    switch (e.type) {
      case 'start': console.log(`shipgen ${e.mode}${e.build === 'staged' ? ' (staged build)' : ''}: ${e.models?.join(' vs ') ?? e.model}, role ${e.role}, ${e.contract} replies, mirror ${e.mirror === false ? 'off' : 'on'}${e.critic ? `, critic ${e.critic}` : ''} -> ${out}`); break;
      case 'step': console.log(`${L}step ${e.index}/${e.of} ${e.step}: ${e.status}${e.note ? ` (${e.note})` : ''}`); break;
      case 'brief': console.log(`${L}brief: ${e.text.split('\n')[0]} (${e.legendCodes} codes, prompt ${e.promptChars} chars)`); break;
      case 'prompt': tokens = 0; process.stdout.write(`${L}round ${e.round}: asking (${e.messages} messages, ${e.chars} chars) `); break;
      case 'token': if (verbose) process.stdout.write(e.text); else if (++tokens % 40 === 0) process.stdout.write(e.kind === 'thinking' ? '~' : '.'); break;
      case 'reply': console.log(`\n${L}  reply in ${s(e.ms)}${e.outputTokens ? `, ${e.outputTokens} tokens` : ''}${e.tokensPerSec ? ` at ${e.tokensPerSec}/s` : ''}${e.structured ? ' (schema)' : ''}`); break;
      case 'grid': if (!e.partial) console.log(`${L}  grid (${e.via}): ${e.parts} parts${e.errors.length ? `, ${e.errors.length} unreadable: ${e.errors[0].message}` : ''}${e.warnings.length ? `, ${e.warnings.length} guesses` : ''}`); break;
      case 'check': console.log(`${L}  check: ${e.valid ? 'VALID' : `invalid (${e.result.errors.length} errors: ${e.result.errors[0]?.message ?? ''})`}, score ${e.score}${e.brief?.unmet.length ? `, brief unmet: ${e.brief.unmet.join('; ')}` : ''}`); break;
      case 'render': console.log(`${L}  render ${e.ms} ms: ${e.path}`); break;
      case 'critic': console.log(`${L}  critic ${e.model}: looks ${e.looks ?? '?'}/10, ${e.reason} (${s(e.ms)})`); break;
      case 'score': console.log(`${L}  score ${e.score}`); break;
      case 'best': console.log(`${L}  best so far: "${e.name}" ${e.score}${e.valid ? ' (valid)' : ''}`); break;
      case 'feedback': if (verbose) console.log(`${L}  feedback:\n${e.text}`); break;
      case 'mutation': console.log(`gen ${e.gen} child ${e.child} from ${e.parent}: ${e.instruction}`); break;
      case 'generation': console.log(`generation ${e.gen}: ${e.population.map((p) => `${p.id} ${p.score}${p.valid ? '' : ' (invalid)'}`).join(', ')}`); break;
      case 'error': console.error(`\n${L}  ${e.fatal ? 'FATAL ' : ''}error: ${e.message}`); break;
      case 'done': console.log(`done${e.cancelled ? ' (cancelled)' : ''}: ${JSON.stringify(e.metrics)}`); break;
    }
  };

  try {
    const r = await run(deps, opts, print);
    const designs = join(out, 'designs');
    mkdirSync(designs, { recursive: true });
    const save = (file: string, bp: Blueprint) => writeFileSync(join(designs, `${file.replace(/[^\w.-]+/g, '_')}.json`), serializeBlueprint(bp) + '\n');
    const saveAll = (prefix: string, as: Attempt[]) => { for (const a of as) if (a.bp) save(`${prefix}r${a.round}${a.valid ? '' : '-invalid'}`, a.bp); };
    let metrics: unknown;
    if (r.mode === 'design') {
      saveAll('', r.outcome.attempts);
      if (r.outcome.best?.bp) save('best', r.outcome.best.bp);
      metrics = { ...(await doneMetrics(events)), attempts: r.outcome.attempts.map(summary) };
    } else if (r.mode === 'evolve') {
      r.outcome.survivors.forEach((i, k) => i.a.bp && save(`survivor${k + 1}-${i.id}`, i.a.bp));
      metrics = { ...r.outcome.metrics, survivors: r.outcome.survivors.map((i) => ({ id: i.id, ...summary(i.a) })) };
    } else {
      for (const [m, as] of r.outcome.best) as.forEach((a, k) => a.bp && save(`${m}-t${k + 1}`, a.bp));
      metrics = r.outcome.metrics;
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    console.log(`wrote ${out}`);
  } finally {
    await renderer?.close();
  }
}

const summary = (a: Attempt) => ({ round: a.round, valid: a.valid, score: a.score, looks: a.looks, reason: a.reason, errors: a.result?.errors.length, unmet: a.brief?.unmet, render: a.renderPath, ms: a.ms, tokensPerSec: a.tokensPerSec });

async function doneMetrics(events: string): Promise<object> {
  const last = readFileSync(events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse().find((e) => e.type === 'done');
  return last?.metrics ?? {};
}

main().catch((e) => { console.error(`[shipgen] ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
