/**
 * The Scrap Mother's moves (her brain, which picks them, is the server's: server/src/game/brains/scrapMother.ts, where
 * her fight is described). The same on both sides: the server runs them for real, a client running her body draws
 * their tells and straight shots from her MOVE, HARASS and PERSONAL decisions (decision-inputs stage 4).
 */
import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { wantAim, wantDrive, wantFace, wantFly, wantHold } from '../decisions.js';
import type { StagedFlightTables } from '../stagedFlight.js';
import { densityCap, type MoveHost, type MoveOrigin } from './host.js';
import { StagedMoves, wrapTurn as wrap, type Move } from './staged.js';

const P = (name: string) => `scrapmother_${name}`;

/** Her moves (a MOVE's index) and her personal attacks (a PERSONAL's name index) */
export const MOTHER_MOVES = ['barrage', 'crane', 'haul', 'shrapnel', 'charge', 'intake', 'spiral', 'scissor', 'seekers'] as const;
export const MOTHER_PERSONAL_NAMES = ['mark', 'rivets', 'mites', 'sludge', 'seeker'] as const;
/** Her personal attacks by stage: the pool, how often they're rolled and how long one runs (fightRules.ts) */
export const MOTHER_PERSONAL = { beat: 120, chance: 0.2, ticks: 300, pool: [['rivets', 'mites'], ['rivets', 'sludge'], ['sludge', 'seeker']] };
/** A signature move puts at most this many shots within DENSITY_R of any pilot (rework 2.3) */
export const DENSITY = 6, DENSITY_R = 800;
/** Tells (ticks): a line attack's warning, an area one's (never shorter: rework 2.4) */
const TELL_LINE = 54, TELL_AREA = 72;
/** The crane's claw: within CRANE_CLEAR of her hull it passes over you; it bites from CRANE_BITE of its reach out (client bossTells.ts the same) */
const CRANE_CLEAR = 600, CRANE_BITE = 0.52, CRANE_W = 260, CRANE_SWEEP = 96, CRANE_BACK = 24;
/** Her rings: chunks in one, the gap's width (chunks) at each flank, how many, how far apart (ticks), and how far she turns between */
const RING_N = 26, RING_GAP = 3, RINGS = 4, RING_EVERY = 36, RING_TURN = 0.2;
/** Her stage-three harassing shot: a spike's glint, then three chunks at where you were (sidestep) */
const POT_WARN = 40, POT_FAN = 0.12;

/** The density cap over pilots' positions (her server host's `cap`) */
export function motherCap(x: number, y: number, angles: number[], pilots: { x: number; y: number }[]): number[] {
  return densityCap(x, y, angles, pilots, DENSITY, DENSITY_R, dcos, dsin, dhypot);
}

export class ScrapMotherMoves extends StagedMoves {
  readonly names = MOTHER_MOVES;
  /** Rivets due down a gun's line (its own frame: where on her, which way), each with the decision it came of */
  private rivets: { part: number; rel: number; at: number; left: number; scale: number; o: MoveOrigin }[] = [];
  /** Sludge pools still burning */
  private pools: { x: number; y: number; next: number; until: number }[] = [];
  /** Harassing chunks due (stage three: from a spike, at where its pilot was when it glinted) */
  private pots: { spike: number; x: number; y: number; at: number; o: MoveOrigin }[] = [];

  constructor(h: MoveHost, eid: number, flight: StagedFlightTables) {
    super(h, eid, flight, [1, 1, 1]);
  }

