/**
 * @contract validate.stations
 * owns:       stations.json: market goods and station turrets resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateStations(v: V): void {
  const { f, stationDefence, ref, item, bag } = v;
  list(f.stations?.stations).forEach((st, i) => {
    const F = 'stations.json', P = `stations[${i}]`;
    list(st?.market?.sells).forEach((id, j) => item(F, `${P}.market.sells[${j}]`, id));
    bag(F, `${P}.market.demand`, st?.market?.demand);
    if (isObj(st?.defence)) ref(F, `${P}.defence.weapon`, 'station turret weapon (factions.json rules.stationDefence)', stationDefence, st.defence.weapon);
  });
}
