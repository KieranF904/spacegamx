// The ship generator's page. From game-v2:  npm run shipgen   (or: npx tsx scripts/shipgen/server.ts [--port 5320])
// Serves http://127.0.0.1:5320/ (or the next free port), on localhost only. Models come live from Ollama
// (localhost:11434) and LM Studio (localhost:1234, with LM_API_TOKEN from the environment or game-v2/.env; the token
// never leaves this process). Stills come from the native renderer, started on first use and stopped on exit if this
// started it. Ctrl+C stops any run and quits.
import { createServer } from 'http';
import { loadContext } from './core/index';
import { type Renderer, createLlm, nativeRenderer } from './loop/index';
import { createApp } from './web/app';
import { defaultPaths } from './web/paths';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const HOST = '127.0.0.1';

async function main(): Promise<void> {
  const ctx = loadContext();
  let renderer: Promise<Renderer | undefined> | null = null;
  const getRenderer = () => (renderer ??= nativeRenderer().catch((e) => {
    console.error(`[shipgen] no renders: ${(e as Error).message}`);
    renderer = null;
    return undefined;
  }));
  let quit = () => {};
  const app = createApp({ ctx, llm: createLlm(), paths: defaultPaths(ctx.dataDir), getRenderer, onQuit: () => quit() });
  const server = createServer(app.handle);

  const first = Number(flag('port') ?? process.env.SHIPGEN_PORT ?? 5320);
  const port = await new Promise<number>((ok, fail) => {
    let p = first;
    const tryListen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && p < first + 20) { p++; tryListen(); } else fail(e);
      });
      server.listen(p, HOST, () => ok(p));
    };
    tryListen();
  });
  console.log(`[shipgen] http://${HOST}:${port}/  (pid ${process.pid}; Ctrl+C to quit)`);

  let quitting = false;
  quit = async () => {
    if (quitting) process.exit(130);
    quitting = true;
    console.log('[shipgen] stopping');
    server.close();
    server.closeAllConnections?.();
    await app.close();
    const r = await renderer;
    await r?.close();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

main().catch((e) => { console.error(`[shipgen] ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
