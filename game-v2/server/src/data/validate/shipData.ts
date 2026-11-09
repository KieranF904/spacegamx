/**
 * @contract validate.shipdata
 * owns:       the ship data files (functions, materials, pieces, tuning, inventory, plans): ids and the wire dictionary
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { FN_NAMES, WEAPON_KIND_TYPE, DICTIONARY, type Blueprint } from '@space-game/common';
import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateShipData(v: V): void {
  const { c, ships, fnRows, materials, pieces, weaponKind, fn, material, piece } = v;
  if (!ships) return;
  const dict = new Set(DICTIONARY);
  fnRows.forEach((d, i) => {
    const F = 'ships/functions.json', P = `functions[${i}]`;
    if (typeof d?.id !== 'string') return;
    if (!(d.id in FN_NAMES) && typeof d.name !== 'string') c.err(`${P}.id`, `function "${d.id}" has no display name in FN_NAMES (common/src/econ/items.ts)`, F);
    if (!dict.has(d.id)) c.warn(`${P}.id`, `function "${d.id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts): sent as a plain string`, F);
    if (Array.isArray(d.pieces)) d.pieces.forEach((pc: unknown, j: number) => piece(F, `${P}.pieces[${j}]`, pc));
    if (d.weapon !== undefined) weaponKind(F, `${P}.weapon`, d.weapon);
  });
  for (const id of materials.keys()) if (!dict.has(id)) c.warn(`materials (${id})`, `material "${id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts)`, 'ships/materials.json');
  // (Bespoke pieces go as plain strings: once, with their design)
  for (const [id, p] of pieces) if (!dict.has(id) && !(p as { polygon?: unknown })?.polygon) c.warn(`pieces (${id})`, `piece "${id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts)`, 'ships/pieces.json');
  for (const [kind, w] of entries(ships.tuning?.weapons)) {
    const F = 'ships/tuning.json';
    if (w?.type === 'projectile' && !w?.pointDefence && !(kind in WEAPON_KIND_TYPE)) c.err(`weapons.${kind}`, `projectile kind "${kind}" is missing from WEAPON_KIND_TYPE (common/src/ecs/components.ts): clients draw it as a cannon shell`, F);
    if (isObj(w?.split)) weaponKind(F, `weapons.${kind}.split.kind`, w.split.kind);
  }
  for (const [k] of entries(ships.tuning?.weaponGrades)) weaponKind('ships/tuning.json', `weaponGrades.${k}`, k);
  for (const [k] of entries(ships.tuning?.partBlast)) fn('ships/tuning.json', `partBlast.${k}`, k);
  for (const [k] of entries(ships.inventory?.pieces)) piece('ships/inventory.json', `pieces.${k}`, k);
  list(ships.inventory?.materials).forEach((m, i) => material('ships/inventory.json', `materials[${i}]`, m));
  const parts = (file: string, bp: Blueprint) => list(bp?.parts).forEach((p, i) => {
    piece(file, `parts[${i}].piece`, p?.piece);
    fn(file, `parts[${i}].fn`, p?.fn);
    material(file, `parts[${i}].material`, p?.material);
  });
  for (const [name, bp] of Object.entries(ships.library ?? {})) parts(`ships/blueprints/${name}.json`, bp);
  for (const [name, bp] of Object.entries(ships.enemies ?? {})) parts(`ships/blueprints/enemy/${name}.json`, bp);
}
