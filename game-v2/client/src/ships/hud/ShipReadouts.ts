/**
 * @contract client.ship.readouts
 * owns:       the numbers the HUD and menus read off your ship: weapon ring groups, gun and laser charge, status-panel input, rating, acceleration, menu ship info
 * needs:      ReadoutsHost (state, store, catalog, tuning, pilot, features, thrustCommand, helm, localJump, jump, jumpReach), RingModel, common rateShip
 * invariants: the status record and ring records are reused between calls — none pinned
 *             ring groups come off the predicted gun state — none pinned
 * extend:     a new HUD readout is one more method here, fed from the ship record
 */

import { rateShip, accelAlong, turnAccel, coreHp, boostOf, chargeTotal, FRICTION, type Catalog, type ShipTuning, type ShipState, type WeaponInfo, type Charge, type JumpTuning, type jumpPhase } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { PilotState } from '../../econ/clientEcon';
import type { MenuShipInfo } from '../../ui/GameMenuUI';
import type { StatusInput, FeatureStatusLine } from '../../ui/shipStatus/source';
import type { ThrustCommand } from '../ThrusterFx';
import type { ClientFeatures } from '../features/host';
import type { ShipStore } from '../ShipStore';
import { RingModel, type RingGroup, type RingSources } from '../gunHud';
import { groupSelection } from '../weaponGroups/selection';
import { inGunRange } from '../../ui/gunRange/rangeState';

export interface ReadoutsHost {
  readonly state: GameState;
  readonly store: ShipStore;
  readonly catalog: Catalog;
  readonly tuning: ShipTuning;
  readonly pilot: PilotState;
  readonly features: ClientFeatures;
  readonly jump: JumpTuning;
  thrustCommand(): ThrustCommand;
  helm(): boolean;
  localJump(): ReturnType<typeof jumpPhase>;
  jumpReach(): number;
}

export class ShipReadouts {
  constructor(private readonly h: ReadoutsHost) {}
  /** The weapon ring's data (own guns, predicted) */
  readonly ringModel = new RingModel();

  private readonly ringAmmo = { loose: 0, crates: 0 };

  /** The ship you fly (null between ships) */  /** The ship you fly (null between ships) */
  myShip(): ShipState | null {
    const ship = this.h.store.get(this.h.state.playerId);
    return ship && ship.kind === 'ship' ? ship : null;
  }

  /** Your ship's rating as it stands (ships/rating.ts): worked out again when its parts change */
  ratingCache: { ship: unknown; derived: unknown; rating: number } | null = null;

  myRating(): number {
    const ship = this.h.store.get(this.h.state.playerId);
    if (!ship || ship.kind !== 'ship') return 0;
    if (this.ratingCache?.ship === ship && this.ratingCache.derived === ship.derived) return this.ratingCache.rating;
    const rating = rateShip(this.h.catalog, this.h.tuning, ship).rating;
    this.ratingCache = { ship, derived: ship.derived, rating };
    return rating;
  }

  localAccel(): number {
    const ship = this.h.store.get(this.h.state.playerId);
    if (!ship || ship.kind !== 'ship' || ship.derived.mass <= 0) return 0;
    return accelAlong(ship.derived, [0, -1]);
  }

  /** How much harder the local ship's engines push boosting (×) */
  localBoostFactor(): number {
    const ship = this.h.store.get(this.h.state.playerId);
    return ship && ship.kind === 'ship' ? boostOf(ship.derived) : 1;
  }

