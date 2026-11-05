/**
 * Custom enemies (docs/enemies/custom-roster.md): designs of their own pieces (data/ships/bespoke) put in a ship type's
 * place wherever it spawns (factions.json custom.types). The enemy AI thinks for them as for any ship (Enemies.fly);
 * this adds what's theirs:
 *
 *   adopt   a new one's pieces' HP (factions.json custom.designs hp, by grade) and its damage scale
 *   order   its engage order as a custom one (common bodies/custom/order.ts): its design, the pieces it has lost (one
 *           byte) and the move under way, a move picked here when it may start (the commander's; its seed rolled from
 *           this server's own stream). Its body flies it, on every client running it too
 *   act     what the move under way does to the world this tick (custom/moves.ts), and its guns between moves
 *
 * Grades scale its hp and damage (custom.grades), not its materials: its look is its design's at every grade.
 */
import {
  AI_ORDER, InSystem, Position, Rotation, Velocity, customIndex, customOrder, customGroups, groupsGone, localToWorldDir, mulberry32, shipPointToWorld, datan2, dcos, dhypot, dsin,
  CUSTOM_DESIGNS, type ShipState, type WantRec,
} from '@space-game/common';
import { MOVES } from './moves.js';
import type { Act, CustomHost, CustomLive, CustomStats, CustomTable } from './types.js';

/** Ticks of a target's velocity kept, to see how it's turning; the most it's taken to turn a tick (radians) */
const TRAIL = 10, TURN_MAX = 0.05;

export class CustomEnemies {
  /** Moves started, by design and move ("censer.lance"), and pieces lost */
  readonly stats = { moves: {} as Record<string, number>, lost: 0 };
  private readonly live = new Map<number, CustomLive>();
  /** Each target's velocity over its last TRAIL ticks (newest last), and the tick it was last noted */
  private readonly trail = new Map<number, { at: number; v: number[] }>();
  private readonly rng = mulberry32(0xc0ffee);

  constructor(private readonly host: CustomHost, private readonly table: CustomTable | undefined) {}

  /** The custom design a ship type spawns as (undefined: a grid design, its own) */
  designOf(type: string): string | undefined {
    const d = this.table?.types[type];
    return d && this.table?.designs[d] && customIndex(d) >= 0 ? d : undefined;
  }

  /** A custom type's numbers */
  statsOf(type: string): CustomStats | undefined {
    const d = this.designOf(type);
    return d ? this.table!.designs[d] : undefined;
  }

  /** What one is worth in a fight (ratings), at a grade */
  firepower(type: string, grade: number): number {
    const s = this.statsOf(type);
    return s ? s.firepower * this.scale('damage', grade) : 0;
  }

  /** Is this ship one */
  has(eid: number): boolean {
    return this.live.has(eid);
  }

  /** A new one: its pieces' HP for its grade (an elite's × `eliteHp`), its damage scale */
  adopt(eid: number, type: string, grade: number, eliteHp = 1): void {
    const design = this.designOf(type), ship = this.host.ships.get(eid);
    if (!design || !ship) return;
    const stats = this.table!.designs[design];
    this.host.ships.setMaxHp(eid, pieceHp(ship, design, stats, this.scale('hp', grade) * eliteHp));
    this.live.set(eid, { design, index: customIndex(design), stats, dmg: this.scale('damage', grade), move: null, next: this.host.tick() + 60, gone: 0, guns: {} });
  }

  forget(eid: number): void {
    this.live.delete(eid);
  }

  /** Its engage order (an ENGAGE want) as its custom one: a move started now if one may */
  order(eid: number, engage: WantRec, target: number): WantRec {
    const L = this.live.get(eid), ship = this.host.ships.get(eid);
    if (!L || !ship) return engage;
    const now = this.host.tick(), gone = groupsGone(ship.blueprint, ship.hp, ship.detached);
    const spec = CUSTOM_DESIGNS[L.index];
    const under = L.move && now - L.move.start < (spec.moves[L.move.move]?.ticks ?? 0);
    if (!under && target >= 0) {
      const a = this.act(eid, ship, L, target, now);
      const pick = MOVES[L.design]?.pick(a);
      if (pick) {
        L.move = { move: pick.move, arg: pick.arg, seed: Math.floor(this.rng() * 256), start: now };
        L.next = now + (L.stats.moves[spec.moves[pick.move].name]?.every ?? 240);
        const key = `${L.design}.${spec.moves[pick.move].name}`;
        this.stats.moves[key] = (this.stats.moves[key] ?? 0) + 1;
      }
    }
    return customOrder(engage, AI_ORDER.CUSTOM, L.index, gone, L.move);
  }

  /** This tick's work: the move under way, its guns, what it has just lost (`fighting`: it has a target it's engaging) */
  step(eid: number, target: number, fighting: boolean): void {
    const L = this.live.get(eid), ship = this.host.ships.get(eid);
    if (!L || !ship) return;
    const now = this.host.tick(), gone = groupsGone(ship.blueprint, ship.hp, ship.detached);
    const a = this.act(eid, ship, L, target, now), moves = MOVES[L.design];
    if (gone !== L.gone) { const newly = gone & ~L.gone; L.gone = gone; if (newly) { this.stats.lost++; moves?.lost?.(a, newly); } }
    if (!fighting || target < 0) return;
    this.note(target, now);
    const spec = CUSTOM_DESIGNS[L.index];
    if (L.move) {
      const k = now - L.move.start;
      if (k >= 0 && k < (spec.moves[L.move.move]?.ticks ?? 0)) moves?.step?.(a, L.move, k);
    }
    moves?.always?.(a);
  }

