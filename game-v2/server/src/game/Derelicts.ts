/**
 * Derelicts and people's craft: the pre-made hulks out in space (systems.json `derelicts`) that are broken up or
 * towed in for salvage and come back a while later, and the ships people live aboard (people.json `craft`), parked
 * and untouchable. Moved verbatim from GameServer (bodies unchanged; the host's pieces are held as plain fields).
 *
 * GameServer keeps field aliases to `derelicts` and `personCraft` (the same array and Map): canDamage, the invulnerable
 * callback, the memory host and systemRows read them on hot paths, so those call sites stay as they were.
 */
import { hasComponent, type IWorld } from 'bitecs';
import { Player, hashString, isStructural, towTuning, type TowKind, type Bag, type DerelictData, type ClientSocket, type ServerMessage, dcos, dsin } from '@space-game/common';
import type { Economy } from '@space-game/common';
import type { GameData } from '../data/GameData.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { Pilots } from './Pilots.js';
import type { LootPods } from './LootPods.js';
import type { Codex } from './Codex.js';
import type { People } from './People.js';
import type { SystemMemory } from './SystemMemory.js';

/** A destroyed derelict is replaced after this long */
const DERELICT_RESPAWN_TICKS = 60 * 60 * 5;
/** A broken derelict gives this share of the plate and wire its structure was built from */
const DERELICT_PLATE_SHARE = 0.15;

/** One derelict's place in a system: its data, the hulk now (eid -1: none), and when the next one is due */
export interface DerelictSlot { data: DerelictData; systemNum: number; eid: number; respawnTick: number; spawns: number }

export interface DerelictsHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly ships: ShipBridge;
  readonly pilots: Pilots;
  readonly pods: LootPods;
  readonly codex: Codex;
  readonly people: People;
  readonly memory: SystemMemory;
  readonly econ: Economy;
  send(ws: ClientSocket, msg: ServerMessage): void;
  /** The server's tick now */
  tick(): number;
}

export class Derelicts {
  /** Every derelict's slot (in the order the systems list them) */
  readonly derelicts: DerelictSlot[] = [];
  /** People's ships, parked where they live (people.json craft): untouchable, by name */
  readonly personCraft = new Map<number, string>();

  private readonly world: IWorld;
  private readonly gameData: GameData;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly ships: ShipBridge;
  private readonly pilots: Pilots;
  private readonly pods: LootPods;
  private readonly codex: Codex;
  private readonly people: People;
  private readonly memory: SystemMemory;
  private readonly econ: Economy;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly tick: () => number;

  constructor(host: DerelictsHost) {
    this.world = host.world;
    this.gameData = host.gameData;
    this.clients = host.clients;
    this.ships = host.ships;
    this.pilots = host.pilots;
    this.pods = host.pods;
    this.codex = host.codex;
    this.people = host.people;
    this.memory = host.memory;
    this.econ = host.econ;
    this.send = host.send;
    this.tick = host.tick;
  }

  private get currentTick(): number {
    return this.tick();
  }

  spawnDerelict(slot: { data: DerelictData; systemNum: number; eid: number; spawns: number }): void {
    const bp = this.ships.library.get(slot.data.blueprint);
    if (!bp) return;
    const seed = hashString(`derelict:${slot.data.id}:${slot.spawns++}`);
    slot.eid = this.ships.spawnWreck(bp, slot.data.position.x, slot.data.position.y, slot.data.angle ?? 0, slot.systemNum, seed);
  }

  /** A broken-up derelict comes back a while later (somebody always tows in another). */
  derelictRespawnSystem(): void {
    if (this.currentTick % 60 !== 0) return;
    for (const slot of this.derelicts) {
      if (!this.memory.isResident(slot.systemNum)) continue;
      if (slot.eid >= 0 && !this.ships.has(slot.eid)) {
        slot.eid = -1;
        slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
      }
      if (slot.eid < 0 && slot.respawnTick && this.currentTick >= slot.respawnTick) {
        slot.respawnTick = 0;
        this.spawnDerelict(slot);
      }
    }
  }

