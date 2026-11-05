// Boss bullet-hell client profile (measurement only; built on clientProfile.mjs's harness: a tab borrowed from the render
// daemon, the same in-page probe). Joins the dev game as a guest, goes to the Pyreclast's lair (ashfall_cavern, nowhere
// near the Redtooth picket), measures its first stage (an ordinary boss fight: turret volleys) and then its third (rings,
// spirals and seekers of great orbs: the densest bullet hell in the game) after `devBoss shed`, with a census of the live
// shots, pooled sprites, lights and bloom sources each frame. Cleans up after (/clear round the spot, god and hide off).
//   node scripts/profile/bossBulletHell.mjs <outDir> [shedSteps=92]
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { daemonUrl } from '../render/daemonClient.mjs';

const [outDir = '.', shedArg] = process.argv.slice(2);
const SHED = Number(shedArg ?? 92);
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


// ---- the bullet-hell census: sampled every frame while measuring ----
const CENSUS = `(() => {
  const g = window.__game, r = g.renderer, fx = r.weaponFx, P = window.__P;
  if (P.census) return 'census in';
  const C = P.census = { frames: 0, shots: [], lights: 0, lightsMax: 0, lightCalls: 0, bloomLive: 0, fxChildren: 0, fxVisible: 0, smoke: 0, flashes: 0, maxShots: 0, telegraphs: 0 };
  const L = r.lighting; let calls = 0;
  for (const k of ['point', 'cone']) { const f = L[k]; L[k] = function (...a) { calls++; return f.apply(this, a); }; }
  const B = r.bloom; const br = B.render;
  B.render = function (...a) { const n = this.sources.filter((c) => this.onScreen(c) && c.children.length).length; C.bloomLive += n; return br.apply(this, a); };
  const loop = () => {
    if (P.sampling) {
      C.frames++;
      const n = fx.shots.size; C.shots.push(n); C.maxShots = Math.max(C.maxShots, n);
      C.lightCalls += calls; C.lightsMax = Math.max(C.lightsMax, calls);
      const walk = (c) => { let t = 0, v = 0; for (const ch of c.children) { t++; if (ch.visible) v++; if (ch.children?.length) { const s = walk(ch); t += s[0]; v += s[1]; } } return [t, v]; };
      if (C.frames % 30 === 1) { const [t, v] = walk(r.effectContainer); C.fxChildren = Math.max(C.fxChildren, t); C.fxVisible = Math.max(C.fxVisible, v);
        const [st, sv] = walk(g.app.stage); C.stageMax = Math.max(C.stageMax ?? 0, st); C.stageVisMax = Math.max(C.stageVisMax ?? 0, sv); }
      C.smoke = Math.max(C.smoke, fx.smoke?.length ?? 0); C.flashes = Math.max(C.flashes, fx.flashes?.length ?? 0);
    }
    calls = 0;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'census in';
})()`;
const CRESET = `(() => { const C = window.__P.census; Object.assign(C, { frames: 0, shots: [], lightCalls: 0, lightsMax: 0, bloomLive: 0, fxChildren: 0, fxVisible: 0, smoke: 0, flashes: 0, maxShots: 0, stageMax: 0, stageVisMax: 0 }); window.__P.sampling = true; return 1; })()`;
const CSTATS = `(() => { const P = window.__P, C = P.census; P.sampling = false; const s = [...C.shots].sort((a, b) => a - b), n = s.length || 1;
  const mainPasses = P.n['pixi render: main pass (CPU submit)'] || 1;
  return { frames: C.frames, shotsMean: +(s.reduce((a, b) => a + b, 0) / n).toFixed(1), shotsP95: s[Math.floor(n * 0.95)] ?? 0, shotsMax: C.maxShots,
    lightCallsPerFrame: +(C.lightCalls / (C.frames || 1)).toFixed(1), lightCallsMax: C.lightsMax, bloomSourcesPerRender: +(C.bloomLive / mainPasses).toFixed(2),
    effectsChildrenMax: C.fxChildren, effectsVisibleMax: C.fxVisible, stageObjectsMax: C.stageMax, stageVisibleMax: C.stageVisMax, smokeMax: C.smoke, flashesMax: C.flashes,
    entityProjectiles: [...window.__game.state.entities.values()].filter((e) => e.type === 7).length }; })()`;

