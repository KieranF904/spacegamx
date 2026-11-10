/**
 * The programs the game draws with, in the order they're wanted, for compiling ahead (shaderWarmup): the sign-in
 * screen's first (its sky and star), then what flying needs as soon as the player is in (the world's layers, hulls,
 * stations, rocks), then the black-hole sky's ring (only black-hole systems draw it). Anything missing here still draws:
 * Pixi compiles it on first use, as before.
 */
import type { Container, GlProgram, Renderer } from 'pixi.js';
import type { StarSystemData } from '@space-game/common';
import { batchProgram, pipePrograms, programsUnder } from './shaderWarmup';
import { litProgram } from './lighting/litShader';
import { sunProgram } from './sun/SunRenderer';
import { skyPrograms, skyRingProgram } from './sky/SkyRenderer';
import { planetPrograms } from './planetView/planetQuad';
import { shipHullProgram } from './lighting/ShipBatch';
import { asteroidPrograms } from './lighting/AsteroidBatch';
import { stationProgram } from './stations/StationMaterials';
import { nestProgram } from './nests/nestShader';
import { particlePrograms } from './particlePool';
import { solarRingProgram } from './solarRing';

export function gameShaders(renderer: Renderer, signIn: Container | null, stage: Container, systems: StarSystemData[]): GlProgram[] {
  const batch = batchProgram(renderer);
  const out: GlProgram[] = batch ? [batch] : [];
  if (signIn) programsUnder(signIn, out);
  const world = programsUnder(stage);
  // (litProgram(2): a single lit object's, a station's before its bake or a stillstone; the sky's ring last, and only
  // if a system has a black hole)
  const ring = systems.some((s) => s.centralBody?.type === 'black_hole') ? [skyRingProgram()] : [];
  // (the Helios Array's, if a system has a solar ring)
  const solar = systems.some((s) => s.structures?.some((st) => st.kind === 'solar_ring')) ? [solarRingProgram()] : [];
  for (const p of [sunProgram(), ...skyPrograms(), ...world, ...pipePrograms(renderer), shipHullProgram(), stationProgram(), litProgram(2), ...asteroidPrograms(), ...particlePrograms(), nestProgram(), ...solar, ...planetPrograms(), ...ring]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
