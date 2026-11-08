import { boundKeyName } from '../../input/keybindings';
import { settings } from '../../settings/Settings';
import type { ShipReplicaSet } from '@space-game/common';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipStore } from '../ShipStore';
import { ClientFeatures } from '../features/host';
import { CLIENT_FEATURES } from '../features/index';
import { mountField } from '../field/mount';
import type { ShipClientWiringOpts } from './types';

/** What the part features and the field machines read of the client */
export interface FeatureWiringHost {
  readonly store: ShipStore;
  replicas(): ShipReplicaSet;
  scene(): Renderer | null;
  sideOf(id: number): number;
  hangarOpen(): boolean;
  docked(): boolean;
  helm(): boolean;
  setHelm(on: boolean): void;
}

/** Part features' client side (ships/features/host.ts) wired to the game */
export function makeFeatures(opts: ShipClientWiringOpts, h: FeatureWiringHost): ClientFeatures {
  return new ClientFeatures(CLIENT_FEATURES, {
    catalog: opts.catalog,
    playerId: () => opts.state.playerId,
    entity: (eid) => opts.state.entities.get(eid),
    ship: (eid) => h.store.get(eid),
    send: (msg) => opts.send(msg),
    showMessage: (text, color) => opts.showMessage(text, color),
    keyName: (id) => boundKeyName(id, settings.data.bindings),
    hangarOpen: () => h.hangarOpen(),
    isKeyDown: (code) => opts.isKeyDown(code),
    inputEnabled: () => opts.inputEnabled?.() ?? true,
    helm: () => h.helm(),
    charge: () => opts.state.charge,
    entities: () => opts.state.entities, cellSize: opts.tuning.cellSize,
    tick: (own) => (own ? opts.state.ownDrawTick() : opts.state.renderTickNow),
    systemId: () => opts.state.systemId,
    side: (id) => h.sideOf(id), exactAt: (id, t) => h.replicas().at(id, t)?.body ?? null, shipAt: (id, t) => h.store.asOf(id, t),
  });
}

/** The field machines' HUD and build overlay (ships/field): they read the game through this */
export function mountFieldFor(opts: ShipClientWiringOpts, h: FeatureWiringHost): void {
  mountField({
    catalog: opts.catalog, tuning: opts.tuning, econ: opts.pilot.econ,
    send: (msg) => opts.send(msg),
    toast: (text, kind) => (opts.toast ? opts.toast(text, kind ?? 'info') : opts.showMessage(text)),
    ship: () => h.store.get(opts.state.playerId),
    entity: () => opts.state.entities.get(opts.state.playerId),
    clocks: () => ({ charge: opts.state.charge, tick: opts.state.predictedTick }),
    level: () => opts.pilot.profile?.level ?? 1,
    learned: () => opts.pilot.profile?.recipes ?? [],
    have: (id) => opts.pilot.count(id),
    canMake: (id) => opts.pilot.canMake(id),
    flying: () => !h.hangarOpen() && !h.docked() && (opts.inputEnabled?.() ?? true),
    view: {
      zoom: () => opts.zoom?.get() ?? 1,
      setZoom: (z) => opts.zoom?.set(z),
      helm: () => h.helm(),
      setHelm: (on) => h.setHelm(on),
      screenToWorld: (x, y) => h.scene()?.screenToWorld(x, y) ?? { x: 0, y: 0 },
    },
  });
}
