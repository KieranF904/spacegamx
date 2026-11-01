// The build-up of a design as frames: the core, its frame of hull, power, weapons, engines, tools, then armour, each
// stage growing outward from the core, one part (or a few, on a big ship) a frame, rendered by the native renderer.
import { join } from 'path';
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import type { ShipgenContext } from '../core/index';
import type { Renderer } from '../loop/index';
import { type Category, categoryOf, cellsOf } from './parts';

const STAGE: Record<Category, number> = {
  core: 0, hull: 1, cargo: 1, other: 1, generator: 2, dynamo: 2, store: 2, conduit: 2, diode: 2,
  weapon: 3, thruster: 4, tool: 5, armour: 6,
};
export const STAGE_NAMES = ['core', 'frame', 'power', 'weapons', 'engines', 'tools', 'armour'];

export interface Frame { bp: Blueprint; stage: string; parts: number }

export function buildUp(ctx: ShipgenContext, bp: Blueprint, maxFrames = 80): Frame[] {
  const centre = (p: PlacedPart) => {
    const c = cellsOf(ctx, p);
    return c.length ? [c.reduce((a, x) => a + x[0], 0) / c.length, c.reduce((a, x) => a + x[1], 0) / c.length] : [p.y, p.x];
  };
  const core = bp.parts.find((p) => p.fn === 'core');
  const [cr, cc] = core ? centre(core) : [0, 0];
  const order = bp.parts
    .map((p) => { const [r, c] = centre(p); return { p, stage: STAGE[categoryOf(ctx, p)], d: Math.hypot(r - cr, c - cc) }; })
    .sort((a, b) => a.stage - b.stage || a.d - b.d || a.p.uid - b.p.uid);
  const step = Math.max(1, Math.ceil(order.length / maxFrames));
  const frames: Frame[] = [];
  for (let i = 0; i < order.length;) {
    // (A frame never spans two stages)
    let k = i + 1;
    while (k < order.length && k - i < step && order[k].stage === order[i].stage) k++;
    frames.push({ bp: { ...bp, parts: order.slice(0, k).map((x) => x.p) }, stage: STAGE_NAMES[order[i].stage], parts: k });
    i = k;
  }
  return frames;
}

export interface TimelapseResult { dir: string; frames: { file: string; stage: string; parts: number }[]; ms: number }

export async function renderTimelapse(renderer: Renderer, frames: Frame[], dir: string, signal?: AbortSignal): Promise<TimelapseResult> {
  const t0 = Date.now();
  const out: TimelapseResult['frames'] = [];
  const name = (i: number) => join(dir, `frame-${String(i).padStart(3, '0')}.png`);
  // (The whole ship first: its zoom holds for every frame, so the ship grows instead of the camera following it)
  const last = frames.length - 1;
  const whole = last >= 0 ? await renderer.render(frames[last].bp, name(last), signal) : undefined;
  const params = whole?.zoom ? { zoom: String(whole.zoom) } : undefined;
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) break;
    if (i < last) await renderer.render(frames[i].bp, name(i), signal, params);
    out.push({ file: name(i), stage: frames[i].stage, parts: frames[i].parts });
  }
  return { dir, frames: out, ms: Date.now() - t0 };
}
