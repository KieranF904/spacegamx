// Client frame profiling (measurement only): joins the dev game as a guest in a tab borrowed from the render daemon's one
// Chrome (as boss-shots/shoot.mjs does), builds scenes with admin chat commands (guests are admins on dev servers), and
// for each scene records a CPU profile (Profiler.start/stop) plus in-page timings: the frame's parts (instance methods
// wrapped from the page, nothing in the game changed), frame intervals, draw calls, and a GPU probe (the main pass with a
// 1-pixel readPixels after it, which waits for the GPU to finish the frame).
//   node scripts/profile/clientProfile.mjs <outDir> [scene,scene,...]
// Scenes: load idle map hangar boss sun gpu msaa. Needs Vite on 5273 and a dev game server on 3000.
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { daemonUrl } from '../render/daemonClient.mjs';

const [outDir = '.', only] = process.argv.slice(2);
const want = new Set((only ?? 'load,idle,map,hangar,boss,sun,gpu').split(','));
mkdirSync(outDir, { recursive: true });
const URL0 = process.env.GAME_URL ?? 'http://localhost:5273/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440, H = 900;

const base = await daemonUrl();
const tab = await (await fetch(`${base}/tab`)).json();
let returned = false;
const giveBack = async () => { if (returned) return; returned = true; try { await fetch(`${base}/tab/close?id=${tab.id}`); } catch {} };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => giveBack().finally(() => process.exit(1)));
const ws = new WebSocket(tab.ws);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const logs = [];
const traceEvents = [];
let traceDone = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value);
  if (m.method === 'Tracing.tracingComplete') traceDone?.();
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 120000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: code.replace('Key', '').charCodeAt(0) });
const tap = async (code) => { await key('keyDown', code); await sleep(60); await key('keyUp', code); };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const chat = (text) => ev(`window.__game.network.send({ type: 'chat', text: ${JSON.stringify(text)} }), 1`);
const metrics = (w = W, h = H, dpr = 1) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });

