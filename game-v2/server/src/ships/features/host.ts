/**
 * ServerFeatures: the server features built once (GameServer's constructor) and flattened so the per-tick calls walk
 * plain arrays and allocate nothing. With no feature every call is an empty loop.
 */
import type { FeatureHost, FeatureInstance, FeatureMessageHandler, ServerFeature, SnapshotWindow } from './types.js';

export class ServerFeatures {
  /** Message handlers by type (net/dispatch.ts gets one entry per type) */
  readonly messages: ReadonlyMap<string, FeatureMessageHandler>;
  private readonly ids: string[] = [];
  private readonly ticks: (() => void)[] = [];
  private readonly cargo: ((eid: number) => number)[] = [];
  private readonly wires: ((eid: number, out: number[]) => number)[] = [];
  private readonly rebuilt: ((eid: number) => void)[] = [];
  private readonly breaks: ((eid: number) => void)[] = [];
  private readonly leaves: ((eid: number) => void)[] = [];
  private readonly snapshots: ((pilot: number, win: SnapshotWindow) => void)[] = [];
  private readonly byId = new Map<string, FeatureInstance>();

  /** `taken`: message types the game already handles (a feature may not shadow them) */
  constructor(features: readonly ServerFeature[], host: FeatureHost, taken: ReadonlySet<string> = new Set()) {
    const messages = new Map<string, FeatureMessageHandler>();
    for (const f of [...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (this.byId.has(f.id)) throw new Error(`server feature ${f.id} is listed twice`);
      const inst = f.create(host);
      this.byId.set(f.id, inst);
      this.ids.push(f.id);
      if (inst.tick) this.ticks.push(inst.tick.bind(inst));
      if (inst.cargoMass) this.cargo.push(inst.cargoMass.bind(inst));
      if (inst.wire) this.wires.push(inst.wire.bind(inst));
      if (inst.onShipRebuilt) this.rebuilt.push(inst.onShipRebuilt.bind(inst));
      if (inst.onShieldBreak) this.breaks.push(inst.onShieldBreak.bind(inst));
      if (inst.onLeave) this.leaves.push(inst.onLeave.bind(inst));
      if (inst.onSnapshot) this.snapshots.push(inst.onSnapshot.bind(inst));
      for (const [type, fn] of Object.entries(inst.messages ?? {})) {
        if (taken.has(type)) throw new Error(`server feature ${f.id}: message ${type} is already handled by the game`);
        if (messages.has(type)) throw new Error(`server feature ${f.id}: message ${type} has two handlers`);
        messages.set(type, fn);
      }
    }
    this.messages = messages;
  }

  /** The feature ids, in the order they run */
  list(): readonly string[] { return this.ids; }

  get(id: string): FeatureInstance | undefined { return this.byId.get(id); }

  tick(): void {
    for (let i = 0; i < this.ticks.length; i++) this.ticks[i]();
  }

  /** Mass its features add to a pilot's hold */
  cargoMass(eid: number): number {
    let m = 0;
    for (let i = 0; i < this.cargo.length; i++) m += this.cargo[i](eid);
    return m;
  }

  /** Every feature's pilot-row values, one after the other, into `out` from `at`; returns the index after the last */
  wire(eid: number, out: number[], at = 0): number {
    let n = at;
    for (let i = 0; i < this.wires.length; i++) {
      const tmp = this.scratch;
      tmp.length = 0;
      const k = this.wires[i](eid, tmp);
      for (let j = 0; j < k; j++) out[n++] = tmp[j];
    }
    return n;
  }
  private readonly scratch: number[] = [];

  /** A feature's status-row value (0: none, or no such feature) */
  status(id: string, eid: number): number { return this.byId.get(id)?.status?.(eid) ?? 0; }

  onShipRebuilt(eid: number): void {
    for (let i = 0; i < this.rebuilt.length; i++) this.rebuilt[i](eid);
  }

  onShieldBreak(eid: number): void {
    for (let i = 0; i < this.breaks.length; i++) this.breaks[i](eid);
  }

  onLeave(eid: number): void {
    for (let i = 0; i < this.leaves.length; i++) this.leaves[i](eid);
  }

  /** Does any feature want snapshot windows (onSnapshot)? The builder makes none otherwise */
  get wantsSnapshots(): boolean { return this.snapshots.length > 0; }

  onSnapshot(pilot: number, win: SnapshotWindow): void {
    for (let i = 0; i < this.snapshots.length; i++) this.snapshots[i](pilot, win);
  }
}
