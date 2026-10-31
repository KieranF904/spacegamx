import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { shipsDevApi } from './shipsDevApi';

/** In the browser, Node's built-ins (imported by the server code the sandbox and replays bundle) are stubs */
const nodeStubs = (on: boolean) => (on ? [{ find: /^(fs|fs\/promises|path|os|url|zlib)$/, replacement: resolve(__dirname, 'src/nodeStubs.ts') }] : []);

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
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sandbox: resolve(__dirname, 'sandbox.html'),
      },
    },
  },
}));
