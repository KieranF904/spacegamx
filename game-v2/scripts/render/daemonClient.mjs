// Find the render daemon (daemon.mjs), starting it if it isn't running. Everything that needs a browser goes through
// it: the one headless Chrome on the machine (render.mjs for stills, boss-shots/shoot.mjs for live game shots).
import { spawn } from 'child_process';
import { readFileSync, openSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const here = fileURLToPath(new URL('.', import.meta.url));
// (RENDER_PORT picks a daemon: each port its own, started with that port)
export const PORT = Number(process.env.RENDER_PORT ?? 5281);
export const STATE = join(tmpdir(), `space-render-daemon${PORT === 5281 ? '' : `-${PORT}`}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function daemonUrl(start = true) {
  const tryState = async () => {
    try {
      const s = JSON.parse(readFileSync(STATE, 'utf8'));
      const r = await fetch(`http://127.0.0.1:${s.port}/status`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return `http://127.0.0.1:${s.port}`;
    } catch {}
    return null;
  };
  let url = await tryState();
  if (url || !start) return url;
  const logFile = join(tmpdir(), `space-render-daemon${PORT === 5281 ? '' : `-${PORT}`}.log`);
  console.error(`starting the render daemon (log: ${logFile})…`);
  const out = openSync(logFile, 'a');
  spawn(process.execPath, [join(here, 'daemon.mjs')], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  for (let i = 0; i < 240 && !url; i++) { await sleep(500); url = await tryState(); }
  if (!url) throw new Error(`the render daemon didn't start: see ${logFile}`);
  return url;
}
