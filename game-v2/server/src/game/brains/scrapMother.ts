/**
 * The Scrap Mother (her Nest Rock in the Drift, past Nereid): a nest the size of a station, welded out of salvage
 * (scripts/bespoke/scrap_mother.mjs). The generalist starter boss (docs/bosses/rework-2026-11.md sections 4 and 15): any
 * loadout works. Each stage is an attack phase: its signature moves chained back to back (a short beat between them),
 * then one short window (fightRules.ts: x2 up to its cap; outside it she takes x0.3), then the phase again. Nothing is
 * scaled by how many fight her. Each move has one light tell on her hull (always the same for the same move) and one
 * dodge rule that always works. Between moves and in her window (after its 1 s rest beat) she keeps up a light threat:
 * a gun's aimed rivets down a drawn line (stages one and two), a spike's aimed chunks (stage three).
 *
 * Stage one, the hoard (her nest wings, crane arms, grapple booms): she holds off. Phase: barrage, crane, haul.
 *
 *   barrage   tell: a wing gun swings onto you with a clank, a faint yellow line. Her guns in turn, clockwise, a new
 *             line every 0.45 s (two or three live at once), 5 rivets down each, drawn at you, never ahead.
 *                                                                                Rule: cross the line
 *   crane     tell: a crane arm's elbow lamp blinks amber twice. The arm swings across her front from that side, its
 *             claw a wide hit from 600 off her hull out; the other arm blinks as it goes and swings back 0.4 s after.
 *                                                                                Rule: get in close
 *   haul      tell: her magnets hum and glow green. A strong pull towards her front (only her front), then her claws
 *             snap shut across it (the crane drew you in close: now slide off her front). Rule: get out of her front
 *
 * Stage two, the mill (her body): she closes in. Phase: shrapnel, charge, intake, charge.
 *
 *   shrapnel  tell: her stacks puff black smoke, three puffs. Four rings of fast chunks out to the nest's walls; the gap
 *             in every ring is at her flanks as she faces when it's thrown, and she turns a little between rings.
 *                                                                                Rule: stay level with her side
 *   charge    tell: her drives flare white. She lines up on where you are and rams, not turning once she goes.
 *                                                                                Rule: sidestep
 *   intake    tell: her throat glows, her rotors grind up. Her maw's lane pulls you in towards the rotors, and turns
 *             slowly after you.                                                  Rule: leave the lane sideways
 *
 * Stage three, the seed (her heart): small and quick. Phase: spiral, scissor, seekers, scissor.
 *
 *   spiral    tell: her core pulses green, she darts to a new angle. Four arms of fast chunks spun out one way only,
 *             out to the walls.                                                  Rule: circle with the spin
 *   scissor   tell: her welder tips glow blue-white. Two beams sweep in from wide until they cross ahead of her, then
 *             back out.                                                          Rule: get in close
 *   seekers   tell: her four spikes chime in turn. Eight slow-turning seekers in all, two waves of four, shared among
 *             the pilots she sees.                                               Rule: turn hard across them
 *
 * Her window (one a phase) is drawn by clients from the window alone (BossFx: the stage's pieces in bosses.json
 * `exposed`): her breeches and magnets (stage one), her throat and stacks (two), her core (three).
 *
 * Per pilot (fightRules.ts personal, held only in a window's rest beat and a stagger): marked rivets and a mite pair
 * (stage one), marked rivets and a sludge drop (two), a sludge drop and a lone seeker (three). Breaking a move's part
 * takes that move out of her phase (she goes straight on to the next): safer, not slower; her window still comes.
 */

import { Position, Velocity, WINDOW, datan2, dcos, dhypot, dsin, wantAim, wantDrive, wantFace, wantFly, wantHold, windowOpen, type WindowSpec } from '@space-game/common';
import { bodyFrame, pose, wrap } from './kit.js';
import type { BrainHost } from './kit.js';
import { StagedBrain, type Move } from './staged.js';

const P = (name: string) => `scrapmother_${name}`;

/**
 * Her attack phases' windows (rework section 15), by stage: one a phase, 5 s (4.5 s in stage three). Caps are what
 * lands after her armour (her plating lets a starter's Pip through at about 0.40-0.48): a solo starter fills about two
 * thirds of one, two or more crack it
 */
