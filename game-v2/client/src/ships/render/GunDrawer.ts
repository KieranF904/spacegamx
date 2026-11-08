/**
 * @contract client.ship.render.gunDrawer
 * owns:       turret heads and fixed barrels each frame: aim easing, recoil, heat, tint under light and damage, cracks and state-driven decor
 * needs:      GunDrawHost (catalog, geometry, renderer zoom/ventPuff, playerId, light level), gunDecor turretHead, gunAnim, turretEase
 * invariants: a gun too small on screen is neither drawn nor turned — none pinned
 * extend:     a new per-gun visual state is one more branch in animate()
 */

import { Container, Graphics } from 'pixi.js';
import { isOpen, type Catalog, type ShipState, type WeaponInfo } from '@space-game/common';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipSource } from '../ShipStore';
import { turretHead } from '../gunDecor';
import { animOf, lightsLit, reloadShare } from '../gunAnim';
import { easeTurret, fireCatch } from '../turretEase';
import { mix } from '../shipColors';
import { gunGraphics, gunLook, showCracks, hurt, shade, clearTurrets } from './gunLooks';
import { GUN_MIN_PX, GUN_TINT, GUN_BLOCKED, RECOIL, RECOIL_RETURN, COOL } from './constants';
import type { BodyView, Turret, Barrel } from './viewTypes';

export interface GunDrawHost {
  readonly catalog: Catalog;
  readonly renderer: Pick<Renderer, 'getZoom' | 'ventPuff'>;
  /** The light level the guns are tinted by (filled per ship by ShipRenderer) */
  readonly lvl: [number, number, number];
  playerId(): number;
  geometry(ship: ShipState): ReturnType<ShipSource['geometry']>;
}

export class GunDrawer {
  constructor(private readonly h: GunDrawHost) {}

  private weaponOfPart(ship: ShipState, part: number): WeaponInfo | undefined {
    for (let i = 0; i < ship.derived.weapons.length; i++) if (ship.derived.weapons[i].part === part) return ship.derived.weapons[i];
    return undefined;
  }

  /**
   * One gun's state-driven decor (gunAnim.ts): the reload glow (returned: 0..1 of the way to its red), vents and
   * ejects off the housing, a spinning cluster, rail lights. `dx, dy` is the barrel's direction in the container `c`
   * (a turret's turns with it: 1, 0), `len` its length. Your own guns read the ship's gun state; other ships' guns
   * keep the resting look (a spin follows how hard they are being fired).
   */
  private animate(view: BodyView, ship: ShipState, gun: Turret | Barrel, w: WeaponInfo | undefined, c: Container, x0: number, y0: number,
    dx: number, dy: number, len: number, frames: number): number {
    const a = gun.anim!, p = gun.part, mine = view.id === this.h.playerId();
    const reload = w?.fire.reload ?? 0, left = mine ? ship.reload[p] ?? 0 : 0;
    const share = reloadShare(left, reload);
    if (left > 0) {
      // The housing in the world (a turret's barrel turns with it)
      const ang = 'barrel' in gun ? gun.barrel.rotation : gun.g.rotation, ca = Math.cos(ang), sa = Math.sin(ang);
      const cr = view.container.rotation, cc = Math.cos(cr), cs = Math.sin(cr);
      const bx = (dx * ca - dy * sa), by = (dx * sa + dy * ca);
      const lx = x0 + bx * len * 0.5, ly = y0 + by * len * 0.5;
      const fa = cr + Math.atan2(by, bx);
      gun.ventT = (gun.ventT ?? 0) + frames;
      if (a.vent && gun.ventT >= a.vent.every) {
        gun.ventT = 0;
        this.h.renderer.ventPuff(view.container.x + lx * cc - ly * cs, view.container.y + lx * cs + ly * cc, fa, a.vent.kind, a.vent.color);
      }
      if (!gun.reloading && a.eject !== undefined) {
        // The spent clip falls out sideways
        const ex = view.container.x + x0 * cc - y0 * cs, ey = view.container.y + x0 * cs + y0 * cc;
        this.h.renderer.ventPuff(ex, ey, fa + Math.PI / 2, 'spark', a.eject);
        this.h.renderer.ventPuff(ex, ey, fa - Math.PI / 2, 'spark', a.eject);
      }
    }
    gun.reloading = left > 0;
    if (a.lights || a.spin) {
      if (!gun.deco) {
        gun.deco = new Graphics();
        gun.deco.blendMode = 'add';
        c.addChild(gun.deco);
      }
      const d = gun.deco;
      // Along the barrel's line (a turret's frame turns with its head: dx, dy = 1, 0; a fixed gun's is the ship's, from its base)
      const px = -dy, py = dx;
      if (a.lights) {
        const n = a.lights.n, lit = lightsLit(n, mine ? ship.rounds[p] ?? n : n, left, reload);
        // (redrawn only when what it shows changes: sixths of a light)
        const key = Math.round(lit * 6) + (left > 0 ? 1000 : 0);
        if (key !== gun.decoKey) {
          gun.decoKey = key;
          d.clear();
          const r = Math.max(1.3, len * 0.028);
          for (let i = 0; i < n; i++) {
            const u = len * (0.3 + 0.55 * (i / (n - 1)));
            const k = Math.max(0, Math.min(1, lit - i));
            d.circle(dx * u, dy * u, r * 1.9).fill({ color: a.lights.color, alpha: 0.12 + 0.2 * k });
            d.circle(dx * u, dy * u, r).fill({ color: k > 0.5 ? 0xe8fbff : a.lights.color, alpha: 0.12 + 0.88 * k });
          }
        }
      }
      if (a.spin) {
        // The cluster turns with the gun's spin; another ship's follows how hard it is fired
        const spin = mine ? ship.spin[p] ?? 0 : Math.min(1, gun.heat * 1.1);
        if (spin > 0.02 || gun.decoKey) {
          gun.phase = ((gun.phase ?? 0) + frames * (0.15 + 1.1 * spin)) % (Math.PI * 2);
          gun.decoKey = spin > 0.02 ? 1 : 0;
          d.clear();
          if (spin > 0.02) {
            const R = Math.max(2, len * 0.06);
            for (let i = 0; i < 3; i++) {
              const v = R * Math.sin(gun.phase + (i * Math.PI * 2) / 3), ox = px * v, oy = py * v;
              d.moveTo(dx * len * 0.35 + ox, dy * len * 0.35 + oy).lineTo(dx * len * 0.95 + ox, dy * len * 0.95 + oy);
              d.stroke({ color: 0xffd9a0, width: Math.max(1, len * 0.014), alpha: 0.18 + 0.5 * spin });
            }
          }
        }
      }
    }
    return a.reloadGlow !== undefined ? share * 0.7 : 0;
  }

