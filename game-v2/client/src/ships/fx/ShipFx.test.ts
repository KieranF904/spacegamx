/**
 * The ship effect layers (ShipFx.init): what glows is added as a bloom source, and the local jump charge sound is cut
 * on abort. The effect classes are stand-ins here (their drawing is their own); this is the wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { ShipFx, type ShipFxHost } from './ShipFx';

const glow = (name: string) => ({ name });
vi.mock('../../ui/IncomingWarning', () => ({ IncomingWarning: class {} }));
vi.mock('../JumpFx', () => ({ JumpFx: class { onPhase: unknown; } }));
vi.mock('../BossFx', () => ({ BossFx: class { glowLayer = { name: 'boss' }; partsAt: unknown; } }));
vi.mock('../DamageFx', () => ({ DamageFx: class { glowLayer = { name: 'damage' }; setQuality() {} collectLights() {} } }));
vi.mock('../MiningBeamFx', () => ({ MiningBeamFx: class { glowLayer = { name: 'beam' }; } }));
vi.mock('../ScannerFx', () => ({ ScannerFx: class {} }));
vi.mock('../ChargeFx', () => ({ ChargeFx: class { glowLayer = { name: 'charge' }; } }));

function rig() {
  const bloom: unknown[] = [];
  const sounds: string[] = [];
  const stops: string[] = [];
  const renderer = {
    lighting: { addSource: () => {} },
    getShipLayer: () => ({}), getEffectLayer: () => ({}), getZoom: () => 1,
    addBloomSource: (c: unknown) => bloom.push(c),
  };
  const shipRenderer = { glowLayers: () => [glow('hull-a'), glow('hull-b')] };
  const host = {
    state: { playerId: 1 }, store: {}, tuning: {}, jump: {}, econ: {}, ownBeams: new Set(), chargeTells: new Map(), strike: {},
    sound: (id: string) => { sounds.push(id); return () => { stops.push(id); }; },
  } as unknown as ShipFxHost;
  const fx = new ShipFx(host);
  fx.init(renderer as never, shipRenderer as never);
  return { fx, bloom, sounds, stops };
}

describe('what glows is added as a bloom source', () => {
  it('the ships\' glow layers and the damage, beam, boss and charge layers all bloom', () => {
    const { bloom } = rig();
    expect(new Set(bloom.map((b) => (b as { name: string }).name))).toEqual(new Set(['hull-a', 'hull-b', 'damage', 'beam', 'boss', 'charge']));
  });
});

describe('the local jump charge sound is cut on abort', () => {
  it('charging starts the whine, going back to ready cuts it; another ship\'s is not kept', () => {
    const { fx, sounds, stops } = rig();
    const onPhase = (fx.jumpFx as unknown as { onPhase: (id: number, prev: string, next: string, x: number, y: number) => void }).onPhase;
    onPhase(1, 'ready', 'charging', 0, 0);
    expect(sounds).toEqual(['jump_charge']);
    expect(stops).toEqual([]);
    onPhase(1, 'charging', 'ready', 0, 0); // aborted
    expect(stops).toEqual(['jump_charge']);
    expect(fx.chargeSound).toBeNull();
    // another pilot's charge aborting does not cut ours
    onPhase(1, 'ready', 'charging', 0, 0);
    onPhase(2, 'charging', 'ready', 0, 0);
    expect(stops).toEqual(['jump_charge']);
  });
});