  // ---- Tow Beam (ships/features/tow/Towing.ts): towed into a station's reach, a wreck, debris or a pod is salvaged into the pilot's storage
  towDelivered(pilot: number, target: number, kind: TowKind): void {
    const pc = this.pilots.connOf(pilot);
    if (!pc) return;
    const tell = (text: string) => { for (const c of this.clients.values()) if (c.playerId === pilot) this.send(c.ws, { type: 'systemMessage', text, color: '#ffd166' }); };
    if (kind === 'pod') {
      const bag = this.pods.take(target);
      if (!bag) return;
      this.pilots.give(pc, bag, { toStorage: true, source: 'salvaged' });
      tell('Towed in a pod: its contents are in station storage');
      return;
    }
    const ship = this.ships.get(target);
    if (!ship) return;
    // Its structure cut up for plate (towTuning salvage of what it's made of), as a derelict's chunks are; modules aren't salvaged
    const share = towTuning(this.ships.tuning).salvage;
    const made: Bag = {};
    ship.blueprint.parts.forEach((q, i) => {
      if (!(ship.hp[i] > 0) || ship.detached[i] || !isStructural(q.fn)) return;
      for (const [id, n] of Object.entries(this.econ.recipes.partInputs(q))) made[id] = (made[id] ?? 0) + n * share;
    });
    const bag: Bag = {};
    for (const [id, n] of Object.entries(made)) if (Math.floor(n) > 0) bag[id] = Math.floor(n);
    const slot = this.derelicts.find((d) => d.eid === target);
    let credits = 0, name = kind === 'wreck' ? 'a wreck' : 'debris';
    if (slot) {
      slot.eid = -1;
      slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
      credits = slot.data.salvage ?? 250;
      name = slot.data.name;
      this.pilots.addCredits(pc, credits);
      this.pilots.addXp(pc, Math.round(credits / 4));
      if (slot.data.log) this.codex.unlock(pc, [slot.data.log.codex]);
    }
    this.ships.removeShip(target);
    if (Object.keys(bag).length) this.pilots.give(pc, bag, { toStorage: true, source: 'salvaged' });
    this.pilots.bumpStat(pc, 'salvaged');
    const n = Object.values(bag).reduce((t, k) => t + k, 0);
    tell(`Salvaged ${name}: ${n} plate to station storage${credits ? `, +${credits} credits` : ''}`);
  }
  // ---- (end Tow Beam)

  /** Whoever breaks a derelict's core gets its salvage: credits, and plate of its material */
  onPilotlessShipDestroyed(eid: number, lastHitBy: number | undefined): void {
    const slot = this.derelicts.find((d) => d.eid === eid);
    if (!slot) return;
    slot.eid = -1;
    slot.respawnTick = this.currentTick + DERELICT_RESPAWN_TICKS;
    if (lastHitBy === undefined || !hasComponent(this.world, Player, lastHitBy)) return;
    const credits = slot.data.salvage ?? 250;
    const xp = Math.round(credits / 4);
    const pc = this.pilots.connOf(lastHitBy);
    // Cut up, it gives plate of what it was built from (and the wire in it), thrown out as chunks to pull in
    const bp = this.ships.library.get(slot.data.blueprint);
    if (bp) {
      const made: Bag = {};
      for (const q of bp.parts) {
        if (!isStructural(q.fn)) continue;
        for (const [id, n] of Object.entries(this.econ.recipes.partInputs(q))) made[id] = (made[id] ?? 0) + n * DERELICT_PLATE_SHARE;
      }
      const x = slot.data.position.x, y = slot.data.position.y;
      let i = 0;
      for (const [id, n] of Object.entries(made)) {
        let left = Math.floor(n);
        while (left > 0) {
          const k = Math.min(left, 6), a = i++ * 2.39996;
          this.pods.spawnChunk(slot.systemNum, x, y, dcos(a) * 2, dsin(a) * 2, { [id]: k }, lastHitBy);
          left -= k;
        }
      }
    }
    if (pc) {
      this.pilots.addCredits(pc, credits);
      this.pilots.addXp(pc, xp);
      this.pilots.bumpStat(pc, 'salvaged');
      if (slot.data.log) this.codex.unlock(pc, [slot.data.log.codex]);
    }
    for (const c of this.clients.values()) {
      if (c.playerId !== lastHitBy) continue;
      this.send(c.ws, { type: 'systemMessage', text: `Salvaged ${slot.data.name}: +${credits} credits, +${xp} XP`, color: '#ffd166' });
    }
  }

  /** People out in space and on planets live aboard something (people.json craft): parked there, out of every fight */
  spawnPersonCraft(): void {
    for (const d of this.people.file.people) {
      const bp = d.craft && this.ships.library.get(d.craft.ship);
      if (!bp || !d.craft || 'station' in d.at) continue;
      const num = this.gameData.getSystem(d.at.system) ? this.gameData.getSystemNum(d.at.system) : -1;
      if (num < 0) continue;
      const eid = this.ships.spawnDummy(bp, d.at.x, d.at.y, d.craft.angle ?? 0, num);
      this.ships.pin(eid);
      this.personCraft.set(eid, d.craft.name ?? d.name);
    }
  }
}
