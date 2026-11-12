/**
 * @contract client.damage.ambient
 * owns:       effects that go on over time: burning parts, wrecked boss pieces smoking, a boss's charging glow, embers off
 *             crumbling debris and glints over ships being repaired (a spreading fire, a Burn modifier's, is
 *             damage/fires.ts's: here it is only handed on)
 * needs:      DamageCtx (particles, ships, sound, clock), common isRuined
 * invariants: a burn ends when its time is up or its part is gone — client/src/ships/damage/shieldsAmbient.test.ts
 * extend:     a new lingering effect is one member below, called from DamageFx.update
 */

import { EntityType, isRuined } from '@space-game/common';
import type { DamageCtx } from './context';
import { PartFires } from './fires';

export class AmbientFx {
  /** Burning parts (incendiary hits): flames until `until` (seconds on this clock) */
  private burns: { body: number; part: number; until: number }[] = [];
  /** Bosses charging a nova: a gathering glow until it fires */
  private charges: { body: number; kind: string; start: number; until: number }[] = [];
  private emberClock = 0;
  /** Spreading fires (a Burn modifier's: an ignite with `gen`), drawn their own way */
  readonly spread: PartFires;

  constructor(private readonly c: DamageCtx) { this.spread = new PartFires(c); }

  onIgnite(bodyId: number, part: number, ticks: number, gen?: number): void {
    if (gen) { this.spread.onIgnite(bodyId, part, ticks, gen); return; }
    const until = this.c.time + ticks / 60;
    const cur = this.burns.find((b) => b.body === bodyId && b.part === part);
    if (cur) cur.until = Math.max(cur.until, until);
    else this.burns.push({ body: bodyId, part, until });
    const p = this.c.partWorld(bodyId, part);
    if (p) {
      this.c.p.glow(p.x, p.y, p.vx, p.vy, 40, 14, 0xffb347, 0.9);
      this.c.p.burstSparks(p.x, p.y, p.vx, p.vy, 14, 2.5, 7, 0xff7a2a);
    }
  }

  onBossCharge(bodyId: number, kind: string, ticks: number): void {
    this.charges.push({ body: bodyId, kind, start: this.c.time, until: this.c.time + ticks / 60 });
    const e = this.c.state.entities.get(bodyId);
    if (e) this.c.sound('jump_charge', { x: e.renderX, y: e.renderY }, 0.8);
  }

  /** Flames licking off burning parts, and smoke and fire pouring off wrecked ones (a boss's ruined pieces) */
  fires(frames: number): void {
    this.wrecks(frames);
    this.spread.emit(frames);
    if (!this.burns.length) return;
    this.burns = this.burns.filter((b) => b.until > this.c.time && this.c.source.get(b.body)?.derived.alive[b.part] !== false);
    for (const b of this.burns) {
      if (Math.random() > 0.55 * frames) continue;
      const p = this.c.partWorld(b.body, b.part);
      if (!p) continue;
      const a = Math.random() * Math.PI * 2;
      this.c.p.push({ kind: 'glow', x: p.x + Math.cos(a) * 6, y: p.y + Math.sin(a) * 6, vx: p.vx + (Math.random() - 0.5) * 0.5, vy: p.vy + (Math.random() - 0.5) * 0.5,
        life: 0, max: 16 + Math.random() * 14, size: 9 + Math.random() * 9, grow: 0.25, color: Math.random() < 0.5 ? 0xff7a1a : 0xffc04a, alpha: 0.8, drag: 0.97, rot: 0, vr: 0 });
      if (Math.random() < 0.25) this.c.p.dustPuff(p.x, p.y, p.vx, p.vy - 0.2, 7, 60, 0x302a26, 0.35, 0.15);
      // Embers lifting off it
      if (Math.random() < 0.3) this.c.p.push({ kind: 'spark', x: p.x + Math.cos(a) * 4, y: p.y + Math.sin(a) * 4, vx: p.vx + (Math.random() - 0.5) * 0.8, vy: p.vy - 0.5 - Math.random() * 0.7,
        life: 0, max: 26 + Math.random() * 20, size: 1.3, grow: 0, color: 0xffa04a, alpha: 1, drag: 0.97, rot: 0, vr: 0 });
    }
  }

  /** The spreading fires' glows and chars, where their parts are this frame (the pools open) */
  drawFires(): void { this.spread.draw(); }