export const MOTHER_EXPOSURE: WindowSpec[] = [{ ticks: 300, cap: 440 }, { ticks: 300, cap: 470 }, { ticks: 300, cap: 480 }];
/** Her signature moves (what counts as one: fightRules.ts), each with its stage's window */
export const MOTHER_SIGNATURE: Record<string, WindowSpec> = {
  barrage: MOTHER_EXPOSURE[0], haul: MOTHER_EXPOSURE[0], crane: MOTHER_EXPOSURE[0],
  intake: MOTHER_EXPOSURE[1], shrapnel: MOTHER_EXPOSURE[1], charge: MOTHER_EXPOSURE[1],
  scissor: MOTHER_EXPOSURE[2], spiral: MOTHER_EXPOSURE[2], seekers: MOTHER_EXPOSURE[2],
};
/** Her phases: the moves chained in order, the beat between two of them, her rest after a window (ticks), by stage */
export const MOTHER_LOOP = [['barrage', 'crane', 'haul'], ['shrapnel', 'charge', 'intake', 'charge'], ['spiral', 'scissor', 'seekers', 'scissor']];
const CHAIN = [30, 24, 18], REST = [30, 24, 18];
/** Her light threat between moves and in her windows: a harassing shot every this many ticks, by stage */
const HARASS = [90, 80, 70];
/** Outside her windows she takes this (not the shared x0.35): a group's extra pilots add less (rework 3.3's lever) */
const OUTSIDE = 0.25;
/** A signature move puts at most this many shots within DENSITY_R of any pilot (rework 2.3) */
const DENSITY = 6, DENSITY_R = 800;
/** Tells (ticks): a line attack's warning, an area one's (never shorter: rework 2.4) */
const TELL_LINE = 54, TELL_AREA = 72;
/** The crane's claw: within CRANE_CLEAR of her hull it passes over you; it bites from CRANE_BITE of its reach out (client bossTells.ts the same) */
const CRANE_CLEAR = 600, CRANE_BITE = 0.52, CRANE_W = 260, CRANE_SWEEP = 96, CRANE_BACK = 24;
/** Her rings: chunks in one, the gap's width (chunks) at each flank, how many, how far apart (ticks), and how far she turns between */
const RING_N = 26, RING_GAP = 3, RINGS = 4, RING_EVERY = 36, RING_TURN = 0.2;
/** Her stage-three harassing shot: a spike's glint, then three chunks at where you were (sidestep) */
const POT_WARN = 40, POT_FAN = 0.12;

export class ScrapMotherBrain extends StagedBrain {
  /** Rivets due down a gun's line (its own frame: where on her, which way) */
  private rivets: { part: number; rel: number; at: number; left: number; scale: number }[] = [];
  /** Sludge pools still burning */
  private pools: { x: number; y: number; next: number; until: number }[] = [];
  /** Harassing chunks due (stage three: from a spike, at where its pilot was when it glinted) */
  private pots: { spike: number; x: number; y: number; at: number }[] = [];

  constructor(host: BrainHost) {
    super(host, {
      loop: MOTHER_LOOP, rest: REST, haste: [1, 1, 1], chain: CHAIN, harass: HARASS,
      signature: MOTHER_SIGNATURE, exposure: MOTHER_EXPOSURE,
      personal: { beat: 120, chance: 0.2, ticks: 300, pool: [['rivets', 'mites'], ['rivets', 'sludge'], ['sludge', 'seeker']] },
    }, 'scrap_mother');
  }

  /** A move by name, or null when its part is shot off (her phase goes straight on without it) */
  protected make(id: string): Move | null {
    switch (id) {
      case 'barrage': return this.working('autocannon').length ? this.barrage() : null;
      case 'haul': return this.magnets().length ? this.haul() : null;
      case 'crane': return this.cranes().length ? this.crane() : null;
      case 'intake': return this.named(P('throat')) >= 0 ? this.intake() : null;
      case 'shrapnel': return this.named(P('stacks')) >= 0 ? this.shrapnel() : null;
      case 'charge': return this.drives().length ? this.charge() : null;
      case 'scissor': return this.working('arc').length ? this.scissor() : null;
      case 'spiral': return this.core() >= 0 ? this.spiral() : null;
      case 'seekers': return this.spikes().length ? this.seekers() : null;
    }
    return null;
  }

  protected onStop(): void {
    this.rivets = [];
    this.pools = [];
    this.pots = [];
  }

  // ---- Her parts ----