// ---- the in-page probe ----
const PROBE = `(() => {
  const g = window.__game; if (!g) return 'no game';
  if (window.__P) return 'probe already in';
  const P = window.__P = { t: {}, n: {}, frames: [], draws: 0, tris: 0, finish: false, gpuWait: 0, gpuN: 0, longs: [] };
  const wrap = (o, name, key) => {
    if (!o || typeof o[name] !== 'function') { P.t[key + ' (missing)'] = 0; return; }
    const f = o[name]; P.t[key] = 0; P.n[key] = 0;
    o[name] = function (...a) { const s = performance.now(); try { return f.apply(this, a); } finally { P.t[key] += performance.now() - s; P.n[key]++; } };
  };
  const r = g.renderer, sc = g.shipClient;
  wrap(g, 'update', 'Game.update (all frame JS but pixi render)');
  // GPU timer queries (EXT_disjoint_timer_query_webgl2): from the start of Game.update (bloom's passes) to the end of the main pass
  { const gl0 = g.app.renderer.gl; P.tq = gl0.getExtension('EXT_disjoint_timer_query_webgl2'); P.qs = []; P.gpuTimes = []; P.timer = false;
    const gu = g.update; g.update = function (...a) { if (P.timer && P.tq && !P.qActive) { const q = gl0.createQuery(); gl0.beginQuery(P.tq.TIME_ELAPSED_EXT, q); P.qActive = q; } return gu.apply(this, a); }; }
  wrap(g.state, 'interpolate', '  state.interpolate');
  wrap(sc, 'update', '  shipClient.update');
  wrap(sc.renderer, 'update', '    ShipRenderer.update');
  for (const k of ['navMarkers', 'peopleUI', 'bossUI', 'farMarkers', 'targetUI', 'infoPanel', 'opsUI', 'pingUI', 'cargoPanel', 'context', 'tutorial', 'frost', 'buildSites', 'regionUI']) wrap(g[k], 'update', '  HUD ' + k);
  wrap(g, 'updateUI', '  HUD updateUI');
  wrap(g, 'updateSounds', '  updateSounds');
  wrap(g, 'updateGuide', '  updateGuide');
  wrap(g, 'updateHeatGauge', '  updateHeatGauge');
  wrap(r, 'update', '  Renderer.update');
  for (const k of ['updateCamera', 'renderBackground', 'updatePlanets', 'renderEntities', 'updateEffects', 'renderDamageNumbers', 'updateMinimap', 'updateScreen']) wrap(r, k, '    ' + k);
  wrap(r.rocks, 'update', '    AsteroidBatch.update');
  wrap(r.sky, 'update', '      sky.update');
  wrap(r.weaponFx, 'update', '      WeaponFx.update');
  wrap(r.weaponFx, 'draw', '      WeaponFx.draw');
  wrap(r, 'applyLighting', '  Renderer.applyLighting');
  wrap(r, 'renderBloom', '  Renderer.renderBloom');
  // Network: the message handler (decode is before it, in the socket's onmessage: in the CPU profile)
  { const net = g.network, f = net.onMessage; P.t['network onMessage (handle)'] = 0; P.n['network onMessage (handle)'] = 0;
    net.onMessage = (m) => { const s = performance.now(); try { return f(m); } finally { P.t['network onMessage (handle)'] += performance.now() - s; P.n['network onMessage (handle)']++; } }; }
  // Pixi's draws: the main pass (container = stage) apart from the render-texture passes (bloom, haze)
  const R = g.app.renderer, gl = R.gl;
  const rr = R.render; P.t['pixi render: main pass (CPU submit)'] = 0; P.t['pixi render: RT passes'] = 0; P.n['pixi render: main pass (CPU submit)'] = 0;
  const px = new Uint8Array(4);
  R.render = function (...a) {
    const o = a[0]; const main = o && (o === g.app.stage || o.container === g.app.stage) && !o.target;
    const s = performance.now(); const out = rr.apply(this, a); const e = performance.now();
    if (main && P.qActive) { gl.endQuery(P.tq.TIME_ELAPSED_EXT); P.qs.push(P.qActive); P.qActive = null; }
    while (P.qs.length && gl.getQueryParameter(P.qs[0], gl.QUERY_RESULT_AVAILABLE)) { const q = P.qs.shift(); const disj = gl.getParameter(P.tq.GPU_DISJOINT_EXT); const ns = gl.getQueryParameter(q, gl.QUERY_RESULT); if (!disj) P.gpuTimes.push(ns / 1e6); gl.deleteQuery(q); }
    if (main) { P.t['pixi render: main pass (CPU submit)'] += e - s; P.n['pixi render: main pass (CPU submit)']++;
      if (P.finish) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); P.gpuWait += performance.now() - s; P.gpuN++; } }
    else P.t['pixi render: RT passes'] += e - s;
    return out;
  };
  for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const f = gl[fn]; if (!f) continue;
    gl[fn] = function (...a) { P.draws++; return f.apply(this, a); };
  }
  // Frame intervals
  let last = performance.now();
  const loop = (t) => { P.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longs.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {}
  return 'probe in';
})()`;
const RESET = `(() => { const P = window.__P; for (const k in P.t) { P.t[k] = 0; P.n[k] = 0; } P.frames = []; P.draws = 0; P.gpuWait = 0; P.gpuN = 0; P.longs = []; P.gpuTimes = []; P.t0 = performance.now(); return 1; })()`;
const STATS = `(() => {
  const P = window.__P, g = window.__game, f = P.frames.slice(1).sort((a, b) => a - b);
  const n = f.length, sum = f.reduce((a, b) => a + b, 0), q = (p) => +(f[Math.min(n - 1, Math.floor(n * p))] ?? 0).toFixed(1);
  const frames = P.n['pixi render: main pass (CPU submit)'] || 1;
  const parts = {}; for (const k in P.t) parts[k] = +(P.t[k] / frames).toFixed(3);
  const es = [...g.state.entities.values()]; const types = {}; for (const e of es) types[e.type] = (types[e.type] || 0) + 1;
  const me = g.state.entities.get(g.state.playerId);
  return { secs: +((performance.now() - P.t0) / 1000).toFixed(1), frames: n, fps: +(n / (sum / 1000)).toFixed(1), interval: { mean: +(sum / n).toFixed(2), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) },
    gpuTimer: P.gpuTimes.length ? (() => { const t = [...P.gpuTimes].sort((a, b) => a - b); return { n: t.length, mean: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(3), p50: +t[t.length >> 1].toFixed(3), p95: +t[Math.floor(t.length * 0.95)].toFixed(3) }; })() : (P.tq ? 'none' : 'no ext'),
    mainPasses: frames, drawsPerFrame: +(P.draws / frames).toFixed(1), gpuProbe: P.gpuN ? +(P.gpuWait / P.gpuN).toFixed(2) : null, longTasks: P.longs.length, longMax: Math.max(0, ...P.longs),
    perFrameMs: parts, entities: es.length, types, me: me ? [Math.round(me.x), Math.round(me.y), g.state.systemId] : null,
    res: g.app.renderer.resolution, canvas: [g.app.renderer.width, g.app.renderer.height], heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
})()`;

