import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Share code with main game client
      '@space-game/common': resolve(__dirname, '../../game-v2/common/src'),
      '@game': resolve(__dirname, '../../game-v2/client/src'),
    },
  },
  server: {
    port: 5174, // Different port from main game
    open: true,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    outDir: 'dist',
  },
});