  private magnets(): number[] { return [this.named(P('magnet_l')), this.named(P('magnet_r'))].filter((i) => i >= 0); }
  private wrists(): number[] { return [this.named(P('wrist_l')), this.named(P('wrist_r'))].filter((i) => i >= 0); }
  /** Her crane arms that can swing: the elbow (its lamp) and the forearm still on */
  private cranes(): number[] { return (['l', 'r'] as const).filter((s) => this.named(P(`elbow_${s}`)) >= 0 && this.named(P(`forearm_${s}`)) >= 0).map((s) => this.named(P(`elbow_${s}`))); }
  private rotors(): number[] { return [this.named(P('rotor_l')), this.named(P('rotor_r'))].filter((i) => i >= 0); }
  private vats(): number[] { return [this.named(P('vat_l')), this.named(P('vat_r'))].filter((i) => i >= 0); }
  private drives(): number[] { return [this.named(P('drive_l')), this.named(P('drive_c')), this.named(P('drive_r'))].filter((i) => i >= 0); }
  private spikes(): number[] { return [1, 2, 4, 5].map((k) => this.named(P(`s3_spike${k}`))).filter((i) => i >= 0); }
  /** Her seed's core (wrecked or not: it fires while it's on) */
  private core(): number {
    const i = this.ship.blueprint.parts.findIndex((p) => p.piece === P('s3_core'));
    return i >= 0 && this.ship.derived.alive[i] ? i : -1;
  }

  /** A point ahead of her (her own frame): her maw, her claws' meeting */
  private ahead(d: number): { x: number; y: number } {
    const me = pose(this.view.eid);
    return { x: me.x + dcos(me.angle) * d, y: me.y + dsin(me.angle) * d };
  }

  /** Of these parts, the one whose mount faces a pilot best (round her middle) */
  private facing(parts: number[], t: number): number {
    const me = pose(this.view.eid), to = datan2(Position.y[t] - me.y, Position.x[t] - me.x);
    const off = (g: number) => { const m = this.mount(g); return Math.abs(wrap(datan2(m.y - me.y, m.x - me.x) - to)); };
    return parts.reduce((a, b) => (off(b) < off(a) ? b : a));
  }

  // ---- Tells: light, on her hull, the same for the same move ----

