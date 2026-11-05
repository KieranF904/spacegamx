/**
 * The client's copy of the economy (items, recipes, part costs), built from
 * the same bundled data as the server's, plus the pilot's latest state as the
 * server reports it. UIs subscribe to changes.
 */

import {
  Economy, Blueprint, Catalog, ItemsFile, RecipesFile, Stack, Bag, ShipTuning,
  ServerProfileMessage, ServerItemsMessage, ServerRebuildStatusMessage, ServerHangarMessage, countOf, canCraft,
  OrderPlan, JobView, planOrders, setUnlockTable, UnlockTable, registerAmmo,
} from '@space-game/common';
import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import shipTuning from '../../../data/ships/tuning.json';
import unlockData from '../../../data/unlocks.json';

const blueprintFiles = import.meta.glob('../../../data/ships/blueprints/*.json', { eager: true, import: 'default' }) as Record<string, Blueprint>;

/** Pre-made ship plans by file name (sparrow-t, lancer, ...) */
export const PLAN_LIBRARY: Record<string, Blueprint> = Object.fromEntries(
  Object.entries(blueprintFiles).map(([path, bp]) => [path.split('/').pop()!.replace(/\.json$/, ''), bp]),
);

export function createClientEconomy(ships: Catalog): Economy {
  const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, ships, PLAN_LIBRARY);
  econ.tuning = shipTuning as unknown as ShipTuning;
  setUnlockTable(unlockData as unknown as Partial<UnlockTable>);
  registerAmmo(econ.items.all());
  return econ;
}

type Listener = () => void;

export class PilotState {
  profile: ServerProfileMessage | null = null;
  cargo: Stack[] = [];
  storage: Stack[] = [];
  cargoCapacity = 0;
  credits = 0;
  atStation = false;
  rebuild: ServerRebuildStatusMessage | null = null;
  /** Hangar slots and fabricator jobs */
  hangar: ServerHangarMessage | null = null;
  /** Server clock minus ours (ms), from the last hangar message */
  clockSkew = 0;
  private listeners = new Set<Listener>();

  constructor(readonly econ: Economy) {}

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }


  setProfile(m: ServerProfileMessage): void {
    this.profile = m;
    if (m.now) this.clockSkew = m.now - Date.now();
    this.credits = m.credits;
    this.emit();
  }

  setItems(m: ServerItemsMessage): void {
    this.cargo = m.cargo;
    this.storage = m.storage;
    this.cargoCapacity = m.cargoCapacity;
    this.credits = m.credits;
    this.atStation = m.atStation;
    this.emit();
  }

  setHangar(m: ServerHangarMessage): void {
    this.hangar = m;
    this.clockSkew = m.now - Date.now();
    this.emit();
  }

  /** Can this pilot fabricate this item (licences)? */
  canMake(id: string): boolean {
    const r = this.econ.recipes.recipeFor(id);
    return !!r && canCraft(r, this.profile?.recipes ?? [], this.profile?.level ?? 1);
  }

  /** Parts of each kind on their way from the fabricator */
  coming(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const j of this.hangar?.jobs ?? []) for (const [id, n] of Object.entries(j.out)) out[id] = (out[id] ?? 0) + n * (j.count - j.done);
    return out;
  }

  /** Every unfinished slot's build, down to ore, in the order the hangar works them (econ/orders.ts) */
  orders(jobs: JobView[] = this.hangar?.jobs ?? []): OrderPlan[] {
    const h = this.hangar;
    if (!h) return [];
    return planOrders(this.econ, { storage: this.storage, jobs, recipes: this.profile?.recipes ?? [], level: this.profile?.level ?? 1, hangar: h.slots });
  }

  setRebuild(m: ServerRebuildStatusMessage): void {
    this.rebuild = m;
    this.emit();
  }

  cargoUsed(): number {
    return this.cargo.reduce((t, s) => t + s.n * this.econ.items.volume(s.id), 0);
  }

  /** Parts in storage (the hangar adds the ship's own intact parts) */
  storedParts(): Bag {
    const out: Bag = {};
    for (const s of this.storage) if (this.econ.items.get(s.id)?.category === 'part') out[s.id] = s.n;
    return out;
  }

  count(id: string): number {
    return countOf(this.cargo, id) + countOf(this.storage, id);
  }
}
