import { defineConfig } from 'vite';
import { resolve } from 'path';
import { shipsDevApi } from './shipsDevApi';

export default defineConfig(({ mode }) => ({
  plugins: [shipsDevApi()],
  // (module workers, split like the rest: the hull worker brings in the hull builder and what it needs)
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@space-game/common': resolve(__dirname, '../common/src'),
    },
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
