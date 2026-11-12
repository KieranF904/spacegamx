/**
 * @contract server.gun-range
 * owns:       the gun range: going in from any station (the pilot's own ship and profile set aside, a cheat ship flown),
 *             picking its weapon, an admin's pick of a library ship, going through a door with X (the exit: out; a door
 *             to another room: into that room), and the ways out that aren't the door (death, a disconnect, being moved
 *             out); dying in it (the respawn is back at the exit door of the room they were in, in the same ship); each
 *             room's targets' upkeep; each visitor's gunRangeState
 * needs:      GunRangeHost, Pilots (freeze, thaw, swapFrozenShip, realProfile, onFrozenDeath), Ammo (setFree),
 *             common gunRange (layout, buildCheatShip, gunRangeOptions), ./target
 * events:     Pilots.onFrozenDeath (the cheat ship destroyed: the profile stays frozen, nothing is lost)
 * invariants: the real profile is never changed by anything done in the range, and its saves are byte for byte the
 *             profile as it went in but for the timestamps — server/src/game/gunRange/isolation.test.ts
 *             a pilot leaves docked at the station they came from with their own ship as it was, by the door, or on a
 *             disconnect; dying there is no way out: the respawn is at the door in the same cheat ship and weapon; nobody
 *             but a visitor stays in the range — server/src/game/gunRange/gunRange.test.ts
 *             a room's targets stand only while someone is in that room; a pilot changes room only by X at a door that
 *             leads there, and arrives inside the door that leads back with the ship, the weapon and the modifiers kept;
 *             X away from every door does nothing; only an admin is sent the library's ships or may fly one, and the real profile is as
 *             untouched by one as by the cheat ship — server/src/game/gunRange/rooms.test.ts
 * extend:     a new way into or out of the range is a method here that ends in enter() or leave(); a new room is data
 *             (systems.json `gunRange.rooms`: nothing here names one)
 *
 * One shared instance (systems.json `gunRange`, a private system) of a few rooms far apart (common gunRange/layout.ts):
 * everyone in a room sees everyone else in it. An admin (the server's own admin rule) may fly any design of the ship
 * library instead of the cheat ship, as it is drawn (its weapon groups kept), under the same rules: the range flag, free
 * ammunition, the throwaway profile. The cheat ship
 * (common gunRange/cheatShip.ts) carries one weapon model the pilot may fit at their level (gunRangeOptions), with any
 * weapon modifiers of theirs behind it (gunRangeMods; each at full strength, live on every shot); its guns are
 * never short of power (Blueprint.range, read by the shared gun step: every client predicts it; a beam still burns in pieces and rests) and fire their standard
 * crate without limit (Ammo.setFree). The profile in play is a throwaway copy (pilots/freeze.ts): saves write the real
 * one, as it went in; gives, takes, XP, credits, stats and quest events all refuse; build, trade, item and dev messages
 * are refused before their handlers (./messageGate.ts, net/dispatch.ts).
 */

import { RANGE_EXIT, buildCheatShip, exitDoor, cleanRangeMods, doorArrival, doorTo, gunRangeMods, gunRangeOptions, rangeDoor, rangeDoorAt, type Blueprint, type Catalog, type GunRangeDef, type GunRangeRoomDef, type ModifierTuning, type ServerGunRangeStateMessage, type ServerMessage } from '@space-game/common';
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

/** A library ship an admin may fly in the range: its id (the file's name), its name, and the picker's group for it */
export interface RangeShip {
  id: string;
  name: string;
  group: string;
  blueprint: Blueprint;
}

export interface GunRangeHost {
  tick(): number;
  readonly catalog: Catalog;
  /** The weapon modifiers' tuning (none: this game's data has no modifiers) */
  readonly modifiers: ModifierTuning | undefined;
  /** The range system: its number and rooms (null: this game's data has none) */
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
  /** May this pilot fly the library's ships here (the server's admin rule: on a dev server its guests too, never elsewhere) */
  admin(conn: PilotConn): boolean;
  /** The library ships an admin may fly: the plan library, then the dev test ships (none of the retired ones) */
  ships(): readonly RangeShip[];
}

interface Visit {
  berth: RangeBerth;
  /** The room they are in (its place in the def's list) */
  room: number;
  /** Flying this library ship instead of the cheat ship (admins only) */
  ship?: string;
  weapon: string;
  options: string[];
  /** The weapon modifier effects chosen, and those they may choose */
  mods: string[];
  modOptions: string[];
  /** Their own ship's live energy when they went in */
  charge: unknown;
  /** The cheat ship was destroyed: the respawn takes them back to their station */
  dead?: boolean;
}

export class GunRange {
  private readonly visits = new Map<PilotConn, Visit>();
  /** Each room's targets, in the def's order (made at the first tick) */
  private targets: RangeTarget[][] | null = null;

  constructor(private readonly host: GunRangeHost, private readonly pilots: Pilots, private readonly ammo: Ammo) {
    pilots.onFrozenDeath = (conn) => this.died(conn);
  }

