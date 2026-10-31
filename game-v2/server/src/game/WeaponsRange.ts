/**
 * The weapons range (DEV ONLY): a private system (data/dev/range.json, merged by data/devData.ts) with a firing line and
 * a spread of real enemy ships standing at set distances to shoot at. They are held where they are, do not aim or fire
 * (Enemies.spawnTarget: pinned, no AI, server authoritative), take damage as any ship does, pay nothing and drop
 * nothing when they die, and come back whole a few seconds later at the same spot. A "moving targets" switch sets them
 * sweeping slowly side to side across their spot instead.
 *
 * It also keeps the readout the panel shows: for each dummy the damage taken in the last 5 s, its rate, and the time
 * from the first hit to the kill. GameServer builds this only on a dev server (devTeleport, never NODE_ENV=production).
 */

import { InSystem, Position, type ServerRangeStateMessage, type RangeDummyState } from '@space-game/common';
import type { Enemies } from './Enemies.js';
import type { ShipBridge } from '../ships/ShipBridge.js';

export interface RangeDummySpec {
  id: string;
  /** Row label (default: the ship design's name) */
  label?: string;
  /** Enemy design (data/ships/blueprints/enemy), its faction, Mk grade and extra armour plating, as the game builds it */
  ship: string;
  faction: string;
  grade?: number;
  plating?: number;
  elite?: boolean;
  /** Hull strength × this, core hardness × this (a boss's, bosses.json) */
  hp?: number;
  core?: number;
  /** Units from the firing line, and degrees off north (clockwise) */
  distance: number;
  bearing: number;
}

export interface RangeConfig {
  system: string;
  /** The firing line: where the pilot arrives */
  origin: { x: number; y: number };
  respawnSeconds: number;
  /** Moving targets sweep this far either side of their spot */
  sweep: number;
  dummies: RangeDummySpec[];
}

/** The seconds the damage readout looks back over */
const WINDOW_SECONDS = 5;
/** A fight is over (the next hit starts a new one) after this long without damage */
const FIGHT_GAP_SECONDS = 8;
/** Readout every this many ticks */
const READOUT_TICKS = 15;
const TPS = 60;

interface Slot {
  spec: RangeDummySpec;
  x: number;
  y: number;
  angle: number;
  /** Lateral unit vector (for the sweep) */
  lx: number;
  ly: number;
  eid: number;
  name: string;
  /** Tick it died (-1 alive) */
  deadAt: number;
  hits: { t: number; n: number }[];
  /** Tick of the fight's first hit (-1: none), its last hit, and the damage since the first */
  first: number;
  last: number;
  total: number;
  ttk: number | null;
  /** Sweeping towards this side (1 or -1) */
  side: number;
}

export interface RangeHost {
  tick(): number;
  /** The range system's number (-1: not in this game's data) */
  systemNum(): number;
  /** Pilots in a system */
  players(num: number): number[];
  /** What the readout says about this pilot's own guns and ammunition */
  pilot(player: number): Pick<ServerRangeStateMessage, 'ideal' | 'guns'>;
  send(player: number, msg: ServerRangeStateMessage): void;
}

export class WeaponsRange {
  private slots: Slot[];
  private byEid = new Map<number, Slot>();
  moving = false;
  private num = -1;

  constructor(readonly cfg: RangeConfig, private enemies: Enemies, private ships: ShipBridge, private host: RangeHost) {
    this.slots = cfg.dummies.map((spec) => {
      const b = (spec.bearing * Math.PI) / 180;
      const x = cfg.origin.x + Math.sin(b) * spec.distance, y = cfg.origin.y - Math.cos(b) * spec.distance;
      return {
        spec, x, y, angle: Math.atan2(cfg.origin.y - y, cfg.origin.x - x), lx: Math.cos(b), ly: Math.sin(b), eid: -1,
        name: spec.label ?? this.enemies.displayName(spec.ship), deadAt: -1, hits: [], first: -1, last: -1, total: 0, ttk: null, side: 1,
      };
    });
  }

  /** Is this entity one of the range's dummies */
  isDummy(eid: number): boolean {
    return this.byEid.has(eid);
  }

  /** Every tick: keep the dummies stocked while a pilot is in the system, notice deaths, bring them back, send the readout */
  tick(): void {
    const now = this.host.tick();
    if (this.num < 0) this.num = this.host.systemNum();
    if (this.num < 0) return;
    const players = this.host.players(this.num);
    if (!players.length) {
      // Nobody here: put them all away (nothing is remembered about them)
      if (this.byEid.size) this.clear();
      return;
    }
    for (const s of this.slots) {
      if (s.eid >= 0 && !this.ships.has(s.eid)) this.died(s, now);
      if (s.eid < 0 && (s.deadAt < 0 || now - s.deadAt >= this.cfg.respawnSeconds * TPS)) this.spawn(s);
      else if (s.eid >= 0 && this.moving) this.sweep(s);
    }
    if (now % READOUT_TICKS === 0) {
      const dummies = this.readout(now);
      for (const p of players) this.host.send(p, { type: 'rangeState', moving: this.moving, dummies, ...this.host.pilot(p) });
    }
  }

