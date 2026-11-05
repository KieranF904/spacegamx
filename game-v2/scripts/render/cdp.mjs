// Headless Chrome over the DevTools protocol (as scripts/boss-shots/shoot.mjs drives it): launch, attach to its page, send.
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, setPriority, constants } from 'os';
import { keepIdle } from '../lib/lowPriority.mjs';

export const CHROME = process.env.CHROME ?? 'C:/Users/Kieran/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A headless Chrome on a debugging port, its page attached: at the lowest priority, on the real GPU (SOFTGL=1: SwiftShader, as shoot.mjs) */
export async function launch({ width = 1600, height = 1000 } = {}) {
  const port = 9333 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'cdp-render-'));
  // (Chrome inherits the priority: it only gets CPU nothing else wants)
  try { setPriority(constants.priority.PRIORITY_LOW); } catch {}
  const gpu = process.env.SOFTGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', ...gpu, `--window-size=${width},${height}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--mute-audio', '--renderer-process-limit=1', '--disable-extensions', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-default-browser-check', '--disable-background-networking', '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 75 && !ws; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
  }
  if (!ws) { kill(proc.pid); throw new Error(`Chrome didn't start (${CHROME})`); }
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const page = attach(ws);
  page.proc = proc;
  page.port = port;
  keepIdle(proc.pid);
  page.close = () => { try { ws.close(); } catch {} kill(proc.pid); setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500); };
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return page;
}

/** send(method, params) → result (throws on a protocol error); logs: the page's console and exceptions, last 200 */
function attach(ws) {
  let id = 0;
  const pending = new Map();
  const logs = [];
  const push = (s) => { logs.push(s); if (logs.length > 200) logs.shift(); };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  });
  ws.addEventListener('close', () => { for (const cb of pending.values()) cb({ error: { message: 'socket closed' } }); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  /** Evaluate in the page (awaiting a promise), its value back */
  const evaluate = async (expression, timeout = 120000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, logs };
}

/** Kill a process and its children (Chrome's renderers, GPU process) */
export function kill(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {}
}
