/**
 * Crowd benchmark: a real server Game with N bot pilots (real ships, AI enemies, firing) in a few layouts, measuring
 * the server's tick (mean, p95), time in rebuilds, replication/encode, bytes per client per second (wire and raw) for
 * capable and legacy clients, message counts, and how well the capable clients' tick layer agrees with the server's.
 * Each case runs in its own process (seeded, so runs compare). Prints a table, writes JSON.
 *
 *   npm run bench:crowd                    quick: n 20 and 50; spread, ball, boss(20); ~10 s measured each
 *   npm run bench:crowd -- --full          n 20, 50, 100, 300 (boss: 20), 15 s each
 *   --n 20,100  --layouts spread,ball,cruise  --secs 10  --bulk packed|blocks|focus  --caps 2047  --probes 4  --out file.json
 *   (cruise: pilots flying out and back over 24 km, the focus grid's churn; caps 2047 = with CAPS.FOCUS)
 *   --case <layout>:<n>                    one case in this process (what the matrix runs), prints one JSON line
 *   --crowd                                crowd fallbacks on and automatic (CAPS.CROWD, probes with every cap): each
 *                                          second's level and base-tick time, where it settled (try --secs 40)
 */
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { runCase, type CaseOpts } from './crowd/run.js';
import { LAYOUTS, type Layout } from './crowd/world.js';

const argv = process.argv.slice(2);
const arg = (name: string, d?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (name: string) => argv.includes(`--${name}`);

const full = flag('full');
const opts = (layout: Layout, n: number): CaseOpts => ({
  layout, n, secs: Number(arg('secs', full ? '15' : '10')), bulk: (arg('bulk', 'legacy') as 'legacy' | 'packed' | 'blocks' | 'focus'),
  crowd: flag('crowd'),
  probes: Number(arg('probes', '4')), caps: Number(arg('caps', flag('crowd') ? '262143' : '511')), lat: Number(arg('lat', '3')), warm: Number(arg('warm', '240')), sample: Number(arg('sample', '4')),
});

const one = arg('case');
if (one) {
  const [layout, n] = one.split(':');
  const res = await runCase(opts(layout as Layout, Number(n)));
  console.log('CROWDJSON ' + JSON.stringify(res));
  process.exit(0);
}

const sizes = (arg('n') ?? (full ? '20,50,100,300' : '20,50')).split(',').map(Number);
const layouts = (arg('layouts') ?? LAYOUTS.join(',')).split(',') as Layout[];
const cases: [Layout, number][] = [];
for (const l of layouts) for (const n of l === 'boss' ? [Math.min(...sizes) <= 20 ? 20 : sizes[0]] : sizes) cases.push([l, n]);

const results: any[] = [];
for (const [layout, n] of cases) {
  const args = [fileURLToPath(import.meta.url), '--case', `${layout}:${n}`, ...argv.filter((_, i) => argv[i - 1] !== '--case')];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', 'tsx', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' }, timeout: 20 * 60_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('CROWDJSON '));
  if (!line) { console.error(`case ${layout}:${n} failed (${r.status})\n${(r.stderr ?? '').slice(-1500)}${(r.stdout ?? '').slice(-800)}`); continue; }
  const res = JSON.parse(line.slice(10));
  results.push(res);
  console.error(`done ${layout}:${n} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const f = (v: number, d = 1) => v.toFixed(d);
const head = ['layout', 'n', 'tick ms', 'p95', 'max', 'budget%', 'snap ms', 'repl ms', 'enc ms', 'rebuild ms', 'rebuilds/s', 'reb. repeats', 'cap raw B/s', 'cap wire B/s', 'bulk raw B/s', 'bulk wire B/s', 'msgs/s cap', 'msgs/s bulk', 'checked', 'disagree', 'other dis.', 'kf corr/s', 'hit fixes', 'held', 'drops/s', 'entries/s', 'offers/s', 'logs/s', 'refused'];
const rows = results.map((r) => [
  r.layout, r.n, f(r.timing.tickMeanMs, 2), f(r.timing.tickP95Ms, 2), f(r.timing.tickMaxMs, 1), f(r.timing.budgetPct, 0), f(r.timing.snapshotsMsPerTick, 2), f(r.timing.replicationMsPerTick, 2), f(r.timing.encodeSendMsPerTick, 2), f(r.timing.rebuildMsPerTick, 3), f(r.timing.rebuildsPerSec, 1), r.timing.rebuildRepeats ?? 0,
  r.bytes.capable.rawBpsMean, r.bytes.capable.wireBpsMean, r.bytes.legacyOrBulk.rawBpsMean, r.bytes.legacyOrBulk.wireBpsMean, f(r.bytes.capable.msgsPerSecMean, 1), f(r.bytes.legacyOrBulk.msgsPerSecMean, 1),
  r.agreement.checked, r.agreement.disagreeNoKeyframe, `${r.agreement.otherDisagree}/${r.agreement.otherChecked}`, f(r.agreement.keyframeCorrectionsPerSecPerProbe, 2), r.agreement.server.hits.fixes ?? 0,
  f(r.focus?.heldMean ?? 0, 1), f(r.focus?.dropsPerSec ?? 0, 2), f(r.focus?.entriesPerSec ?? 0, 2), f(r.focus?.offersPerSec ?? 0, 2), f(r.focus?.logsPerSec ?? 0, 2), r.focus?.refused ?? 0,
].map(String));
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => c.padStart(w[i])).join('  ');
console.log(`\nbulk sockets: ${arg('bulk', 'legacy')}; probes: ${arg('probes', '4')} (caps ${arg('caps', '511')}, latency ${arg('lat', '3')} ticks)\n`);
console.log(line(head)); console.log(w.map((x) => '-'.repeat(x)).join('  ')); for (const r of rows) console.log(line(r));

console.log('\ndebris: pieces mean/max, server step ms/tick, probe client debris-world ms/tick, capable debris B/s by type, debris corrections, off/checked (no keyframe)');
for (const r of results) {
  const d = r.bytes.capable.debrisBps ?? {}, tot = Object.values(d).reduce((a: number, b) => a + (b as number), 0), c = r.agreement.correctionsByClass?.debris;
  console.log(`${r.layout} ${r.n}: ${r.timing.debrisMean}/${r.timing.debrisMax}, ${r.timing.debrisStepMsPerTick} ms, client ${r.probeDebrisMsPerTick} ms, ${tot} B/s ${JSON.stringify(d)}, corr ${c?.n ?? 0}, ${r.agreement.debrisOff}/${r.agreement.debrisChecked} (${r.agreement.debrisDisagree})`);
}

if (flag('crowd')) {
  console.log('\ncrowd fallbacks (automatic): level and base-tick ms by second; settled = the last third');
  for (const r of results) {
    const c = r.crowd;
    if (!c) continue;
    console.log(`${r.layout} ${r.n}: settled level ${c.settledLevel}, ${c.settledTickMs} ms a base tick (budget ${(1000 / 60).toFixed(1)})`);
    console.log('  ' + c.bySecond.map((s: any) => `L${s.lv}:${s.tickMs.toFixed(1)}`).join(' '));
  }
}

const out = arg('out');
if (out) writeFileSync(out, JSON.stringify({ when: new Date().toISOString().slice(0, 10), mode: full ? 'full' : 'quick', bulk: arg('bulk', 'legacy'), results }, null, 1));
