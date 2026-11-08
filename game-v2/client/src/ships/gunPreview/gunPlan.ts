/**
 * What a gun does when fired, as plain numbers for the hangar's live preview (no Pixi, no DOM): its round (speed, size,
 * life, spread, blast), its volley (burst fan, salvo), whether it is a held or pulsed beam, and its trigger beat as a
 * `FireClock` that says on which ticks it fires (cycle, clip with its reload or regrow, charge and cooldown, spin-up).
 * Everything is read from the same data the game fires from (tuning gunDef, the model's `fire` spec), so the preview
 * runs at the gun's real rate.
 */

import { endsAtAim, gunDef, partGrade, WEAPON_KIND_TYPE, type Catalog, type FireSpec, type FunctionDef, type ShipTuning, type WeaponTuning } from '@space-game/common';

export interface GunPlan {
  fnId: string;
  /** The model id the renderer styles the round by (PlacedPart.fn) */
  model: string;
  /** Tuning weapon kind and its wire weapon type */
  kind: string;
  type: number;
  beam: boolean;
  /** A pulse laser: a pulse every `fire.interval`, `ticks` long, brightest `peakAt` (0..1) through it */
  pulse: { ticks: number; peakAt: number } | null;
  /** Rounds: world units a tick */
  speed: number;
  accel: number;
  maxSpeed: number;
  life: number;
  size: number;
  /** Degrees either side of the aim */
  spread: number;
  damage: number;
  /** Burst blast radius (world units), 0 for none */
  splash: number;
  /** Reach in world units */
  range: number;
  /** Steers or speeds up in flight: drawn as a tracked shell */
  tracked: boolean;
  /** Lobbed to burst where it was aimed */
  lob: boolean;
  /** Rounds a pull of the trigger: a fanned burst, and a rippling salvo */
  burst: number;
  salvo: { count: number; gap: number } | null;
  /** Beams: the tuning colour name and width */
  color?: string;
  width: number;
  fire: FireSpec;
}

/** The plan for a gun model, or null when it has nothing to show (a Repair Beam, Point Defence, a part with no weapon) */
export function gunPlan(catalog: Catalog, tuning: ShipTuning, fn: FunctionDef): GunPlan | null {
  if (!fn.weapon || !fn.fire) return null;
  const base = tuning.weapons?.[fn.weapon];
  if (!base || base.heal || base.pointDefence || fn.fire.model === 'auto') return null;
  const mat = fn.model && fn.material ? fn.material : 'alloy';
  const grade = partGrade(catalog, { fn: fn.id, material: mat });
  const def: WeaponTuning = gunDef(tuning, fn.weapon, { grade, size: 1, model: fn.weaponMods });
  const beam = def.type === 'beam';
  const accel = def.accel ?? 0;
  const maxSpeed = def.maxSpeed ?? def.speed ?? 0;
  return {
    fnId: fn.id, model: fn.id, kind: fn.weapon, type: WEAPON_KIND_TYPE[fn.weapon] ?? 1, beam,
    pulse: def.pulse ? { ticks: def.pulse.ticks, peakAt: def.pulse.peakAt } : null,
    speed: def.speed ?? 0, accel, maxSpeed, life: def.life ?? 0, size: def.size ?? 1, spread: def.spread ?? 0, damage: def.damage ?? 0,
    splash: def.splash?.radius ?? 0,
    range: beam ? def.range ?? 0 : maxSpeed * (def.life ?? 0),
    tracked: !beam && ((def.homing ?? 0) > 0 || accel > 0),
    lob: !beam && endsAtAim(def),
    burst: Math.max(1, def.burst ?? 1),
    salvo: def.salvo ? { count: def.salvo.count, gap: def.salvo.gap } : null,
    color: def.color, width: def.width ?? 14,
    fire: fn.fire,
  };
}

/** The tick a round at constant `speed` takes to cover `dist`, or one that speeds up from `v0` by `accel` to `vmax` (whole ticks, at least 1) */
export function flightTicks(dist: number, v0: number, accel: number, vmax: number): number {
  if (dist <= 0) return 1;
  let d = 0, v = Math.max(0.1, v0), t = 0;
  while (d < dist && t < 6000) {
    d += v;
    v = Math.min(vmax > 0 ? vmax : v + accel, v + accel);
    t++;
  }
  return Math.max(1, t);
}

/** The first `t` (0..1) along (x0, y0) -> (x1, y1) where it meets the circle at (cx, cy) of radius r, or null */
export function segmentCircle(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number): number | null {
  const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/**
 * The trigger held down, tick by tick: `step()` returns true on the ticks the gun fires. A cycle fires every
 * `interval` (a spinning gun's beat easing from `from` to `to` over `up` ticks); a clip fires its rounds at `interval`
 * then reloads for `reload` (a regrowing clip fires its stock then one round every `regrow` ticks); a charge gun
 * charges `charge` ticks, fires, and cools for `cooldown`. A held beam is `lit()` for `HOLD` ticks then off for `REST`.
 */
export class FireClock {
  private wait = 0;
  private shots = 0;
  private spun = 0;
  private t = 0;

  constructor(private f: FireSpec, private beam = false) {
    this.reset();
  }

  reset(): void {
    this.shots = 0; this.spun = 0; this.t = 0;
    this.wait = this.f.model === 'charge' ? Math.max(0, (this.f.charge ?? this.f.interval) - 1) : 0;
  }

  /** Beams: lit for this many ticks, then dark for REST, repeating */
  static readonly HOLD = 150;
  static readonly REST = 50;

  lit(): boolean {
    return this.t % (FireClock.HOLD + FireClock.REST) < FireClock.HOLD;
  }

  /** Advance a tick: did the gun fire on it? (A beam never "fires"; it is `lit()`) */
  step(): boolean {
    this.t++;
    if (this.beam) return false;
    if (this.wait > 0) { this.wait--; return false; }
    const f = this.f;
    switch (f.model) {
      case 'clip': {
        const per = f.rounds ?? 1, clip = Math.max(1, Math.floor((f.clip ?? 1) / per));
        this.shots++;
        if (this.shots >= clip) {
          this.shots = 0;
          this.wait = Math.max(0, (f.regrow ? Math.max(f.interval, f.regrow * per) : (f.reload ?? 0) + f.interval) - 1);
        } else this.wait = Math.max(0, f.interval - 1);
        return true;
      }
      case 'charge':
        this.wait = Math.max(0, (f.cooldown ?? 0) + (f.charge ?? f.interval) - 1);
        return true;
      default: {
        const s = f.spin;
        if (s) {
          this.spun++;
          const k = Math.min(1, this.spun / Math.max(1, s.up));
          this.wait = Math.max(0, Math.round(s.from + (s.to - s.from) * k) - 1);
        } else this.wait = Math.max(0, f.interval - 1);
        return true;
      }
    }
  }
}