async function measureHell(name, secs, opts) {
  await ensure();
  await ev(CENSUS);
  await ev(CRESET);
  const s = await measure(name, secs, opts);
  const c = await ev(CSTATS);
  console.log(`   census: ${JSON.stringify(c)}`);
  writeFileSync(join(outDir, `${name}.census.json`), JSON.stringify(c, null, 1));
  return { ...s, census: c };
}

const SPOT = { x: 0, y: -14000 + 1900, sys: 'ashfall_cavern' };
const results = {};
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await metrics();
  await send('Page.navigate', { url: URL0 });
  await sleep(6000);
  await joinGame();
  console.log(await ev(PROBE));
  console.log(await ev(CENSUS));
  await chat('/god on');
  await chat('/hide on');
  scene = async () => {
    await chat('/god on');
    await chat(`/tp ${SPOT.x} ${SPOT.y} ${SPOT.sys}`); await sleep(5000);
  };
  await scene();
  console.log(await ev(`(() => { const g = window.__game; const me = g.state.entities.get(g.state.playerId); return 'at ' + Math.round(me?.x) + ',' + Math.round(me?.y) + ' sys ' + g.state.systemId; })()`));
  await chat('/boss boss_pyreclast'); await sleep(2500);
  await chat('/hide off'); await sleep(3000);
  // Its first stage: an ordinary boss fight (turret volleys, drones), the pilot firing at it
  await fire(true, W * 0.5, H * 0.2);
  results.stage1 = await measureHell('pyre-stage1', 12);
  // To its third stage (each earlier stage blown away), then a loop of its moves: crystal, ring, spiral, swarm, vent
  await ev(`window.__game.network.send({ type: 'devBoss', shed: ${SHED} }), 1`);
  await sleep(7000);
  results.stage3 = await measureHell('pyre-stage3', 24);
  // The GPU probe in the same phase (readPixels after the main pass)
  results.stage3gpu = await measureHell('pyre-stage3-gpu', 8, { profile: false, gpu: true });
  // LAYERS=1: the GPU probe with one layer off at a time (renderable / enabled: nothing the game itself touches), then at DPR 2
  if (process.env.LAYERS) {
    const toggles = [
      ['no-effects', 'window.__game.renderer.effectContainer.renderable = false', 'window.__game.renderer.effectContainer.renderable = true'],
      ['no-bloom', 'window.__game.renderer.bloom.enabled = false', 'window.__game.renderer.bloom.enabled = true'],
      ['no-ships', 'window.__game.renderer.shipLayer.renderable = false', 'window.__game.renderer.shipLayer.renderable = true'],
    ];
    for (const [name, off, on] of toggles) {
      await ev(`${off}, 1`);
      try { results[name] = await measureHell(`pyre-stage3-${name}`, 6, { profile: false, gpu: true }); } finally { await ev(`${on}, 1`); }
    }
    results.again = await measureHell('pyre-stage3-again', 6, { profile: false, gpu: true });
    await metrics(1920, 1080, 2); await sleep(1500);
    results.dpr2 = await measureHell('pyre-stage3-dpr2', 6, { profile: false, gpu: true });
    await ev('window.__game.renderer.effectContainer.renderable = false, 1');
    try { results.dpr2noFx = await measureHell('pyre-stage3-dpr2-no-effects', 6, { profile: false, gpu: true }); } finally { await ev('window.__game.renderer.effectContainer.renderable = true, 1'); }
    await metrics();
  }
  await fire(false);
  // The same spot with nothing hostile (the GPU floor and a quiet frame for comparison)
  await chat('/clear 9000'); await sleep(4000);
  results.quiet = await measureHell('pyre-cleared', 6, { profile: false, gpu: true });
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  try { await fire(false); await chat('/clear 9000'); await sleep(500); await chat('/god off'); await chat('/hide off'); } catch {}
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  writeFileSync(join(outDir, 'logs.txt'), logs.join('\n'));
  try { ws.close(); } catch {}
  await giveBack();
}
process.exit(0);
