// Stills through the native renderer (scripts/native-render: the game's own hull shader, no browser). A design that isn't
// on disk is POSTed to /render. The service is started if it isn't up, and stopped again on close() if this started it.
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import type { Blueprint } from '../../../common/src/ships/index';

export interface Renderer {
  /** `params`: viewer params for this still only (zoom=<n> holds the framing); `zoom` is the one the service used */
  render(bp: Blueprint, outPath: string, signal?: AbortSignal, params?: Record<string, string>): Promise<{ path: string; ms: number; png: Buffer; zoom?: number }>;
  close(): Promise<void>;
}

export interface NativeRenderOptions {
  w?: number;
  h?: number;
  /** Extra viewer params (light, bg, flames...) */
  params?: Record<string, string>;
  /** Leave the service running on close() even if this started it */
  keep?: boolean;
}

/** A still that takes longer than this is given up on (a non-fatal render error), whatever signal the caller passed */
export const RENDER_TIMEOUT_MS = 60000;

interface NativeClient { BASE: string; health(): Promise<unknown>; start(): Promise<unknown>; stop(): Promise<void> }

export async function nativeRenderer(opts: NativeRenderOptions = {}): Promise<Renderer> {
  const native = (await import(pathToFileURL(join(__dirname, '../../native-render/client.mjs')).href)) as NativeClient;
  const wasUp = !!(await native.health());
  if (!wasUp) await native.start();
  const q = new URLSearchParams({ w: String(opts.w ?? 640), h: String(opts.h ?? 640), ...opts.params });
  return {
    async render(bp, outPath, signal, params) {
      const t0 = Date.now();
      const timeout = AbortSignal.timeout(RENDER_TIMEOUT_MS);
      const qs = params ? new URLSearchParams({ ...Object.fromEntries(q), ...params }) : q;
      const r = await fetch(`${native.BASE}/render?${qs}`, { method: 'POST', body: JSON.stringify(bp), headers: { 'Content-Type': 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch((e) => {
        if (timeout.aborted && !signal?.aborted) throw new Error(`render: no picture in ${RENDER_TIMEOUT_MS / 1000} s`);
        throw e;
      });
      if (!r.ok) throw new Error(`render: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      const png = Buffer.from(await r.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, png);
      const zoom = Number(r.headers.get('X-Render-Zoom'));
      return { path: outPath, ms: Date.now() - t0, png, ...(Number.isFinite(zoom) && zoom > 0 ? { zoom } : {}) };
    },
    async close() {
      if (!wasUp && !opts.keep) await native.stop();
    },
  };
}
