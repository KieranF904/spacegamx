/**
 * @contract server.gun-range
 * owns:       the gun range: going in from any station (the pilot's own ship and profile set aside, a cheat ship flown),
 *             picking its weapon, leaving at the door with X, and the ways out that aren't the door (death, a disconnect,
 *             being moved out); the target's upkeep; each visitor's gunRangeState
 * needs:      GunRangeHost, Pilots (freeze, thaw, swapFrozenShip, realProfile, onFrozenDeath), Ammo (setFree),
 *             common gunRange (layout, buildCheatShip, gunRangeOptions), ./target
 * events:     Pilots.onFrozenDeath (the cheat ship destroyed)
 * invariants: the real profile is never changed by anything done in the range, and its saves are byte for byte the
 *             profile as it went in but for the timestamps — server/src/game/gunRange/isolation.test.ts
 *             a pilot leaves docked at the station they came from with their own ship as it was; dying or disconnecting
 *             there takes them back too; nobody but a visitor stays in the range — server/src/game/gunRange/gunRange.test.ts
 * extend:     a new way into or out of the range is a method here that ends in enter() or leave()
 *
 * One shared instance (systems.json `gunRange`, a private system): everyone in it sees everyone else. The cheat ship
 * (common gunRange/cheatShip.ts) carries one weapon model the pilot may fit at their level (gunRangeOptions); its guns are
 * always fully powered (Blueprint.range, read by the shared gun step: every client predicts it) and fire their standard
 * crate without limit (Ammo.setFree). The profile in play is a throwaway copy (pilots/freeze.ts): saves write the real
 * one, as it went in; gives, takes, XP, credits, stats and quest events all refuse; build, trade, item and dev messages
 * are refused before their handlers (./messageGate.ts, net/dispatch.ts).
 */

import { atRangeDoor, buildCheatShip, gunRangeOptions, rangeDoor, type Catalog, type GunRangeDef, type ServerGunRangeStateMessage, type ServerMessage } from '@space-game/common';
import type { Pilots, PilotConn } from '../Pilots.js';
import type { Ammo } from '../Ammo.js';
import { RangeTarget, type TargetHost } from './target.js';

/** A berth at a station as the pilot left it (the host's own record: Docking's `conn.docked`) */
export interface RangeBerth {
  station: number;
  /** The station's data id and name */
  id: string;
  name: string;
  state: unknown;
}

export interface GunRangeHost {
  tick(): number;
  readonly catalog: Catalog;
  /** The range system: its number and chamber (null: this game's data has none) */
  range(): { num: number; def: GunRangeDef } | null;
  send(conn: PilotConn, msg: ServerMessage): void;
  toast(conn: PilotConn, text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  /** Their ship is alive in the world */
  flying(conn: PilotConn): boolean;
  /** Still in the training yard's lessons (the range opens once they have left it) */
  training(conn: PilotConn): boolean;
  /** Still connected (a closed connection's visit is dropped) */
  connected(conn: PilotConn): boolean;
  /** The system their ship is in */
  systemOf(conn: PilotConn): number;
  where(conn: PilotConn): { x: number; y: number };
  /** The berth they are in, as it stands (null: not berthed) */
  berthOf(conn: PilotConn): RangeBerth | null;
  /** Out of the berth just as they are: nothing restocked, paid or counted */
  unberth(conn: PilotConn): void;
  /** Move them (to any system), at rest, facing `angle` */
  travel(conn: PilotConn, num: number, x: number, y: number, angle: number): void;
  /** Back in that berth at its station (false: the station is gone) */
  reberth(conn: PilotConn, berth: RangeBerth): boolean;
  /** Their ship's live energy (kept while they're in), and put back */
  charge(conn: PilotConn): unknown;
  setCharge(conn: PilotConn, c: unknown): void;
  /** Their combat lock let go (shooting the target is no fight to linger over) */
  calm(conn: PilotConn): void;
  /** The pilots whose ships are in this system */
  pilotsIn(num: number): PilotConn[];
  /** Somebody who doesn't belong in the range: put back at their home station */
  sendHome(conn: PilotConn): void;
  readonly target: TargetHost;
}

interface Visit {
  berth: RangeBerth;
  weapon: string;
  options: string[];
  /** Their own ship's live energy when they went in */
  charge: unknown;
  /** The cheat ship was destroyed: the respawn takes them back to their station */
  dead?: boolean;
}

export class GunRange {
  private readonly visits = new Map<PilotConn, Visit>();
  private target: RangeTarget | null = null;

