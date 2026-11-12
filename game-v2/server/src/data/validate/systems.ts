/**
 * @contract validate.systems
 * owns:       systems.json: portals, rifts, stations, surfaces, pockets, arenas, gun ranges, dens, planets
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { dhypot } from '@space-game/common';
import { type V } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateSystems(v: V): void {
  const { c, f, systems, stations, bosses, asteroidFields, ref, sys, station, faction, record, plan, material, item } = v;
  const F = 'systems.json';
  const listedStations = new Map<string, string>();
  const lodestoneIds = new Set<string>();
  const nestIds = new Set<string>();
  list(f.systems?.systems).forEach((s, i) => {
    const P = `systems[${i}]`;
    list(s?.portals).forEach((g, j) => sys(F, `${P}.portals[${j}].targetSystem`, g?.targetSystem));
    list(s?.rifts).forEach((r, j) => sys(F, `${P}.rifts[${j}].destination.system`, r?.destination?.system));
    list(s?.stations).forEach((id, j) => {
      const p = `${P}.stations[${j}]`;
      if (!station(F, p, id)) return;
      if (listedStations.has(id)) c.err(p, `station "${id}" is also listed by system "${listedStations.get(id)}"`, F);
      listedStations.set(id, s.id);
      const st = stations.get(id);
      if (st.system !== s.id) c.err(p, `station "${id}" says it is in "${st.system}" but is listed (and spawned) here in "${s.id}"`, F);
    });
    if (s?.asteroidField !== undefined) ref(F, `${P}.asteroidField`, 'asteroid field (DEFAULT_ASTEROID_FIELDS)', asteroidFields, s.asteroidField);
    list(s?.asteroidBelt?.extra).forEach((b, k) => { if (b?.field !== undefined) ref(F, `${P}.asteroidBelt.extra[${k}].field`, 'asteroid field (DEFAULT_ASTEROID_FIELDS)', asteroidFields, b.field); });
    const sf = s?.surface;
    if (isObj(sf)) {
      if (sys(F, `${P}.surface.of`, sf.of)) {
        const planet = list(systems.get(sf.of).planets).find((p) => p?.id === sf.planet);
        if (!planet) c.err(`${P}.surface.planet`, `system "${sf.of}" has no planet "${sf.planet}"`, F);
        else if (typeof sf.moon === 'number' && !list(planet.moons)[sf.moon]) c.err(`${P}.surface.moon`, `planet "${sf.planet}" has no moon ${sf.moon}`, F);
      }
      if (isObj(sf.siege) && sf.siege.faction !== undefined) faction(F, `${P}.surface.siege.faction`, sf.siege.faction);
      if (sf.arena && !s.instance) c.warn(`${P}.surface.arena`, 'an arena with no `instance` slots: every party shares one copy', F);
      // (a cave: its mouth is on another surface)
      if (isObj(sf.under) && sys(F, `${P}.surface.under.surface`, sf.under.surface) && !isObj(systems.get(sf.under.surface).surface)) c.err(`${P}.surface.under.surface`, `"${sf.under.surface}" is not a surface`, F);
    }
    // A pocket: its way in is out in another system (not a surface, not another pocket), and where you arrive is inside its edge
    const pk = s?.pocket;
    if (isObj(pk) && isObj(pk.entrance)) {
      if (sys(F, `${P}.pocket.entrance.system`, pk.entrance.system) && (systems.get(pk.entrance.system).surface || systems.get(pk.entrance.system).pocket)) c.err(`${P}.pocket.entrance.system`, `"${pk.entrance.system}" is a surface or a pocket: a pocket's way in is out in space`, F);
      if (isObj(pk.entrance.look)) faction(F, `${P}.pocket.entrance.look.faction`, pk.entrance.look.faction);
      if (s.surface) c.err(`${P}.pocket`, 'a system is a surface or a pocket, not both', F);
      if (isObj(pk.landing) && typeof pk.radius === 'number' && dhypot(pk.landing.x, pk.landing.y) >= pk.radius) c.err(`${P}.pocket.landing`, `outside its edge (radius ${pk.radius}): you'd be sent straight back out`, F);
    }
    // A boss arena: its boss lairs here, and where a pilot is put out of it is outside it
    const ar = s?.arena;
    if (isObj(ar)) {
      const bd = bosses.get(ar.boss);
      if (!bd) c.err(`${P}.arena.boss`, `no boss "${ar.boss}" in bosses.json`, F);
      else if (bd.system !== s.id || bd.arena) c.err(`${P}.arena.boss`, `"${ar.boss}" doesn't lair in "${s.id}"`, F);
      if (isObj(ar.outside) && isObj(ar.centre) && typeof ar.radius === 'number' && dhypot(ar.outside.x - ar.centre.x, ar.outside.y - ar.centre.y) <= ar.radius + 100) c.err(`${P}.arena.outside`, 'inside the arena: a pilot put out would be put back in', F);
      if (ar.barrier !== undefined && (!Array.isArray(ar.barrier) || ar.barrier.length !== 2 || ar.barrier.some((p: unknown) => !Array.isArray(p) || p.length !== 2))) c.err(`${P}.arena.barrier`, 'two points, [[x, y], [x, y]]', F);
    }
    // The gun range: a private, empty system of rooms; each room's spawn and targets on its floor, a target a real
    // faction's ship or a mob (never both, never neither), the rooms' ids each their own
    const gr = s?.gunRange;
    if (isObj(gr) && Array.isArray(gr.rooms)) {
      if (!s.private) c.err(`${P}.gunRange`, 'a gun range must be `private` (never on the galaxy map, reached only from a station)', F);
      if (list(s.portals).length || list(s.stations).length) c.err(`${P}.gunRange`, 'a gun range has no gates and no stations of its own', F);
      if (!gr.rooms.length) c.err(`${P}.gunRange.rooms`, 'a gun range needs at least one room', F);
      const ids = new Set<string>();
      gr.rooms.forEach((room: any, j: number) => {
        const R = `${P}.gunRange.rooms[${j}]`;
        if (!isObj(room) || !isObj(room.spawn) || !Array.isArray(room.targets) || !isObj(room.centre)) return;
        if (ids.has(room.id)) c.err(`${R}.id`, `"${room.id}" is another room's id`, F);
        ids.add(room.id);
        const inside = (x: number, y: number) => Math.abs(x - room.centre.x) < room.width / 2 && Math.abs(y - room.centre.y) < room.height / 2;
        if (!inside(room.spawn.x, room.spawn.y)) c.err(`${R}.spawn`, 'outside the chamber', F);
        // Its doors: one exit; any other leads to another room of this range, which has a door back
        const doors: any[] = list(room.doors).filter(isObj);
        if (doors.filter((d) => d.to === 'exit').length !== 1) c.err(`${R}.doors`, 'a room has exactly one door `to` "exit"', F);
        doors.forEach((d, k) => {
          if (d.to === 'exit') return;
          const other = gr.rooms.find((x: any) => isObj(x) && x.id === d.to);
          if (!other || other === room) c.err(`${R}.doors[${k}].to`, `"${d.to}" is not another room of this range (or "exit")`, F);
          else if (!list(other.doors).some((x: any) => isObj(x) && x.to === room.id)) c.err(`${R}.doors[${k}].to`, `room "${d.to}" has no door back to "${room.id}"`, F);
        });
        if (!room.targets.length) c.err(`${R}.targets`, 'a room needs at least one target', F);
        room.targets.forEach((t: any, k: number) => {
          if (!isObj(t)) return;
          if (!inside(t.x, t.y)) c.err(`${R}.targets[${k}]`, 'outside the chamber', F);
          if (!!t.mob === !!t.ship) c.err(`${R}.targets[${k}]`, 'a target is a `ship` (with its `faction`) or a `mob`, one of the two', F);
          if (t.ship) faction(F, `${R}.targets[${k}].faction`, t.faction);
        });
      });
    }
    // A den's features: its vents' cycle takes each vent once; a cache's crust is a material, its loot items
    list(s?.den).forEach((d, j) => {
      const dp = `${P}.den[${j}]`;
      if (d?.kind === 'vents') {
        const n = list(d.at).length, order = list(d.order);
        if (order.length !== n || new Set(order).size !== n || order.some((i) => !(Number.isInteger(i) && i >= 0 && i < n))) c.err(`${dp}.order`, `each of its ${n} vents once (0..${n - 1})`, F);
        if (!(d.every > 0 && d.tell >= 0 && d.burn > 0)) c.err(dp, '`every` and `burn` above 0', F);
      } else if (d?.kind === 'cache') {
        material(F, `${dp}.material`, d.material);
        list(d.loot).forEach((l, k) => { item(F, `${dp}.loot[${k}].item`, l?.item); if (!(l?.min >= 1 && l?.max >= l?.min && l?.chance > 0 && l?.chance <= 1)) c.err(`${dp}.loot[${k}]`, 'chance 0..1, 1 <= min <= max', F); });
        if (!(d.hp > 0 && d.cells >= 3)) c.err(dp, '`hp` above 0, at least 3 `cells` across', F);
      }
    });
    list(s?.planets).forEach((pl, j) => {
      const pp = `${P}.planets[${j}]`;
      const target = (id: unknown, path: string, moon?: number) => {
        if (!sys(F, path, id)) return;
        const t = systems.get(id as string).surface;
        if (!isObj(t)) c.err(path, `system "${id}" is not a surface`, F);
        else if (t.of !== s.id || t.planet !== pl.id || (moon !== undefined && t.moon !== moon)) c.warn(path, `surface "${id}" says it belongs to ${t.of}/${t.planet}${t.moon !== undefined ? ` moon ${t.moon}` : ''}`, F);
      };
      if (pl?.surface !== undefined) target(pl.surface, `${pp}.surface`);
      list(pl?.moons).forEach((m, k) => { if (m?.surface !== undefined) target(m.surface, `${pp}.moons[${k}].surface`, k); });
    });
    list(s?.derelicts).forEach((d, j) => {
      plan(F, `${P}.derelicts[${j}].blueprint`, d?.blueprint);
      if (isObj(d?.log)) record(F, `${P}.derelicts[${j}].log.codex`, d.log.codex);
    });
    // Stillstones (`lodestones`): orbiting or fixed (not both); a camp's spot zone has to sit on a fixed one (packs don't follow an orbit)
    list(s?.lodestones).forEach((l, j) => {
      const lp = `${P}.lodestones[${j}]`;
      if (!isObj(l)) return;
      if (typeof l.id === 'string') { if (lodestoneIds.has(l.id)) c.err(`${lp}.id`, `duplicate lodestone id "${l.id}"`, F); lodestoneIds.add(l.id); }
      if ((l.orbit === undefined) === (l.position === undefined)) c.err(lp, 'a lodestone needs exactly one of `orbit` or `position`', F);
      if (l.scar !== undefined && l.state !== 'scarred') c.err(`${lp}.scar`, 'only a scarred stillstone has a `scar`', F);
      if (l.size !== undefined && !(typeof l.size === 'number' && l.size > 0)) c.err(`${lp}.size`, 'a stillstone needs a size over 0', F);
      if (l.zone === undefined) return;
      const z = list(s.zones).find((q) => q?.id === l.zone);
      if (!z) c.err(`${lp}.zone`, `"${l.zone}" isn't one of this system's zones`, F);
      else if (l.orbit !== undefined) c.err(`${lp}.zone`, 'an orbiting lodestone leaves its spot zone behind: give it a fixed `position`', F);
      else if (z.x !== l.position?.x || z.y !== l.position?.y) c.err(`${lp}.zone`, `zone "${l.zone}" isn't centred on it (it's at ${z.x}, ${z.y})`, F);
    });
    // Nests: whose, and what they circle (a planet of this system, or one of its moons)
    list(s?.nests).forEach((n, j) => {
      const np = `${P}.nests[${j}]`;
      if (!isObj(n)) return;
      if (typeof n.id === 'string') { if (nestIds.has(n.id)) c.err(`${np}.id`, `duplicate nest id "${n.id}"`, F); nestIds.add(n.id); }
      faction(F, `${np}.faction`, n.faction);
      const pl = n.around !== undefined ? list(s.planets).find((q) => q?.id === n.around) : undefined;
      if (n.around !== undefined && !pl) c.err(`${np}.around`, `"${n.around}" isn't one of this system's planets`, F);
      if (n.moon !== undefined && (n.around === undefined || (pl && !list(pl.moons)[n.moon]))) c.err(`${np}.moon`, n.around === undefined ? 'a moon needs `around` (its planet)' : `${n.around} has no moon ${n.moon}`, F);
    });
    list(s?.traffic).forEach((t, j) => {
      plan(F, `${P}.traffic[${j}].blueprint`, t?.blueprint);
      list(t?.route).forEach((id, k) => {
        const p = `${P}.traffic[${j}].route[${k}]`;
        if (station(F, p, id) && !list(s.stations).includes(id)) c.err(p, `station "${id}" isn't in "${s.id}" (traffic only flies between this system's stations)`, F);
      });
    });
  });
  list(f.stations?.stations).forEach((st, i) => {
    if (!sys('stations.json', `stations[${i}].system`, st?.system)) return;
    // (A private system's dock is spawned with each copy, not listed)
    if (typeof st.id === 'string' && !listedStations.has(st.id) && !list(f.systems?.systems).some((s) => s?.id === st.system && s?.private)) c.warn(`stations[${i}]`, `station "${st.id}" is not listed in any system's stations, so it is never spawned`, 'stations.json');
  });
}