  /** Anyone in, or a target still standing (the tick has work) */
  busy(): boolean {
    return this.visits.size > 0 || !!this.targets?.some((room) => room.some((t) => t.eid >= 0));
  }

  isVisitor(conn: PilotConn): boolean {
    return this.visits.has(conn);
  }

  /** Is this entity one of the range's targets */
  isTarget(eid: number): boolean {
    return !!this.targets?.some((room) => room.some((t) => t.isTarget(eid)));
  }

  /** The weapon models this pilot may try (their real profile's level, licences and ships) */
  options(conn: PilotConn): string[] {
    const p = this.pilots.realProfile(conn);
    return p ? gunRangeOptions(this.host.catalog, p) : [];
  }

  /** The weapon modifier effects this pilot may try (by the same rule, over every part an effect takes) */
  modOptions(conn: PilotConn): string[] {
    const p = this.pilots.realProfile(conn);
    return p ? gunRangeMods(this.host.catalog, this.host.modifiers, p) : [];
  }

  private ship(weapon: string, mods: readonly string[]): Blueprint | null {
    const mt = this.host.modifiers;
    return buildCheatShip(this.host.catalog, weapon, mt && mods.length ? { tuning: mt, effects: mods } : undefined);
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
    this.visits.set(conn, { berth, room: 0, weapon, options, mods: [], modOptions: this.modOptions(conn), charge });
    this.atSpawn(conn, r, 0);
    this.host.toast(conn, `Gun range: you are flying the ${ship.name.replace(/^.*?: /, '')}. Pick any weapon you can fit. To go back to ${berth.name}, fly to the exit door and press {interact}.`, 'info');
    this.sendState(conn);
  }

  /**
   * Inside a room's door (the exit unless `from` names the room they came from: then the door that leads back there),
   * side by side (so pilots coming in together, or back from a respawn, don't land on each other)
   */
  private atSpawn(conn: PilotConn, r: { num: number; def: GunRangeDef }, room: number, from?: string): void {
    const d = r.def.rooms[room], back = from === undefined ? undefined : doorTo(d, from);
    const sp = back ? doorArrival(d, back) : d.spawn, door = rangeDoor(d, back);
    let k = 0;
    for (const [c, v] of this.visits) { if (c === conn) break; if (v.room === room) k++; }
    // (Through a door: the one who came stands in the middle of it, where they'd look for themselves)
    const off = back ? 0 : ((k % 5) - 2) * 180;
    this.host.travel(conn, r.num, sp.x + door.ny * off, sp.y + door.nx * off, sp.angle);
  }

  /** Through a door to the room it leads to (by id): inside that room's door back, in the ship they are flying, weapon and modifiers as they were */
  private through(conn: PilotConn, v: Visit, r: { num: number; def: GunRangeDef }, to: string): void {
    const room = r.def.rooms.findIndex((d) => d.id === to);
    if (room < 0 || room === v.room) return;
    const from = r.def.rooms[v.room].id;
    v.room = room;
    this.host.calm(conn);
    this.atSpawn(conn, r, room, from);
    this.sendState(conn);
  }

  /** `gunRangeShip`: an admin flies this library ship (by id) as it is drawn, in place of the cheat ship. Refused from anyone else */
  pickShip(conn: PilotConn, id: unknown): void {
    const v = this.visits.get(conn);
    if (!v || v.dead) return;
    if (!this.host.admin(conn)) { this.host.toast(conn, 'Library ships are for admins', 'warn'); return; }
    const pick = this.host.ships().find((s) => s.id === id);
    if (!pick) { this.host.toast(conn, 'No such ship in the library', 'warn'); this.sendState(conn); return; }
    if (v.ship === pick.id) return;
    // (The range flag: never captured into a profile, its guns under the range's rules. pilots/persist.ts, types.ts Blueprint.range)
    if (!this.pilots.swapFrozenShip(conn, { ...pick.blueprint, range: true })) return;
    v.ship = pick.id;
    this.sendState(conn);
  }

  /** `gunRangeWeapon`: fly this weapon model instead (one of their options), with these weapon modifiers (`asked` absent: as they were) */
  pick(conn: PilotConn, model: string, asked?: unknown): void {
    const v = this.visits.get(conn);
    if (!v || v.dead || typeof model !== 'string') return;
    v.modOptions = this.modOptions(conn);
    const mods = cleanRangeMods(v.modOptions, asked === undefined ? v.mods : asked);
    if (!v.ship && model === v.weapon && mods.join() === v.mods.join()) return;
    v.options = this.options(conn);
    if (!v.options.includes(model)) { this.host.toast(conn, 'That weapon is not one you can fit yet', 'warn'); this.sendState(conn); return; }
    const ship = this.ship(model, mods);
    if (!ship || !this.pilots.swapFrozenShip(conn, ship)) return;
    v.weapon = model; v.mods = mods; v.ship = undefined;
    this.sendState(conn);
  }

  // ------------------------------------------------------------ out