  wrecks(frames: number): void {
    const catalog = this.c.source.catalog;
    for (const [id, ship] of this.c.source.bodies) {
      if (!ship.blueprint.rigid) continue;
      ship.hp.forEach((_, i) => {
        if (!ship.derived.alive[i] || !isRuined(catalog, ship, i) || Math.random() > 0.12 * frames) return;
        const p = this.c.partWorld(id, i);
        if (!p) return;
        const a = Math.random() * Math.PI * 2, r = Math.random() * 18;
        if (Math.random() < 0.6) this.c.p.dustPuff(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, p.vx, p.vy - 0.3, 14, 110, 0x221c19, 0.55, 0.2);
        else this.c.p.push({ kind: 'glow', x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: p.vx + (Math.random() - 0.5) * 0.6, vy: p.vy + (Math.random() - 0.5) * 0.6,
          life: 0, max: 14 + Math.random() * 12, size: 10 + Math.random() * 10, grow: 0.3, color: Math.random() < 0.5 ? 0xff6a1a : 0xffb04a, alpha: 0.85, drag: 0.97, rot: 0, vr: 0 });
      });
    }
  }

  /** A boss gathering power: a tightening ring and a growing core glow */
  drawCharges(): void {
    if (!this.charges.length) return;
    this.charges = this.charges.filter((c) => c.until > this.c.time);
    for (const c of this.charges) {
      const e = this.c.state.entities.get(c.body);
      const ship = this.c.source.get(c.body);
      if (!e || !ship) continue;
      const k = Math.min(1, (this.c.time - c.start) / Math.max(0.01, c.until - c.start));
      const r = ship.derived.radius + 40;
      const color = c.kind === 'emp' ? 0x7dd3fc : c.kind === 'singularity' ? 0xc084fc : c.kind === 'prism_shard' ? 0xf0abfc : 0xffa04a;
      this.c.p.rings.ring(e.renderX, e.renderY, r * (2.2 - 1.2 * k), 2 + 6 * k, color, 0.25 + 0.6 * k);
      this.c.p.rings.disc(e.renderX, e.renderY, r * (0.4 + 0.5 * k), color, 0.06 + 0.16 * k);
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2, d = r * (1.6 - k * 0.6);
        this.c.p.push({ kind: 'spark', x: e.renderX + Math.cos(a) * d, y: e.renderY + Math.sin(a) * d, vx: -Math.cos(a) * 5 + e.vx, vy: -Math.sin(a) * 5 + e.vy,
          life: 0, max: 14, size: 1.5, grow: 0, color, alpha: 0.9, drag: 0.95, rot: 0, vr: 0 });
      }
    }
  }

  /**
   * Things that just go on: embers and smoke trailing off crumbling debris, and
   * cyan glints over ships being repaired at a station.
   */
  ambient(dt: number): void {
    this.emberClock += dt;
    if (this.emberClock < 0.08) return;
    this.emberClock = 0;
    const stations = [...this.c.state.entities.ofType(EntityType.Station)];
    for (const [id, ship] of this.c.source.bodies) {
      const e = this.c.state.entities.get(id);
      if (!e) continue;
      const alive = ship.derived.alive.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
      if (!alive.length) continue;
      if (ship.kind === 'debris') {
        if (Math.random() > 0.5) continue;
        const p = this.c.partWorld(id, alive[Math.floor(Math.random() * alive.length)]);
        if (!p) continue;
        if (Math.random() < 0.6) this.c.p.spark(p.x, p.y, p.vx + (Math.random() - 0.5) * 0.6, p.vy + (Math.random() - 0.5) * 0.6, 30 + Math.random() * 40, 0xff8a3a);
        else this.c.p.dustPuff(p.x, p.y, p.vx + (Math.random() - 0.5) * 0.3, p.vy + (Math.random() - 0.5) * 0.3, 6 + Math.random() * 6, 70, 0x5a5550, 0.25, 0.12);
        continue;
      }
      // Being repaired: near a station and something to fix
      const damaged = alive.filter((i) => ship.hp[i] < ship.maxHp[i] - 1e-6);
      const missing = ship.derived.alive.length - alive.length;
      if (!damaged.length && !missing) continue;
      const nearStation = stations.some((s) => Math.hypot(s.renderX - e.renderX, s.renderY - e.renderY) < (s.data?.[8] ?? 200) + this.c.repairRange);
      if (!nearStation) continue;
      const pool = damaged.length ? damaged : alive;
      const p = this.c.partWorld(id, pool[Math.floor(Math.random() * pool.length)]);
      if (!p) continue;
      const a = Math.random() * Math.PI * 2;
      this.c.p.push({ kind: 'spark', x: p.x + Math.cos(a) * 8, y: p.y + Math.sin(a) * 8, vx: p.vx, vy: p.vy - 0.15, life: 0, max: 30, size: 1.2, grow: 0, color: 0x8ff6ff, alpha: 0.7, drag: 1, rot: 0, vr: 0 });
    }
  }
}