// A Vite full reload (someone editing the client) loses the probe and the guest: join again and rebuild the scene
let scene = null;
const joinStats = [];
async function ensure() {
  if (await ev('!!window.__P && !!window.__game?.state?.playerId').catch(() => false)) return;
  console.log('(page reloaded: joining again)');
  await sleep(4000);
  await joinGame();
  console.log(await ev(PROBE));
  if (scene) await scene();
}
async function measure(name, secs, opts = {}) {
  try { return await measureOnce(name, secs, opts); }
  catch (e) { console.log(`(${name}: ${e.message.slice(0, 80)}; again)`); await ensure(); return measureOnce(name, secs, opts); }
}
async function measureOnce(name, secs, { profile = true, gpu = false } = {}) {
  await ensure();
  await ev(RESET);
  if (gpu === 'timer') await ev('window.__P.timer = true'); else if (gpu) await ev('window.__P.finish = true');
  if (profile) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 250 }); await send('Profiler.start'); }
  await sleep(secs * 1000);
  let prof = null;
  if (profile) { prof = (await send('Profiler.stop')).profile; writeFileSync(join(outDir, `${name}.cpuprofile`), JSON.stringify(prof)); }
  const s = await ev(STATS);
  if (gpu) await ev('window.__P.finish = false, window.__P.timer = false');
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(s, null, 1));
  console.log(`\n### ${name}: fps ${s.fps} · interval p50 ${s.interval.p50} p95 ${s.interval.p95} max ${s.interval.max} · draws/frame ${s.drawsPerFrame} · gpuProbe ${s.gpuProbe} · gpuTimer ${JSON.stringify(s.gpuTimer)} · entities ${s.entities} ${JSON.stringify(s.types)} · long tasks ${s.longTasks} (max ${s.longMax}) · res ${s.res} ${s.canvas}`);
  for (const [k, v] of Object.entries(s.perFrameMs)) if (v >= 0.01) console.log(`   ${v.toFixed(3).padStart(8)} ms  ${k}`);
  return s;
}