  constructor(private readonly host: GunRangeHost, private readonly pilots: Pilots, private readonly ammo: Ammo) {
    pilots.onFrozenDeath = (conn) => this.died(conn);
  }

  /** Anyone in, or the target still standing (the tick has work) */
  busy(): boolean {
    return this.visits.size > 0 || (this.target?.eid ?? -1) >= 0;
  }

  isVisitor(conn: PilotConn): boolean {
    return this.visits.has(conn);
  }

  /** Is this entity the range's target */
  isTarget(eid: number): boolean {
    return !!this.target?.isTarget(eid);
  }

  /** The weapon models this pilot may try (their real profile's level, licences and ships) */
  options(conn: PilotConn): string[] {
    const p = this.pilots.realProfile(conn);
    return p ? gunRangeOptions(this.host.catalog, p) : [];
  }

  // ------------------------------------------------------------ in

  /** `gunRangeEnter`: from the station they are berthed at, into the range in a cheat ship */
  enter(conn: PilotConn): void {
    if (this.visits.has(conn)) { this.sendState(conn); return; }
    const refuse = (error: string) => this.host.send(conn, { type: 'gunRangeState', in: false, error });
    const r = this.host.range();
    if (!r) return refuse('There is no gun range on this server');
    if (!this.host.flying(conn)) return refuse('No ship to take in');
    const berth = this.host.berthOf(conn);
    if (!berth) return refuse('Dock at a station first: the gun range is reached from any station');
    if (this.host.training(conn)) return refuse('Finish or leave training first');
    if (this.pilots.isFrozen(conn)) return refuse('Already in the gun range');
    const real = this.pilots.realProfile(conn);
    const options = this.options(conn);
    if (!real || !options.length) return refuse('No weapon to try');
    // (Their own ship's first weapon the range has, else the first there is)
    const own = real.ship.blueprint.parts.map((q) => q.fn).find((fn) => options.includes(fn));
    const weapon = own ?? options[0];
    const ship = buildCheatShip(this.host.catalog, weapon);
    if (!ship) return refuse('No weapon to try');
    const charge = this.host.charge(conn);
    if (!this.pilots.freeze(conn, ship)) return refuse('Fly your own ship to go in (and wait for your save to load)');
    this.ammo.setFree(conn, true);
    this.host.unberth(conn);
    // (Side by side inside the door, so pilots coming in together don't land on each other)
    const k = this.visits.size % 5, sp = r.def.spawn, door = rangeDoor(r.def);
    const off = (k - 2) * 180;
    this.host.travel(conn, r.num, sp.x + door.ny * off, sp.y + door.nx * off, sp.angle);
    this.visits.set(conn, { berth, weapon, options, charge });
    this.host.toast(conn, `Gun range: fly the ${ship.name.replace(/^.*?: /, '')}. Pick any weapon you can fit; fly to the door and press X to go back to ${berth.name}`, 'info');
    this.sendState(conn);
  }

  /** `gunRangeWeapon`: fly this weapon model instead (one of their options) */
  pick(conn: PilotConn, model: string): void {
    const v = this.visits.get(conn);
    if (!v || v.dead || typeof model !== 'string' || model === v.weapon) return;
    v.options = this.options(conn);
    if (!v.options.includes(model)) { this.host.toast(conn, 'That weapon is not one you can fit yet', 'warn'); this.sendState(conn); return; }
    const ship = buildCheatShip(this.host.catalog, model);
    if (!ship || !this.pilots.swapFrozenShip(conn, ship)) return;
    v.weapon = model;
    this.sendState(conn);
  }