  /** A target's velocity this tick, once a tick however many fight it (its trail: `ahead`) */
  private note(target: number, now: number): void {
    let tr = this.trail.get(target);
    if (tr?.at === now) return;
    if (!tr || now - tr.at > 1) this.trail.set(target, (tr = { at: now, v: [] }));
    tr.at = now;
    tr.v.push(Velocity.x[target], Velocity.y[target]);
    if (tr.v.length > TRAIL * 2) tr.v.splice(0, 2);
    // (now and then, the trails of targets no longer fought)
    if (now % 600 === 0) for (const [id, t] of this.trail) if (now - t.at > 60) this.trail.delete(id);
  }

  /** Where a target will be `ticks` on: its speed held, its heading turning as it turned over its trail (at most TURN_MAX a tick) */
  private ahead(target: number, ticks: number): { x: number; y: number } {
    let x = Position.x[target], y = Position.y[target];
    const vx = Velocity.x[target], vy = Velocity.y[target], s = dhypot(vx, vy), tr = this.trail.get(target)?.v;
    let w = 0;
    if (tr && tr.length >= 4 && s > 2) {
      const n = tr.length / 2 - 1, ox = tr[0], oy = tr[1];
      if (dhypot(ox, oy) > 2) w = Math.max(-TURN_MAX, Math.min(TURN_MAX, datan2(ox * vy - oy * vx, ox * vx + oy * vy) / n));
    }
    if (!w) return { x: x + vx * ticks, y: y + vy * ticks };
    let a = datan2(vy, vx);
    for (let k = 0; k < ticks; k++) { a += w; x += dcos(a) * s; y += dsin(a) * s; }
    return { x, y };
  }

  private scale(what: 'hp' | 'damage', grade: number): number {
    const g = this.table?.grades[what];
    return g?.[Math.max(0, Math.min(g.length - 1, grade - 1))] ?? 1;
  }

  /** What its moves see this tick */
  private act(eid: number, ship: ShipState, live: CustomLive, target: number, now: number): Act {
    const groups = customGroups(live.design), host = this.host, rng = this.rng;
    const gone = () => groupsGone(ship.blueprint, ship.hp, ship.detached);
    const bit = (g: string) => { const i = groups.indexOf(g); return i < 0 ? 0 : 1 << i; };
    return {
      eid, num: InSystem.systemId[eid], now, target, live, host,
      d: target >= 0 ? dhypot(Position.x[target] - Position.x[eid], Position.y[target] - Position.y[eid]) : Infinity,
      has: (g) => { const b = bit(g); return b !== 0 && !(gone() & b); },
      at: (g, evenGone) => {
        const b = bit(g);
        if (!b || (!evenGone && gone() & b)) return null;
        return groupAt(host, eid, ship, groups.indexOf(g));
      },
      rng: () => rng(),
      ahead: (ticks) => (target >= 0 ? this.ahead(target, Math.max(0, Math.round(ticks))) : { x: 0, y: 0 }),
    };
  }
}

/** Each part's most HP: its piece's HP (custom.designs hp) shared among its parts by their area */
function pieceHp(ship: ShipState, design: string, stats: CustomStats, k: number): number[] {
  const groups = customGroups(design), parts = ship.blueprint.parts;
  const area = new Map<number, number>();
  parts.forEach((p, i) => { if (p.group !== undefined) area.set(p.group, (area.get(p.group) ?? 0) + ship.maxHp[i]); });
  return parts.map((p, i) => {
    const g = p.group, hp = g !== undefined ? stats.hp[groups[g]] : undefined;
    if (g === undefined || hp === undefined) return ship.maxHp[i];
    return Math.max(1, (hp * k * ship.maxHp[i]) / (area.get(g) || 1));
  });
}

/** A piece in the world: the first of its parts with a mount (where it fires from), else its first part's middle */
function groupAt(host: CustomHost, eid: number, ship: ShipState, group: number): { x: number; y: number; dir: number } | null {
  const geoms = host.ships.geometry(ship), pose = { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] };
  let first = -1;
  for (let i = 0; i < ship.blueprint.parts.length; i++) {
    if (ship.blueprint.parts[i].group !== group) continue;
    if (first < 0) first = i;
    const m = geoms[i]?.mount;
    if (m) {
      const [x, y] = shipPointToWorld(ship, pose, m.at, host.ships.tuning.cellSize), [dx, dy] = localToWorldDir(m.dir, pose.angle);
      return { x, y, dir: datan2(dy, dx) };
    }
  }
  if (first < 0) return null;
  const [x, y] = shipPointToWorld(ship, pose, geoms[first].centroid, host.ships.tuning.cellSize), [dx, dy] = localToWorldDir([0, -1], pose.angle);
  return { x, y, dir: datan2(dy, dx) };
}

