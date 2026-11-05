// Headless runner: node run.mjs [chromePath]. Serves this folder on port 5611, drives one Chrome via CDP,
// runs the scaling table for each mode, prints JSON, then kills Chrome and the server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5611, DBG = 9333;
const modes = (process.argv[3] || 'pixi-webgl,pixi-webgpu,direct').split(',');
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = http.createServer((req, res) => {
  const f = path.join(dir, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }); res.end(d); } });
}).listen(PORT);
const prof = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'gfxbench-'));
const ch = spawn(chrome, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--disable-gpu-vsync', '--disable-frame-rate-limit', '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); if (targets.length) break; } catch {} await sleep(200); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send('Page.enable');
  const all = {};
  for (const mode of modes) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mode=${mode}&auto=1` });
    let done = false;
    for (let i = 0; i < 300 && !done; i++) { await sleep(1000); done = await ev('window.__done===true'); }
    all[mode] = await ev('JSON.stringify(window.__results)').then(v => v && JSON.parse(v));
  }
  const info = await ev(`(async()=>{const a=navigator.gpu?await navigator.gpu.requestAdapter():null;return JSON.stringify({ua:navigator.userAgent,webgpu:!!navigator.gpu,adapter:a?(a.info?{vendor:a.info.vendor,arch:a.info.architecture,desc:a.info.description}:'yes'):null})})()`);
  console.log(JSON.stringify({ env: JSON.parse(info), results: all }, null, 1));
  ws.close();
}
try { await main(); } finally { ch.kill(); srv.close(); setTimeout(() => process.exit(0), 500); }
