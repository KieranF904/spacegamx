/**
 * The Scrap Mother (her nest in the Drift, past Nereid): a nest the size of a station, welded out of salvage
 * (scripts/bespoke/scrap_mother.mjs). Three stages, each its own fight, the last the hardest (staged.ts, docs/boss-design.md):
 *
 * Stage one, the hoard (her nest wings, crane arms, grapple booms): she holds off, her guns doing the work.
 *
 *   barrage      her wing guns one after another, clockwise: each draws a yellow line, then hammers rivets down it
 *   haul         her electromagnets wind up (green rings closing on her), then drag you in; her claws draw red lines
 *                and snap shut ahead of her. Thrust away, or get out of her front. Shoot a magnet off, less pull;
 *                both claws off, no snap
 *   brood        her egg racks hatch scrap mites that hunt you down and burst. Shoot the racks off: no more
 *
 *   Between moves her guns fire now and then. Every slab gone, she stops, can't be hurt, and blows her scaffold
 *   apart where each slab was; then her nest is gone.
 *
 * Stage two, the mill (her body): lighter, she drives harder and closes in.
 *
 *   intake       she turns her maw on you, draws a green lane, then sucks you in towards her grinding rotors (close
 *                to her maw, you're ground). Wreck the throat, no intake; wreck the rotors, no grinding
 *   slag         her vats lob sludge where you are and where you're going; it lands and pools, burning a while
 *   shrapnel     her stacks gather, then throw rings of great scrap chunks, two gaps in each (never where you are),
 *                the gaps turning
 *   charge       only if you keep away from her, now and then: she lines up and rams; spent, she drifts
 *   flak         (always) her turrets burst flak round you between moves
 *
 *   Each piece worn out is left a wreck. Every piece wrecked, she stops and her body blows apart, its core last.
 *
 * Stage three, the seed (her heart): small and quick, darting to a new angle before every move.
 *
 *   scissor      her two arc welders draw lines wide either side, then sweep their beams in until they cross ahead
 *                of her: get between them close in, or well out to the side
 *   seekers      her greyseam spikes loose seekers that hunt you
 *   spiral       arms of scrap chunks spun out of her core, turning back halfway, and fans thrown where you're going
 *   iris         her iris opens (a breathing green ring round her): rings of chunks from her core, and the only time
 *                she takes full damage. Braced, she takes far less, your hits glancing; shoot her spikes off and she
 *                can't brace at all
 *
 *   Her round (core, iris, servo ring) wrecks, cracking as it's worn; all wrecked, she shudders and every piece
 *   blows apart at once.
 *
 * From her last phase she's enraged: quicker, warns you for less time, more of everything.
 */

import { Position, datan2, dcos, dhypot, dsin } from '@space-game/common';
import { bodyFrame, lead, pose, wrap } from './kit.js';
import type { BrainHost } from './kit.js';
import { StagedBrain, type Move } from './staged.js';

const P = (name: string) => `scrapmother_${name}`;
/** Her stage two's charge: kept away this far, this long (ticks), no sooner than this after the last */
const CHARGE_AWAY = 2800, CHARGE_WAIT = 240, CHARGE_COOL = 1200;
/** What she takes of a hit in her seed: braced, and with her iris open */
const BRACED = 0.4, OPEN = 1.5;
/** Between moves: ticks between her guns' bursts (stage one) and flak (stage two) */
const IDLE_GUNS = 85, IDLE_FLAK = 70;

export class ScrapMotherBrain extends StagedBrain {
  /** Rivets due down a gun's line (its own frame: where on her, which way) */
  private rivets: { part: number; rel: number; at: number; left: number }[] = [];
  /** Sludge pools still burning */
  private pools: { x: number; y: number; next: number; until: number }[] = [];
  private nextIdle = 0;
  private turn = 0;
  private away = -1;
  private nextCharge = 0;
  private irisUntil = -1;

  constructor(host: BrainHost) {
    super(host, {
      loop: [['barrage', 'haul', 'brood'], ['intake', 'slag', 'shrapnel'], ['scissor', 'seekers', 'spiral', 'iris']],
      range: [2100, 1500, 1200], circle: [0.3, 0.4, 0.55], rest: [95, 75, 60], haste: [1, 0.85, 0.75],
      drive: [0.12, 0.2, 0.3], homeR: 5000,
    });
  }

