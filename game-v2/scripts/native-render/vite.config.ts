// vite-node config for the native renderer's Node side: the client's alias to common's source, nothing else (no dev
// server, no plugins, no HMR). The client code it imports resolves its own packages from client/node_modules.
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, '../../client'),
  cacheDir: resolve(__dirname, '../../client/node_modules/.vite-native'),
  resolve: {
    alias: {
      '@space-game/common': resolve(__dirname, '../../common/src'),
      earcut: resolve(__dirname, '../../client/node_modules/earcut'),
    },
  },
  server: { hmr: false, watch: null },
  logLevel: 'warn',
});
