/**
 * The programs the game draws with, in the order they're wanted, for compiling ahead (shaderWarmup): the sign-in
 * screen's first, then what flying needs as soon as the player is in (the world's layers, hulls, stations, rocks), then
 * the other stars' sun styles. Anything missing here still draws: Pixi compiles it on first use, as before.
 */
import type { Container, GlProgram, Renderer } from 'pixi.js';
import { sunShaderDefs, type StarSystemData } from '@space-game/common';
import { batchProgram, pipePrograms, programsUnder } from './shaderWarmup';
import { litProgram } from './lighting/litShader';
import { isSunProgram, sunProgram } from './SunRenderer';
import { skyPrograms } from './sky/SkyRenderer';
import { planetProgram } from './PlanetRenderer';
import { shipHullProgram } from './lighting/ShipBatch';
import { asteroidPrograms } from './lighting/AsteroidBatch';
import { stationProgram } from './stations/StationMaterials';
import { nestProgram } from './nests/nestShader';
import { particlePrograms } from './particlePool';

const styleIndex = (styles: { id: string }[], id: string | undefined, fallback: string) =>
  Math.max(0, styles.findIndex((s) => s.id === (id ?? fallback)));

/** Every sun style and corona style pair the systems' stars are drawn with (Renderer: lookOf, updateDetailStar) */
function sunPrograms(systems: StarSystemData[]): GlProgram[] {
  const { sunStyles, coronaStyles } = sunShaderDefs;
  const out: GlProgram[] = [];
  for (const s of systems) {
    const body = s.centralBody;
    if (!body || body.type === 'none') continue;
    // (A detail star is the brownian style, its corona off: whichever corona style is set, it draws the same)
    if ((body as { detailStar?: boolean }).detailStar) {
      const b = styleIndex(sunStyles, 'brownian', 'brownian');
      out.push(sunProgram(b, 0), sunProgram(b, 1));
    } else out.push(sunProgram(styleIndex(sunStyles, body.sunStyle, 'granular'), styleIndex(coronaStyles, body.coronaStyle, 'plasmaStreams')));
  }
  return out;
}

export function gameShaders(renderer: Renderer, signIn: Container | null, stage: Container, systems: StarSystemData[]): GlProgram[] {
  const batch = batchProgram(renderer);
  const out: GlProgram[] = batch ? [batch] : [];
  if (signIn) programsUnder(signIn, out);
  // (The world's sun is on its placeholder style until a system's visuals come: the systems' own styles are below)
  const world = programsUnder(stage).filter((p) => !isSunProgram(p));
  // (litProgram(2): a single lit object's, a station's before its bake or a stillstone)
  for (const p of [...skyPrograms(), ...world, ...pipePrograms(renderer), shipHullProgram(), stationProgram(), litProgram(2), ...asteroidPrograms(), ...particlePrograms(), nestProgram(), planetProgram(), ...sunPrograms(systems)]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
