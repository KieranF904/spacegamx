/**
 * Mining laser beams, weapon beams (lances, frostbite), pulse lasers' pulses
 * and stations' laser turrets. Your own mining beam shows as soon as you press
 * the button; other ships' beams come from the snapshot (the "right weapon
 * active" flag). Each beam is cast locally against the asteroids, so it stops
 * on the rock it's cutting, where it throws sparks and a hot glow.
 *
 * Mining lasers and station turrets are drawn as pulse lasers are (PulseFx): a
 * mining laser's pulses in cyan, each fading in, flaring and trailing off to
 * nothing, the next starting the moment it's gone (no cooldown), for as long
 * as it cuts; a station turret's, one pulse a shot.
 */

import { clearIfDrawn } from '../rendering/gfx';
import { Container, Graphics } from 'pixi.js';
import { GAS_TYPES } from '../rendering/AsteroidLook';
import {
  EntityType, ShipTuning, jumpTuning, jumpPhase, getAsteroidPolygon, segmentIntersectT, shipPointToWorld, worldToLocalDir, standing, castParts, unpackCursorWeaponState, partWeaponDef, pulseProfile, MINING_PULSE, MINE_TAIL,
  type ShipState, type WeaponInfo, type PulseTuning, type WeaponTuning, type Composition,
} from '@space-game/common';
import type { GameState } from '../state/GameState';

/**
 * A beam laser's outer glow, body and core by grade (tuning.json weaponGrades):
 * Mk I red, II emerald, III a cooled orange, IV a wide magenta, V white-hot x-ray
 */
const LASER_COLORS: [number, number, number][] = [
  [0xdc2626, 0xff6b6b, 0xffe4e4],
  [0x059669, 0x34d399, 0xf0fdf4],
  [0xea580c, 0xff9a5c, 0xfff1e6],
  [0xdb2777, 0xff7ad9, 0xffe8f8],
  [0xf43f5e, 0xffc2d0, 0xffffff],
];
import type { ShipSource } from './ShipStore';
import { JumpFx } from './JumpFx';
import { canHurt, canHeal } from './sides';
import { beamLook } from '../rendering/weapons/weaponStyles';
import { drawCone, drawStrands, sputterGain } from './beamLookFx';
import { PulseFx, type PulseRun } from './PulseFx';
import { MiningFx } from './MiningFx';
import { rockMaterial } from '../rendering/rocks/RockMaterials';

/** (`heal`: a Repair Beam's sparkle, soft green, drifting: support.ts) */
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; heal?: boolean }

/** A mining laser's pulse (ticks): fades in, flares, trails off to nothing; the next one starts the moment it's gone (no cooldown) */
const MINING_EVERY = 54;
/** A station laser turret's pulse (its shot every 48 ticks: factions.json rules.stationDefence.laser) */
const STATION_PULSE: PulseTuning = { ticks: 48, peakAt: 0.42 };
const STATION_LASER: WeaponTuning = { type: 'beam', range: 3200, width: 22 } as WeaponTuning;

const newRun = (owner: number, part: number, start: number): PulseRun => ({ owner, part, start, sounded: true, flared: false, arrived: false, impact: -1, mx: 0, my: 0 });

export class MiningBeamFx {
  private g = new Graphics();
  /** Round the Graphics: drawn again into the bloom, a layer is a render group, and a Graphics redrawn as one rebuilds the scene's draw list */
  private root = new Container();
  /** The beams (for the bloom) */
  get glowLayer(): Container { return this.root; }
  private sparks: Spark[] = [];
  private t = 0;
  /** Is your own beam on (for the loop sound) */
  localActive = false;

  constructor(layer: Container, private source: ShipSource, private state: GameState, private tuning: ShipTuning,
    private local: () => { firing: boolean; aim: number; dist: number }) {
    this.g.blendMode = 'add';
    this.root.addChild(this.g);
    layer.addChild(this.root);
  }

  /** The frame's step (seconds) */
  private dt = 0;

