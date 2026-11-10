import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { shipsDevApi } from './shipsDevApi';

/** In the browser, Node's built-ins (imported by the server code the sandbox and replays bundle) are stubs */
const nodeStubs = (on: boolean) => (on ? [{ find: /^(fs|fs\/promises|path|os|url|zlib|crypto)$/, replacement: resolve(__dirname, 'src/nodeStubs.ts') }] : []);

/**
 * Fails the build if server code (proto mode's and the replays', which only load
 * lazily) ends up in what index.html loads at start: the main chunk and its static imports
 */
const serverOutOfMain = (): Plugin => ({
  name: 'server-out-of-main',
  apply: 'build',
  generateBundle(_, bundle) {
    const main = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && c.name === 'main');
    const seen = new Set<string>();
    const walk = (file: string) => {
      const c = bundle[file];
      if (seen.has(file) || !c || c.type !== 'chunk') return;
      seen.add(file);
      const server = Object.keys(c.modules).find((id) => /[\\/]server[\\/]src[\\/]/.test(id));
      if (server) this.error(`${server} is in the start-up chunk ${file}: import it lazily (import())`);
      c.imports.forEach(walk);
    };
    if (main) walk(main.fileName);
  },
});

export default defineConfig(({ command, mode }) => ({
  plugins: [shipsDevApi(), serverOutOfMain()],
  // (module workers, split like the rest: the hull worker brings in the hull builder and what it needs)
  worker: { format: 'es' },
  resolve: {
    alias: [
      { find: '@space-game/common', replacement: resolve(__dirname, '../common/src') },
      // (in dev too: the sandbox and replays bundle server code that imports Node's built-ins by name)
      ...nodeStubs(true),
    ],
  },
  server: {
    port: 5273,
    strictPort: true,
    // Proto mode imports ../server/src and ../data
    fs: { allow: ['..'] },
    // (WS_TARGET: where this /ws proxy forwards, the dev server on 3000 by default. The game's own join doesn't use it: it
    // connects straight to the server picked in the server browser, so a server on another port is joined from there)
    proxy: {
      '/ws': {
        target: process.env.WS_TARGET || 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    // (maps are written for local debugging, but no bundle links to them: nothing tells a browser they exist)
    // (VITE_NO_SOURCEMAP=1, set by deploy/vps/deploy.sh, skips them: they were 73% of the deploy tarball and nginx 404s them)
    sourcemap: process.env.VITE_NO_SOURCEMAP === '1' ? false : 'hidden',
    rollupOptions: {
      output: {
        // Libraries in their own chunk: it changes rarely, so a browser keeps it cached across deploys of the game code
        manualChunks: (id) => (/[\/]node_modules[\/](pixi\.js|@pixi|bitecs)[\/]/.test(id) ? 'vendor' : undefined),
      },
      input: {
        main: resolve(__dirname, 'index.html'),
        // The sandbox (a developer tool) only in non-production builds, or with SANDBOX_BUILD=1
        ...(mode !== 'production' || process.env.SANDBOX_BUILD === '1' ? { sandbox: resolve(__dirname, 'sandbox.html') } : {}),
      },
    },
  },
}));
