/**
 * Thruster cost, measured (logged, not asserted: timings vary by machine): a busy scene of 48 big ships, every engine
 * burning, half of them boosting, with each ship's engines swapped to one model in turn so every look is drawn. Times
 * ThrusterFx's per-frame work (beginFrame + draw for each ship: sprite updates and the exhaust), and counts the sprites
 * per nozzle and the exhaust particles alive. No WebGL here: the painted textures are stubbed with Texture.WHITE.
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { Container, Texture } from 'pixi.js';
import { blueprintGeometry, createShipState, loadCatalog, type Blueprint, type ShipState } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import type { InterpolatedEntity } from '../state/GameState';
import type { ShipSource } from './ShipStore';

vi.mock('../rendering/fxTextures', async (orig) => {
  const real = await orig<typeof import('../rendering/fxTextures')>();
  const white = () => Texture.WHITE;
  return { ...real, plumeBody: white, plumeCore: white, plumeDiamonds: white, puff: white, ring: white, softDot: white };
});

const { ThrusterFx } = await import('./ThrusterFx');

const cfg = loadShipConfigFromDisk(join(__dirname, '../../../data')) as ReturnType<typeof loadShipConfigFromDisk> & { library: Record<string, Blueprint>; enemies: Record<string, Blueprint> };
const catalog = loadCatalog(cfg.catalog as never, { overlapShrink: cfg.tuning.overlapShrink });
const tuning = cfg.tuning, cs = tuning.cellSize;

const ENGINE = /^(thruster|afterburner|plasma_drive|engine_)/;
const MODELS = ['engine_ion_drive', 'engine_vernier', 'engine_afterburner', 'engine_torch', 'engine_plasma_drive', 'engine_fusion_torch', 'engine_drift_sail', 'engine_reaction_thruster', 'thruster', 'plasma_drive'];

describe('thruster cost', () => {
  it('a busy scene: 48 big ships, every engine burning', () => {
    const designs = [cfg.library['bastion-dreadnought'], cfg.library.hammerhead, cfg.library.galleon, cfg.enemies.pyreclast, cfg.library.hauler, cfg.library.lancer];
    const ships: { ship: ShipState; e: InterpolatedEntity; c: Container }[] = [];
    for (let k = 0; k < 48; k++) {
      const bp = designs[k % designs.length], fn = MODELS[k % MODELS.length];
      const swapped: Blueprint = { ...bp, parts: bp.parts.map((p) => (ENGINE.test(p.fn) ? { ...p, fn } : p)) };
      const ship = createShipState(catalog, tuning, k + 1, swapped, 0);
      const e = { id: k + 1, type: 'ship', x: k * 400, y: 0, angle: 0, vx: 1, vy: 0, renderX: k * 400, renderY: 0, renderAngle: 0, hp: 1, maxHp: 1, angVel: 0 } as unknown as InterpolatedEntity;
      ships.push({ ship, e, c: new Container() });
    }
    const geoms = new WeakMap<Blueprint, ReturnType<typeof blueprintGeometry>>();
    const source = { catalog, tuning, bodies: new Map(), get: () => undefined, geometry: (s: ShipState) => { let g = geoms.get(s.blueprint); if (!g) { g = blueprintGeometry(catalog, s.blueprint); geoms.set(s.blueprint, g); } return g; } } as unknown as ShipSource;
    const fx = new ThrusterFx(new Container(), source);
    const dt = 1 / 60;
    const frame = (f: number) => {
      fx.beginFrame(dt);
      ships.forEach(({ ship, e, c }, k) => fx.draw(c, ship, e, { dir: [0, -1], turn: 0.4, boost: k % 2 === 0 && f % 240 < 180 }, dt, cs, k % 3 === 0 ? 0xd94040 : undefined));
    };
    for (let f = 0; f < 60; f++) frame(f);
    const N = 240, t = performance.now();
    for (let f = 0; f < N; f++) frame(f);
    const ms = (performance.now() - t) / N;
    const sprites = ships.reduce((a, s) => a + s.c.children.length, 0);
    const visible = ships.reduce((a, s) => a + s.c.children.filter((x) => x.visible).length, 0);
    const particles = (fx.exhaustLayer as unknown as { particleChildren: unknown[] }).particleChildren.length;
    console.log(`[thrusterPerf] 48 ships: ${ms.toFixed(3)} ms a frame, ${sprites} nozzle sprites (${visible} visible), ${particles} exhaust particles`);
    expect(sprites).toBeGreaterThan(0);
    expect(particles).toBeGreaterThan(0);
  });
});
