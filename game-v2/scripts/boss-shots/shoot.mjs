// Live game shots through the DevTools protocol, in a tab of the render daemon's Chrome: open a page, press keys, take screenshots.
//   node shoot.mjs <url> <outPrefix> [steps json]
// A step: { eval }, { shot, clip }, { wait }, { down/up }, { click }, { rclick, hold }, { move }, { wheel }, { resize },
// or { cdp: { method, params, save } } (any DevTools call; `save` writes its result, e.g. Profiler.stop's profile, to a file)
import { writeFileSync } from 'fs';
import { daemonUrl } from '../render/daemonClient.mjs';

const [url, out, stepsJson] = process.argv.slice(2);
const steps = JSON.parse(stepsJson?.startsWith('@') ? (await import('fs')).readFileSync(stepsJson.slice(1), 'utf8') : stepsJson ?? '[]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No browser of its own: a tab borrowed from the render daemon's one Chrome (scripts/render/daemon.mjs: lowest priority,
// the real GPU), started if it isn't up. Shots take turns there, so however many run, it's one browser on the machine.
// (the heavy path: a real browser. Stills of an asset or a design (ships, bosses, models, materials, sheets) don't need it:
// `npm run render -- <asset> ...` draws them natively in tens of ms with no browser. This is for LIVE game shots only.)
console.error('NOTE: shoot.mjs drives headless Chrome (heavy), for live game shots only. Stills of assets/designs: npm run render (native, no browser).');
const base = await daemonUrl();
console.error('waiting for a tab in the render daemon…');
const tab = await (await fetch(`${base}/tab`)).json();
let returned = false;
const giveBack = async () => { if (returned) return; returned = true; try { await fetch(`${base}/tab/close?id=${tab.id}`); } catch {} };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => giveBack().finally(() => process.exit(1)));
process.on('uncaughtException', (e) => { console.error(e); giveBack().finally(() => process.exit(1)); });
const ws = new WebSocket(tab.ws);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(9000);
const key = async (type, code, keyName) => send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0) });
let shot = 0;
try {
for (const s of steps) {
  if (s.down) await key('keyDown', s.down, s.key ?? s.down.replace('Key', '').toLowerCase());
  if (s.up) await key('keyUp', s.up, s.key ?? s.up.replace('Key', '').toLowerCase());
  if (s.cdp) { const r = await send(s.cdp.method, s.cdp.params ?? {}); if (s.cdp.save) writeFileSync(s.cdp.save, JSON.stringify(r.result?.profile ?? r.result)); }
  // (`move` and `rclick` take [x, y], or an expression in the page that gives one)
  const at = async (v) => {
    if (typeof v !== 'string') return v;
    const r = await send('Runtime.evaluate', { expression: v, returnByValue: true });
    const xy = r.result?.result?.value;
    if (!Array.isArray(xy)) throw new Error(`${v}: ${JSON.stringify(r.result?.exceptionDetails?.exception?.description ?? xy)}`);
    return xy;
  };
  if (s.move) { const [x, y] = await at(s.move); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  if (s.click) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.click[0], y: s.click[1], button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.click[0], y: s.click[1], button: 'left', clickCount: 1 });
  }
  // A right-click (`hold`: ms between press and release, for telling a click from a hold)
  if (s.rclick) {
    const [x, y] = await at(s.rclick);
    // (Stamped as they'd come from a mouse, `hold` apart: a slow headless frame mustn't stretch a click into a hold)
    const t0 = Date.now() / 1000;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, timestamp: t0 });
    if (s.hold) await sleep(s.hold);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, timestamp: t0 + (s.hold ?? 0) / 1000 });
  }
  if (s.eval) { const r = await send('Runtime.evaluate', { expression: s.eval, returnByValue: true, awaitPromise: true }); logs.push('EVAL ' + JSON.stringify(r.result?.result?.value ?? r.result)); }
  if (s.resize) await send('Emulation.setDeviceMetricsOverride', { width: s.resize[0], height: s.resize[1], deviceScaleFactor: 1, mobile: false });
  if (s.wheel) for (let i = 0; i < (s.times ?? 1); i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: s.wheel }); await sleep(60); }
  if (s.wait) await sleep(s.wait);
  if (s.shot) {
    // Shots never show the chat box nor the chat bubbles over ships (a step can keep them: { shot, chat: true } both,
    // { shot, bubbles: true } just the bubbles)
    if (!s.chat) await send('Runtime.evaluate', { expression: "(() => { const c = document.getElementById('chatBox'); if (c) c.style.visibility = 'hidden'; })()" });
    await send('Runtime.evaluate', { expression: `(() => { const c = document.getElementById('chatBubbles'); if (c) c.style.visibility = '${s.chat || s.bubbles ? '' : 'hidden'}'; })()` });
    const r = await send('Page.captureScreenshot', { format: 'png', ...(s.clip ? { clip: { ...s.clip, scale: s.scale ?? 1 } } : {}) });
    writeFileSync(`${out}-${shot++}.png`, Buffer.from(r.result.data, 'base64'));
  }
}
} catch (e) { logs.push('STEP FAILED ' + e.message); }
console.log(logs.slice(-(+process.env.NLOG||15)).join('\n'));
ws.close();
await giveBack();
process.exit(0);
