/**
 * Charge tells (docs/design/rework-2026-11.md §7): what a charge gun shows while it gathers, from the first tick, for
 * your ship (read off your own gun state) and for others (a charge-start fire event until it fires or is let go:
 * ShipClient.chargeTells).
 *
 *   Longbarrel  a thin red sight line along its aim that brightens as it fills, and a glow on the barrel's end
 *   Blackout    its emitter darkening: a dark disc swelling over the dish, a blue rim of crackle at the edge
 *   any other   a soft dot at the muzzle in a neutral light
 *
 * Plain Graphics, redrawn each frame (a dark one in normal blend, a glowing one added, so bloom picks it up).
 */

import { Container, Graphics } from 'pixi.js';
import { partWeaponDef, shipPointToWorld, type ShipState, type ShipTuning, type WeaponInfo } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';

/** Charge tell kinds by the model's function id; anything else gets the plain dot */
type Look = 'sight' | 'blackout' | 'dot';
const LOOKS: Record<string, Look> = { cannon_longbarrel: 'sight', emp_blackout: 'blackout' };

/** How long a tell with no fire event or cancel is believed (ticks past its charge): a lost event never leaves one drawn */
const STALE = 45;

export class ChargeFx {
  private dark = new Graphics();
  private glow = new Graphics();
  private root = new Container();
  private t = 0;
  /** Round the glowing Graphics: the bloom draws it again (a layer is a render group: MiningBeamFx) */
  private glowRoot = new Container();
  get glowLayer(): Container { return this.glowRoot; }

  constructor(layer: Container, private source: ShipSource, private state: GameState, private tuning: ShipTuning,
    private tells: ReadonlyMap<number, number>) {
    this.glow.blendMode = 'add';
    this.root.addChild(this.dark);
    layer.addChild(this.root);
    this.glowRoot.addChild(this.glow);
    layer.addChild(this.glowRoot);
  }

  update(dt: number, tick: number): void {
    this.t += dt;
    this.dark.clear();
    this.glow.clear();
    const me = this.state.playerId;
    const mine = this.source.get(me);
    if (mine && mine.kind === 'ship') {
      for (const w of mine.derived.weapons) {
        if (w.fire.model !== 'charge') continue;
        const c = mine.charge[w.part] ?? 0;
        if (c > 0) this.draw(me, mine, w, Math.min(1, c / Math.max(1, w.fire.charge ?? 60)));
      }
    }
    for (const [key, start] of this.tells) {
      const owner = key >> 8, part = key & 255;
      if (owner === me) continue;
      const ship = this.source.get(owner);
      if (!ship || ship.kind !== 'ship') continue;
      const w = ship.derived.weapons.find((x) => x.part === part);
      if (!w || w.fire.model !== 'charge') continue;
      const need = Math.max(1, w.fire.charge ?? 60), age = tick - start;
      if (age > need + STALE) continue;
      this.draw(owner, ship, w, Math.max(0, Math.min(1, age / need)));
    }
  }

  private draw(owner: number, ship: ShipState, w: WeaponInfo, k: number): void {
    const e = this.state.entities.get(owner);
    if (!e) return;
    const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
    // The muzzle and the way it points now (as the shot would leave: shot.ts buildShot)
    let muzzle = w.muzzle, dir = w.dir;
    if (w.mount === 'turret' && w.window) {
      const a = w.window.center + (ship.aim[w.part] ?? 0);
      dir = [Math.cos(a), Math.sin(a)];
      muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
    } else if (ship.aim[w.part]) {
      const a = Math.atan2(dir[1], dir[0]) + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
    }
    const cs = this.tuning.cellSize;
    const [x, y] = shipPointToWorld(ship, pose, muzzle, cs);
    const ang = pose.angle + Math.PI / 2 + Math.atan2(dir[1], dir[0]);
    const look = LOOKS[ship.blueprint.parts[w.part]?.fn ?? ''] ?? 'dot';
    const pulse = 0.75 + 0.25 * Math.sin(this.t * (10 + 24 * k));
    if (look === 'sight') {
      const def = partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w);
      const reach = Math.min(1800, def.range ?? (def.speed && def.life ? def.speed * def.life : 900));
      const x1 = x + Math.cos(ang) * reach, y1 = y + Math.sin(ang) * reach;
      this.glow.moveTo(x, y).lineTo(x1, y1).stroke({ color: 0xef4444, width: 1 + 2.5 * k, alpha: (0.1 + 0.55 * k) * pulse });
      this.glow.moveTo(x, y).lineTo(x1, y1).stroke({ color: 0xfecaca, width: 0.8, alpha: 0.15 + 0.5 * k });
      this.softDot(x, y, 5 + 10 * k, 0xff5a4a, 0.3 + 0.6 * k);
    } else if (look === 'blackout') {
      const r = (w.window ? cs * 0.9 : cs) * (0.4 + 1.1 * k);
      // The emitter goes dark: a black disc swelling over it, its rim crackling blue
      this.dark.circle(x, y, r).fill({ color: 0x02040a, alpha: 0.25 + 0.6 * k });
      this.glow.circle(x, y, r * 1.1).stroke({ color: 0x3b5bdb, width: 1 + 1.5 * k, alpha: (0.25 + 0.5 * k) * pulse });
      const n = 5;
      for (let i = 0; i < n; i++) {
        const a = this.t * 6 + (i * Math.PI * 2) / n, j = 1 + 0.35 * Math.sin(this.t * 31 + i * 2.1);
        this.glow.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r).lineTo(x + Math.cos(a) * r * (1 + 0.5 * j * k), y + Math.sin(a) * r * (1 + 0.5 * j * k))
          .stroke({ color: 0x93c5fd, width: 1, alpha: 0.6 * k });
      }
    } else {
      this.softDot(x, y, 4 + 8 * k, 0xbfdbfe, 0.25 + 0.6 * k);
    }
  }

  /** A soft glow dot: concentric discs, fainter outward */
  private softDot(x: number, y: number, r: number, color: number, alpha: number): void {
    for (let i = 3; i >= 1; i--) this.glow.circle(x, y, (r * i) / 3).fill({ color, alpha: (alpha * 0.45) / (i === 1 ? 1 : i * 0.9) });
  }

  dispose(): void {
    this.root.destroy({ children: true });
    this.glowRoot.destroy({ children: true });
  }
}
