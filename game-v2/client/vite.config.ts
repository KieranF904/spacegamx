import { defineConfig } from 'vite';
import { resolve } from 'path';
import { shipsDevApi } from './shipsDevApi';

/** Built for the browser, Node's built-ins (imported by the server code the sandbox and replays bundle) are stubs */
const nodeStubs = (on: boolean) => (on ? [{ find: /^(fs|fs\/promises|path|os|url|zlib)$/, replacement: resolve(__dirname, 'src/nodeStubs.ts') }] : []);

export default defineConfig(({ command, mode }) => ({
  plugins: [shipsDevApi()],
  // (module workers, split like the rest: the hull worker brings in the hull builder and what it needs)
  worker: { format: 'es' },
  resolve: {
    alias: [
      { find: '@space-game/common', replacement: resolve(__dirname, '../common/src') },
      ...nodeStubs(command === 'build'),
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
