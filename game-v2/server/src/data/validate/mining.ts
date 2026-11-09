/**
 * @contract validate.mining
 * owns:       mining.json: fields, types and their items resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import {  } from '@space-game/common';
import { type V, entries, keysOf } from './context.js';
import { list } from '../validateShapes.js';

export function validateMining(v: V): void {
  const { c, f, ships, weaponKinds, asteroidTypes, ref, station, material, item, bag } = v;
  const F = 'mining.json';
  const m = f.mining;
  for (const [t, def] of entries(m?.types)) {
    ref(F, `types.${t}`, 'asteroid type (DEFAULT_ASTEROIDS)', asteroidTypes, t, 'warning');
    bag(F, `types.${t}.ores`, def?.ores);
  }
  bag(F, 'oreHardness', m?.oreHardness);
  for (const [t, def] of entries(m?.types)) if (def?.like !== undefined) ref(F, `types.${t}.like`, 'asteroid type', asteroidTypes, def.like);
  for (const [fid, mix] of entries(m?.fields)) {
    for (const [t] of entries(mix)) ref(F, `fields.${fid}.${t}`, 'asteroid type', asteroidTypes, t);
  }
  for (const [d, def] of entries(m?.danger)) bag(F, `danger.${d}.boost`, def?.boost);
  list(m?.seams).forEach((s, i) => item(F, `seams[${i}].gem`, s?.gem));
  for (const [t, g] of entries(f.gems?.types)) {
    item('gems.json', `types.${t}.material`, g?.material);
    for (const lv of keysOf(g?.levels)) item('gems.json', `types.${t}.levels.${lv}`, `gem_${t}_${lv}`);
  }
  for (const [lv, cut] of entries(f.gems?.cuts)) bag('gems.json', `cuts.${lv}.inputs`, cut?.inputs);
  bag('station.json', 'charter.items', f.station?.charter?.items);
  list(f.station?.sites).forEach((s, i) => station('station.json', `sites[${i}].station`, s?.station));
  for (const [t, def] of entries(f.station?.tracks)) list(def?.tiers).forEach((r, i) => bag('station.json', `tracks.${t}.tiers[${i}].cost`, r?.cost));
  for (const [k, w] of entries(ships?.tuning?.weapons)) if ((w as any)?.ammo) item('ships/tuning.json', `weapons.${k}.ammo.item`, (w as any).ammo.item);
  for (const [t, def] of entries(m?.traces)) {
    item(F, `traces.${t}`, t);
    list(def?.from).forEach((o, i) => item(F, `traces.${t}.from[${i}]`, o));
  }
  list(m?.guns?.common).forEach((o, i) => item(F, `guns.common[${i}]`, o));
  for (const [k, t] of entries(m?.tools)) {
    if (['fixed', 'turret', 'miner', 'siphon', 'minerByMaterial'].includes(k)) continue;
    if (ships && !weaponKinds.has(k)) c.warn(`tools.${k}`, `"${k}" is not a weapon kind, so nothing uses this tool`, F);
    // Every gun mines soft rock (all but the EMP, which does no damage to it)
    if (k !== 'emp' && !(t as any)?.yield) c.warn(`tools.${k}`, `"${k}" mines nothing: every gun should mine soft rock (yield > 0)`, F);
  }
  for (const [k] of entries(m?.tools?.minerByMaterial)) material(F, `tools.minerByMaterial.${k}`, k);
}
