/**
 * Your own straight shells, worked out here (CAPS.SHOT_IDS; sim foundation Stage 1B). The server sends no fire records
 * of your own and no server ids for those shells: which of your guns fired on which tick is your own gun step's
 * (common sim/guns.ts, ShipClient.predictGuns, which runs once per predicted tick on the tick the server runs that
 * input), and each volley is built at a snapshot that covers its tick, from your confirmed ship as it fired
 * (OwnTick.firePose) with the shared launch maths (common launch.ts fireVolley), as the server's record would have
 * had it built. Each shell is named by its shot id (common sim/b-shots.ts ownShotWire), and so is anything the server
 * still says of it: a hit record, a removal it can't derive (a rock strike).
 *
 * Expiry is derived on both ends: a shell lives through tick `fire tick + life - 1` on the server (spawned and stepped
 * on its fire tick, its Lifetime counted down from that tick, GameServer lifetimeSystem), so at the first snapshot at
 * or past that tick it's removed here and sits that window out on the tick layer, as the server's HitLedger leaves a
 * shell its snapshot removes to its records.
 */
import {
  EntityType, WEAPON_KIND_TYPE, fireVolley, firesStraight, gunShell, ownShotWire, SHOT_ID_BARRELS,
  type EntityState, type FlightBody, type ShipState, type ShipTuning,
} from '@space-game/common';

/** A volley your guns fired (recorded by the prediction, built once a snapshot covers its tick) */
export interface OwnFire { tick: number; part: number; aimQ: number; ammo: number; aug?: 1 }

export interface OwnShellsHost {
  self(): number;
  ship(id: number): ShipState | undefined;
  tuning: ShipTuning;
  /** Your confirmed ship where it was as its guns fired on tick t (OwnTick.firePose) */
  firePose(t: number): FlightBody | null;
}

/** Fires kept waiting for their snapshot at most this long (a stalled connection) */
const KEEP_TICKS = 600;

export class OwnShells {
  on = false;
  private fires: OwnFire[] = [];
  /** Shells built and not yet removed: the tick their life ends on (inclusive) */
  private live = new Map<number, number>();
  /** This snapshot's shells, and whether the tick layer can have them exactly (false: your ship was keyframed: told) */
  readonly fresh = new Map<number, boolean>();
  readonly stats = { fires: 0, shells: 0, expired: 0, unbuilt: 0 };

  constructor(private readonly host: OwnShellsHost) {}

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.reset();
  }

  reset(): void {
    this.fires = [];
    this.live.clear();
    this.fresh.clear();
  }

  /** Is this gun's volley one you build yourself (straight from the muzzle: as the server's ownVolleyExact) */
  derivable(ship: ShipState, gun: number): boolean {
    const sh = gunShell(this.host.tuning, ship, gun);
    return !!sh && firesStraight(sh.def) && !sh.def.lob && !sh.def.arm;
  }

  /** Your prediction fired a volley on tick `f.tick` (once per tick: predictions never replay) */
  fired(f: OwnFire): void {
    if (!this.on) return;
    this.fires.push(f);
    this.stats.fires++;
  }

  /**
   * A snapshot at `tick`: the volleys fired up to it as rows (as the server's fire records would have been built, named
   * by shot id), and the shells whose life has ended by it removed (`removed`: pushed onto the snapshot's list).
   * `keyed`: your ship was keyframed in this window (its shells' hits are told: the server's rowShell)
   */
  snapshot(tick: number, removed: number[], keyed: boolean): EntityState[] {
    this.fresh.clear();
    const out: EntityState[] = [];
    if (!this.on) return out;
    const me = this.host.self(), ship = this.host.ship(me);
    let keep = 0;
    for (const f of this.fires) {
      if (f.tick > tick) { this.fires[keep++] = f; continue; }
      if (tick - f.tick > KEEP_TICKS || !ship) continue;
      const pose = this.host.firePose(f.tick);
      const v = pose ? fireVolley({ owner: me, tick: f.tick, part: f.part, aimQ: f.aimQ, ammo: f.ammo, aug: f.aug }, ship, pose, this.host.tuning) : null;
      if (!v || v.shells.length > SHOT_ID_BARRELS) { this.stats.unbuilt++; continue; }
      // (a pilot's shells move on the tick they're fired: ShipClient.preSnapshot's rule)
      const spawnTick = f.tick - 1, gun = f.part + 256 * f.ammo + (f.aug ? 65536 : 0);
      const grade = v.w.grade ?? 1;
      v.shells.forEach((s, i) => {
        const id = ownShotWire(f.tick, f.part, i), age = tick - spawnTick;
        this.live.set(id, f.tick + s.life - 1);
        this.fresh.set(id, !keyed);
        this.stats.shells++;
        out.push({
          id, type: EntityType.Projectile, x: s.x + s.vx * age, y: s.y + s.vy * age, vx: s.vx, vy: s.vy,
          data: [WEAPON_KIND_TYPE[v.kind] ?? 1, grade, (me * 137) % 360, spawnTick, s.x, s.y, me, s.size, v.turret ? 1 : 0, 0, gun],
        });
      });
    }
    this.fires.length = keep;
    // (the end of their life, worked out: the server sends no removal for it)
    for (const [id, until] of this.live) {
      if (until > tick) continue;
      this.live.delete(id);
      // (built and ended in the same window: never drawn)
      if (this.fresh.delete(id)) { const at = out.findIndex((e) => e.id === id); if (at >= 0) out.splice(at, 1); }
      removed.push(id);
      this.stats.expired++;
    }
    return out;
  }

  /** Shells gone otherwise (a hit record spent them, a removal the server sent): forgotten */
  gone(ids: Iterable<number>): void {
    for (const id of ids) this.live.delete(id);
  }

  /** One of yours, built this snapshot: true when the tick layer has it exactly, false when its hits are told, undefined if not one */
  freshExact(id: number): boolean | undefined {
    return this.fresh.get(id);
  }
}
