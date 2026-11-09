import { partItemId, isDevPartId, type Blueprint, type Catalog, type ClientMessage, type ShipTuning } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { PilotState } from '../../econ/clientEcon';
import { Lazy } from '../../lazy';
import type { HangarUI } from '../HangarUI';
import type { ShipStore } from '../ShipStore';

/** What the hangar is built from (a slice of ShipClientOptions) */
export interface HangarOpts {
  catalog: Catalog;
  tuning: ShipTuning;
  pilot: PilotState;
  grantAllParts?: boolean;
  /** An admin: dev-only parts (`exclusive: "dev"`) are in the hangar and free to place for them, and nobody else */
  isAdmin?(): boolean;
  state: GameState;
  send(msg: ClientMessage): void;
  stationOpen?(): boolean;
  onHangarBackToStation?(): void;
  onHangarOpen?(): void;
  onHangarClose?(): void;
}

/** What it reads of the client: the ship store, designs shared by party members, the last ship flown, leaving the berth */
export interface HangarHost {
  readonly store: ShipStore;
  readonly shared: { from: string; blueprint: Blueprint }[];
  lastBlueprint(): Blueprint | null;
  undock(): void;
}

/** The hangar, split out of the main chunk (Game prefetches it after sign-in) */
export function makeHangar(opts: HangarOpts, h: HangarHost): Lazy<HangarUI> {
  return new Lazy(() => import('../HangarUI').then(({ HangarUI }) => new HangarUI({
    catalog: opts.catalog,
    tuning: opts.tuning,
    econ: opts.pilot.econ,
    owned: (slot) => {
      // Storage and the hold's modules (a refit takes those too), plus that slot's built parts (ghosts aren't built yet)
      const bag = opts.pilot.storedParts();
      for (const s of opts.pilot.cargo) if (opts.pilot.econ.items.get(s.id)?.category === 'part') bag[s.id] = (bag[s.id] ?? 0) + s.n;
      const rec = opts.pilot.hangar?.slots[slot];
      const parts = rec?.blueprint.parts ?? (slot === (opts.pilot.hangar?.active ?? 0) ? h.store.get(opts.state.playerId)?.blueprint.parts ?? [] : []);
      const ghosts = new Set(rec?.ghosts ?? []);
      for (const p of parts) {
        if (ghosts.has(p.uid)) continue;
        const id = partItemId(p);
        bag[id] = (bag[id] ?? 0) + 1;
      }
      return bag;
    },
    hangarState: () => opts.pilot.hangar,
    canMake: (id) => opts.pilot.canMake(id) || (!!opts.isAdmin?.() && isDevPartId(opts.catalog, id)),
    admin: () => !!opts.isAdmin?.(),
    level: () => opts.pilot.profile?.level ?? 1,
    learned: () => opts.pilot.profile?.recipes ?? [],
    have: (id) => opts.pilot.count(id),
    cargoMass: () => opts.pilot.econ.items.massOf(opts.pilot.cargo),
    stored: (id) => opts.pilot.storage.reduce((t, x) => t + (x.id === id ? x.n : 0), 0),
    coming: () => opts.pilot.coming(),
    send: (m) => opts.send(m),
    knownPlans: () => opts.pilot.profile?.plans ?? ['sparrow-t'],
    sharedDesigns: () => h.shared,
    grantAll: opts.grantAllParts ?? false,
    getBlueprint: () => h.store.get(opts.state.playerId)?.blueprint ?? h.lastBlueprint() ?? { name: 'New ship', catalogVersion: opts.catalog.version, parts: [] },
    liveShip: () => h.store.get(opts.state.playerId),
    onOpen: () => opts.onHangarOpen?.(),
    // (refreshes as the server reports saves, fitted parts and finished jobs)
    onClose: (launch) => {
      if (launch) opts.send({ type: 'shipEdit', blueprint: launch });
      if (opts.stationOpen?.()) opts.onHangarBackToStation?.();
      else h.undock();
      opts.onHangarClose?.();
    },
  })));
}