async function joinGame() {
  await ev(`localStorage.setItem('sg.tutorialDone', '1'), 1`);
  const r = await ev(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !document.querySelector('.guest-button'); i++) await w(250);
    document.querySelector('.guest-button').click(); await w(2500);
    const b = [...document.querySelectorAll('button')].find((b) => /join/i.test(b.innerText)); const tj = performance.now(); if (b) b.click();
    // the frames from the click: when the ship first exists, and the hitches while the world comes in
    const fr = []; let last = performance.now(), shipAt = null, done = false;
    const loop = (t) => { fr.push([Math.round(t - tj), Math.round(t - last)]); last = t; const g = window.__game; if (shipAt === null && g && g.state.playerId && g.state.entities.get(g.state.playerId)) shipAt = Math.round(t - tj); if (!done) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    for (let i = 0; i < 160 && shipAt === null; i++) await w(50);
    await w(5000); done = true;
    const after = fr.filter(([at]) => shipAt !== null && at >= shipAt);
    return { shipAt, framesFirst5s: after.length, over50: after.filter(([, d]) => d > 50).length, worst: after.map(([, d]) => d).sort((a, b) => b - a).slice(0, 6), longFrames: fr.filter(([, d]) => d > 50).slice(0, 12) }; })()`);
  console.log('join:', JSON.stringify(r));
  joinStats.push(r);
  await sleep(1000);
}

const fire = async (on, x = W * 0.75, y = H * 0.4) => {
  await mouse('mouseMoved', x, y, on ? { buttons: 1 } : {});
  await mouse(on ? 'mousePressed' : 'mouseReleased', x, y, { button: 'left', buttons: on ? 1 : 0, clickCount: 1 });
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await metrics();
  // Shader programs: each link's blocking status read timed (a cold GPU program cache pays the compile here)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const S = window.__SH = { programs: [], compile: 0, link: 0, status: 0 };
    const P = WebGL2RenderingContext.prototype, srcs = new WeakMap(), att = new WeakMap();
    const tagOf = (src) => ((src.match(/uniform [a-z0-9]+ [A-Za-z_0-9]+/g) || []).map((u) => u.split(' ').pop()).slice(0, 5).join(','));
    const ss = P.shaderSource; P.shaderSource = function (sh, src) { srcs.set(sh, src); return ss.call(this, sh, src); };
    const as = P.attachShader; P.attachShader = function (p, sh) { if (!att.has(p)) att.set(p, []); att.get(p).push(sh); return as.call(this, p, sh); };
    const cs = P.compileShader; P.compileShader = function (sh) { const t = performance.now(); const r = cs.call(this, sh); S.compile += performance.now() - t; return r; };
    const lp = P.linkProgram; P.linkProgram = function (p) { const t = performance.now(); const r = lp.call(this, p); S.link += performance.now() - t; return r; };
    const gp = P.getProgramParameter; P.getProgramParameter = function (p, n) {
      if (n !== this.LINK_STATUS) return gp.call(this, p, n);
      const t = performance.now(); const r = gp.call(this, p, n); const d = performance.now() - t; S.status += d;
      const sh = att.get(p) || []; const v = srcs.get(sh[0]) || '', f = srcs.get(sh[1]) || '';
      S.programs.push({ at: Math.round(t), ms: +d.toFixed(1), vert: v.length, frag: f.length, tag: tagOf(f) || tagOf(v) });
      return r;
    };
  })()` });
  // 1) Cold load: a trace from navigation to the guest's ship in flight (main thread, workers, GPU)
  if (want.has('load')) {
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'loading', 'toplevel', 'gpu', 'v8'] } });
    const t0 = Date.now();
    await send('Page.navigate', { url: URL0 });
    // (first paint of the login screen)
    let firstFrame = null;
    for (let i = 0; i < 200; i++) { await sleep(100); try { if (await ev(`!!document.querySelector('.guest-button')`)) { firstFrame = Date.now() - t0; break; } } catch {} }
    const nav = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
      const res = performance.getEntriesByType('resource'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), paint: p, resources: res.length, kb: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024), scripts: res.filter((r) => r.initiatorType === 'script' || /\\.(js|ts)/.test(r.name)).length }; })()`);
    console.log(`load: login screen after ${firstFrame} ms; ${JSON.stringify(nav)}`);
    await sleep(1500);
    const tj = Date.now();
    await joinGame();
    const joinMs = Date.now() - tj;
    await sleep(3000);
    traceDone = null;
    const done = new Promise((r) => (traceDone = r));
    await send('Tracing.end');
    await done;
    writeFileSync(join(outDir, 'load.trace.json'), JSON.stringify({ traceEvents }));
    const shaders = await ev(`(() => { const S = window.__SH; const gl = window.__game.app.renderer.gl; return { n: S.programs.length, compileMs: +S.compile.toFixed(0), linkMs: +S.link.toFixed(0), statusMs: +S.status.toFixed(0), parallelExt: !!gl.getExtension('KHR_parallel_shader_compile'), programs: S.programs }; })()`);
    console.log(`shaders: ${shaders.n} programs, blocking status reads ${shaders.statusMs} ms (compile calls ${shaders.compileMs}, link calls ${shaders.linkMs}); KHR_parallel_shader_compile ${shaders.parallelExt}`);
    for (const p of [...shaders.programs].sort((a, b) => b.ms - a.ms).slice(0, 15)) console.log(`   ${String(p.ms).padStart(7)} ms at +${p.at}  frag ${p.frag}  ${p.tag}`);
    writeFileSync(join(outDir, 'load.json'), JSON.stringify({ firstFrame, nav, joinMs, join: joinStats[0], shaders }, null, 1));
    console.log(`load trace: ${traceEvents.length} events; join took ${joinMs} ms`);
    await send('Network.setCacheDisabled', { cacheDisabled: false });
  } else {
    await send('Page.navigate', { url: URL0 });
    await sleep(6000);
    await joinGame();
  }
  console.log(await ev(PROBE));
  await chat('/god on');
  await chat('/hide on');
  // 2) Idle flight at the spawn
  if (want.has('idle')) {
    await sleep(2000);
    await measure('idle', 10);
    await key('keyDown', 'KeyW'); await sleep(200);
    await measure('idle-thrust', 6, { profile: false });
    await key('keyUp', 'KeyW');
  }
  if (want.has('map')) { await tap('KeyM'); await sleep(2500); await measure('map', 8); await tap('KeyM'); await sleep(1500); }
  if (want.has('hangar')) {
    await ev(`window.__game.shipClient.openHangar(), 1`); await sleep(3000);
    console.log('hangar open:', await ev(`window.__game.shipClient.hangarOpen`));
    await measure('hangar', 8);
    await tap('Escape'); await sleep(500); await ev(`window.__game.shipClient.hangarOpen && window.__game.shipClient.hangar.close?.(), 1`); await sleep(1500);
  }
  // 3) The boss fight: the Redtooth picket's lair in Sol, packs all round, firing
  if (want.has('boss')) {
    // The arrival (travel, the boss and the packs coming into view): a profile over it, and its hitches
    await ensure(); await ev(RESET);
    await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 250 }); await send('Profiler.start');
    await chat('/tp 61800 -62600 sol'); await sleep(5000);
    await chat('/hide off');
    await chat('/boss boss_redtooth_picket'); await sleep(1500);
    for (const s of ['/spawn redtooth_brawler redtooth_cutter x6', '/spawn pirate_raider pirate_skiff x6', '/spawn redtooth_sledge redtooth_cutter x5', '/spawn pirate_gunship pirate_raider x4']) { await chat(s); await sleep(400); }
    // Aim at the boss (screen point toward it) and hold fire
    await fire(true, W * 0.3, H * 0.75);
    await sleep(3000);
    writeFileSync(join(outDir, 'boss-arrive.cpuprofile'), JSON.stringify((await send('Profiler.stop')).profile));
    { const a = await ev(STATS); writeFileSync(join(outDir, 'boss-arrive.json'), JSON.stringify(a, null, 1)); console.log(`### boss-arrive: frames ${a.frames} interval p95 ${a.interval.p95} p99 ${a.interval.p99} max ${a.interval.max} · long tasks ${a.longTasks} (max ${a.longMax})`); }
    await sleep(3000);
    await measure('boss', 10);
    // What's on the stage, and a timeline trace (style, layout, paint, GPU process) of 5 s of the fight
    const census = await ev(`(() => { const g = window.__game, r = g.renderer; const count = (c) => { let n = 1; for (const ch of c.children || []) n += count(ch); return n; };
      const types = {}; let visible = 0; const walk = (c, vis) => { types[c.constructor.name] = (types[c.constructor.name] || 0) + 1; const v = vis && c.visible && c.renderable; if (v) visible++; for (const ch of c.children || []) walk(ch, v); }; walk(g.app.stage, true);
      return { total: count(g.app.stage), visible, world: count(r.worldContainer), shipLayer: count(r.shipLayer), effects: count(r.effectContainer), entities: count(r.entityContainer), ui: count(r.uiContainer), sky: count(r.sky.container), types: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 14)), domNodes: document.getElementsByTagName('*').length }; })()`);
    console.log('census:', JSON.stringify(census));
    writeFileSync(join(outDir, 'boss-census.json'), JSON.stringify(census, null, 1));
    traceEvents.length = 0;
    await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'toplevel', 'gpu', 'disabled-by-default-devtools.timeline.frame'] } });
    await sleep(5000);
    { traceDone = null; const done = new Promise((r) => (traceDone = r)); await send('Tracing.end'); await done; }
    writeFileSync(join(outDir, 'boss.trace.json'), JSON.stringify({ traceEvents }));
    console.log(`boss trace: ${traceEvents.length} events`);
    await ensure();
    await measure('boss-gpu', 4, { profile: false, gpu: 'timer' });
    await fire(false);
  }
  // 4) By the sun: packs, firing, the sun's disc and glow filling the view's edge
  if (want.has('sun') || want.has('gpu') || want.has('msaa')) {
    scene = async () => {
      await chat('/god on');
      await chat('/tp 25500 1500 sol'); await sleep(5000);
      await chat('/clear 6000'); await sleep(300);
      for (const s of ['/spawn pirate_raider pirate_skiff x8', '/spawn redtooth_brawler redtooth_cutter x8', '/spawn pirate_gunship pirate_raider x5']) { await chat(s); await sleep(400); }
      await fire(true, W * 0.75, H * 0.45);
      await sleep(6000);
    };
    await scene();
    if (want.has('sun')) await measure('sun', 10);
  }
  // 5) GPU-ish: the main pass waited on (readPixels), with layers switched off one at a time, quality tiers, resolution
  if (want.has('gpu') || want.has('msaa')) {
    console.log('GPU:', await ev(`(() => { const gl = window.__game.app.renderer.gl; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`));
    const topUp = async () => { const n = await ev(`[...window.__game.state.entities.values()].filter((e) => e.type === 7).length`); if (n < 60) { await chat('/spawn pirate_raider pirate_skiff redtooth_brawler x10'); await sleep(1500); } };
    const set = (fn) => ev(`(async () => { const u = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/src/settings/Settings.ts')) ?? '/src/settings/Settings.ts'; const m = await import(u); m.settings.update((s) => { ${fn} }); return 1; })()`);
    const size = async (w, h, dpr) => { await metrics(w, h, dpr); await sleep(300); await ev(`window.dispatchEvent(new Event('resize')), 1`); await sleep(1200); };
    const run = async (label, expr = '') => { await ensure(); await topUp(); if (expr) await ev(`(() => { const r = window.__game.renderer; ${expr}; return 1; })()`); await sleep(800); return measure(`gpu-${label}`, 4, { profile: false, gpu: process.env.GPU_METHOD === 'timer' ? 'timer' : true }); };
    const ALL_ON = 'r.sky.container.renderable = true; r.sunRenderer.getContainer().renderable = true; r.glowRenderer.getContainer().renderable = true; r.corona.getContainer().renderable = true; r.bloom.sprite.renderable = true; r.bloom.enabled = true; r.shipLayer.renderable = true; r.effectContainer.renderable = true; r.worldContainer.renderable = true';
    const layers = async (tag) => {
      await run(`${tag}-base`, ALL_ON);
      await run(`${tag}-no-sky`, ALL_ON + '; r.sky.container.renderable = false');
      await run(`${tag}-no-sun-glow-corona`, ALL_ON + '; r.sunRenderer.getContainer().renderable = false; r.glowRenderer.getContainer().renderable = false; r.corona.getContainer().renderable = false');
      await run(`${tag}-no-bloom`, ALL_ON + '; r.bloom.enabled = false; r.bloom.sprite.renderable = false');
      await run(`${tag}-no-ships`, ALL_ON + '; r.shipLayer.renderable = false');
      await run(`${tag}-no-effects`, ALL_ON + '; r.effectContainer.renderable = false');
      await run(`${tag}-no-world`, ALL_ON + '; r.worldContainer.renderable = false');
      await run(`${tag}-bare`, ALL_ON + '; r.worldContainer.renderable = false; r.sky.container.renderable = false; r.bloom.enabled = false; r.bloom.sprite.renderable = false');
      await ev(`(() => { const r = window.__game.renderer; ${ALL_ON}; return 1; })()`);
    };
    if (want.has('gpu')) {
      await size(W, H, 1);
      await layers('900p');
      await set('s.display.lighting = false'); await run('900p-no-lighting'); await set('s.display.lighting = true');
      if (process.env.SOFTGL) { for (const q of ['medium', 'low', 'high']) { await set(`s.display.quality = '${q}'`); await sleep(1200); await run(`900p-q-${q}(msaa-on)`); } }
      // 4K-like: 1920x1080 CSS at DPR 2 (3840x2160 at high, which allows DPR 2)
      if (!process.env.SOFTGL) { await size(1920, 1080, 2);
      await layers('4k');
      for (const q of ['medium', 'low', 'high']) { await set(`s.display.quality = '${q}'`); await sleep(1200); await run(`4k-q-${q}(msaa-on)`); }
      await size(2560, 1440, 1); await run('1440p-high');
      await size(W, H, 2); await run('900p@2-high');
      await size(W, H, 1); }
    }
    if (want.has('msaa')) {
      // MSAA is read at start-up: low with MSAA on (started high, switched) against low started fresh (no MSAA)
      const big = process.env.SOFTGL ? [W, H, 1] : [1920, 1080, 2];
      await size(...big);
      await set(`s.display.quality = 'medium'`); await sleep(1200); await run('big-medium-msaa-on');
      await set(`s.display.quality = 'low'`); await sleep(1200); await run('big-low-msaa-on');
      await send('Page.reload'); await sleep(2000); await ensure(); await size(...big);
      await set(`s.display.quality = 'low'`); await sleep(1200);
      console.log('msaa now:', await ev(`(() => { const gl = window.__game.app.renderer.gl; return gl.getContextAttributes().antialias; })()`));
      await run('big-low-msaa-off');
      await size(W, H, 1); await run('900p-low-msaa-off');
      await set(`s.display.quality = 'high'`);
    }
    await size(W, H, 1);
    if (want.has('gpu')) {
      // A CPU profile of the sun fight at low quality, for the JS split by tier
      await set(`s.display.quality = 'low'`); await sleep(1000); await topUp(); await measure('sun-low', 8);
      await set(`s.display.quality = 'high'`);
    }
  }
  await fire(false);
  // Tidy: the hostiles spawned near here and at the lair
  await chat('/clear 9000'); await sleep(500);
  await chat('/tp 61800 -62600 sol'); await sleep(4000); await chat('/clear 9000'); await sleep(500);
  await chat('/god off');
} catch (e) {
  console.log('FAILED', e.stack ?? e);
} finally {
  console.log('--- page log (last 25)\n' + logs.slice(-25).join('\n'));
  writeFileSync(join(outDir, 'pagelog.txt'), logs.join('\n'));
  try { ws.close(); } catch {}
  await giveBack();
  process.exit(0);
}
