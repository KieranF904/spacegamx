/**
 * @contract validate.extras
 * owns:       the small data files nothing else validates: strings.json (placeholders), mobs.json (blast, the mobs that part
 *             functions launch) and terrain/<id>.json (named for a real system, outlines well-formed)
 * needs:      validate/context (the ids and reference helpers), common MOB_IDS; browser-safe: no Node imports
 * invariants: the real data has no errors — server/src/data/validateGameData.test.ts
 *             a launched mob that does not exist (also those named in move code), an unbalanced string placeholder and a terrain file for no system are
 *             caught — server/src/data/validate/extras.test.ts
 * extend:     a new cross-reference check for one of these files goes in the function below
 */

import { MOB_IDS } from '@space-game/common';
import { type V, entries, str } from './context.js';
import { isObj, list, typeName } from '../validateShapes.js';

export function validateExtras(v: V): void {
  const { c, f, systems, ships } = v;
  for (const [k, text] of entries(f.strings)) {
    const s = str(text);
    if (s === undefined) continue;
    if (s.split('{').length !== s.split('}').length) c.err(k, `unbalanced "{" "}" in "${s}"`, 'strings.json');
  }
  const mobs = new Map(entries(f.mobs?.mobs));
  if (f.mobs !== undefined) {
    for (const fnd of ships?.catalog.functions?.functions ?? []) {
      const mob = (fnd as { id?: string; launches?: { mob?: string } })?.launches?.mob;
      if (mob !== undefined) v.ref('ships/functions.json', `${(fnd as { id?: string }).id}.launches.mob`, 'mob (mobs.json)', mobs, mob);
    }
  }
  // Mobs that move code launches by name (common MOB_IDS) must exist
  if (f.mobs !== undefined) for (const [k, id] of Object.entries(MOB_IDS)) v.ref('common/src/constants.ts', `MOB_IDS.${k}`, 'mob (mobs.json)', mobs, id);
  for (const [id, t] of Object.entries(f.terrain ?? {})) {
    if (!systems.has(id)) c.err(id, `terrain file for "${id}": no such system in systems.json`, 'terrain');
    validateTerrain(c, `terrain/${id}.json`, t);
  }
}

const isPoint = (p: unknown): boolean => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
const POLYGONS = ['rocks', 'mass', 'fill', 'holes', 'gates', 'walls', 'floor'];
const LINES = ['cliff', 'cliffIn'];
const LINE_SETS = ['streams', 'ridges'];

/** Terrain files (common/src/terrain.ts TerrainFile): outlines are arrays of [x, y] points, rock outlines have at least 3 */
function validateTerrain(c: V['c'], file: string, t: unknown): void {
  if (!isObj(t)) { c.err('', `must be an object, not ${typeName(t)}`, file); return; }
  if (!Array.isArray(t.rocks)) c.err('rocks', 'required: an array of outlines', file);
  const points = (path: string, pts: unknown, min: number): void => {
    if (!Array.isArray(pts)) { c.err(path, `must be an array of [x, y] points, not ${typeName(pts)}`, file); return; }
    if (pts.length < min) c.err(path, `has ${pts.length} point(s), needs at least ${min}`, file);
    const bad = pts.findIndex((p) => !isPoint(p));
    if (bad >= 0) c.err(`${path}[${bad}]`, 'not an [x, y] pair of numbers', file);
  };
  for (const k of POLYGONS) if (t[k] !== undefined) list(t[k]).forEach((poly, i) => points(`${k}[${i}]`, poly, 3));
  for (const k of LINES) if (t[k] !== undefined) points(k, t[k], 2);
  for (const k of LINE_SETS) {
    if (t[k] !== undefined) list(t[k]).forEach((s, i) => {
      points(`${k}[${i}].pts`, s?.pts, 2);
      if (Array.isArray(s?.pts) && Array.isArray(s?.w) && s.w.length !== s.pts.length) c.err(`${k}[${i}].w`, `has ${s.w.length} value(s) for ${s.pts.length} point(s)`, file);
    });
  }
  if (Array.isArray(t.cliff) && Array.isArray(t.cliffIn) && t.cliff.length !== t.cliffIn.length) c.err('cliffIn', `has ${t.cliffIn.length} direction(s) for ${t.cliff.length} cliff point(s)`, file);
}