  make(id: string): Move | null {
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

  onStop(): void {
    this.rivets = [];
    this.pools = [];
    this.pots = [];
  }

  /** Anything of hers still due (rivets down a line, pools, harassing chunks) */
  busy(): boolean {
    return this.rivets.length > 0 || this.pools.length > 0 || this.pots.length > 0;
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
    const ship = this.ship, i = ship.blueprint.parts.findIndex((p) => p.piece === P('s3_core'));
    return i >= 0 && this.alive(i) ? i : -1;
  }

  /** A point ahead of her (her own frame): her maw, her claws' meeting */
  private ahead(d: number): { x: number; y: number } {
    const me = this.me();
    return { x: me.x + dcos(me.angle) * d, y: me.y + dsin(me.angle) * d };
  }

  /** Of these parts, the one whose mount faces a pilot best (round her middle) */
  private facing(parts: number[], t: number): number {
    const me = this.me(), tp = this.at(t), to = datan2(tp.y - me.y, tp.x - me.x);
    const off = (g: number) => { const m = this.mount(g); return Math.abs(wrap(datan2(m.y - me.y, m.x - me.x) - to)); };
    return parts.reduce((a, b) => (off(b) < off(a) ? b : a));
  }

  /** Hold still, facing a heading, for `ticks` */
  private *face(heading: number, ticks: number): Move {
    for (let i = 0; i < ticks; i++) { this.want = wantFace(heading); yield; }
  }

  /** One scrap chunk out of a point this way (`speed`: × a chunk's) */
  private chunk(x: number, y: number, a: number, speed = 1, off = 150): void {
    this.fire('scrap_chunk', x + dcos(a) * off, y + dsin(a) * off, a, 1, speed);
  }

  // ---- Stage one: the hoard ----

  /** A gun swings onto a pilot (where they ARE: never ahead) and draws its line; `n` rivets come down it after `warn` */
  private gun(part: number, t: number, warn: number, n: number, scale = 1): void {
    if (t < 0) return;
    const at = this.bodyFrame(part), m = this.mount(part), me = this.me(), tp = this.at(t);
    const rel = wrap(datan2(tp.y - m.y, tp.x - m.x) - me.angle);
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'rivet', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length: 2800, width: 50, ticks: warn });
    this.rivets.push({ part, rel, at: this.h.tick() + warn, left: n, scale, o: this.h.origin });
  }

  /** Rivets due now fly down their guns' lines */
  private hammer(now: number): void {
    const me = this.me(), o = this.h.origin;
    for (let k = this.rivets.length - 1; k >= 0; k--) {
      const r = this.rivets[k];
      if (now < r.at) continue;
      if (!this.alive(r.part)) { this.rivets.splice(k, 1); continue; }
      const m = this.mount(r.part), a = me.angle + r.rel;
      this.h.origin = r.o;
      this.fire('rivet', m.x + dcos(a) * 40, m.y + dsin(a) * 40, a, r.scale);
      r.at = now + 3;
      if (--r.left <= 0) this.rivets.splice(k, 1);
    }
    this.h.origin = o;
  }

  /** Her wing guns one after another, clockwise, a new line every 27 ticks; she holds still so every line stays where it was drawn */
  private *barrage(): Move {
    const order = this.clockwise(this.working('autocannon')), gap = 27, heading = this.me().angle;
    for (const part of order) {
      if (this.alive(part)) this.gun(part, this.target, TELL_LINE, 5);
      yield* this.face(heading, gap);
    }
    while (this.rivets.length) { this.want = wantFace(heading); yield; }
  }

  /** Her magnets hum and glow; a strong pull towards her front (only there); her claws snap shut across it */
  private *haul(): Move {
    const pullTicks = 90, reach = 3600, r = this.ship.derived.radius;
    for (const m of this.magnets()) this.glow(m, 'glow_green', TELL_AREA + pullTicks, 200);
    yield* this.hold(TELL_AREA);
    const snapAt = pullTicks - 30, claws = this.wrists().length > 0;
    for (let i = 0; i < pullTicks; i++) {
      if (!this.magnets().length) break;
      const p = this.ahead(r * 0.55), me = this.me();
      for (const q of this.h.work?.players() ?? []) {
        // (her front only: beside or behind her, nothing pulls)
        const qp = this.at(q), dx = qp.x - me.x, dy = qp.y - me.y;
        if (dx * dcos(me.angle) + dy * dsin(me.angle) <= 0) continue;
        this.pullOne(q, p.x, p.y, reach, 0.75);
      }
      if (claws && i === snapAt) {
        const tx = r * 0.75;
        for (const w of this.wrists()) {
          const at = this.bodyFrame(w);
          this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'claw', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), angle: datan2(-at.y, tx - at.x), length: Math.round(dhypot(at.y, tx - at.x) + 300), width: 380, ticks: pullTicks - snapAt });
        }
      }
      this.want = wantHold();
      yield;
    }
    if (claws && this.wrists().length) {
      // Snap: down each claw's line to where they meet
      const me = this.me(), c = dcos(me.angle), s = dsin(me.angle);
      const due: { x: number; y: number; at: number }[] = [];
      for (const w of this.wrists()) {
        const at = this.bodyFrame(w), tx = r * 0.75;
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
    const arms = this.cranes(), ship = this.ship;
    // (the arm on the side her target's on first, else the one left)
    const me0 = this.me(), t = this.target, tp = this.at(t);
    const right = t >= 0 && -(tp.x - me0.x) * dsin(me0.angle) + (tp.y - me0.y) * dcos(me0.angle) > 0;
    const first = arms.find((e) => ship.blueprint.parts[e].piece.endsWith(right ? '_r' : '_l')) ?? arms[0];
    const order = [first, ...arms.filter((e) => e !== first)];
    const heading = me0.angle, inner = ship.derived.radius + CRANE_CLEAR, outer = Math.round(inner / CRANE_BITE);
    const sideOf = (e: number) => (this.ship.blueprint.parts[e].piece.endsWith('_r') ? 1 : -1);
    // Tell: two amber blinks on the first elbow (two short glows), the arm's start line faint
    this.glow(first, 'glow_amber', 26, 170);
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'crane', bodyId: this.eid, x: 0, y: 0, angle: sideOf(first) * 1.75, length: outer, width: CRANE_W, ticks: TELL_AREA });
    yield* this.face(heading, 34);
    this.glow(first, 'glow_amber', 26, 170);
    yield* this.face(heading, TELL_AREA - 34);
    for (let n = 0; n < order.length; n++) {
      const elbow = order[n], side = sideOf(elbow);
      if (this.named(this.ship.blueprint.parts[elbow].piece) < 0) continue;
      const a0 = side * 1.75, a1 = -side * 1.75;
      this.h.fx({ type: 'bossBeam', kind: 'crane', bodyId: this.eid, x: 0, y: 0, a0, a1, ticks: CRANE_SWEEP, length: outer, width: CRANE_W });
      const struck = new Set<number>(), next = order[n + 1];
      for (let i = 0; i < CRANE_SWEEP; i++) {
        // (the next arm's lamp blinks as this one goes: it's coming back the other way)
        if (next !== undefined && (i === CRANE_SWEEP - 50 || i === CRANE_SWEEP - 20)) this.glow(next, 'glow_amber', 22, 170);
        const me = this.me(), a = me.angle + a0 + (a1 - a0) * (i / CRANE_SWEEP);
        const x0 = me.x + dcos(a) * inner, y0 = me.y + dsin(a) * inner, x1 = me.x + dcos(a) * outer, y1 = me.y + dsin(a) * outer;
        // (a struck pilot's flash goes from the server: it's the hit's)
        for (const q of this.cut(x0, y0, x1, y1, CRANE_W / 2, 75, { type: 'kinetic', pen: 1 }, struck)) {
          const qp = this.at(q);
          this.h.work?.say({ type: 'detonation', kind: 'scrap', x: Math.round(qp.x), y: Math.round(qp.y), radius: 180 });
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
    const ticks = 120, r = this.ship.derived.radius, half = 500, turn = 0.09;
    let heading = this.me().angle;
    const throat = this.named(P('throat')), at = this.bodyFrame(throat);
    this.glow(throat, 'glow_green', TELL_AREA + ticks, 260);
    for (const ro of this.rotors()) this.glow(ro, 'grind', TELL_AREA + ticks, 160);
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'intake', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), angle: 0, length: 3000, width: half * 2, ticks: TELL_AREA + ticks });
    yield* this.face(heading, TELL_AREA);
    const grind = this.rotors().length;
    for (let i = 0; i < ticks; i++) {
      if (this.named(P('throat')) < 0) break;
      const maw = this.ahead(r * 0.45), me = this.me(), c = dcos(me.angle), s = dsin(me.angle);
      for (const q of this.h.work?.players() ?? []) {
        // (in the lane only: out of it sideways, nothing pulls)
        const qp = this.at(q), dx = qp.x - maw.x, dy = qp.y - maw.y, along = dx * c + dy * s, across = -dx * s + dy * c;
        if (along < -200 || along > 3000 || Math.abs(across) > half) continue;
        this.pullOne(q, maw.x, maw.y, 3000, 0.6);
      }
      if (grind && i % 10 === 0) this.land([{ x: maw.x, y: maw.y, at: 0 }], 420 + 100 * grind, 26 * grind, 'scrap');
      // (the lane follows its target, slowly, a step every 15 ticks (each a want: a decision): keep going sideways)
      const t = this.target;
      if (t >= 0 && i % 15 === 14) { const tp = this.at(t); heading += Math.max(-turn, Math.min(turn, wrap(datan2(tp.y - me.y, tp.x - me.x) - heading))); }
      this.want = wantFace(heading);
      yield;
    }
  }

  /**
   * Her stacks puff three times; four rings of fast chunks out to the walls, the gaps at her flanks as she faces when
   * each is thrown; she turns a little between rings (always the same way in one volley), so the gaps follow her flanks
   */
  private *shrapnel(): Move {
    const stacks = this.named(P('stacks')), turn = this.rnd() < 0.5 ? RING_TURN : -RING_TURN;
    let heading = this.me().angle;
    for (let k = 0; k < 3; k++) { this.glow(stacks, 'smoke', 22, 260); yield* this.face(heading, 24); }
    for (let ring = 0; ring < RINGS; ring++) {
      if (this.named(P('stacks')) < 0) return;
      const c = this.mount(stacks), h = this.me().angle, angles: number[] = [];
      for (let j = 0; j < RING_N; j++) {
        const a = h + (j / RING_N) * Math.PI * 2;
        // (the gaps: either side of her flanks, every ring)
        const off = wrap(a - h);
        if (Math.abs(Math.abs(off) - Math.PI / 2) < (RING_GAP / RING_N) * Math.PI) continue;
        angles.push(a);
      }
      for (const a of this.h.cap(c.x, c.y, angles)) this.chunk(c.x, c.y, a);
      heading = h + turn;
      yield* this.face(heading, RING_EVERY);
    }
  }

  /** Her drives flare white as she lines up on where you are; then she rams straight, not turning; spent, she drifts */
  private *charge(): Move {
    const t = this.target, r = this.ship.derived.radius, drives = this.drives();
    for (const d of drives) this.glow(d, 'glow_white', TELL_LINE + 6, 180);
    for (let i = 0; i < TELL_LINE; i++) {
      if (i === 18) this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'ram', bodyId: this.eid, x: 0, y: 0, angle: 0, length: 3600, width: Math.round(r * 1.1), ticks: TELL_LINE - 18 });
      this.want = t >= 0 ? wantAim() : wantHold();
      yield;
    }
    const me = this.me();
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
    const welders = this.working('arc'), t = this.target;
    // (she turns onto her target first: the cross is ahead of her, where you are)
    let heading = this.me().angle;
    if (t >= 0) { const me = this.me(), tp = this.at(t); heading = datan2(tp.y - me.y, tp.x - me.x); }
    const sweep = 64, length = 7000, width = 70;
    for (const w of welders) this.glow(w, 'glow_white', TELL_LINE, 150);
    const arms = welders.map((w) => {
      const at = this.bodyFrame(w), side = at.y < 0 ? -1 : 1;
      return { w, at, a0: side * 1.0, a1: -side * 0.18 };
    });
    for (const a of arms) this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'weld', bodyId: this.eid, x: Math.round(a.at.x), y: Math.round(a.at.y), angle: a.a0, length, width, ticks: TELL_LINE });
    yield* this.face(heading, TELL_LINE);
    // In until they cross, then straight back out
    for (let i = 0; i < sweep * 2; i++) {
      if (i === 0 || i === sweep) for (const a of arms) {
        const [b0, b1] = i === 0 ? [a.a0, a.a1] : [a.a1, a.a0];
        this.h.fx({ type: 'bossBeam', kind: 'weld', bodyId: this.eid, x: Math.round(a.at.x), y: Math.round(a.at.y), a0: b0, a1: b1, ticks: sweep, length, width });
      }
      const k = i < sweep ? i / sweep : 1 - (i - sweep) / sweep;
      for (const a of arms) if (this.alive(a.w)) this.beam(a.at, a.a0 + (a.a1 - a.a0) * k, length, width, 9);
      this.want = wantFace(heading);
      yield;
    }
  }

  /** Her core pulses green twice as she darts once to a new angle; then four arms of fast chunks spun out one way only, out to the walls */
  private *spiral(): Move {
    const ticks = 180, every = 10, arms = 4, spin = this.rnd() < 0.5 ? 0.2 : -0.2;
    this.glow(this.core(), 'glow_green', 36, 260);
    yield* this.dart(1000, 20, 30);
    this.glow(this.core(), 'glow_green', 36, 260);
    yield* this.hold(30);
    let base = this.rnd() * Math.PI * 2;
    for (let i = 0; i < ticks; i++) {
      if (this.core() < 0) return;
      if (i % every === 0) {
        const c = this.mount(this.core()), angles: number[] = [];
        for (let k = 0; k < arms; k++) angles.push(base + (k / arms) * Math.PI * 2);
        for (const a of this.h.cap(c.x, c.y, angles)) this.chunk(c.x, c.y, a);
        base += spin;
      }
      this.want = wantHold();
      yield;
    }
  }

  /** Her four spikes chime one after another; then eight seekers in all, two waves of four, shared among the pilots she can see */
  private *seekers(): Move {
    const who = this.pilots(6000);
    for (const s of this.spikes()) { this.glow(s, 'chime', 30, 140); yield* this.hold(14); }
    if (!who.length) return;
    for (let wave = 0; wave < 2; wave++) {
      const spikes = this.spikes(), me = this.me();
      for (let k = 0; k < 4 && spikes.length; k++) {
        const n = wave * 4 + k, s = spikes[k % spikes.length], m = this.mount(s), out = datan2(m.y - me.y, m.x - me.x);
        const a = out + (wave - 0.5) * 0.5;
        const w = this.h.work;
        // (homing: its guide is the server's)
        w?.homing('seam_seeker', m.x + dcos(a) * 60, m.y + dsin(a) * 60, a, w.damageScale, who[n % who.length]);
      }
      for (let i = 0; i < 40; i++) { this.want = wantFly(); yield; }
    }
  }

  // ---- Her light threat (the brain's harass): between moves and in her window ----

  /** A gun facing the pilot draws a thin line and puts 2 rivets down it (stages one and two); a spike glints (the glint: an aimed shot) and throws three chunks at where they were (three) */
  harassShot(t: number): boolean {
    const guns = [...this.working('autocannon'), ...this.working('flak')];
    if (guns.length) { this.gun(this.facing(guns, t), t, TELL_LINE, 2, 0.8); return true; }
    const spikes = this.spikes();
    if (!spikes.length) return false;
    const s = this.facing(spikes, t), tp = this.at(t);
    this.glow(s, 'glint', POT_WARN, 120);
    this.pots.push({ spike: s, x: tp.x, y: tp.y, at: this.h.tick() + POT_WARN, o: this.h.origin });
    return true;
  }

  /** Harassing chunks due: three at where the pilot was when the spike glinted (sidestep) */
  private throwPots(now: number): void {
    const o = this.h.origin;
    for (let k = this.pots.length - 1; k >= 0; k--) {
      const p = this.pots[k];
      if (now < p.at) continue;
      this.pots.splice(k, 1);
      if (!this.alive(p.spike)) continue;
      this.h.origin = p.o;
      const m = this.mount(p.spike), a = datan2(p.y - m.y, p.x - m.x);
      for (let j = -1; j <= 1; j++) this.chunk(m.x, m.y, a + j * POT_FAN, 1, 60);
    }
    this.h.origin = o;
  }

  // ---- Personal attacks (rework 4.3): one pilot's own, local to them ----

  personalMove(name: string, target: number, seed: number): Move | null {
    switch (name) {
      case 'rivets': return this.markedRivets(target);
      case 'mites': return this.h.mobs && this.working('brood_bay').length ? this.mites(target, seed) : null;
      case 'sludge': return this.sludge(target);
      case 'seeker': return this.spikes().length ? this.loneSeeker(target) : null;
    }
    return super.personalMove(name, target, seed);
  }

  /** The gun (or flak mount) facing a pilot clanks onto them and draws a thin line; 4 rivets down it 0.9 s later */
  private *markedRivets(t: number): Move {
    const guns = [...this.working('autocannon'), ...this.working('flak')];
    if (!guns.length) return;
    this.gun(this.facing(guns, t), t, 54, 4);
    for (let i = 0; i < 70; i++) yield;
  }

  /** A brood rack on the pilot's side flickers amber; two mites hunt them (55 HP, 19 u/tick) until they burst or run out */
  private *mites(t: number, seed: number): Move {
    const rack = this.facing(this.working('brood_bay'), t);
    this.glow(rack, 'glow_amber', 50, 180);
    for (let i = 0; i < 50; i++) yield;
    if (!this.alive(rack)) return;
    const m = this.mount(rack);
    this.launchFx(m.x, m.y);
    const w = this.h.work;
    if (!w) return;
    for (let k = 0; k < 2; k++) {
      const a = m.dir + (k - 0.5) * 0.6 + ((seed & 7) - 3.5) * 0.02;
      w.mob('scrap_mite', m.x + dcos(a) * 30, m.y + dsin(a) * 30, a, 12, w.damageScale, t);
    }
  }

  /** A vat burps; a faint circle where the pilot will be in 1.3 s, on their line; it lands, then pools 3 s */
  private *sludge(t: number): Move {
    const warn = 78, radius = 230, at = this.h.tick() + warn;
    const vat = this.vats()[0] ?? this.core();
    if (vat >= 0) this.glow(vat, 'smoke', 30, 180);
    // (on their line: where they're going, so the rule is change direction)
    const tp = this.at(t), x = tp.x + tp.vx * warn, y = tp.y + tp.vy * warn;
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'sludge', x: Math.round(x), y: Math.round(y), radius, ticks: warn });
    const due = [{ x, y, at }];
    while (this.h.tick() < at) yield;
    this.land(due, radius, 70, 'sludge');
    const n = this.h.tick();
    this.pools.push({ x, y, next: n + 20, until: n + 180 });
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'pool', x: Math.round(x), y: Math.round(y), radius, ticks: 180 });
  }

  /** Pools still burning hurt what's in them (the server's) */
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
    const me = this.me(), s = this.facing(this.spikes(), t);
    this.glow(s, 'chime', 40, 140);
    for (let i = 0; i < 40; i++) yield;
    if (!this.alive(s)) return;
    const m = this.mount(s), a = datan2(m.y - me.y, m.x - me.x), w = this.h.work;
    w?.homing('seam_seeker', m.x + dcos(a) * 60, m.y + dsin(a) * 60, a, w.damageScale, t);
  }

  passives(now: number): void {
    this.hammer(now);
    this.burnPools(now);
    this.throwPots(now);
  }
}