  update(dt: number): void {
    this.t += dt;
    this.dt = dt;
    const g = this.g;
    clearIfDrawn(g);
    this.weaponBeams(g);
    const mt = this.tuning.miner;
    this.localActive = false;
    if (!mt) return;
    const frames = Math.min(4, dt * 60);
    const prof = pulseProfile(MINING_PULSE), miningSeen = new Set<number>(), miningSounded = new Set<number>();
    this.miningFx.begin(this.t * 60);
    for (const [id, ship] of this.source.bodies) {
      if (ship.kind !== 'ship' || !ship.derived.miners.length) continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      let on = false, aim = 0, dist = mt.range;
      if (id === this.state.playerId) {
        const l = this.local();
        on = l.firing; aim = l.aim; dist = l.dist;
        if (on) this.localActive = true;
      } else if (e.type === EntityType.Player && e.data && e.data.length) {
        const c = unpackCursorWeaponState(e.data[0]);
        on = c.rightActive; aim = c.aimAngle; dist = e.data[2] ?? mt.range;
      }
      // (A pulse already under way finishes when the button's let go: it just isn't followed by another)
      const finishing = !on && ship.derived.miners.some((_, mi) => { const r = this.mining.get(id * 16 + mi); return !!r?.length && this.t * 60 - r[r.length - 1].start < MINING_EVERY; });
      if (!on && !finishing) continue;
      if (id === this.state.playerId && finishing) this.localActive = true;
      const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
      const aimX = pose.x + Math.cos(aim) * Math.max(dist, mt.range);
      const aimY = pose.y + Math.sin(aim) * Math.max(dist, mt.range);
      const gimbal = mt.gimbalDeg * Math.PI / 180;
      for (let mi = 0; mi < ship.derived.miners.length; mi++) {
        const m = ship.derived.miners[mi];
        if (m.satisfaction <= 0.01) continue;
        const [x, y] = shipPointToWorld(ship, pose, m.muzzle, this.tuning.cellSize);
        const facing = pose.angle + Math.PI / 2 + Math.atan2(m.dir[1], m.dir[0]);
        let off = Math.atan2(aimY - y, aimX - x) - facing;
        while (off > Math.PI) off -= 2 * Math.PI;
        while (off < -Math.PI) off += 2 * Math.PI;
        const a = facing + Math.max(-gimbal, Math.min(gimbal, off));
        const reach = mt.range * (1 + MINE_TAIL), x1 = x + Math.cos(a) * reach, y1 = y + Math.sin(a) * reach;
        const t = this.cast(x, y, x1, y1, !!m.gas);
        const hx = x + (x1 - x) * t, hy = y + (y1 - y) * t;
        // Its pulses: a new one every MINING_EVERY ticks (on the beat, unless it's been let go), the last still trailing off
        const key = id * 16 + mi, now = this.t * 60;
        let runs = this.mining.get(key);
        if (!runs) this.mining.set(key, (runs = []));
        const last = runs[runs.length - 1];
        if (!last || now - last.start >= MINING_EVERY) {
          if (!on) continue;
          runs.push(newRun(id, mi, last && now - last.start < MINING_EVERY * 2 ? last.start + MINING_EVERY : now));
          if (!miningSounded.has(id)) { miningSounded.add(id); this.onMiningPulse?.(x, y, id === this.state.playerId); }
        }
        while (runs.length && now - runs[0].start >= prof.ticks) runs.shift();
        miningSeen.add(key);
        // (Its newest pulse sets the beam's brightness; older ones are trailing off under it)
        const rock = t < 0.999 ? rockMaterial(this.rockHit) : null;
        this.miningFx.draw(g, key, prof, now - runs[runs.length - 1].start, !on, x, y, hx, hy, t < 0.999, rock, now, frames, mt.range, beamLook(ship.blueprint.parts[m.part]?.fn));
        if (t < 0.999 && Math.random() < 0.35 * frames) {
          const sa = a + Math.PI + (Math.random() - 0.5) * 2.2, s = 1.5 + Math.random() * 4;
          this.sparks.push({ x: hx, y: hy, vx: Math.cos(sa) * s, vy: Math.sin(sa) * s, life: 0, max: 10 + Math.random() * 14 });
        }
      }
    }
    // (A beam let go: its next press starts a fresh pulse)
    for (const key of this.mining.keys()) if (!miningSeen.has(key)) this.mining.delete(key);
    this.miningFx.drawAfter(g, dt, frames);
    // Sparks off the rock face
    let w = 0;
    for (const s of this.sparks) {
      s.life += frames;
      if (s.life >= s.max) continue;
      s.vx *= Math.pow(0.9, frames); s.vy *= Math.pow(0.9, frames);
      s.x += s.vx * frames; s.y += s.vy * frames;
      const f = 1 - s.life / s.max;
      if (s.heal) {
        // (A Repair Beam's sparkle: a little green cross, fading)
        const r = 2.4 * (0.6 + f);
        g.moveTo(s.x - r, s.y).lineTo(s.x + r, s.y).moveTo(s.x, s.y - r).lineTo(s.x, s.y + r).stroke({ color: f > 0.5 ? 0xd1fae5 : 0x34d399, width: 1.3, alpha: f });
      } else g.moveTo(s.x - s.vx * 2, s.y - s.vy * 2).lineTo(s.x, s.y).stroke({ color: f > 0.5 ? 0xfff2c8 : 0xffa04a, width: 1.4, alpha: f });
      this.sparks[w++] = s;
    }
    this.sparks.length = Math.min(w, 400);
  }