  /** The menu's ship readout */
  menuShipInfo(): MenuShipInfo | null {
    const ship = this.h.store.get(this.h.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const d = ship.derived;
    const accel = d.mass > 0 ? accelAlong(d, [0, -1]) : 0;
    const core = coreHp(ship);
    const ph = this.h.localJump();
    return {
      name: ship.blueprint.name,
      parts: ship.blueprint.parts.length,
      mass: d.mass,
      accel,
      topSpeed: (accel * FRICTION) / (1 - FRICTION),
      turn: d.inertia > 0 ? Math.min(turnAccel(d).cw, turnAccel(d).ccw) : 0,
      radius: d.radius,
      coreHp: core.hp,
      coreMax: core.max,
      guns: d.weapons.length,
      turrets: d.weapons.filter((w) => w.mount === 'turret').length,
      engines: d.thrusters.length,
      power: { supply: d.energy.supply, demand: d.energy.demand },
      controls: this.h.helm() ? 'helm' : 'mouse-steer',
      jump: {
        phase: ph.phase, progress: ph.progress,
        // (The ship's own cooldown and reach: jump coils change both)
        cooldownSecs: ph.phase === 'cooldown' ? Math.ceil(((1 - ph.progress) * (d.jumpCooldown || this.h.jump.cooldownTicks)) / 60) : 0,
        distance: this.h.jumpReach(),
      },
    };
  }

  /**
   * Your charge guns' charge, for the HUD (the fullest one being charged: 0..1, as your client steps it: guns.ts),
   * null when none is charging
   */
  gunCharge(): { charge: number; gun: WeaponInfo } | null {
    const ship = this.h.store.get(this.h.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    let best: { charge: number; gun: WeaponInfo } | null = null;
    for (const w of ship.derived.weapons) {
      if (w.fire.model !== 'charge' || !(ship.charge[w.part] > 0)) continue;
      const c = Math.min(1, ship.charge[w.part] / Math.max(1, w.fire.charge ?? 60));
      if (!best || c > best.charge) best = { charge: c, gun: w };
    }
    return best;
  }

  /**
   * The weapon ring's groups (ui/WeaponRing.ts): your guns by model, with clip, charge, spin, ammo and bank, off your
   * own predicted gun state. Empty when you fly nothing with guns. The records are reused every call.
   */
  ringGroups(): RingGroup[] {
    const ship = this.h.store.get(this.h.state.playerId);
    this.ringSrc.charge = this.h.state.charge;
    this.ringSrc.sel = groupSelection.packed;
    return this.ringModel.update(ship ?? null, this.ringSrc);
  }

  /** The weapon ring's chip, "L: 2  R: all" (empty while there is nothing to choose between: gunHud.ts RingModel.chip) */
  ringChip(): string {
    return this.ringModel.chip(groupSelection.packed);
  }

  /**
   * What the ship status panel reads (ui/shipStatus/source.ts), at its own rate: the ship, the predicted charge, the
   * shield, the keys' thrust, the weapon ring's groups (as the ring last stepped them) and the part features' lines.
   * The record is reused.
   */
  statusInput(): StatusInput | null {
    const st = this.h.state, ship = this.h.store.get(st.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const inp = this.statusRec;
    inp.ship = ship;
    inp.charge = st.charge;
    inp.shieldPct = st.entities.get(st.playerId)?.data?.[4] ?? 0;
    const cmd = this.h.thrustCommand();
    inp.thrust.on = cmd.dir[0] !== 0 || cmd.dir[1] !== 0;
    inp.thrust.boost = cmd.boost;
    inp.tick = st.serverTick;
    inp.tuning = this.h.tuning;
    // (The ring's groups as Game stepped them this frame; stepped here only when nothing has)
    inp.groups = this.ringModel.groups.length || !ship.derived.weapons.length ? this.ringModel.groups : this.ringGroups();
    inp.features = this.h.features.statusLines(this.statusLines);
    inp.now = performance.now();
    return inp;
  }

  private readonly statusLines: FeatureStatusLine[] = [];

  private readonly statusRec: StatusInput = {
    ship: null, charge: {}, shieldPct: 0, thrust: { on: false, boost: false }, tick: 0, tuning: {} as StatusInput['tuning'],
    groups: [], features: [], now: 0,
    nameOf: (fn) => this.h.catalog.functions.get(fn)?.name ?? fn,
  };

  private readonly ringSrc: RingSources = {
    charge: {},
    ammoOf: (kind) => {
      const item = this.h.tuning.weapons?.[kind]?.ammo?.item;
      // (The gun range's ammunition is unlimited, as the server's Ammo.setFree: nothing to count, never plain rounds)
      if (!item || inGunRange()) return null;
      const a = this.ringAmmo;
      a.loose = this.h.pilot.profile?.ammo?.[item] ?? 0;
      a.crates = 0;
      for (const s of this.h.pilot.cargo) if (s.id === item) a.crates += s.n;
      return a;
    },
  };

  /**
   * Your pulse lasers' charge, for the HUD: how far the least-charged one is
   * to its next pulse (0..1; its reload, as your client steps it: guns.ts),
   * and how many are ready. Null without any.
   */
  laserCharge(): { charge: number; ready: number; total: number } | null {
    const ship = this.h.store.get(this.h.state.playerId);
    if (!ship || ship.kind !== 'ship') return null;
    const defs = this.h.tuning.weapons ?? {};
    let charge = 1, ready = 0, total = 0;
    for (const w of ship.derived.weapons) {
      if (!defs[w.kind]?.pulse) continue;
      total++;
      const c = 1 - Math.max(0, ship.cooldown[w.part] ?? 0) / Math.max(1, w.interval);
      charge = Math.min(charge, c);
      if (c >= 1) ready++;
    }
    return total ? { charge, ready, total } : null;
  }

  /** All your ship's stored energy as one percentage (the HUD's gauge) */
  chargeTotal(charge: Charge): number {
    const ship = this.h.store.get(this.h.state.playerId);
    return ship && ship.kind === 'ship' ? chargeTotal(ship.derived, charge) : 100;
  }
}