  /** A glow on a part (`kind`: its colour, BossFx) for `ticks` */
  private glow(part: number, kind: string, ticks: number, radius = 220): void {
    if (part < 0) return;
    const at = bodyFrame(this.host, this.view.eid, this.ship, part);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind, bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius, ticks });
  }

  /** Hold still, facing a heading, for `ticks` */
  private *face(heading: number, ticks: number): Move {
    for (let i = 0; i < ticks; i++) { this.want = wantFace(heading); yield; }
  }

  // ---- Shots, held to the density cap ----

  /**
   * Of a volley's shots (from (x, y) along `angles`), the ones it keeps: no pilot has more than DENSITY passing within
   * DENSITY_R of them; past that the volley's later shots are dropped (its order: the same on every run)
   */
  private capped(x: number, y: number, angles: number[]): number[] {
    const near = this.pilots(9000).map(() => 0), who = this.pilots(9000);
    return angles.filter((a) => {
      const ux = dcos(a), uy = dsin(a);
      const hits = who.map((q) => {
        const dx = Position.x[q] - x, dy = Position.y[q] - y, along = dx * ux + dy * uy;
        return along > -DENSITY_R && dhypot(dx - ux * Math.max(0, along), dy - uy * Math.max(0, along)) < DENSITY_R;
      });
      if (hits.some((h, k) => h && near[k] >= DENSITY)) return false;
      hits.forEach((h, k) => { if (h) near[k]++; });
      return true;
    });
  }

  /** One scrap chunk out of a point this way (`speed`: x a chunk's: tuning.json scrap_chunk flies to the nest's walls) */
  private chunk(x: number, y: number, a: number, speed = 1, off = 150): void {
    this.host.fire(this.view.eid, 'scrap_chunk', x + dcos(a) * off, y + dsin(a) * off, a, this.view.damage, { speed });
  }

  // ---- Stage one: the hoard ----

  /** A gun swings onto a pilot (where they ARE: never ahead) and draws its line; `n` rivets come down it after `warn` */
  private gun(part: number, t: number, warn: number, n: number, scale = 1): void {
    if (t < 0) return;
    const at = bodyFrame(this.host, this.view.eid, this.ship, part), m = this.mount(part), me = pose(this.view.eid);
    const rel = wrap(datan2(Position.y[t] - m.y, Position.x[t] - m.x) - me.angle);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'rivet', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length: 2800, width: 50, ticks: warn });
    this.rivets.push({ part, rel, at: this.host.tick() + warn, left: n, scale });
  }

  /** Rivets due now fly down their guns' lines */
  private hammer(now: number): void {
    const me = pose(this.view.eid);
    for (let k = this.rivets.length - 1; k >= 0; k--) {
      const r = this.rivets[k];
      if (now < r.at) continue;
      if (!this.ship.derived.alive[r.part]) { this.rivets.splice(k, 1); continue; }
      const m = this.mount(r.part), a = me.angle + r.rel;
      this.host.fire(this.view.eid, 'rivet', m.x + dcos(a) * 40, m.y + dsin(a) * 40, a, this.view.damage * r.scale);
      r.at = now + 3;
      if (--r.left <= 0) this.rivets.splice(k, 1);
    }
  }

  /** Her wing guns one after another, clockwise, a new line every 27 ticks; she holds still so every line stays where it was drawn */
  private *barrage(): Move {
    const order = this.clockwise(this.working('autocannon')), gap = 27, heading = pose(this.view.eid).angle;
    for (const part of order) {
      if (this.ship.derived.alive[part]) this.gun(part, this.target, TELL_LINE, 5);
      yield* this.face(heading, gap);
    }
    while (this.rivets.length) { this.want = wantFace(heading); yield; }
  }

  /** Her magnets hum and glow; a strong pull towards her front (only there); her claws snap shut across it */
  private *haul(): Move {
    const eid = this.view.eid, pullTicks = 90, reach = 3600, r = this.ship.derived.radius;
    for (const m of this.magnets()) this.glow(m, 'glow_green', TELL_AREA + pullTicks, 200);
    yield* this.hold(TELL_AREA);
    const snapAt = pullTicks - 30, claws = this.wrists().length > 0;
    for (let i = 0; i < pullTicks; i++) {
      if (!this.magnets().length) break;
      const p = this.ahead(r * 0.55), me = pose(eid);
      for (const q of this.host.players(this.view.systemNum)) {
        // (her front only: beside or behind her, nothing pulls)
        const dx = Position.x[q] - me.x, dy = Position.y[q] - me.y;
        if (dx * dcos(me.angle) + dy * dsin(me.angle) <= 0) continue;
        this.pullOne(q, p.x, p.y, reach, 0.75);
      }
      if (claws && i === snapAt) {
        const tx = r * 0.75;
        for (const w of this.wrists()) {
          const at = bodyFrame(this.host, eid, this.ship, w);
          this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'claw', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: datan2(-at.y, tx - at.x), length: Math.round(dhypot(at.y, tx - at.x) + 300), width: 380, ticks: pullTicks - snapAt });
        }
      }
      this.want = wantHold();
      yield;
    }
    if (claws && this.wrists().length) {
      // Snap: down each claw's line to where they meet
      const me = pose(eid), c = dcos(me.angle), s = dsin(me.angle);
      const due: { x: number; y: number; at: number }[] = [];
      for (const w of this.wrists()) {
        const at = bodyFrame(this.host, eid, this.ship, w), tx = r * 0.75;
        for (let k = 0; k <= 4; k++) {
          const lx = at.x + (tx - at.x) * (k / 4), ly = at.y * (1 - k / 4);
          due.push({ x: me.x + lx * c - ly * s, y: me.y + lx * s + ly * c, at: 0 });
        }
      }
      this.land(due, 260, 110, 'eruption');
    }
    yield* this.hold(12);
  }

  /**
   * A crane arm's elbow lamp blinks amber twice and the arm draws back; then it swings across her front half from that
   * side to the other, its claw hitting from CRANE_CLEAR off her hull out (once a pilot a swing). The other arm blinks
   * as it goes and swings back the other way CRANE_BACK ticks after. Close in, both pass over
   */
  private *crane(): Move {
    const eid = this.view.eid, arms = this.cranes();
    // (the arm on the side her target's on first, else the one left)
    const me0 = pose(eid), t = this.target;
    const right = t >= 0 && -(Position.x[t] - me0.x) * dsin(me0.angle) + (Position.y[t] - me0.y) * dcos(me0.angle) > 0;
    const first = arms.find((e) => this.ship.blueprint.parts[e].piece.endsWith(right ? '_r' : '_l')) ?? arms[0];
    const order = [first, ...arms.filter((e) => e !== first)];
    const heading = me0.angle, inner = this.ship.derived.radius + CRANE_CLEAR, outer = Math.round(inner / CRANE_BITE);
    const sideOf = (e: number) => (this.ship.blueprint.parts[e].piece.endsWith('_r') ? 1 : -1);
    // Tell: two amber blinks on the first elbow (two short glows), the arm's start line faint
    this.glow(first, 'glow_amber', 26, 170);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'crane', bodyId: eid, x: 0, y: 0, angle: sideOf(first) * 1.75, length: outer, width: CRANE_W, ticks: TELL_AREA });
    yield* this.face(heading, 34);
    this.glow(first, 'glow_amber', 26, 170);
    yield* this.face(heading, TELL_AREA - 34);
    for (let n = 0; n < order.length; n++) {
      const elbow = order[n], side = sideOf(elbow);
      if (this.named(this.ship.blueprint.parts[elbow].piece) < 0) continue;
      const a0 = side * 1.75, a1 = -side * 1.75;
      this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'crane', bodyId: eid, x: 0, y: 0, a0, a1, ticks: CRANE_SWEEP, length: outer, width: CRANE_W });
      const struck = new Set<number>(), next = order[n + 1];
      for (let i = 0; i < CRANE_SWEEP; i++) {
        // (the next arm's lamp blinks as this one goes: it's coming back the other way)
        if (next !== undefined && (i === CRANE_SWEEP - 50 || i === CRANE_SWEEP - 20)) this.glow(next, 'glow_amber', 22, 170);
        const me = pose(eid), a = me.angle + a0 + (a1 - a0) * (i / CRANE_SWEEP);
        const x0 = me.x + dcos(a) * inner, y0 = me.y + dsin(a) * inner, x1 = me.x + dcos(a) * outer, y1 = me.y + dsin(a) * outer;
        for (const q of this.host.players(this.view.systemNum)) {
          if (struck.has(q)) continue;
          const sh = this.host.ships.get(q);
          const h = sh && this.host.ships.segmentHit(q, sh, x0, y0, x1, y1, CRANE_W / 2);
          if (!h) continue;
          struck.add(q);
          this.host.ships.damagePartBy(q, h.part, 75 * this.view.damage, eid, { type: 'kinetic', pen: 1 });
          this.host.send(this.view.systemNum, { type: 'detonation', kind: 'scrap', x: Math.round(Position.x[q]), y: Math.round(Position.y[q]), radius: 180 });
        }
        this.want = wantFace(heading);
        yield;
      }
      if (next !== undefined) yield* this.face(heading, CRANE_BACK);
    }
  }

  // ---- Stage two: the mill ----

  /** Her throat glows and her rotors grind up; her maw's lane (her front, 1,000 wide) pulls you towards the rotors, turning slowly after you */
  private *intake(): Move {
    const eid = this.view.eid, ticks = 120, r = this.ship.derived.radius, half = 500, turn = 0.09;
    let heading = pose(eid).angle;
    const throat = this.named(P('throat')), at = bodyFrame(this.host, eid, this.ship, throat);
    this.glow(throat, 'glow_green', TELL_AREA + ticks, 260);
    for (const ro of this.rotors()) this.glow(ro, 'grind', TELL_AREA + ticks, 160);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'intake', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: 0, length: 3000, width: half * 2, ticks: TELL_AREA + ticks });
    yield* this.face(heading, TELL_AREA);
    const grind = this.rotors().length;
    for (let i = 0; i < ticks; i++) {
      if (this.named(P('throat')) < 0) break;
      const maw = this.ahead(r * 0.45), me = pose(eid), c = dcos(me.angle), s = dsin(me.angle);
      for (const q of this.host.players(this.view.systemNum)) {
        // (in the lane only: out of it sideways, nothing pulls)
        const dx = Position.x[q] - maw.x, dy = Position.y[q] - maw.y, along = dx * c + dy * s, across = -dx * s + dy * c;
        if (along < -200 || along > 3000 || Math.abs(across) > half) continue;
        this.pullOne(q, maw.x, maw.y, 3000, 0.6);
      }
      if (grind && i % 10 === 0) this.land([{ x: maw.x, y: maw.y, at: 0 }], 420 + 100 * grind, 26 * grind, 'scrap');
      // (the lane follows its target, slowly, a step every 15 ticks (each a want: a decision): keep going sideways)
      const t = this.target;
      if (t >= 0 && i % 15 === 14) heading += Math.max(-turn, Math.min(turn, wrap(datan2(Position.y[t] - me.y, Position.x[t] - me.x) - heading)));
      this.want = wantFace(heading);
      yield;
    }
  }

  /**
   * Her stacks puff three times; four rings of fast chunks out to the walls, the gaps at her flanks as she faces when
   * each is thrown; she turns a little between rings (always the same way in one volley), so the gaps follow her flanks
   */
  private *shrapnel(): Move {
    const stacks = this.named(P('stacks')), turn = this.host.rng() < 0.5 ? RING_TURN : -RING_TURN;
    let heading = pose(this.view.eid).angle;
    for (let k = 0; k < 3; k++) { this.glow(stacks, 'smoke', 22, 260); yield* this.face(heading, 24); }
    for (let ring = 0; ring < RINGS; ring++) {
      if (this.named(P('stacks')) < 0) return;
      const c = this.mount(stacks), h = pose(this.view.eid).angle, angles: number[] = [];
      for (let j = 0; j < RING_N; j++) {
        const a = h + (j / RING_N) * Math.PI * 2;
        // (the gaps: either side of her flanks, every ring)
        const off = wrap(a - h);
        if (Math.abs(Math.abs(off) - Math.PI / 2) < (RING_GAP / RING_N) * Math.PI) continue;
        angles.push(a);
      }
      for (const a of this.capped(c.x, c.y, angles)) this.chunk(c.x, c.y, a);
      heading = h + turn;
      yield* this.face(heading, RING_EVERY);
    }
  }

  /** Her drives flare white as she lines up on where you are; then she rams straight, not turning; spent, she drifts */
  private *charge(): Move {
    const t = this.target, r = this.ship.derived.radius, drives = this.drives();
    for (const d of drives) this.glow(d, 'glow_white', TELL_LINE + 6, 180);
    for (let i = 0; i < TELL_LINE; i++) {
      if (i === 18) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'ram', bodyId: this.view.eid, x: 0, y: 0, angle: 0, length: 3600, width: Math.round(r * 1.1), ticks: TELL_LINE - 18 });
      this.want = t >= 0 ? wantAim() : wantHold();
      yield;
    }
    const me = pose(this.view.eid);
    const vx = dcos(me.angle), vy = dsin(me.angle);
    let room = 0;
    for (let s = 0; s < 4 * this.flight.homeR; s += 200) { if (this.fromHome(me.x + vx * s, me.y + vy * s) > this.flight.homeR + 1500) break; room = s; }
    const speed = Math.max(12, Math.min(26, room / 60));
    this.want = wantDrive(me.angle, me.angle, speed);
    yield;
    for (let i = 0; i < 38; i++) { this.want = wantDrive(me.angle, me.angle); yield; }
    for (let i = 0; i < 18; i++) { this.want = wantHold(); yield; }
  }

  // ---- Stage three: the seed ----

  /** Her welder tips glow; two beams sweep in from wide either side until they cross ahead of her, then back out */
  private *scissor(): Move {
    const eid = this.view.eid, welders = this.working('arc'), t = this.target;
    // (she turns onto her target first: the cross is ahead of her, where you are)
    let heading = pose(eid).angle;
    if (t >= 0) { const me = pose(eid); heading = datan2(Position.y[t] - me.y, Position.x[t] - me.x); }
    const sweep = 64, length = 7000, width = 70;
    for (const w of welders) this.glow(w, 'glow_white', TELL_LINE, 150);
    const arms = welders.map((w) => {
      const at = bodyFrame(this.host, eid, this.ship, w), side = at.y < 0 ? -1 : 1;
      return { w, at, a0: side * 1.0, a1: -side * 0.18 };
    });
    for (const a of arms) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'weld', bodyId: eid, x: Math.round(a.at.x), y: Math.round(a.at.y), angle: a.a0, length, width, ticks: TELL_LINE });
    yield* this.face(heading, TELL_LINE);
    // In until they cross, then straight back out
    for (let i = 0; i < sweep * 2; i++) {
      if (i === 0 || i === sweep) for (const a of arms) {
        const [b0, b1] = i === 0 ? [a.a0, a.a1] : [a.a1, a.a0];
        this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'weld', bodyId: eid, x: Math.round(a.at.x), y: Math.round(a.at.y), a0: b0, a1: b1, ticks: sweep, length, width });
      }
      const k = i < sweep ? i / sweep : 1 - (i - sweep) / sweep;
      for (const a of arms) if (this.ship.derived.alive[a.w]) this.beam(a.at, a.a0 + (a.a1 - a.a0) * k, length, width, 9);
      this.want = wantFace(heading);
      yield;
    }
  }

  /** Her core pulses green twice as she darts once to a new angle; then four arms of fast chunks spun out one way only, out to the walls */
  private *spiral(): Move {
    const ticks = 180, every = 10, arms = 4, spin = this.host.rng() < 0.5 ? 0.2 : -0.2;
    this.glow(this.core(), 'glow_green', 36, 260);
    yield* this.dart(1000, 20, 30);
    this.glow(this.core(), 'glow_green', 36, 260);
    yield* this.hold(30);
    let base = this.host.rng() * Math.PI * 2;
    for (let i = 0; i < ticks; i++) {
      if (this.core() < 0) return;
      if (i % every === 0) {
        const c = this.mount(this.core()), angles: number[] = [];
        for (let k = 0; k < arms; k++) angles.push(base + (k / arms) * Math.PI * 2);
        for (const a of this.capped(c.x, c.y, angles)) this.chunk(c.x, c.y, a);
        base += spin;
      }
      this.want = wantHold();
      yield;
    }
  }

  /** Her four spikes chime one after another; then eight seekers in all, two waves of four, shared among the pilots she can see */
  private *seekers(): Move {
    const eid = this.view.eid, who = this.pilots(6000);
    for (const s of this.spikes()) { this.glow(s, 'chime', 30, 140); yield* this.hold(14); }
    if (!who.length) return;
    for (let wave = 0; wave < 2; wave++) {
      const spikes = this.spikes();
      for (let k = 0; k < 4 && spikes.length; k++) {
        const n = wave * 4 + k, s = spikes[k % spikes.length], m = this.mount(s), out = datan2(m.y - Position.y[eid], m.x - Position.x[eid]);
        const a = out + (wave - 0.5) * 0.5;
        this.host.fire(eid, 'seam_seeker', m.x + dcos(a) * 60, m.y + dsin(a) * 60, a, this.view.damage, { target: who[n % who.length] });
      }
      for (let i = 0; i < 40; i++) { this.want = wantFly(); yield; }
    }
  }

  // ---- Her light threat (staged.ts harass): between moves and in her window ----

  /** A gun facing the pilot draws a thin line and puts 2 rivets down it (stages one and two); a spike glints (the glint: an aimed shot) and throws three chunks at where they were (three) */
  protected harassShot(t: number): boolean {
    const guns = [...this.working('autocannon'), ...this.working('flak')];
    if (guns.length) { this.gun(this.facing(guns, t), t, TELL_LINE, 2, 0.8); return true; }
    const spikes = this.spikes();
    if (!spikes.length) return false;
    const s = this.facing(spikes, t);
    this.glow(s, 'glint', POT_WARN, 120);
    this.pots.push({ spike: s, x: Position.x[t], y: Position.y[t], at: this.host.tick() + POT_WARN });
    return true;
  }

  /** Harassing chunks due: three at where the pilot was when the spike glinted (sidestep) */
  private throwPots(now: number): void {
    for (let k = this.pots.length - 1; k >= 0; k--) {
      const p = this.pots[k];
      if (now < p.at) continue;
      this.pots.splice(k, 1);
      if (!this.ship.derived.alive[p.spike]) continue;
      const m = this.mount(p.spike), a = datan2(p.y - m.y, p.x - m.x);
      for (let j = -1; j <= 1; j++) this.chunk(m.x, m.y, a + j * POT_FAN, 1, 60);
    }
  }

  // ---- Personal attacks (rework 4.3): one pilot's own, local to them ----

  protected personalMove(name: string, target: number, seed: number): Move | null {
    switch (name) {
      case 'rivets': return this.markedRivets(target);
      case 'mites': return this.host.mobs && this.working('brood_bay').length ? this.mites(target, seed) : null;
      case 'sludge': return this.sludge(target);
      case 'seeker': return this.spikes().length ? this.loneSeeker(target) : null;
    }
    return super.personalMove(name, target, seed);
  }

  /** The gun (or flak mount) facing a pilot clanks onto them and draws a thin line; 4 rivets down it 0.9 s later */
  private *markedRivets(t: number): Move {
    const guns = [...this.working('autocannon'), ...this.working('flak')];
    if (!guns.length || !this.ship) return;
    this.gun(this.facing(guns, t), t, 54, 4);
    for (let i = 0; i < 70; i++) yield;
  }

  /** A brood rack on the pilot's side flickers amber; two mites hunt them (55 HP, 19 u/tick) until they burst or run out */
  private *mites(t: number, seed: number): Move {
    const rack = this.facing(this.working('brood_bay'), t);
    this.glow(rack, 'glow_amber', 50, 180);
    for (let i = 0; i < 50; i++) yield;
    if (!this.ship.derived.alive[rack] || !this.host.mobs) return;
    const m = this.mount(rack);
    this.host.launchFx(this.view.systemNum, m.x, m.y);
    for (let k = 0; k < 2; k++) {
      const a = m.dir + (k - 0.5) * 0.6 + ((seed & 7) - 3.5) * 0.02;
      const d = this.host.mobs.spawn('scrap_mite', this.view.systemNum, m.x + dcos(a) * 30, m.y + dsin(a) * 30, a, 12, this.view.eid, this.view.damage, t);
      if (d >= 0) this.drones.add(d);
    }
  }

  /** A vat burps; a faint circle where the pilot will be in 1.3 s, on their line; it lands, then pools 3 s */
  private *sludge(t: number): Move {
    const warn = 78, radius = 230, at = this.host.tick() + warn;
    const vat = this.vats()[0] ?? this.core();
    if (vat >= 0) this.glow(vat, 'smoke', 30, 180);
    // (on their line: where they're going, so the rule is change direction)
    const x = Position.x[t] + Velocity.x[t] * warn, y = Position.y[t] + Velocity.y[t] * warn;
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'sludge', x: Math.round(x), y: Math.round(y), radius, ticks: warn });
    const due = [{ x, y, at }];
    while (this.host.tick() < at) yield;
    this.land(due, radius, 70, 'sludge');
    const n = this.host.tick();
    this.pools.push({ x, y, next: n + 20, until: n + 180 });
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'pool', x: Math.round(x), y: Math.round(y), radius, ticks: 180 });
  }

  /** Pools still burning hurt what's in them */
  private burnPools(now: number): void {
    for (let k = this.pools.length - 1; k >= 0; k--) {
      const p = this.pools[k];
      if (now >= p.until) { this.pools.splice(k, 1); continue; }
      if (now < p.next) continue;
      p.next = now + 20;
      this.land([{ x: p.x, y: p.y, at: 0 }], 230, 22, '');
    }
  }

  /** One spike on the pilot's side chimes; one seeker after them */
  private *loneSeeker(t: number): Move {
    const me = pose(this.view.eid), s = this.facing(this.spikes(), t);
    this.glow(s, 'chime', 40, 140);
    for (let i = 0; i < 40; i++) yield;
    if (!this.ship.derived.alive[s]) return;
    const m = this.mount(s), a = datan2(m.y - me.y, m.x - me.x);
    this.host.fire(this.view.eid, 'seam_seeker', m.x + dcos(a) * 60, m.y + dsin(a) * 60, a, this.view.damage, { target: t });
  }

  /** What she takes of a hit, before the window's share (fightRules): outside her windows, OUTSIDE instead of the shared rate */
  taken(): number {
    return windowOpen(this.fight.window, this.host.tick()) ? 1 : OUTSIDE / WINDOW.outside;
  }

  // ---- Always on ----

  /** A pull on one pilot towards a point (`k` a tick at its middle, none at `r`), not through rock */
  private pullOne(q: number, x: number, y: number, r: number, k: number): void {
    const dx = x - Position.x[q], dy = y - Position.y[q], d = dhypot(dx, dy);
    if (d > r || d < 1 || this.walled(x, y, q)) return;
    const f = k * (1 - d / r);
    this.host.ships.push(q, (dx / d) * f, (dy / d) * f);
  }

  protected passives(now: number): void {
    this.hammer(now);
    this.burnPools(now);
    this.throwPots(now);
  }
}
