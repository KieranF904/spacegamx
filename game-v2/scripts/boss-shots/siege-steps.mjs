// Steps for the siege panels (docs/design/siege-upgrade.md): a guest, god mode, down to Selene, one cannon, day, dusk, night,
// the north lane, four skiffs at the bastion. Blocks the Vite HMR socket in the tab (other agents' edits reload the page).
//   node scripts/boss-shots/siege-steps.mjs > steps.json && node scripts/boss-shots/shoot.mjs http://localhost:5273/ out/siege @steps.json
// Shots: 0 day zoom 1 (panel), 1 day 0.35, 2 dusk, 3 night 0.35, 4-5 north lane 0.6, 6-8 combat 0.6
const login = `(async () => { try { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); localStorage.setItem('sg.tutorialDone','1'); document.querySelector('.guest-button').click(); await sleep(2500); const j = [...document.querySelectorAll('button')].find(b => /join/i.test(b.innerText)); if (j) j.click(); await sleep(9000);
 const g = window.__game; g.network.send({ type: 'admin', cmd: 'god', args: { on: true } }); await sleep(400);
 const C = await import('/@fs/C:/Users/Kieran/Desktop/Spacegame/game-v2/common/src/index.ts');
 const D = (await import('/@fs/C:/Users/Kieran/Desktop/Spacegame/game-v2/data/systems.json?import')).default; const sys = D.systems.find(s => s.id === 'sol'); const p = sys.planets.find(q => (q.moons||[]).some(m => m.surface === 'selene_siege'));
 g.network.send({ type: 'admin', cmd: 'tp', args: { system: 'sol', x: 0, y: 30000 } }); await sleep(6000);
 const i = p.moons.findIndex(m => m.surface === 'selene_siege');
 const tick = g.state.getRawServerTick() + 210; const at = C.planetPosition(p, tick), o = C.moonOffset(p, i, tick);
 const mx = at.x + o.x, my = at.y + o.y;
 g.network.send({ type: 'admin', cmd: 'tp', args: { system: 'sol', x: mx + p.moons[i].radius + 350, y: my } }); await sleep(3500);
 g.network.send({ type: 'interact' }); await sleep(7000); const me = g.state.entities.get(g.state.playerId) ?? {};
 return { sys: g.currentSystem()?.id, mx, my, me: [me.x, me.y] }; } catch (e) { return 'ERR ' + e.stack; } })()`;
const act = (o, wait = 600) => ({ eval: `(async () => { window.__game.network.send(${JSON.stringify({ type: 'siege', ...o })}); await new Promise(r => setTimeout(r, ${wait})); return 'ok'; })()` });
const tp = (x, y, wait = 2500) => ({ eval: `(async () => { const g = window.__game; g.network.send({ type: 'admin', cmd: 'tp', args: { system: g.currentSystem().id, x: ${x}, y: ${y} } }); await new Promise(r => setTimeout(r, ${wait})); return g.currentSystem().id; })()` });
const zoom = (z) => ({ eval: `(() => { const i = window.__game.input; i.minZoom = Math.min(i.minZoom, ${z}); i.zoom = i.targetZoom = ${z}; return [i.minZoom, i.zoom]; })()` });
const steps = [
  { eval: login },
  act({ action: 'buy', item: 'turret_cannon' }),
  tp(0, 420),
  { eval: `(() => window.__game.renderer.getZoom())()` },
  { wait: 1500 }, { shot: 1 },            // 0 day, default zoom
  zoom(0.35), { wait: 1500 }, { shot: 1 }, // 1 day, wide
  act({ action: 'ready' }, 3500), { shot: 1 }, // 2 dusk
  { wait: 5000 }, { shot: 1 },            // 3 night at bastion, wide
  zoom(0.6), tp(0, -4200, 3000), { shot: 1 }, // 4 out on the north lane
  { wait: 12000 }, { shot: 1 },           // 5 enemies coming
  { eval: `(async () => { const g = window.__game; g.network.send({ type: 'admin', cmd: 'spawn', args: { x: 300, y: -1600, count: 4 } }); await new Promise(r => setTimeout(r, 300)); return 'spawned'; })()` },
  tp(150, -500, 2500), { shot: 1 },       // 6 combat at the bastion
  { wait: 2500 }, { shot: 1 },            // 7
  { wait: 2500 }, { shot: 1 },            // 8
  { eval: `(() => { const g = window.__game; g.network.send({ type: 'admin', cmd: 'clear', args: { radius: 20000, quiet: true } }); return 'cleared'; })()` },
  { wait: 800 },
];

const noHmr = "(() => { const W = window.WebSocket; window.WebSocket = function (url, p) { if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return new W('ws://127.0.0.1:9/', p); return p === undefined ? new W(url) : new W(url, p); }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); })()";
console.log(JSON.stringify([{ cdp: { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: noHmr } } }, { cdp: { method: 'Page.reload', params: {} } }, { wait: 10000 }, ...steps]));