  /** Pulse lasers and plasma lances: drawn while the ship's "left weapon active" flag is set (a laser's colour is its grade's: LASER_COLORS) */
  private weaponBeams(g: Graphics): void {
    const defs = this.tuning.weapons ?? {};
    for (const [id, ship] of this.source.bodies) {
      if (ship.kind !== 'ship') continue;
      // (Pulse lasers are drawn from their pulses: drawPulses)
      const beams = ship.derived.weapons.filter((w) => w.fire.model === 'beam');
      if (!beams.length) continue;
      const e = this.state.entities.get(id);
      if (!e || !e.data?.length) continue;
      // Players: the cursor state's weapon flag; hostiles: snapshot data[6]
      if (e.type === EntityType.Player ? !unpackCursorWeaponState(e.data[0]).leftActive : e.type !== EntityType.ShipBody || e.data[6] !== 1) continue;
      const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
      for (const w of beams) {
        // Its own tuning: its grade's reach and width too (launch.ts gunDef)
        const def = partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w);
        // A Repair Beam: a soft teal beam to the friendly hull it mends, sparkling where it lands (support.ts)
        if (def.heal) { this.repairBeam(g, id, ship, w, pose, def); continue; }
        const { x, y, hx, hy, t } = this.beamLine(id, ship, w, pose, def.range ?? 800, (def.width ?? 0) / 2);
        const lance = w.kind === 'lance';
        const look = beamLook(ship.blueprint.parts[w.part]?.fn);
        let [outer, mid, core] = lance ? [0x7c3aed, 0xc084fc, 0xf5e8ff] : w.kind === 'frostbite' ? [0x0284c7, 0x7dd3fc, 0xf0fbff] : LASER_COLORS[Math.max(0, Math.min(4, (w.grade ?? 1) - 1))];
        const flick = 0.85 + 0.15 * Math.sin(this.t * 53 + id);
        // A wider beam (a better grade's) draws wider, and each mark up a little hotter
        // (A model's own look, if it has one: BEAM_LOOKS)
        if (look) { outer = look.outer ?? outer; mid = look.mid ?? mid; core = look.core ?? core; }
        const wid = (lance ? 13 : w.kind === 'frostbite' ? 10 : 6) * flick * ((def.width ?? 1) / (defs[w.kind]!.width ?? 1)) * (1 + 0.08 * ((w.grade ?? 1) - 1)) * (look?.width ?? 1);
        const gain = sputterGain(look?.sputter, this.t, id + w.part);
        const bl = Math.hypot(hx - x, hy - y) || 1, bux = (hx - x) / bl, buy = (hy - y) / bl;
        if (look?.cone) drawCone(g, x, y, bux, buy, bl, look.cone, mid, 0.22 * gain);
        g.moveTo(x, y).lineTo(hx, hy).stroke({ color: outer, width: wid * 3, alpha: 0.13 * gain });
        g.moveTo(x, y).lineTo(hx, hy).stroke({ color: mid, width: wid * 1.4, alpha: 0.45 * gain });
        g.moveTo(x, y).lineTo(hx, hy).stroke({ color: core, width: wid * 0.45, alpha: 0.95 * gain });
        if (look?.braid) drawStrands(g, x, y, bux, buy, bl, wid, look.braid.strands, look.braid.color, gain, this.t, id + w.part);
        g.circle(x, y, wid * 1.2).fill({ color: mid, alpha: 0.5 * gain });
        if (t < 0.999) {
          g.circle(hx, hy, wid * 2.6).fill({ color: mid, alpha: 0.3 });
          g.circle(hx, hy, wid * 1.1).fill({ color: core, alpha: 0.85 });
          if (Math.random() < 0.6) this.sparks.push({ x: hx, y: hy, vx: (Math.random() - 0.5) * 7, vy: (Math.random() - 0.5) * 7, life: 0, max: 8 + Math.random() * 10 });
        }
      }
    }
    this.drawPulses(g);
  }

  /**
   * A Repair Beam (support.ts): it passes through every ship it can't mend, as the server's does, and stops on the
   * first friendly hull; a calm teal beam, gently breathing, and green sparkles drifting off where it lands.
   */
  private repairBeam(g: Graphics, id: number, ship: ShipState, w: WeaponInfo, pose: { x: number; y: number; angle: number }, def: WeaponTuning): void {
    const { x, y, hx, hy, t } = this.beamLine(id, ship, w, pose, def.range ?? 500, (def.width ?? 0) / 2, true);
    const breathe = 0.8 + 0.2 * Math.sin(this.t * 5 + id);
    const wid = 7 * breathe;
    g.moveTo(x, y).lineTo(hx, hy).stroke({ color: 0x0f766e, width: wid * 3.4, alpha: 0.12 });
    g.moveTo(x, y).lineTo(hx, hy).stroke({ color: 0x2dd4bf, width: wid * 1.3, alpha: 0.4 });
    g.moveTo(x, y).lineTo(hx, hy).stroke({ color: 0xecfdf5, width: wid * 0.35, alpha: 0.9 });
    // (Motes running along it towards what it mends)
    const len = Math.hypot(hx - x, hy - y);
    for (let k = 0; k < 4; k++) {
      const u = ((this.t * 0.9 + k / 4 + id * 0.13) % 1);
      g.circle(x + (hx - x) * u, y + (hy - y) * u, 2.2 + 1.2 * Math.sin(u * Math.PI)).fill({ color: 0xa7f3d0, alpha: 0.75 * Math.sin(u * Math.PI) });
    }
    g.circle(x, y, wid * 1.1).fill({ color: 0x5eead4, alpha: 0.45 });
    if (t < 0.999 && len > 1) {
      g.circle(hx, hy, wid * 2.8).fill({ color: 0x2dd4bf, alpha: 0.22 });
      g.circle(hx, hy, wid * 1.0).fill({ color: 0xecfdf5, alpha: 0.8 });
      if (Math.random() < 0.7) {
        const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 1.2;
        this.sparks.push({ x: hx + Math.cos(a) * 10, y: hy + Math.sin(a) * 10, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.3, life: 0, max: 24 + Math.random() * 20, heal: true });
      }
    }
  }

  /** Where a beam weapon points now and what it meets: muzzle, hit point, and how far along (1: nothing) */
  /** (`half`: the beam's half-width, as the server burns it: a hull its edge touches stops it; `heal`: a Repair Beam's, stopped by friends only) */
  private beamLine(id: number, ship: ShipState, w: WeaponInfo, pose: { x: number; y: number; angle: number }, range: number, half = 0, heal = false): { x: number; y: number; hx: number; hy: number; t: number } {
    let muzzle = w.muzzle, dir = w.dir;
    if (w.mount === 'turret' && w.window) {
      const a = w.window.center + (ship.aim[w.part] ?? 0);
      dir = [Math.cos(a), Math.sin(a)];
      muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
    } else if (ship.aim[w.part]) {
      // A fixed gun on its gimbal (as the server burns it: ShipBridge.fireBeam)
      const a = Math.atan2(dir[1], dir[0]) + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
    }
    const [x, y] = shipPointToWorld(ship, pose, muzzle, this.tuning.cellSize);
    const a = pose.angle + Math.PI / 2 + Math.atan2(dir[1], dir[0]);
    const x1 = x + Math.cos(a) * range, y1 = y + Math.sin(a) * range;
    // (A Repair Beam passes over rock as the server's does: only terrain and friends stop it)
    const t = heal ? this.castShips(id, x, y, x1, y1, half, true) : Math.min(this.cast(x, y, x1, y1), this.castShips(id, x, y, x1, y1, half));
    return { x, y, hx: x + (x1 - x) * t, hy: y + (y1 - y) * t, t };
  }

  /** Pulses under way: by ship, its laser's part and the tick its pulse started (the server's fire events; your own, as your client fires them) */
  private pulses: PulseRun[] = [];
  /** How the pulses are drawn (their phases, particles, rings and scorches) */
  private pulseFx = new PulseFx();
  /** A pulse leaving its gun (on its timeline): where, and its gun's grade (its sound) */
  onPulse: ((x: number, y: number, grade: number, own: boolean) => void) | null = null;

  /** Mining lasers' pulses under way (the newest last), by ship and miner (id × 16 + its index) */
  private mining = new Map<number, PulseRun[]>();
  /** The rock the last cast met (its composition: what its cut throws off) */
  private rockHit: Composition | undefined;
  /** How mining beams are drawn (nothing like a weapon's pulse) */
  private miningFx = new MiningFx();
  /** A mining laser's pulse starting: where, and whether it's yours (its sound; once a ship, however many miners) */
  onMiningPulse: ((x: number, y: number, own: boolean) => void) | null = null;
  /** Station laser turrets' pulses: from the muzzle as it fired to the ship it's on */
  private stationRuns: { run: PulseRun; x: number; y: number; target: number; station: number }[] = [];

  /** A station laser turret fires at `target` from (x, y) (its muzzle, on `station`) */
  stationPulse(x: number, y: number, target: number, station = -1): void {
    this.stationRuns.push({ run: newRun(-1, this.stationRuns.length, this.t * 60), x, y, target, station });
    if (this.stationRuns.length > 48) this.stationRuns.shift();
    this.onPulse?.(x, y, 1, false);
  }

  /** A pulse laser fired on `start` (pulse.ts) */
  startPulse(owner: number, part: number, start: number): void {
    // (The server's word for one your client already fired is the same pulse)
    if (this.pulses.some((p) => p.owner === owner && p.part === part && Math.abs(p.start - start) <= 2)) return;
    this.pulses.push({ owner, part, start, sounded: false, flared: false, arrived: false, impact: -1, mx: 0, my: 0 });
    if (this.pulses.length > 64) this.pulses.shift();
  }

  /**
   * Each pulse follows its curve (pulse.ts), on the timeline its ship is drawn
   * on (PulseFx draws its phases), the beam cast against rock and hulls as it goes.
   */
  private drawPulses(g: Graphics): void {
    const frames = Math.min(4, this.dt * 60);
    if (this.pulses.length) {
      const present = this.state.getRawServerTick(), render = present - this.state.interpDelayMs / (1000 / 60);
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const p = this.pulses[i];
        const ship = this.source.bodies.get(p.owner), e = this.state.entities.get(p.owner);
        const w = ship?.kind === 'ship' ? ship.derived.weapons.find((x) => x.part === p.part) : undefined;
        const def = w && ship && partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w);
        if (!ship || !e || !w || !def?.pulse) { this.pulses.splice(i, 1); continue; }
        const prof = pulseProfile(def.pulse);
        const own = p.owner === this.state.playerId;
        const age = (!this.state.predictionEnabled || own ? present : render) - p.start;
        if (age >= prof.ticks + 1) { this.pulses.splice(i, 1); continue; }
        if (age < 0) continue;
        const pose = { x: e.renderX, y: e.renderY, angle: e.renderAngle };
        // (As wide as the server burns this tick of the pulse: pulse.ts profile)
        const wk = prof.width[Math.max(0, Math.min(prof.ticks - 1, Math.floor(age)))] ?? 1;
        const { x, y, hx, hy, t } = this.beamLine(p.owner, ship, w, pose, def.range ?? 800, ((def.width ?? 0) * wk) / 2);
        if (!p.sounded) { p.sounded = true; this.onPulse?.(x, y, w.grade ?? 1, own); }
        this.pulseFx.draw(g, p, prof, age, x, y, hx, hy, t < 0.999, def, w.grade ?? 1, frames, ship.blueprint.parts[w.part]?.fn);
      }
    }
    if (this.stationRuns.length) {
      const prof = pulseProfile(STATION_PULSE), now = this.t * 60;
      for (let i = this.stationRuns.length - 1; i >= 0; i--) {
        const s = this.stationRuns[i], age = now - s.run.start, e = this.state.entities.get(s.target);
        if (!e || age >= prof.ticks + 1) { this.stationRuns.splice(i, 1); continue; }
        // To the hull facing the station, not the ship's centre: where the server's shot strikes, which it finds
        // along the line from the station's centre to the ship's (Enemies.stationShot, partFacing); from the muzzle
        // if the station isn't known
        const ship = this.source.bodies.get(s.target), st = this.state.entities.get(s.station);
        const ox = st ? st.renderX : s.x, oy = st ? st.renderY : s.y;
        const t = ship ? this.castShip(ship, e, ox, oy, e.renderX, e.renderY, 0) : 1;
        this.pulseFx.draw(g, s.run, prof, age, s.x, s.y, ox + (e.renderX - ox) * t, oy + (e.renderY - oy) * t, true, STATION_LASER, 1, frames);
      }
    }
    this.pulseFx.drawAfter(g, this.dt, frames);
  }

  /**
   * Fraction along the segment where it first meets another ship's hull (1 = none): its parts' own shapes, as the
   * server burns it (ShipBridge.segmentHit: a skeleton or a wreck is passed through), once the line comes near it
   */
  /** (As the server's beams: ShipBridge.fireBeam and stepMiners pass through ships mid-jump and ships the shooter can't hurt) */
  private castShips(self: number, x0: number, y0: number, x1: number, y1: number, half = 0, heal = false): number {
    let best = 1;
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1, cs = this.tuning.cellSize;
    const jt = jumpTuning(this.tuning);
    for (const [id, ship] of this.source.bodies) {
      if (id === self) continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      if (jumpPhase(JumpFx.counter(e, id === this.state.playerId), jt).phase === 'burn' || !(heal ? canHeal(this.state, self, id) : canHurt(this.state, self, id))) continue;
      // Not near it at all: on to the next
      const u = Math.max(0, Math.min(1, ((e.renderX - x0) * dx + (e.renderY - y0) * dy) / len2));
      if (Math.hypot(x0 + dx * u - e.renderX, y0 + dy * u - e.renderY) > ship.derived.radius + cs + half) continue;
      best = Math.min(best, this.castShip(ship, e, x0, y0, x1, y1, half));
    }
    return best;
  }

  /** One ship: the segment in its own grid (cells about its centre of mass), `half` thick, against each standing part (collide.ts castParts, as the server) */
  private castShip(ship: ShipState, e: { renderX: number; renderY: number; renderAngle: number }, x0: number, y0: number, x1: number, y1: number, half: number): number {
    const cs = this.tuning.cellSize, com = ship.derived.com;
    const [ax, ay] = worldToLocalDir([x0 - e.renderX, y0 - e.renderY], e.renderAngle), [bx, by] = worldToLocalDir([x1 - e.renderX, y1 - e.renderY], e.renderAngle);
    const h = castParts(this.source.geometry(ship), (i) => standing(this.source.catalog, ship, i), ax / cs + com[0], ay / cs + com[1], bx / cs + com[0], by / cs + com[1], half / cs);
    return h ? h.t : 1;
  }

  /** Fraction along the segment where it first meets an asteroid (1 = none): a siphon meets only gas pockets, anything else passes them */
  private cast(x0: number, y0: number, x1: number, y1: number, gas = false): number {
    let best = 1;
    this.rockHit = undefined;
    const minX = Math.min(x0, x1) - 200, maxX = Math.max(x0, x1) + 200, minY = Math.min(y0, y1) - 200, maxY = Math.max(y0, y1) + 200;
    for (const e of this.state.entities.values()) {
      if (e.type !== EntityType.Asteroid) continue;
      if (e.renderX < minX || e.renderX > maxX || e.renderY < minY || e.renderY > maxY) continue;
      if (GAS_TYPES.has(e.composition?.type ?? '') !== gas) continue;
      const poly = getAsteroidPolygon(e.id, e.renderX, e.renderY, e.data?.[0] ?? 30, e.renderAngle);
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
        const t = segmentIntersectT(x0, y0, x1, y1, p1.x, p1.y, p2.x, p2.y);
        if (t !== null && t < best) { best = t; this.rockHit = e.composition; }
      }
    }
    return best;
  }
}
