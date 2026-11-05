// Steps for the Rockery prediction-mode demo (dev Sim tools, client dev/predict): a guest in the Rockery, test traffic
// spawned with /rockery, a little bot flying the guest's ship (cursor led onto the nearest target as drawn, firing,
// strafing), and for each prediction mode and each round trip: the network simulator set, a warm-up, the numbers read
// off window.__simTools (corrections, re-steps, hit agreement, CPU) and a shot with the overlay on.
//   node scripts/boss-shots/predict-demo-steps.mjs <gamePort> > steps.json
//   node scripts/boss-shots/shoot.mjs http://localhost:<vitePort>/ out/predict @steps.json > demo.txt
// Env: MODES=A,B,C1,C2,C3  PINGS=100,200  JITTER=10  LOSS=0  SECS=15 (measured, a mode and ping)  TARGETS=drones|bots|both|dummy
//      SHOTS=1 (a screenshot each run)  ZOOM=0.65  VIEW=1280x800
const [port = '3471'] = process.argv.slice(2);
const modes = (process.env.MODES ?? 'A,B,C1,C2,C3').split(',');
const pings = (process.env.PINGS ?? '100,200').split(',').map(Number);
const jitter = Number(process.env.JITTER ?? 10), loss = Number(process.env.LOSS ?? 0), secs = Number(process.env.SECS ?? 15);
const targets = process.env.TARGETS ?? 'both';

// (Before the page's own scripts: no Vite HMR socket, so another agent's edit can't reload the page mid-run)
const pre = `(() => {
  const W = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return new W('ws://127.0.0.1:9/', p);
    return p === undefined ? new W(url) : new W(url, p);
  };
  window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
})()`;

// (Test traffic beside the guest: bot players once (they fly in from where they join and stay), a fresh drone pack
// before each run, as drones get shot apart: the admin clear takes only hostiles)
const spawn = (first) => `async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms)), g = window.__game;
  const say = (text) => g.network.send({ type: 'chat', text });
  if (${first}) { say('/rockery clear'); await sleep(600); }
  else { g.network.send({ type: 'admin', cmd: 'clear', args: { radius: 12000, quiet: true } }); await sleep(600); }
  if ('${targets}' === 'dummy') { if (${first}) { say('/rockery dummy halberd'); await sleep(400); } }
  else {
    if ('${targets}' !== 'bots') { say('/rockery drones 5'); await sleep(400); }
    if ('${targets}' !== 'drones' && ${first}) { say('/rockery bots 3 mid near'); await sleep(400); }
  }
  await sleep(${first ? 8000 : 2500});
  return 'spawned';
}`;