  // ------------------------------------------------------------ out

  /** X: at the door, out; anywhere else in the range, a reminder. True when the pilot is a visitor (nothing else answers X here) */
  interact(conn: PilotConn): boolean {
    const v = this.visits.get(conn), r = this.host.range();
    if (!v) return false;
    if (v.dead || !r || !this.host.flying(conn)) return true;
    const at = this.host.where(conn);
    if (atRangeDoor(r.def, at.x, at.y)) this.leave(conn);
    else this.host.toast(conn, 'Fly to the door and press X to leave the range', 'info');
    return true;
  }

  /**
   * Out of the range: the real profile back as it was, their own ship on it with the energy it had, and back in the berth
   * they left (or, the station gone, at their home station). A dead visitor is left to the respawn (respawned). False: not in it.
   */
  leave(conn: PilotConn): boolean {
    const v = this.visits.get(conn);
    if (!v) return false;
    this.visits.delete(conn);
    this.ammo.setFree(conn, false);
    if (v.dead) return true;
    this.pilots.thaw(conn, true);
    this.host.setCharge(conn, v.charge);
    this.host.calm(conn);
    this.goBack(conn, v.berth);
    return true;
  }

  /** The cheat ship was destroyed (Pilots has already put the real profile back): the respawn takes them home */
  private died(conn: PilotConn): void {
    const v = this.visits.get(conn);
    if (!v) return;
    v.dead = true;
    this.ammo.setFree(conn, false);
    this.host.toast(conn, `The range ship was destroyed: nothing lost. Respawn to go back to ${v.berth.name} in your own ship`, 'info');
  }

  /** A respawn (net/handlers/flight.ts): one who died in the range goes back to their berth */
  respawned(conn: PilotConn): void {
    const v = this.visits.get(conn);
    if (!v?.dead) return;
    this.visits.delete(conn);
    this.host.calm(conn);
    this.goBack(conn, v.berth);
  }

  private goBack(conn: PilotConn, berth: RangeBerth): void {
    if (!this.host.reberth(conn, berth)) this.host.sendHome(conn);
    this.host.send(conn, { type: 'gunRangeState', in: false, station: berth.name });
  }

  // ------------------------------------------------------------ the tick

  /** Every tick while busy: the target kept, and every visitor where they should be (and nobody else in the range) */
  tick(): void {
    const r = this.host.range();
    if (!r) return;
    const now = this.host.tick();
    for (const [conn, v] of [...this.visits]) {
      // (Gone, or put back by Pilots itself, a detach: nothing more to do)
      if (!this.host.connected(conn) || (!v.dead && !this.pilots.isFrozen(conn))) { this.visits.delete(conn); this.ammo.setFree(conn, false); continue; }
      // (Moved out of the range by anything but the door: out properly, their own ship back, at their station)
      if (!v.dead && this.host.flying(conn) && this.host.systemOf(conn) !== r.num) this.leave(conn);
    }
    if (now % 30 === 0) for (const c of this.host.pilotsIn(r.num)) if (!this.visits.has(c) && this.host.flying(c)) this.host.sendHome(c);
    this.target ??= new RangeTarget(this.host.target, r.def.target);
    const occupied = [...this.visits.values()].some((v) => !v.dead);
    if (this.target.tick(now, occupied)) for (const [c, v] of this.visits) if (!v.dead) this.sendState(c);
  }

  // ------------------------------------------------------------ the state

  private stateOf(conn: PilotConn): ServerGunRangeStateMessage {
    const v = this.visits.get(conn), r = this.host.range();
    if (!v || !r) return { type: 'gunRangeState', in: false };
    const door = rangeDoor(r.def), t = r.def.target;
    return {
      type: 'gunRangeState', in: true, weapon: v.weapon, options: v.options, station: v.berth.name,
      door: { x: door.x, y: door.y, reach: r.def.door.reach },
      target: { id: this.target?.eid ?? -1, x: t.x, y: t.y },
    };
  }

  sendState(conn: PilotConn): void {
    this.host.send(conn, this.stateOf(conn));
  }
}
