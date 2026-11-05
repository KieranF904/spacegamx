// Load-time measurement (measurement only): a first visit in a fresh Chrome profile (cold GPU program cache, empty
// HTTP cache and IndexedDB), then a reload in the same profile (everything warm). For each: when the sign-in screen is up,
// how long the main thread is blocked before and after it, every shader program's blocking link, the guest click to
// the server list, the join (frames over 50 ms in the first 5 s with a ship), and the worker threads' CPU.
//   node scripts/profile/loadTime.mjs [url] [--out file.json] [--runs cold,warm] [--trace prefix (writes <prefix>-<run>.json)]
// Launches its own headless Chrome (scripts/render/cdp.mjs) and closes it at the end. Needs the game server on 3000 and
// the lobby on 8787; the url is the client (a `vite preview` of a build, or the dev server).
import { writeFileSync } from 'fs';
import { launch } from '../render/cdp.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const out = flag('--out');
const traceOut = flag('--trace');
const runs = (flag('--runs') ?? 'cold,warm').split(',');
const URL0 = args[0] ?? 'http://localhost:5273/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In every document, from its start: each program's blocking LINK_STATUS read, long tasks, frame gaps
const PROBE = `(() => {
  const S = window.__LT = { programs: [], status: 0, longs: [], frames: [] };
  const P = WebGL2RenderingContext.prototype, srcs = new WeakMap(), att = new WeakMap();
  const tagOf = (src) => (src.match(/#define SHADER_NAME (\S+)/)?.[1] ?? '') + ' ' + ((src.match(/uniform [a-z0-9]+ [A-Za-z_0-9]+/g) || []).map((u) => u.split(' ').pop()).slice(0, 4).join(','));
  const ss = P.shaderSource; P.shaderSource = function (sh, src) { srcs.set(sh, src); return ss.call(this, sh, src); };
  const as = P.attachShader; P.attachShader = function (p, sh) { if (!att.has(p)) att.set(p, []); att.get(p).push(sh); return as.call(this, p, sh); };
  // (Any program query can wait on the driver, not just the link status: a reflection query after a parallel compile)
  const gp = P.getProgramParameter; P.getProgramParameter = function (p, n) {
    const t = performance.now(); const r = gp.call(this, p, n); const d = performance.now() - t;
    if (n !== this.LINK_STATUS) { if (d > 5) { S.status += d; { const f = srcs.get((att.get(p) || [])[1]) || ''; S.other = (S.other || []).concat([[Math.round(t), +d.toFixed(1), n, f.length, ...(d > 50 ? [f.replace(/\s+/g, ' ').slice(-400)] : [])]]); } } return r; }
    S.status += d;
    const sh = att.get(p) || []; const f = srcs.get(sh[1]) || '';
    S.programs.push({ at: Math.round(t), ms: +d.toFixed(1), frag: f.length, tag: tagOf(f), ...(d > 20 ? { head: f.replace(/\s+/g, ' ').slice(0, 260) } : {}) });
    return r;
  };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) S.longs.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
  let last = performance.now();
  const loop = (t) => { S.frames.push([Math.round(t), Math.round(t - last)]); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

const page = await launch({ width: 1440, height: 900 });
const results = {};
try {
  const { send, evaluate: ev } = page;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  // A second DevTools client on the page for the trace (cdp.mjs's doesn't pass events on): the worker threads' CPU
  const target = (await (await fetch(`http://127.0.0.1:${page.port}/json`)).json()).find((t) => t.type === 'page');
  const tws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => tws.addEventListener('open', r));
  let tid = 0, traceEvents = [], traceDone = null;
  tws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
    if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value);
    if (m.method === 'Tracing.tracingComplete') traceDone?.(); });
  const tsend = (method, params = {}) => tws.send(JSON.stringify({ id: ++tid, method, params }));
  const workerCpu = () => {
    const names = new Map();
    for (const e of traceEvents) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
    const per = {};
    for (const e of traceEvents) {
      if (e.ph !== 'X' || e.name !== 'ThreadControllerImpl::RunTask') continue;
      const n = names.get(`${e.pid}:${e.tid}`) ?? '';
      const k = /Worker/.test(n) ? 'workers' : /CrRendererMain/.test(n) ? 'main' : null;
      if (k) per[k] = (per[k] ?? 0) + (e.dur ?? 0) / 1000;
    }
    return Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Math.round(v)]));
  };
  for (const run of runs) {
    traceEvents = [];
    tsend('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', includedCategories: ['toplevel', 'devtools.timeline', '__metadata', 'v8.execute', 'disabled-by-default-devtools.timeline', ...(process.env.SAMPLES ? ['disabled-by-default-v8.cpu_profiler'] : [])] } });
    await sleep(300);
    const t0 = Date.now();
    if (run === 'cold') await send('Page.navigate', { url: URL0 }); else await send('Page.reload', { ignoreCache: false });
    let loginAt = null;
    for (let i = 0; i < 300 && loginAt === null; i++) { await sleep(50); try { if (await ev(`!!document.querySelector('.guest-button')`)) loginAt = Date.now() - t0; } catch {} }
    // Let the sign-in screen settle (the backdrop's shaders), then the guest click
    await sleep(6000);
    const pre = await ev(`(() => { const S = window.__LT; return { longs: S.longs.slice(), frames: S.frames.length, status: +S.status.toFixed(0) }; })()`);
    const click = await ev(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = performance.now(); document.querySelector('.guest-button').click();
      for (let i = 0; i < 400 && !document.querySelector('.join-btn'); i++) await w(10);
      return Math.round(performance.now() - t); })()`);
    await sleep(1500);
    const join = await ev(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
      const S = window.__LT, f0 = S.frames.length, tj = performance.now();
      document.querySelector('.join-btn').click();
      let shipAt = null;
      for (let i = 0; i < 400 && shipAt === null; i++) { await w(25); const g = window.__game; if (g ? g.state.playerId && g.state.entities.get(g.state.playerId) : document.getElementById('topHud')?.style.display === 'flex') shipAt = performance.now(); }
      await w(5000);
      const after = S.frames.slice(f0).filter(([at]) => shipAt !== null && at >= shipAt && at < shipAt + 5000);
      const gaps = after.map(([, d]) => d).sort((a, b) => b - a);
      return { shipMs: shipAt === null ? null : Math.round(shipAt - tj), over50: gaps.filter((d) => d > 50).length, worst: gaps.slice(0, 5),
        programsAfterJoin: S.programs.filter((p) => p.at >= tj).sort((a, b) => b.ms - a.ms).slice(0, 6) }; })()`);
    const all = await ev(`(() => { const S = window.__LT; return { programs: S.programs, other: S.other || [], status: +S.status.toFixed(0), longs: S.longs, nav: Math.round(performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? 0),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null }; })()`);
    const done = new Promise((r) => (traceDone = r));
    tsend('Tracing.end');
    await done;
    const cpu = workerCpu();
    if (traceOut) writeFileSync(`${traceOut}-${run}.json`, JSON.stringify({ traceEvents }));
    const longBefore = pre.longs.reduce((a, [, d]) => a + d, 0);
    const r = { loginAt, dcl: all.nav, longTasksBeforeClick: { n: pre.longs.length, totalMs: longBefore, max: Math.max(0, ...pre.longs.map(([, d]) => d)) },
      cpuMs: cpu, shaderBlockingMs: all.status, otherQueries: all.other, programs: all.programs.length, guestClickToList: click, join,
      topPrograms: [...all.programs].sort((a, b) => b.ms - a.ms).slice(0, 8) };
    // What the asset cache holds now (client/src/assets/assetCache.ts): by kind, how many and how big
    r.assets = await ev(`new Promise((ok) => { const q = indexedDB.open('space-assets'); q.onerror = () => ok(null); q.onsuccess = () => { const d = q.result;
      if (!d.objectStoreNames.contains('meta')) { ok({}); return; }
      const g = d.transaction('meta').objectStore('meta').getAll(); g.onsuccess = () => { const by = {}; for (const m of g.result) { const k = m.kind + '@' + m.version; by[k] = by[k] || [0, 0]; by[k][0]++; by[k][1] += Math.round(m.size / 1024); } ok(by); }; g.onerror = () => ok(null); }; })`).catch(() => null);
    results[run] = r;
    console.log(`\n## ${run}: sign-in screen ${loginAt} ms (DCL ${all.nav}); long tasks before the click: ${pre.longs.length}, ${longBefore} ms (max ${r.longTasksBeforeClick.max})`);
    if (all.other.length) console.log(`   other blocking program queries (at, ms, pname, frag): ${JSON.stringify(all.other)}`);
    console.log(`   shader links: ${all.programs.length} programs, ${all.status} ms blocking; guest click → server list ${click} ms`);
    console.log(`   asset cache (kind: [count, KB]): ${JSON.stringify(r.assets)}`);
    console.log(`   thread CPU from navigation to 5 s after the join: ${JSON.stringify(cpu)}`);
    console.log(`   join: ship after ${join.shipMs} ms; first 5 s: ${join.over50} frames over 50 ms, worst ${join.worst.join(', ')}`);
    for (const p of r.topPrograms) console.log(`     ${String(p.ms).padStart(7)} ms at +${p.at}  frag ${p.frag}  ${p.tag}`);
    if (join.programsAfterJoin.length) console.log(`   after join: ${join.programsAfterJoin.map((p) => `${p.ms}ms(${p.tag.slice(0, 30)})`).join(' ')}`);
    // back to the sign-in screen for the next run: the page reload does it
  }
  if (out) writeFileSync(out, JSON.stringify(results, null, 1));
  tws.close();
} finally {
  page.close();
}