const login = `(async () => { try {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  localStorage.setItem('sg.tutorialDone', '1');
  document.querySelector('.guest-button').click(); await sleep(2500);
  const g = window.__game;
  g.handleServerSelect({ host: 'localhost', port: ${port}, name: 'demo', region: '', maxPlayers: 8, players: 0, secure: false });
  await sleep(12000);
  g.network.send({ type: 'admin', cmd: 'god', args: { on: true } }); await sleep(300);
  await (${spawn(true)})();
  // The pilot: the cursor led onto the nearest target as drawn, firing within 1500, strafing across its line
  const st = g.state, sc = g.shipClient, input = g.input, keys = input.keys, md0 = input.isMouseDown, me = st.playerId;
  let firing = false; const t0 = performance.now();
  input.isMouseDown = (b) => b === 0 ? firing : md0.call(input, b);
  const isTarget = (id, e) => id !== me && (e.type === 1 || e.type === 2 || e.type === 3 || (e.type === 10 && sc.replicas.modeOf(id) !== 2 && sc.replicas.modeOf(id) !== undefined)) && sc.store.get(id)?.derived;
  const tickBot = () => {
    const m = st.entities.get(st.playerId);
    if (m) {
      let best = null, bd = Infinity;
      for (const [id, e] of st.entities) if (isTarget(id, e)) { const d = Math.hypot(e.renderX - m.renderX, e.renderY - m.renderY); if (d < bd) { bd = d; best = e; } }
      keys.delete('KeyW'); keys.delete('KeyA'); keys.delete('KeyS'); keys.delete('KeyD');
      if (best) {
        let ax = best.renderX - m.renderX, ay = best.renderY - m.renderY;
        for (let i = 0; i < 3; i++) { const tt = Math.hypot(ax, ay) / 48; ax = best.renderX - m.renderX + ((best.vx ?? 0) - 0.3 * (m.vx ?? 0)) * tt; ay = best.renderY - m.renderY + ((best.vy ?? 0) - 0.3 * (m.vy ?? 0)) * tt; }
        const s = g.renderer.worldToScreen(m.renderX + ax, m.renderY + ay);
        input.rawX = s.x; input.rawY = s.y;
        firing = bd < 1100;
        const side = Math.floor((performance.now() - t0) / 4000) % 2 ? 1 : -1, ux = (best.renderX - m.renderX) / bd, uy = (best.renderY - m.renderY) / bd;
        const radial = bd > 700 ? 0.8 : bd < 350 ? -0.7 : 0, mx = -uy * side + ux * radial, my = ux * side + uy * radial;
        if (my < -0.38) keys.add('KeyW'); if (my > 0.38) keys.add('KeyS'); if (mx < -0.38) keys.add('KeyA'); if (mx > 0.38) keys.add('KeyD');
      } else firing = false;
    }
    requestAnimationFrame(tickBot);
  };
  requestAnimationFrame(tickBot);
  window.__simTools.overlay.setOn(true);
  // (The counters panel to the right for the shots: its place beside the F7 panel covers the ship)
  Object.assign(document.querySelector('[data-sim-overlay=counters]').style, { left: '12px', top: '262px', fontSize: '10px', lineHeight: '1.3' });
  for (const el of document.querySelectorAll('.sgc')) el.style.visibility = 'hidden';
  return { me, sys: g.currentSystem?.()?.id, ping: st.smoothedPing, net: !!window.__simTools.net };
} catch (e) { return 'ERR ' + e.stack; } })()`;

const setNet = (ping) => `(() => { const n = window.__simTools.net; if (!n) return 'no netSim'; Object.assign(n.config, { enabled: ${ping > 0}, ping: ${ping}, jitter: ${ping > 0 ? jitter : 0}, loss: ${loss} }); return n.config; })()`;
const setMode = (m) => `(() => { const t = window.__simTools; t.predict.set('${m}'); return t.predict.mode.id; })()`;
const read = (m, ping) => `(() => { const st = window.__game.state, r = window.__simTools.read(), round = (v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  return { run: '${m}@${ping}', ping: Math.round(st.smoothedPing), lead: st.leadTicks, interpMs: Math.round(st.interpDelayMs), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)])), totals: window.__simTools.predict.tally.totals, strikes: window.__simTools.predict.strikes.totals, gapP: window.__simTools.predict.drawGap.pilot.totals, gapA: window.__simTools.predict.drawGap.ai.totals, layer: { ...window.__simTools.predict.layer.stats } }; })()`;
const zoom = (z) => ({ eval: `(() => { const i = window.__game.input; i.minZoom = Math.min(i.minZoom, ${z}); i.zoom = i.targetZoom = ${z}; return i.zoom; })()` });

const steps = [
  { cdp: { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: pre } } }, { cdp: { method: 'Page.reload', params: {} } }, { wait: 10000 },
  { eval: login },
  ...(process.env.VIEW ? [{ resize: process.env.VIEW.split('x').map(Number) }] : []),
  zoom(Number(process.env.ZOOM ?? 0.65)),
];
for (const ping of pings) {
  steps.push({ eval: setNet(ping) }, { wait: 4000 });
  for (const m of modes) {
    // (Switching resets the mode's counters; a warm-up for the clock and interpolation to settle on the new ping)
    steps.push({ eval: `(${spawn(false)})()` }, { eval: setMode(m) }, { wait: 2000 }, { eval: setMode(m) }, { wait: secs * 1000 }, { eval: read(m, ping) });
    if (process.env.SHOTS !== '0') steps.push({ shot: 1 });
  }
}
steps.push({ eval: setNet(0) }, { eval: `(() => { const g = window.__game; g.network.send({ type: 'chat', text: '/rockery clear' }); return 'cleared'; })()` }, { wait: 800 });
console.log(JSON.stringify(steps));