  /** X: at the exit door, out; at a door to another room, into it; anywhere else in the range, a reminder. True when the pilot is a visitor (nothing else answers X here) */
  interact(conn: PilotConn): boolean {
    const v = this.visits.get(conn), r = this.host.range();
    if (!v) return false;
    if (v.dead || !r || !this.host.flying(conn)) return true;
    const at = this.host.where(conn);
    const door = rangeDoorAt(r.def.rooms[v.room], at.x, at.y);
    if (!door) this.host.toast(conn, 'Fly to the exit door and press {interact} to leave the range.', 'info');
    else if (door.to === RANGE_EXIT) this.leave(conn);
    else this.through(conn, v, r, door.to);
    return true;
  }

  /**
   * Out of the range: the real profile back as it was, their own ship on it with the energy it had, and back in the berth
   * they left (or, the station gone, at their home station). False: not in it.
   */
  leave(conn: PilotConn): boolean {
    const v = this.visits.get(conn);
    if (!v) return false;
    this.visits.delete(conn);
    this.ammo.setFree(conn, false);
    // (Dead and leaving by a disconnect: the real profile back, its ship put on at the next login)
    if (v.dead) { this.pilots.thaw(conn, false); return true; }
    this.pilots.thaw(conn, true);
    this.host.setCharge(conn, v.charge);
    this.host.calm(conn);
    this.goBack(conn, v.berth);
    return true;
  }

  /** The cheat ship was destroyed (pilots/death.ts: nothing dropped, counted or paid, the real profile still frozen): the respawn flies it again */
  private died(conn: PilotConn): void {
    const v = this.visits.get(conn);
    if (!v) return;
    v.dead = true;
    this.host.toast(conn, 'Range ship destroyed. Nothing is lost. Respawn to fly it again at the door.', 'info');
  }

  /** A respawn (net/handlers/flight.ts): one who died in the range is back inside their room's exit door, in the same ship and weapon */
  respawned(conn: PilotConn): void {
    const v = this.visits.get(conn), r = this.host.range();
    if (!v?.dead || !r) return;
    v.dead = false;
    this.host.calm(conn);
    this.atSpawn(conn, r, v.room);
    this.sendState(conn);
  }

  private goBack(conn: PilotConn, berth: RangeBerth): void {
    if (!this.host.reberth(conn, berth)) this.host.sendHome(conn);
    this.host.send(conn, { type: 'gunRangeState', in: false, station: berth.name });
  }

  // ------------------------------------------------------------ the tick

  /** Every tick while busy: each room's targets kept, and every visitor where they should be (and nobody else in the range) */
  tick(): void {
    const r = this.host.range();
    if (!r) return;
    const now = this.host.tick();
    for (const [conn, v] of [...this.visits]) {
      // (Gone, or put back by Pilots itself, a detach: nothing more to do)
      if (!this.host.connected(conn) || !this.pilots.isFrozen(conn)) { this.visits.delete(conn); this.ammo.setFree(conn, false); continue; }
      // (Moved out of the range by anything but the door: out properly, their own ship back, at their station)
      if (!v.dead && this.host.flying(conn) && this.host.systemOf(conn) !== r.num) this.leave(conn);
    }
    if (now % 30 === 0) for (const c of this.host.pilotsIn(r.num)) if (!this.visits.has(c) && this.host.flying(c)) this.host.sendHome(c);
    this.targets ??= r.def.rooms.map((room) => room.targets.map((d) => new RangeTarget(this.host.target, d)));
    // (A room's targets stand while anyone is in that room. A dead pilot is still in theirs: they respawn at its door)
    const inRoom = r.def.rooms.map(() => false);
    for (const v of this.visits.values()) inRoom[v.room] = true;
    this.targets.forEach((room, i) => {
      let changed = false;
      for (const t of room) if (t.tick(now, inRoom[i])) changed = true;
      if (changed) for (const [c, v] of this.visits) if (v.room === i && !v.dead) this.host.send(c, this.stateOf(c, false));
    });
  }

  // ------------------------------------------------------------ the state

  /** `full`: with an admin's ship list (left out of the states a target's coming and going sends: the client keeps it) */
  private stateOf(conn: PilotConn, full = true): ServerGunRangeStateMessage {
    const v = this.visits.get(conn), r = this.host.range();
    if (!v || !r) return { type: 'gunRangeState', in: false };
    const d: GunRangeRoomDef = r.def.rooms[v.room], door = rangeDoor(d), admin = this.host.admin(conn);
    return {
      type: 'gunRangeState', in: true, weapon: v.weapon, options: v.options, mods: v.mods, modOptions: v.modOptions, station: v.berth.name,
      room: d.id,
      ...(v.ship && admin ? { ship: v.ship } : {}),
      ...(full && admin ? { ships: this.host.ships().map((s) => ({ id: s.id, name: s.name, group: s.group })) } : {}),
      door: { x: door.x, y: door.y, reach: exitDoor(d).reach },
      targets: d.targets.map((t, i) => ({ id: this.targets?.[v.room]?.[i]?.eid ?? -1, x: t.x, y: t.y, label: t.label })),
    };
  }

  sendState(conn: PilotConn): void {
    this.host.send(conn, this.stateOf(conn));
  }
}
