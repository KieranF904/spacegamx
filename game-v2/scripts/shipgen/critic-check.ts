// Does a vision model's pairwise taste agree with the check's scores? From game-v2:
//   npx tsx scripts/shipgen/critic-check.ts --critic qwen3-vl:8b --pairs 8 scripts/shipgen/out/trial2
// Reads every events.jsonl under the folders given, takes the rendered stills with their scores, pairs stills whose
// scores differ by at least --gap (default 10), and asks the critic both ways round which looks more like a real ship
// (comparePair). Reports how often its pick (when both orders agree) is the higher-scoring still. Read-only.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { comparePair, createLlm, rngOf } from './loop/index';

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

interface Still { path: string; score: number; valid: boolean; run: string }

function stills(dir: string): Still[] {
  const out: Still[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === 'events.jsonl') {
        const ev = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const key = (e: { lane?: string; round: number }) => `${e.lane ?? ''}|${e.round}`;
        const render = new Map<string, string>(), valid = new Map<string, boolean>();
        for (const e of ev) {
          if (e.type === 'render') render.set(key(e), e.path);
          if (e.type === 'check') valid.set(key(e), e.valid);
          if (e.type === 'score' && render.has(key(e)) && existsSync(render.get(key(e))!)) out.push({ path: render.get(key(e))!, score: e.score, valid: !!valid.get(key(e)), run: d });
        }
      }
    }
  };
  walk(dir);
  return out;
}

async function main() {
  const critic = flag('critic', 'qwen3-vl:8b')!, pairs = Number(flag('pairs', '8')), gap = Number(flag('gap', '10'));
  const all = dirs.flatMap((d) => stills(resolve(d))).filter((s) => s.valid);
  // (One still per distinct picture: the same design is often rendered again)
  const seen = new Set<string>();
  const uniq = all.filter((s) => { const k = readFileSync(s.path).toString('base64').slice(0, 2000); if (seen.has(k)) return false; seen.add(k); return true; });
  const rng = rngOf(Number(flag('seed', '7')));
  const cand: [Still, Still][] = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) if (Math.abs(uniq[i].score - uniq[j].score) >= gap) cand.push([uniq[i], uniq[j]]);
  cand.sort(() => rng() - 0.5);
  const pick = cand.slice(0, pairs);
  console.log(`${uniq.length} valid stills, ${cand.length} pairs ${gap}+ points apart; asking ${critic} about ${pick.length}, both ways round`);
  const llm = createLlm();
  const rows: object[] = [];
  let agree = 0, disagree = 0, positional = 0;
  for (const [a, b] of pick) {
    const v = await comparePair(llm, critic, readFileSync(a.path), readFileSync(b.path));
    const hi = a.score > b.score ? 'a' : 'b';
    if (v.pick === null) positional++; else if (v.pick === hi) agree++; else disagree++;
    console.log(`${a.score} vs ${b.score}: answers ${v.answers.join('/')} -> ${v.pick ?? 'no preference'}${v.pick ? (v.pick === hi ? ' (agrees)' : ' (DISAGREES)') : ''}; ${v.reason} (${(v.ms / 1000).toFixed(0)} s)`);
    rows.push({ a: a.path, b: b.path, scoreA: a.score, scoreB: b.score, ...v });
  }
  console.log(`agrees ${agree}, disagrees ${disagree}, picks by position or can't say ${positional} (of ${pick.length})`);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ critic, agree, disagree, positional, rows }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
