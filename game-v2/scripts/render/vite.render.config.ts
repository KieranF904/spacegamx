// The render daemon's own dev server, when 5273 isn't up: frozen (no HMR, no watching, so others' edits can't reload
// the page mid-shot), its own cache and port (RENDER_VITE_PORT, default 5299). Shows the tree as it was when started.
import { resolve } from 'path';
import base from '../../client/vite.config';

export default (env: { mode: string; command: string }) => {
  const c = (base as unknown as (e: typeof env) => Record<string, any>)(env);
  return {
    ...c,
    root: resolve(__dirname, '../../client'),
    cacheDir: resolve(__dirname, '../../client/node_modules/.vite-render'),
    server: { ...c.server, host: '127.0.0.1', port: Number(process.env.RENDER_VITE_PORT ?? 5299), strictPort: true, hmr: false, watch: null, proxy: undefined },
  };
};