  /**
   * Turret barrels at their current aim: bright when the shot is open, dim when
   * hull is in the way. Each barrel is drawn once, in white, and only turned
   * and tinted per frame.
   */
  drawTurrets(view: BodyView, ship: ShipState, cs: number, frames: number): void {
    // (too small on screen to see a gun: none drawn, nor turned)
    const near = cs * this.h.renderer.getZoom() >= GUN_MIN_PX;
    view.guns.visible = near;
    view.barrels.visible &&= near;
    // (turrets only change with the structure)
    if (ship !== view.turretShip || ship.rebuilds !== view.turretRebuilds) {
      view.turretShip = ship;
      view.turretRebuilds = ship.rebuilds;
      clearTurrets(view);
      const [cx, cy] = ship.derived.com;
      for (const [wi, w] of ship.derived.weapons.entries()) {
        if (!w.window) continue;
        // The turret's own head (gunDecor.ts): its gunhouse and barrels, by family and model; its mount is the hull's
        const fn = ship.blueprint.parts[w.part].fn;
        // (A bespoke turret may be drawn bigger than its part: its piece's `turret` size, in cells)
        const big = this.h.catalog.pieces.get(ship.blueprint.parts[w.part].piece)?.turret;
        const area = big ? big * big : this.h.geometry(ship)[w.part]?.area ?? 1;
        const len = big ? Math.max(w.window.barrel, big * 1.1) : w.window.barrel;
        // (drawn once for every turret like it, on any ship: its look shared)
        const look = `t|${fn}|${len}|${area}|${cs}`;
        const { c: barrel, metal, lit } = gunGraphics(gunLook(look, () => ({ ...turretHead(fn, len, area), k: cs })));
        const x0 = (w.window.pivot[0] - cx) * cs, y0 = (w.window.pivot[1] - cy) * cs;
        barrel.position.set(x0, y0);
        view.guns.addChild(barrel);
        view.turrets.push({ part: w.part, weapon: wi, barrel, metal, lit, look, x0, y0, len: w.window.barrel * cs, kick: 0, heat: 0, drawn: NaN, tm: -1, tl: -1, anim: animOf(fn) });
      }
    }
    for (const t of near ? view.turrets : []) {
      const w = ship.derived.weapons[t.weapon];
      if (!w?.window) continue;
      const open = ship.kind === 'ship' && isOpen(w.window, ship.aim[t.part]);
      // (drawn easing after the simulated aim, caught up on a shot: turretEase.ts)
      const full = w.window.half >= Math.PI - 1e-9, aim = ship.aim[t.part] ?? 0;
      if (t.fired) { t.drawn = fireCatch(t.drawn, aim, full); t.fired = false; }
      t.drawn = easeTurret(t.drawn, aim, frames, full);
      const r = w.window.center + t.drawn;
      t.barrel.rotation = r;
      // Recoil: straight back on firing, easing home
      const back = t.kick > 0 ? RECOIL * t.len * t.kick * t.kick : 0;
      t.barrel.position.set(t.x0 - Math.cos(r) * back, t.y0 - Math.sin(r) * back);
      // Lit like the hull, darker while its shot is blocked; a hot barrel glows towards amber-white whatever the light
      const tf = ship.hp[t.part] / (ship.maxHp[t.part] || 1);
      const hot = Math.min(1, t.heat * 0.85 + t.kick * 0.3);
      // (set only when it changes: a tint set marks the Graphics for re-batching)
      // (a gun reloading glows red; gunAnim.ts)
      const rg = t.anim ? this.animate(view, ship, t, w, t.barrel, t.x0, t.y0, 1, 0, t.len, frames) : 0;
      let tm = mix(hurt(shade(open ? GUN_TINT : GUN_BLOCKED, this.h.lvl), tf), 0xffd9a0, hot);
      if (rg > 0) tm = mix(tm, t.anim!.reloadGlow!, rg);
      if (tm !== t.tm) t.metal.tint = t.tm = tm;
      if (t.lit) { let tl = mix(hurt(open ? 0xffffff : 0x9a9a9a, tf), 0xffd9a0, hot); if (rg > 0) tl = mix(tl, t.anim!.reloadGlow!, rg); if (tl !== t.tl) t.lit.tint = t.tl = tl; }
      showCracks(t, t.barrel, tf);
      t.kick = Math.max(0, t.kick - frames * RECOIL_RETURN);
      t.heat = Math.max(0, t.heat - frames * COOL);
    }
    for (const b of view.fixed) {
      // Turned on its gimbal as far as it aims (common/src/ships/turret.ts stepFixedGunAim: your own as predicted, another
      // pilot's from their cursor, a pilotless ship's from its last shot: ShipClient.stepTurretVisuals / preSnapshot)
      const rot = b.debris ? 0 : ship.aim[b.part] ?? 0;
      if (rot !== b.rot) {
        b.rot = rot;
        const c = Math.cos(rot), s = Math.sin(rot);
        b.rx = b.nx * c - b.ny * s; b.ry = b.nx * s + b.ny * c;
        b.g.rotation = rot;
        if (b.kick <= 0 && b.heat <= 0) b.g.position.set(b.x0, b.y0);
      }
      const bf = ship.hp[b.part] / (ship.maxHp[b.part] || 1);
      const hot = Math.min(1, b.heat * 0.85 + b.kick * 0.3);
      const rg = b.anim ? this.animate(view, ship, b, this.weaponOfPart(ship, b.part), b.g, b.x0, b.y0, b.nx, b.ny, b.len, frames) : 0;
      let tm = b.debris ? shade(0x555555, this.h.lvl) : mix(hurt(shade(GUN_TINT, this.h.lvl), bf), 0xffd9a0, hot);
      if (rg > 0) tm = mix(tm, b.anim!.reloadGlow!, rg);
      if (tm !== b.tm) b.metal.tint = b.tm = tm;
      if (b.lit) { let tl = b.debris ? 0x333333 : mix(hurt(0xffffff, bf), 0xffd9a0, hot); if (rg > 0) tl = mix(tl, b.anim!.reloadGlow!, rg); if (tl !== b.tl) b.lit.tint = b.tl = tl; }
      showCracks(b, b.g, bf);
      if (b.kick <= 0 && b.heat <= 0) continue;
      // Fixed guns slide back into the hull, and glow hot
      const back = RECOIL * 1.4 * b.len * b.kick * b.kick;
      b.g.position.set(b.x0 - b.rx * back, b.y0 - b.ry * back);
      b.kick = Math.max(0, b.kick - frames * RECOIL_RETURN);
      b.heat = Math.max(0, b.heat - frames * COOL);
      // Home and cool: settle exactly
      if (b.kick <= 0 && b.heat <= 0) b.g.position.set(b.x0, b.y0);
    }
  }
}
