/**
 * A mining strike: the look of a hit on rock that rolls for ore (server/src/game/Mining.ts `extract`: every unit
 * worked is a dice roll against the tool's keep).
 *
 * Nothing is sent for it. The client can't know the server's roll, so the strike plays on every hit that mines, from
 * the shell it sees strike the rock (ShipClient.struckFx) or a mining laser's pulse landing on it (MiningBeamFx):
 * a hot pinprick, a fan of rock grit thrown back out of the surface and a slow cloud of dust in the rock's own
 * colours, so it reads as rock breaking, not a shell's plain spark. A success can look richer only from what the
 * client already gets: a chunk of ore appearing near a strike just made (`pod`) throws a brighter puff where it
 * appears.
 */

import type { Texture } from 'pixi.js';
import { disc, rock } from '../fxTextures';
import miningTable from '../../../../data/mining.json';

/** Where the particles go (the Renderer's particle and flash pools) */
export interface StrikeEmitter {
  spark(x: number, y: number, vx: number, vy: number, life: number, radius: number, color: number,
    o?: { maxLife?: number; size?: number; tex?: Texture; alpha?: number; rot?: number; rotSpeed?: number }): void;
  flash(x: number, y: number, radius: number, color: number, alpha: number, max: number, grow: number, tex?: Texture): void;
}

/** A rock's dust, its grit (brighter, lit by the strike) and the glow where it's struck, by material (RockMaterials) */
export const STRIKE_COLOURS: Record<string, { dust: number; grit: number; hot: number }> = {
  stone: { dust: 0xb8a284, grit: 0xf0dcb8, hot: 0xffa050 },
  metal: { dust: 0x9aa8ba, grit: 0xe4ebf4, hot: 0xffb066 },
  ice: { dust: 0xbfe6fa, grit: 0xf2fbff, hot: 0xb8ecff },
  crystal: { dust: 0xb9a3e6, grit: 0xf0dcff, hot: 0xd89cff },
  tar: { dust: 0x9a8466, grit: 0xf0c890, hot: 0xff7a2a },
  leestone: { dust: 0xa8c094, grit: 0xeef8dc, hot: 0xd8ff80 },
};

/** A chunk appearing this close to a strike made this recently (seconds) came out of it: the richer puff */
export const POD_NEAR = 220, POD_WITHIN = 1.4;
/** Strikes remembered for that */
const RECENT = 24;

export class MiningStrikeFx {
  /** Recent strikes: where, when (seconds) and the rock's colours */
  private recent: { x: number; y: number; at: number; mat: string }[] = [];

  constructor(private emit: StrikeEmitter, private now: () => number) {}

  /**
   * A hit that mines, at (x, y) on rock of `material`; (dx, dy) points out of the surface (back the way the shot
   * came). `scale`: about 1 for a shell, more for a laser's pulse landing
   */
  strike(x: number, y: number, dx: number, dy: number, material: string | null | undefined, scale = 1): void {
    const c = STRIKE_COLOURS[material ?? ''] ?? STRIKE_COLOURS.stone;
    const len = Math.hypot(dx, dy) || 1, out = Math.atan2(dy / len, dx / len);
    const e = this.emit;
    // A hot pinprick where it bit (not a shell's white flash), and a ring of dust kicked off the face
    e.flash(x, y, 7 * scale, c.hot, 0.85, 0.07, 0.4);
    e.flash(x, y, 12 * scale, c.dust, 0.35, 0.22, 1.6);
    // Grit: rock flecks thrown back out in a fan, tumbling
    const grit = Math.round(7 * scale);
    for (let i = 0; i < grit; i++) {
      const a = out + (Math.random() - 0.5) * 1.9, sp = 1.6 + Math.random() * 3.6;
      e.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + Math.random() * 0.35, 1.6 + Math.random() * 1.8, Math.random() < 0.6 ? c.grit : c.dust,
        { maxLife: 0.7, size: 0.9, tex: rock(i), rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 12 });
    }
    // Dust: a few soft, slow, wide motes drifting off the face, lingering after the grit
    const dust = Math.round(4 * scale);
    for (let i = 0; i < dust; i++) {
      const a = out + (Math.random() - 0.5) * 2.6, sp = 0.3 + Math.random() * 1.1;
      e.spark(x + Math.cos(a) * 4, y + Math.sin(a) * 4, Math.cos(a) * sp, Math.sin(a) * sp, 0.5 + Math.random() * 0.4, 5 + Math.random() * 5 * scale, c.dust,
        { maxLife: 0.9, size: 1, tex: disc(), alpha: 0.32 });
    }
    const t = this.now();
    this.recent.push({ x, y, at: t, mat: material ?? 'stone' });
    if (this.recent.length > RECENT) this.recent.shift();
  }

  /**
   * A pod appeared at (x, y): if it's near a strike just made, it's ore that strike kept (or one like it): a brighter
   * puff of dust and grit where it appears. True if it was
   */
  pod(x: number, y: number): boolean {
    const t = this.now();
    let best: { x: number; y: number; at: number; mat: string } | null = null, bd = POD_NEAR;
    for (const s of this.recent) {
      if (t - s.at > POD_WITHIN) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return false;
    const c = STRIKE_COLOURS[best.mat] ?? STRIKE_COLOURS.stone, e = this.emit;
    e.flash(x, y, 16, c.grit, 0.55, 0.18, 1.2);
    e.flash(x, y, 26, c.dust, 0.3, 0.4, 1.8);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3;
      e.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.4 + Math.random() * 0.4, 1.8 + Math.random() * 2, i % 3 ? c.grit : 0xffffff,
        { maxLife: 0.8, size: 1, tex: rock(i), rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 10 });
    }
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, sp = 0.3 + Math.random() * 0.8;
      e.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.7 + Math.random() * 0.4, 8 + Math.random() * 6, c.dust, { maxLife: 1.1, size: 1, tex: disc(), alpha: 0.3 });
    }
    return true;
  }
}

/** A shell kind's mining tool (data/mining.json `tools`; the client's copy of what the server mines with) */
type ToolRow = { yield?: number; hardness?: number; mining?: boolean };
const MINING_TOOLS = miningTable.tools as unknown as Record<string, ToolRow>;

/**
 * Does a shell of `kind` striking a rock of `rockHardness` roll for ore (Mining.extract)? Guns (any tool that isn't a
 * `mining` one) mine soft rock only (hardness 1); a mining tool (a charge), rock its hardness reaches; nothing with
 * no yield (the EMP). An unknown kind mines as `fixed`, as the server's does
 */
export function strikeRolls(kind: string | undefined, rockHardness: number | undefined, tools: Record<string, ToolRow> = MINING_TOOLS): boolean {
  const t = (kind && tools[kind]) || tools.fixed;
  if (!t || !(t.yield! > 0)) return false;
  const h = rockHardness ?? 1;
  return t.mining ? (t.hardness ?? 1) >= h : h <= 1;
}