  protected make(id: string): Move | null {
    switch (id) {
      case 'barrage': return this.working('autocannon').length ? this.barrage() : null;
      case 'haul': return this.magnets().length ? this.haul() : null;
      case 'brood': return this.working('brood_bay').length && this.host.mobs ? this.brood() : null;
      case 'intake': return this.named(P('throat')) >= 0 ? this.intake() : null;
      case 'slag': return this.vats().length ? this.slag() : null;
      case 'shrapnel': return this.named(P('stacks')) >= 0 ? this.shrapnel() : null;
      case 'scissor': return this.working('arc').length ? this.scissor() : null;
      case 'seekers': return this.spikes().length ? this.seekers() : null;
      case 'spiral': return this.core() >= 0 ? this.spiral() : null;
      case 'iris': return this.core() >= 0 ? this.iris() : null;
    }
    return null;
  }

  protected interrupt(now: number): Move | null {
    if (this.stage !== 2 || this.target < 0) return null;
    const me = pose(this.view.eid), t = this.target;
    if (dhypot(Position.x[t] - me.x, Position.y[t] - me.y) > CHARGE_AWAY) { if (this.away < 0) this.away = now; } else this.away = -1;
    if (this.away >= 0 && now - this.away > CHARGE_WAIT && now >= this.nextCharge && this.fromHome(Position.x[t], Position.y[t]) < this.tables.homeR + 2500) {
      this.nextCharge = now + CHARGE_COOL;
      this.away = -1;
      return this.charge();
    }
    return null;
  }

  protected around(m: Move): Move {
    return this.stage === 3 ? this.darting(m) : m;
  }

  private *darting(m: Move): Move {
    yield* this.dart(1000, 20, 24);
    yield* m;
  }

  protected onStop(): void {
    this.rivets = [];
    this.pools = [];
    this.irisUntil = -1;
  }

  // ---- Her parts ----

  private magnets(): number[] { return [this.named(P('magnet_l')), this.named(P('magnet_r'))].filter((i) => i >= 0); }
  private wrists(): number[] { return [this.named(P('wrist_l')), this.named(P('wrist_r'))].filter((i) => i >= 0); }
  private rotors(): number[] { return [this.named(P('rotor_l')), this.named(P('rotor_r'))].filter((i) => i >= 0); }
  private vats(): number[] { return [this.named(P('vat_l')), this.named(P('vat_r'))].filter((i) => i >= 0); }
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

  // ---- Stage one: the hoard ----

