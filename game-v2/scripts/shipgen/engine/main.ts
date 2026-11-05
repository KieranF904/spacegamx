// The engine as a child process of the desktop app (scripts/shipgen/app): JSON lines both ways over stdin/stdout.
//   in:  { "rid": 7, "cmd": "start", "args": { ... } }
//   out: { "rid": 7, "ok": true, "result": ... } | { "rid": 7, "ok": false, "error": "...", "status": 409 }
//        { "type": "event" | "end", ... } (engine.ts), { "type": "renderer", "status": "ready" | "down", "detail": "..." }
// Anything else the process prints goes to stderr. The renderer is started at once (or a running one used), restarted
// if it dies, and closed when the engine stops if the engine started it. stdin closing (the app gone) stops everything.
import { createInterface } from 'readline';
import { loadContext } from '../core/index';
import { type Renderer, createLlm, lmStudioChatFromEnv, nativeRenderer } from '../loop/index';
import { type EngineMessage, createEngine } from './engine';
import { EngineError } from './errors';
import { defaultPaths } from './paths';

// (stdout is the protocol: every stray log line goes to stderr)
const out = process.stdout.write.bind(process.stdout);
console.log = console.error;
console.info = console.error;
const write = (m: unknown) => out(JSON.stringify(m) + '\n');

/** The renderer, kept alive: started at once, and started again on the next render after one fails */
function reliableRenderer(): { get: () => Promise<Renderer | undefined>; close: () => Promise<void> } {
  let current: Promise<Renderer | undefined> | null = null;
  const start = () => (current = nativeRenderer().then((r) => {
    write({ type: 'renderer', status: 'ready' });
    return r;
  }, (e) => {
    write({ type: 'renderer', status: 'down', detail: (e as Error).message });
    current = null;
    return undefined;
  }));
  const wrapped: Renderer = {
    async render(bp, outPath, signal, params) {
      for (let tries = 0; ; tries++) {
        const r = await (current ?? start());
        if (!r) throw new Error('the renderer is not available');
        try { return await r.render(bp, outPath, signal, params); } catch (e) {
          if (signal?.aborted || tries >= 1) throw e;
          write({ type: 'renderer', status: 'down', detail: `${(e as Error).message}: restarting it` });
          current = null;
          await r.close().catch(() => {});
        }
      }
    },
    async close() { const r = await current; current = null; await r?.close(); },
  };
  start();
  return { get: async () => ((await (current ?? start())) ? wrapped : undefined), close: () => wrapped.close() };
}

async function main(): Promise<void> {
  const ctx = loadContext();
  const settings = { lmstudioChat: lmStudioChatFromEnv() };
  const llm = createLlm({ lmStudioChat: () => settings.lmstudioChat });
  const renderer = reliableRenderer();
  const engine = createEngine({ ctx, llm, paths: defaultPaths(ctx.dataDir), getRenderer: renderer.get, settings, send: (m: EngineMessage) => write(m) });
  write({ type: 'hello', pid: process.pid });

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    const hard = setTimeout(() => process.exit(0), 10000);
    await engine.close().catch(() => {});
    await renderer.close().catch(() => {});
    clearTimeout(hard);
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { rid?: number; cmd?: string; args?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { write({ type: 'error', error: 'not JSON' }); return; }
    if (msg.cmd === 'quit') { write({ rid: msg.rid, ok: true, result: {} }); quit(); return; }
    engine.call(String(msg.cmd ?? ''), msg.args ?? {}).then(
      (result) => write({ rid: msg.rid, ok: true, result }),
      (e) => write({ rid: msg.rid, ok: false, error: (e as Error).message, status: e instanceof EngineError ? e.status : 500 }),
    );
  });
  // (The app is gone: stop the run, close the renderer, exit)
  rl.on('close', quit);
}

main().catch((e) => { console.error(`[shipgen engine] ${e instanceof Error ? e.message : e}`); process.exit(1); });
