/**
 * @contract validate.factions
 * owns:       factions.json: ranks, rules, station defence and ship plans resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { nestReach, safeRadius } from '@space-game/common';
import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateFactions(v: V): void {
  const { c, f, ships, systems, factions, sys, station, faction, design, weaponKind, item } = v;
  const F = 'factions.json';
  const fx = f.factions;
  for (const [id, def] of entries(fx?.factions)) {
    for (const [ship] of entries(def?.ships)) design(F, `factions.${id}.ships.${ship}`, ship);
    list(def?.loot).forEach((l, i) => item(F, `factions.${id}.loot[${i}].item`, l?.item));
  }
  const groups = (path: string, gs: unknown) => list(gs).forEach((g, i) => {
    const p = `${path}[${i}]`;
    const okF = faction(F, `${p}.faction`, g?.faction);
    list(g?.ships).forEach((ship, j) => {
      if (!design(F, `${p}.ships[${j}]`, ship) && ships) return;
      if (okF && typeof ship === 'string' && !isObj(factions.get(g.faction)?.ships?.[ship])) c.warn(`${p}.ships[${j}]`, `"${ship}" isn't in faction "${g.faction}"'s ships table: its kills pay nothing`, F);
    });
  });
  for (const [sid, sp] of entries(fx?.spawns)) {
    sys(F, `spawns.${sid}`, sid);
    if (sp?.grade !== undefined && (typeof sp.grade !== 'number' || sp.grade < 1 || sp.grade > 5)) c.err(`spawns.${sid}.grade`, 'grade is Mk I-V (1..5)', F);
    groups(`spawns.${sid}.groups`, sp?.groups);
    list(sp?.zones).forEach((z, i) => groups(`spawns.${sid}.zones[${i}].groups`, z?.groups));
    groups(`spawns.${sid}.events.warband.groups`, sp?.events?.warband?.groups);
    if (isObj(sp?.events?.peak)) {
      groups(`spawns.${sid}.events.peak.flock`, [sp.events.peak.flock]);
      list(sp.events.peak.goods).forEach((g, k) => item(F, `spawns.${sid}.events.peak.goods[${k}]`, g));
    }
    const zoneIds = new Set(list(sp?.zones).map((z) => z?.id));
    for (const k of ['raidZone', 'salvageZone'] as const) if (sp?.events?.[k] !== undefined && !zoneIds.has(sp.events[k])) c.err(`spawns.${sid}.events.${k}`, `"${sp.events[k]}" isn't one of this system's zones`, F);
    if (sp?.events?.warband && !zoneIds.has(sp.events.warband.zone)) c.err(`spawns.${sid}.events.warband.zone`, `"${sp.events.warband.zone}" isn't one of this system's zones`, F);
    list(sp?.events?.raidStations).forEach((st, k) => station(F, `spawns.${sid}.events.raidStations[${k}]`, st));
    // Nests: each one of the system's (systems.json nests), and hostile ones never reaching into its safe space
    const here = systems.get(sid);
    list(sp?.nests).forEach((n, i) => {
      const np = `spawns.${sid}.nests[${i}]`;
      groups(`${np}.groups`, n?.groups);
      const place = list(here?.nests).find((q) => q?.id === n?.id);
      if (!place) { if (here) c.err(`${np}.id`, `"${n?.id}" isn't one of ${sid}'s nests (systems.json)`, F); return; }
      list(n?.groups).forEach((g, k) => { if (g?.faction !== place.faction) c.warn(`${np}.groups[${k}].faction`, `"${g?.faction}" in ${place.faction}'s nest`, F); });
      if (n?.bias !== undefined && !(typeof n.bias === 'number' && n.bias >= 0 && n.bias <= 1)) c.err(`${np}.bias`, 'bias is 0..1 (how hard loose packs are drawn home)', F);
      if (n?.roam !== undefined && !(typeof n.roam === 'number' && n.roam > 600)) c.err(`${np}.roam`, 'roam must be over 600', F);
      const safe = safeRadius(here);
      const hostile = list(n?.groups).some((g) => !g?.passive);
      const leash = n?.leash ?? factions.get(list(n?.groups)[0]?.faction)?.behaviour?.leash ?? 0;
      if (safe > 0 && hostile && isObj(place.orbit) && nestReach(place, list(here?.planets)).min - leash < safe) c.err(np, `its hostiles reach into ${sid}'s safe space (it comes within ${Math.round(nestReach(place, list(here?.planets)).min)}, leash ${leash}, safe to ${safe})`, F);
    });
    for (const place of list(here?.nests)) if (!list(sp?.nests).some((n) => n?.id === place?.id)) c.warn(`spawns.${sid}.nests`, `nest "${place?.id}" has no packs here, so nothing ever launches from it`, F);
  }
  for (const [k] of entries(fx?.rules?.stationDefence)) weaponKind(F, `rules.stationDefence.${k}`, k);
  // A tougher grade never pays less a kill
  const gc = list(fx?.rules?.gradeCredits);
  gc.forEach((k, i) => { if (i > 0 && !(k >= gc[i - 1])) c.err(`rules.gradeCredits[${i}]`, `pays less than the grade below (${k} < ${gc[i - 1]}): kill credits never fall with grade`, F); });
}