  /** A gun draws its line at its target, then hammers `n` rivets down it */
  private gun(part: number, warn: number, n: number): void {
    const t = this.target;
    if (t < 0) return;
    const at = bodyFrame(this.host, this.view.eid, this.ship, part), m = this.mount(part), me = pose(this.view.eid);
    const rel = wrap(this.aimAt(t, m.x, m.y, 34) - me.angle);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'rivet', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length: 2800, width: 70, ticks: warn });
    this.rivets.push({ part, rel, at: this.host.tick() + warn, left: n });
  }

  /** Rivets due now fly down their guns' lines (the line turns with her: it rides her hull) */
  private hammer(now: number): void {
    const me = pose(this.view.eid);
    for (let k = this.rivets.length - 1; k >= 0; k--) {
      const r = this.rivets[k];
      if (now < r.at) continue;
      if (!this.ship.derived.alive[r.part]) { this.rivets.splice(k, 1); continue; }
      const m = this.mount(r.part), a = me.angle + r.rel;
      this.host.fire(this.view.eid, 'rivet', m.x + dcos(a) * 40, m.y + dsin(a) * 40, a, this.view.damage);
      r.at = now + 3;
      if (--r.left <= 0) this.rivets.splice(k, 1);
    }
  }

  /** Her wing guns one after another, clockwise, twice round */
  private *barrage(): Move {
    const order = this.clockwise(this.working('autocannon')), warn = this.haste(28), gap = this.haste(13);
    for (let round = 0; round < 2; round++) {
      for (const part of order) {
        if (this.ship.derived.alive[part]) this.gun(part, warn, 4);
        for (let i = 0; i < gap; i++) { this.want = {}; yield; }
      }
    }
    while (this.rivets.length) { this.want = {}; yield; }
  }

  /** Her magnets wind up, then drag you in; her claws snap shut ahead of her */
  private *haul(): Move {
    const eid = this.view.eid, warn = this.haste(55), pullTicks = 100, reach = 3600;
    const share = this.magnets().length / 2;
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'magnet', bodyId: eid, x: 0, y: 0, radius: reach, ticks: warn + pullTicks });
    for (const m of this.magnets()) { const w = this.mount(m); this.host.launchFx(this.view.systemNum, w.x, w.y); }
    yield* this.hold(warn);
    const snapAt = pullTicks - this.haste(30), claws = this.wrists().length > 0;
    const r = this.ship.derived.radius;
    for (let i = 0; i < pullTicks; i++) {
      const p = this.ahead(r * 0.55);
      this.pull(p.x, p.y, reach, 0.55 * share * (1 + 0.15 * (this.view.fighters - 1)));
      if (claws && i === snapAt) {
        // The claws' lines: from each wrist in across her front to where they meet (her own frame: nose along +x)
        const tx = r * 0.75;
        for (const w of this.wrists()) {
          const at = bodyFrame(this.host, eid, this.ship, w);
          this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'claw', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: datan2(-at.y, tx - at.x), length: Math.round(dhypot(at.y, tx - at.x) + 300), width: 380, ticks: pullTicks - snapAt });
        }
      }
      this.want = { move: 'hold' };
      yield;
    }
    if (!claws) return;
    // Snap: down each claw's line and where they meet
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
    yield* this.hold(30);
  }

  /** Her egg racks hatch scrap mites */
  private *brood(): Move {
    const mobs = this.host.mobs!, eid = this.view.eid;
    for (const d of [...this.drones]) if (!mobs.has(d)) this.drones.delete(d);
    const cap = 8 + 4 * this.view.fighters;
    for (const bay of this.working('brood_bay')) {
      const m = this.mount(bay);
      this.host.launchFx(this.view.systemNum, m.x, m.y);
      const n = 3 + (this.rage() < 1 ? 1 : 0) + Math.floor((this.view.fighters - 1) / 2);
      for (let i = 0; i < n && this.drones.size < cap; i++) {
        const a = m.dir + (i / Math.max(1, n - 1) - 0.5) * 0.9;
        const d = mobs.spawn('scrap_mite', this.view.systemNum, m.x + dcos(a) * 30, m.y + dsin(a) * 30, a, 12, eid, this.view.damage);
        if (d >= 0) this.drones.add(d);
      }
    }
    for (let i = 0; i < 45; i++) { this.want = {}; yield; }
  }

  // ---- Stage two: the mill ----

  /** Her maw turns on you, draws a lane, then sucks you in towards her grinding rotors */
  private *intake(): Move {
    const eid = this.view.eid, warn = this.haste(50), ticks = 110, r = this.ship.derived.radius;
    yield* this.hold(18);
    const throat = this.named(P('throat')), at = bodyFrame(this.host, eid, this.ship, throat);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'intake', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: 0, length: 3000, width: 1000, ticks: warn + ticks });
    yield* this.hold(warn);
    const grind = this.rotors().length;
    for (let i = 0; i < ticks; i++) {
      if (this.named(P('throat')) < 0) return;
      const maw = this.ahead(r * 0.45);
      this.pull(maw.x, maw.y, 3000, 0.6);
      if (grind && i % 10 === 0) this.land([{ x: maw.x, y: maw.y, at: 0 }], 520 + 120 * grind, 26 * grind, 'scrap');
      this.want = { move: 'hold' };
      yield;
    }
  }

  /** Her vats lob sludge where you are and where you're going: it lands, then pools a while */
  private *slag(): Move {
    const t = this.target, warn = this.haste(70), radius = 230, now = this.host.tick();
    const spots: [number, number][] = [];
    for (const v of this.vats()) {
      const m = this.mount(v);
      this.host.launchFx(this.view.systemNum, m.x, m.y);
      const here = lead(t, 0), ahead = lead(t, warn * 0.8), side = this.host.rng() * Math.PI * 2;
      spots.push([here.x, here.y], [ahead.x, ahead.y], [ahead.x + dcos(side) * 450, ahead.y + dsin(side) * 450]);
    }
    for (const q of this.pilots().slice(1)) { const l = lead(q, warn * 0.6); spots.push([l.x, l.y]); }
    const due = spots.map(([x, y], i) => {
      const ticks = warn + i * 4;
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'sludge', x: Math.round(x), y: Math.round(y), radius, ticks });
      return { x, y, at: now + ticks };
    });
    while (due.length) {
      const before = due.length, n = this.host.tick();
      const landing = due.filter((d) => n >= d.at);
      this.land(due, radius, 70, 'sludge');
      if (due.length < before) for (const d of landing) {
        this.pools.push({ x: d.x, y: d.y, next: n + 20, until: n + 150 });
        this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'pool', x: Math.round(d.x), y: Math.round(d.y), radius, ticks: 150 });
      }
      this.want = {};
      yield;
    }
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

  /** One scrap chunk out of a point this way (`speed`: × a chunk's) */
  private chunk(x: number, y: number, a: number, speed = 1, off = 150): void {
    this.host.fire(this.view.eid, 'scrap_chunk', x + dcos(a) * off, y + dsin(a) * off, a, this.view.damage, { speed });
  }

  /** A ring of chunks from a point, two gaps in it (the first ring solid where its target is) */
  private ring(c: { x: number; y: number }, n: number, gapW: number, off: number): void {
    for (let j = 0; j < n; j++) {
      if (j < gapW || (j >= n / 2 && j < n / 2 + gapW)) continue;
      this.chunk(c.x, c.y, off + (j / n) * Math.PI * 2);
    }
  }

  /** A warning on a part: something's coming out of it */
  private *gather(part: number, ticks: number, radius = 260): Move {
    const at = bodyFrame(this.host, this.view.eid, this.ship, part);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'gather', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius, ticks });
    for (let i = 0; i < ticks; i++) { this.want = { move: 'hold' }; yield; }
  }

  /** Her stacks gather, then throw rings of chunks, the gaps turning */
  private *shrapnel(): Move {
    const stacks = this.named(P('stacks')), rings = this.rage() < 1 ? 4 : 3, n = 26, gapW = 3, every = this.haste(45);
    yield* this.gather(stacks, this.haste(34), 320);
    const c0 = this.mount(stacks), t = this.target;
    let off = datan2(Position.y[t] - c0.y, Position.x[t] - c0.x) - Math.PI / 2 - (gapW / 2 / n) * Math.PI * 2;
    for (let r = 0; r < rings; r++) {
      if (this.named(P('stacks')) < 0) return;
      this.ring(this.mount(stacks), n, gapW, off);
      off += 0.45;
      for (let i = 0; i < every; i++) { this.want = {}; yield; }
    }
  }

  /** Turn, warn down her width, and ram; spent, she drifts */
  private *charge(): Move {
    const t = this.target, wind = this.haste(90), r = this.ship.derived.radius;
    let me = pose(this.view.eid);
    for (let i = 0; i < wind; i++) {
      me = pose(this.view.eid);
      const at = lead(t, 25);
      if (i === 18) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'charge', bodyId: this.view.eid, x: 0, y: 0, angle: 0, length: 3600, width: r * 1.1, ticks: wind - 18 });
      this.want = { move: 'hold', face: datan2(at.y - me.y, at.x - me.x) };
      yield;
    }
    me = pose(this.view.eid);
    const vx = dcos(me.angle), vy = dsin(me.angle);
    let room = 0;
    for (let s = 0; s < 4 * this.tables.homeR; s += 200) { if (this.fromHome(me.x + vx * s, me.y + vy * s) > this.tables.homeR + 1500) break; room = s; }
    const speed = Math.max(12, Math.min(26, room / 66));
    this.want = { impulse: [vx * speed, vy * speed], move: [vx, vy], face: me.angle };
    yield;
    for (let i = 0; i < 40; i++) { this.want = { move: [vx, vy], face: me.angle }; yield; }
    for (let i = 0; i < 60; i++) { this.want = { move: 'hold' }; yield; }
  }

  // ---- Stage three: the seed ----

  /** Her two welders draw lines wide either side, then sweep their beams in until they cross ahead of her */
  private *scissor(): Move {
    const eid = this.view.eid, welders = this.working('arc');
    yield* this.hold(16);
    const heading = pose(eid).angle, warn = this.haste(48), ticks = this.haste(85), length = 7000, width = 70;
    const arms = welders.map((w) => {
      const at = bodyFrame(this.host, eid, this.ship, w), side = at.y < 0 ? -1 : 1;
      return { w, at, a0: side * 1.0, a1: -side * 0.18 };
    });
    for (const a of arms) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'weld', bodyId: eid, x: Math.round(a.at.x), y: Math.round(a.at.y), angle: a.a0, length, width, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = { move: 'hold', face: heading }; yield; }
    for (const a of arms) this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'weld', bodyId: eid, x: Math.round(a.at.x), y: Math.round(a.at.y), a0: a.a0, a1: a.a1, ticks, length, width });
    for (let i = 0; i < ticks; i++) {
      for (const a of arms) if (this.ship.derived.alive[a.w]) this.beam(a.at, a.a0 + (a.a1 - a.a0) * (i / ticks), length, width, 9);
      this.want = { move: 'hold', face: heading };
      yield;
    }
  }

  /** Her greyseam spikes loose seekers, outwards, then hunting */
  private *seekers(): Move {
    const eid = this.view.eid, who = this.pilots(6000), spikes = this.spikes();
    if (!who.length) return;
    for (const s of spikes) yield* this.gather(s, Math.max(6, Math.round(this.haste(30) / spikes.length)), 140);
    let k = 0;
    const per = this.rage() < 1 ? 3 : 2;
    for (const s of this.spikes()) {
      const m = this.mount(s), out = datan2(m.y - Position.y[eid], m.x - Position.x[eid]);
      for (let j = 0; j < per; j++) {
        const a = out + (j / Math.max(1, per - 1) - 0.5) * 0.7;
        this.host.fire(eid, 'seam_seeker', m.x + dcos(a) * 60, m.y + dsin(a) * 60, a, this.view.damage, { target: who[k++ % who.length] });
      }
    }
    for (let i = 0; i < 50; i++) { this.want = {}; yield; }
  }

  /** Where her core is, in the world */
  private coreAt(): { x: number; y: number } {
    const m = this.mount(this.core());
    return { x: m.x, y: m.y };
  }

  /** A quick fan of chunks out of her core at where her target's going */
  private fan(count: number, spread: number): void {
    const t = this.target;
    if (t < 0) return;
    const c = this.coreAt(), a0 = this.aimAt(t, c.x, c.y, 11 * 1.35);
    for (let k = 0; k < count; k++) this.chunk(c.x, c.y, a0 + (k / Math.max(1, count - 1) - 0.5) * spread, 1.35);
  }

  /** Arms of chunks spun out of her core, every other volley slower, turning back halfway; fans now and then */
  private *spiral(): Move {
    const arms = this.rage() < 1 ? 5 : 4, ticks = this.rage() < 1 ? 200 : 160, every = 12, aimed = this.haste(40);
    let base = this.host.rng() * Math.PI * 2, spin = 0.24;
    yield* this.gather(this.core(), this.haste(30));
    for (let i = 0; i < ticks; i++) {
      if (this.core() < 0) return;
      if (i === ticks / 2) spin = -spin;
      if (i % every === 0) {
        const c = this.coreAt(), slow = (i / every) % 2 === 1;
        for (let k = 0; k < arms; k++) this.chunk(c.x, c.y, base + (k / arms) * Math.PI * 2, slow ? 0.6 : 1);
        base += spin;
      }
      if (i % aimed === Math.floor(aimed / 2)) this.fan(3, 0.45);
      this.want = { move: 'hold' };
      yield;
    }
  }

  /** Her iris opens: rings of chunks from her core, and she takes full damage (more) while it's open */
  private *iris(): Move {
    const eid = this.view.eid, open = this.rage() < 1 ? 140 : 170, rings = 3, n = 24, gapW = 3;
    const reach = this.ship.derived.radius * 0.55;
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'iris', bodyId: eid, x: 0, y: 0, radius: Math.round(reach + 300), ticks: open });
    this.irisUntil = this.host.tick() + open;
    const c0 = this.coreAt(), t = this.target;
    let off = t >= 0 ? datan2(Position.y[t] - c0.y, Position.x[t] - c0.x) - Math.PI / 2 - (gapW / 2 / n) * Math.PI * 2 : 0;
    for (let i = 0; i < open; i++) {
      if (i > 20 && (i - 20) % 40 === 0 && (i - 20) / 40 < rings && this.core() >= 0) { this.ring(this.coreAt(), n, gapW, off); off += 0.5; }
      this.want = { move: 'hold' };
      yield;
    }
    this.irisUntil = -1;
  }

  /** What she takes of a hit: in her seed, braced unless her iris is open (no spikes left, she can't brace) */
  taken(): number {
    if (this.stage !== 3 || this.dying || !this.ship) return 1;
    if (this.host.tick() < this.irisUntil) return OPEN;
    return this.spikes().length ? BRACED : 1;
  }

  // ---- Always on ----

  protected passives(now: number): void {
    this.hammer(now);
    this.burnPools(now);
    if (this.move || now < this.nextIdle || this.target < 0) return;
    if (this.stage === 1) {
      const guns = this.working('autocannon');
      if (guns.length) this.gun(guns[this.turn++ % guns.length], this.haste(36), 3);
      this.nextIdle = now + Math.round(IDLE_GUNS / (1 + 0.15 * (this.view.fighters - 1)));
    } else if (this.stage === 2) {
      const t = this.target;
      for (const f of this.working('flak')) {
        const m = this.mount(f);
        this.host.fire(this.view.eid, 'flak', m.x, m.y, this.aimAt(t, m.x, m.y, 34), this.view.damage * 0.6);
      }
      this.nextIdle = now + Math.round(IDLE_FLAK / (1 + 0.15 * (this.view.fighters - 1)));
    }
  }
}