  /** Damage dealt to a ship (GameServer's notifyDamage): counted if it is one of ours */
  onDamage(target: number, amount: number): void {
    const s = this.byEid.get(target);
    if (!s || !(amount > 0)) return;
    const now = this.host.tick();
    if (s.first < 0 || now - s.last > FIGHT_GAP_SECONDS * TPS) { s.first = now; s.total = 0; s.ttk = null; }
    s.last = now;
    s.total += amount;
    s.hits.push({ t: now, n: amount });
  }

  /** Every dummy back whole at its spot, readouts cleared */
  reset(): void {
    this.clear();
    for (const s of this.slots) { s.deadAt = -1; s.hits.length = 0; s.first = s.last = -1; s.total = 0; s.ttk = null; }
  }

  setMoving(on: boolean): void {
    if (on === this.moving) return;
    this.moving = on;
    // (Switching either way puts them back on their spots, so a sweep never leaves one stranded)
    this.reset();
  }

  private clear(): void {
    for (const s of this.slots) {
      if (s.eid >= 0 && this.ships.has(s.eid)) this.ships.removeShip(s.eid);
      s.eid = -1;
      s.deadAt = -1;
    }
    this.byEid.clear();
  }

  private spawn(s: Slot): void {
    if (this.num < 0) return;
    const sp = s.spec;
    const eid = this.enemies.spawnTarget(this.num, { ship: sp.ship, faction: sp.faction, grade: sp.grade, plating: sp.plating, elite: sp.elite, hp: sp.hp, core: sp.core }, s.x, s.y, s.angle);
    if (eid < 0) return;
    s.eid = eid;
    s.deadAt = -1;
    s.hits.length = 0;
    s.first = s.last = -1;
    s.total = 0;
    this.byEid.set(eid, s);
    if (this.moving) this.enemies.setTargetMoving(eid, { x: s.x + s.lx * this.cfg.sweep * s.side, y: s.y + s.ly * this.cfg.sweep * s.side });
  }

  private died(s: Slot, now: number): void {
    this.byEid.delete(s.eid);
    s.eid = -1;
    s.deadAt = now;
    s.ttk = s.first >= 0 ? (now - s.first) / TPS : null;
    s.first = -1;
  }

  /** A sweeping dummy that has reached one end turns for the other */
  private sweep(s: Slot): void {
    const eid = s.eid;
    const along = (Position.x[eid] - s.x) * s.lx + (Position.y[eid] - s.y) * s.ly;
    if (Math.abs(along - s.side * this.cfg.sweep) > this.cfg.sweep * 0.3) return;
    s.side = -s.side;
    this.enemies.setTargetMoving(eid, { x: s.x + s.lx * this.cfg.sweep * s.side, y: s.y + s.ly * this.cfg.sweep * s.side });
  }

  private readout(now: number): RangeDummyState[] {
    const horizon = now - WINDOW_SECONDS * TPS;
    return this.slots.map((s) => {
      while (s.hits.length && s.hits[0].t < horizon) s.hits.shift();
      const dmg5 = s.hits.reduce((a, h) => a + h.n, 0);
      const alive = s.eid >= 0;
      // The fight's length: so far while it lasts, else it ended at the kill (ttk)
      const fight = alive && s.first >= 0 && now - s.last <= FIGHT_GAP_SECONDS * TPS ? (s.last - s.first) / TPS : 0;
      const span = s.first >= 0 ? Math.max(1, Math.min(WINDOW_SECONDS * TPS, now - s.first)) / TPS : 1;
      return {
        id: s.spec.id, name: s.name, dist: s.spec.distance, dead: !alive,
        hull: alive ? Math.round(this.ships.coreFraction(s.eid) * 100) / 100 : 0,
        shield: alive ? Math.round(this.ships.shieldFraction(s.eid) * 100) / 100 : 0,
        dmg5: Math.round(dmg5), dps: Math.round(dmg5 / span), fight: Math.round(fight * 10) / 10, ttk: s.ttk === null ? null : Math.round(s.ttk * 10) / 10,
        total: Math.round(s.total),
      };
    });
  }

  /** Test hook: the dummies' entity ids (-1: down) */
  eids(): number[] {
    return this.slots.map((s) => s.eid);
  }

  /** Test hook */
  inRangeSystem(eid: number): boolean {
    return InSystem.systemId[eid] === this.num;
  }
}
