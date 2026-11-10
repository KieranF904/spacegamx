/**
 * A ship's view in ShipRenderer when the ship goes and comes straight back (its entity dropped for a moment and sent
 * again, or the same id coming back while the old view is still fading out), and when it's docked and leaves again.
 * The hull is a slot in the ShipBatch keyed by the ship's id: a second view beside the fading one lost its hull the
 * moment the old one finished fading (the hull never drawn again, its guns and flames, and once its wires, still were).
 * The batch, hull builds and effect systems are stand-ins here: what's checked is who holds the slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { Container } from 'pixi.js';
import { createShipState, EntityType, isWeaponFn, type Blueprint } from '@space-game/common';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/ships/createShipBridge';

// The hull batch: which ship ids hold a slot, and which were placed (drawn) this frame
const batch = vi.hoisted(() => ({ slots: new Set<number>(), placed: new Set<number>() }));
vi.mock('../rendering/lighting/ShipBatch', async () => {
  const { Container: C } = await import('pixi.js');
  return {
    ShipGeometry: class {},
    ShipBatch: class {
      container = new C();
      begin() { batch.placed.clear(); }
      track() {}
      set(id: number) { batch.slots.add(id); }
      remove(id: number) { batch.slots.delete(id); }
      place(id: number) { if (batch.slots.has(id)) batch.placed.add(id); }
      setDamage() {}
      end() {}
      destroy() {}
    },
  };
});
vi.mock('../rendering/lighting/Lighting', () => ({ Lighting: class {}, LitMesh: class { mesh = { destroy() {} }; destroy() {} } }));
vi.mock('./hullWorkerClient', () => ({ HullWorker: class { ok = false; build() {} terminate() {} } }));
vi.mock('./hullBuild', () => ({ buildHull: () => ({ hull: { full: {}, far: {} }, barrels: [] }), skeletonCovered: () => new Map() }));
vi.mock('./ThrusterFx', async () => {
  const { Container: C } = await import('pixi.js');
  return { ThrusterFx: class { exhaustLayer = new C(); beginFrame() {} draw() {} forget() {} collectLights() {} } };
});
vi.mock('./PartFx', () => ({ PartFx: class { draw() {} } }));
vi.mock('../rendering/fxTextures', () => ({ beam: () => null }));

const { ShipRenderer } = await import('./ShipRenderer');

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../data')));
// A design with no frame or skeleton (nothing here builds lit meshes), its guns taken off (their looks paint canvases)
const base = Object.values(bridge.enemyDesigns as Record<string, Blueprint>).find((bp) => !bp.rigid && bp.parts.every((p) => {
  const pc = bridge.catalog.pieces.get(p.piece);
  return !pc?.frame && !pc?.skeleton;
}))!;
const design: Blueprint = { ...base, parts: base.parts.filter((p) => !isWeaponFn(p.fn)) };
const ID = 7;

function scene() {
  const ship = createShipState(bridge.catalog, bridge.tuning, ID, design, 0);
  const source = { catalog: bridge.catalog, tuning: bridge.tuning, bodies: new Map([[ID, ship]]), get: (id: number) => source.bodies.get(id), geometry: (s: typeof ship) => bridge.geometry(s) };
  const entity = { id: ID, type: EntityType.ShipBody, x: 0, y: 0, angle: 0, vx: 0, vy: 0, renderX: 0, renderY: 0, renderAngle: 0, hp: 1, maxHp: 1, data: [1], lastServerUpdate: 0 };
  const state = { playerId: 1, serverTick: 0, entities: new Map<number, unknown>([[ID, entity]]), charge: { b: [] } };
  const lighting = { enabled: true, addSource() {}, removeSource() {}, add() {}, remove() {}, envAt: () => 1, levelAt: (_x: number, _y: number, out: number[]) => out };
  const renderer = { lighting, getShipLayer: () => new Container(), hiddenEntityIds: new Set<number>(), shipRadius: new Map<number, number>(), inView: () => true, getZoom: () => 1, tagScale: 1 };
  let docked = false;
  const sr = new ShipRenderer(source as never, renderer as never, state as never, () => null, (id) => id === ID && docked);
  return { sr, state, entity, dock: (on: boolean) => { docked = on; } };
}

let now = 0;
const frame = (sr: InstanceType<typeof ShipRenderer>, ms = 16) => { now += ms; sr.update(); };

describe('a ship view that goes and comes back', () => {
  beforeEach(() => {
    batch.slots.clear();
    batch.placed.clear();
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps its hull when its entity is gone for a frame or two and sent again', () => {
    const { sr, state, entity } = scene();
    for (let i = 0; i < 10; i++) frame(sr);
    expect(batch.placed.has(ID)).toBe(true);
    // Gone (an interest flicker, a re-sent entity): it starts fading out...
    state.entities.delete(ID);
    frame(sr);
    // ...and is back before it's faded
    state.entities.set(ID, entity);
    frame(sr);
    // Long past the fade-out: its hull still has its slot and is still drawn
    for (let i = 0; i < 40; i++) frame(sr);
    expect(batch.slots.has(ID)).toBe(true);
    expect(batch.placed.has(ID)).toBe(true);
  });

  it('a ship gone for good still lets its slot go once faded out', () => {
    const { sr, state } = scene();
    for (let i = 0; i < 10; i++) frame(sr);
    state.entities.delete(ID);
    for (let i = 0; i < 40; i++) frame(sr);
    expect(batch.slots.has(ID)).toBe(false);
  });

  it('docked and out again: the same view, hull placed', () => {
    const d = scene();
    for (let i = 0; i < 10; i++) frame(d.sr);
    d.dock(true);
    for (let i = 0; i < 10; i++) frame(d.sr);
    expect(batch.placed.has(ID)).toBe(false);
    d.dock(false);
    for (let i = 0; i < 10; i++) frame(d.sr);
    expect(batch.slots.has(ID)).toBe(true);
    expect(batch.placed.has(ID)).toBe(true);
  });
});
