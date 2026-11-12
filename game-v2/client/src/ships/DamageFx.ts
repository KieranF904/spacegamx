/**
 * @contract client.damage-fx
 * owns:       the facade the ship client drives damage, collision, shield and repair effects through, and the frame order
 *             they update in; each kind of effect lives in damage/
 * needs:      damage/{particles, context, partEffects, detonations, events, shields, ambient}, ShipSource, GameState; npm: @space-game/common, pixi.js
 * invariants: a frame runs delayed actions, ambient effects, anchors, then draws particles, shields, ripples, charges — client/src/ships/DamageFx.test.ts
 * extend:     a new announced effect is a function in damage/events.ts (or a kind in damage/detonations.ts) and one forwarding method here
 */

/**
 * Damage, collision and repair effects for modular ships.
 *
 * Driven by the server's partDestroyed and contact messages, plus what the
 * client can see for itself (parts reappearing after a station repair,
 * debris crumbling, ships healing near a station). Each kind of part goes its
 * own way:
 *   core       a fireball, shockwave, flying chunks and lingering smoke
 *   generator  an electric burst with arcs crackling outwards
 *   thruster   a fiery burst
 *   weapon     its ammunition cooking off in a quick run of pops
 *   armor      heavy plates breaking off, little fire
 *   hull       fragments and sparks
 *   conduit    shorting sparks and a few arcs
 *   crumble    (a loose part decaying) a puff of dust and grit
 *
 * Particles live in world units and move per tick, like everything else.
 * The many small ones (sparks, glows, smoke) and the shield bubbles are pooled
 * sprites of painted textures; rings and beams are particles too (rings worked
 * out per pixel, see rendering/particlePool.ts), chunks are one shared shape
 * placed, and a hot chunk's edge is its outline stroked once. Only electric
 * arcs are drawn as lines a frame, which cost nothing while there are none.
 */

import type { ServerContactMessage, ServerPartDestroyedMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import type { Lighting } from '../rendering/lighting/Lighting';
import type { Container } from 'pixi.js';
import { DamageParticles } from './damage/particles';
import { DamageCtx, type Sound } from './damage/context';
import { partDestroyed } from './damage/partEffects';
import { detonate } from './damage/detonations';
import { contact, bossDefeated, intercept, stationFire, partRestored } from './damage/events';
import { ShieldFx } from './damage/shields';
import { AmbientFx } from './damage/ambient';

/**
 * Shells whose plain hit (no detonation: server Weapons.bursts) still has a look of its own here: ShipClient plays it from
 * the projectileHit, by the shell's weapon type (WEAPON_KIND_TYPE)
 */
export const PLAIN_HIT_LOOKS = new Set(['prism_shard']);

export class DamageFx {
  private p: DamageParticles;
  private c: DamageCtx;
  private shields: ShieldFx;
  private amb: AmbientFx;

  /** The additive layer: sparks, fire, flashes, shields (for the bloom) */
  get glowLayer(): Container { return this.p.glowLayer; }

  setQuality(keep: number, cap: number): void {
    this.p.setQuality(keep, cap);
  }

  constructor(layer: Container, source: ShipSource, state: GameState, sound: Sound, repairRange: number) {
    this.p = new DamageParticles(layer);
    this.c = new DamageCtx(this.p, source, state, sound, repairRange);
    this.shields = new ShieldFx(this.c);
    this.amb = new AmbientFx(this.c);
  }

  // Events (the server's messages and what the client sees for itself)

  onPartDestroyed(m: ServerPartDestroyedMessage): void { partDestroyed(this.c, m); }

  /** Hulls grinding together: sparks thrown along the surface, a flash, some grit */
  onContact(m: ServerContactMessage): void { contact(this.c, m); }

  /** A part caught fire (`gen`: a spreading fire's, a Burn modifier's: damage/fires.ts draws it) */
  onIgnite(bodyId: number, part: number, ticks: number, gen?: number): void { this.amb.onIgnite(bodyId, part, ticks, gen); }

  onBossCharge(bodyId: number, kind: string, ticks: number): void { this.amb.onBossCharge(bodyId, kind, ticks); }

  /** A boss dies: a chain of blasts across its hull, then one huge one */
  onBossDefeated(x: number, y: number): void { bossDefeated(this.c, x, y); }

  /** A warhead went off: flak burst, missile explosion, EMP ring and the rest, by kind (damage/detonations.ts) */
  onDetonation(kind: string, x: number, y: number, radius: number, from?: [number, number]): void { detonate(this.c, kind, x, y, radius, from); }

  /** Point defence fired: a hot tracer to the shot, and brought down, the shot pops */
  onIntercept(m: { x: number; y: number; fx: number; fy: number; down: boolean }): void { intercept(this.c, m); }

  /** A station's defence turret fired on a hostile, from `from`: flak's tracers bursting on the target, or the lance's heavy beam */
  onStationFire(from: { x: number; y: number; weapon: string; color: number }, target: number): void { stationFire(this.c, from, target); }

  /** A part came back (station repair): sparkles drawing in, then a soft flash */
  onPartRestored(bodyId: number, part: number): void { partRestored(this.c, bodyId, part); }

  // Shields

  /** A shot struck at (x, y): if that's on a shielded ship, its bubble lights up there */
  shieldHit(x: number, y: number, model?: string): void { this.shields.shieldHit(x, y, model); }

  /** Is a raised shield's bubble at (x, y)? A shell striking there ripples it (shieldHit): heard as shield_hit */
  bubbleAt(x: number, y: number): boolean { return this.shields.bubbleAt(x, y); }

  /** A Flash Screen came back at (x, y): bloom the nearest bubble */
  shieldReform(x: number, y: number): void { this.shields.shieldReform(x, y); }

  // Frame

  /** Fireballs and flashes light what's near them (see rendering/lighting) */
  collectLights(L: Lighting): void {
    for (const p of this.p.ps) {
      if (p.kind !== 'glow' || p.size < 6) continue;
      const fade = 1 - p.life / p.max;
      L.point(p.x, p.y, p.color, 40 + p.size * 3.5, Math.min(2, p.alpha * fade * fade * 1.3));
    }
  }

  update(dt: number): void {
    const c = this.c, p = this.p;
    c.time += dt;
    const frames = Math.min(4, dt * 60);
    c.runPending();
    this.amb.ambient(dt);
    this.amb.fires(frames);
    if (p.anchors.live.length) p.anchors.step(c.state.entities, frames);
    p.begin();
    p.draw(frames);
    this.shields.drawShields(frames);
    this.shields.drawRipples(frames);
    this.amb.drawCharges();
    this.amb.drawFires();
    p.end();
  }
}
