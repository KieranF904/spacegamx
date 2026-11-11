# Loot tables, wreck salvage, the pickup panel and hold ghosts (2026-11-11)

Kieran's decisions (the brief), mapped to code. Ambiguities and how they were resolved are at the end.

## A. Drop tables

| Rule | Code |
|---|---|
| Named weighted tables in `data/loot.json`: `{ tables: { <id>: { nothing, entries: [{ item, weight, min, max }] } } }`. One roll picks one entry by weight (`nothing` counts as an entry) and drops `min..max` of it (both default 1). | `common/src/econ/loot.ts` (`rollTable`, `rollDrops`), `data/loot.json` |
| `kind: "always"`: every entry drops (`min..max`) on each roll; no weights, no `nothing`. Bosses' guaranteed drops. | same |
| Who drops what: `drops: [{ table, rolls }]` and `eliteDrop: <table>`. Set on the faction (the default), on a design (`factions.json ships.<design>`), or for a design in one system (`factions.json spawns.<system>.loot.<design>`, the Scrap Nest den). The most specific one wins, `drops` and `eliteDrop` separately. No grade or tier scaling. | `dropSpecFor` in `common/src/econ/loot.ts`; `server/src/game/enemies/loot.ts` |
| Elites: one extra roll on their `eliteDrop` table (replaces "elites roll the whole loot list twice"). `rules.eliteLoot` still multiplies an elite's XP and credits. | `enemies/loot.ts` |
| Bosses: `bosses.json <boss>.drops` (the same `[{ table, rolls }]`), rolled per winner as before; their guaranteed drops are an `always` table. | `server/src/game/Bosses.ts` (`rollLoot`) |
| Rolls use the server-only payout dice (`lootDice`, SHA-256 counter stream). Payout to the killer and party is unchanged (a pod for kills, storage for bosses). | unchanged streams `kill loot`, `boss loot` |
| The old `loot` lists (factions, bosses) are gone. Den caches (`systems.json` dens) and derelicts keep their own small lists: they are not enemies. | `FactionDef`, `BossDef`, `validateShapes.ts` |
| Validator: every table's items exist, weights > 0, `nothing` >= 0, `1 <= min <= max`, every `drops`/`eliteDrop` names a table, rolls a whole number >= 1, a `spawns.<sys>.loot` key names a design. | `server/src/data/validate/loot.ts` |
| Field guide: per kill, the chance of at least one of an item, shown only as Low / Medium / High (`tiers.ts`). | `dropChances` in `econ/loot.ts`; `client/src/ui/resources/sourceIndex.ts`, `resourceIndex.ts`; the site's `build-catalog.ts` uses the same numbers |

### Sol tables and rolls (as given)

Tables `scrap_common`, `scrap_rare`, `pirate_common`, `pirate_rare`, `helios_common`, `nest_rare` exactly as in the brief.
Rolls: scrap mite / spitter `scrap_common` x1; crawler / lobber x2; hulk x2 + `scrap_rare` x1; in the den
(`sol_scrap_nest`) crawler / darter / rivet sower `scrap_common` x1 + `nest_rare` x1; pirate skiff / redtooth cutter
`pirate_common` x1; pirate raider / redtooth brawler / pirate gunship `pirate_common` x2 + `pirate_rare` x1;
helios drone `helios_common` x1. Scrap Mother and Hollow Crown: a small `shield_emitter` chance (the Mother's new
`boss_scrap_mother_rare` table; the Crown already had 15%). Tallyman and Hollow Crown: a low-chance `reactor_core`.

### Converting everything else

For a faction's old list (each entry an independent `chance`), entries with `chance >= 0.1` form `<faction>_common`
and the rest `<faction>_rare`. A table rolled R times (R = the chances summed, rounded up) gives each entry weight
`100 x chance / R` and `nothing` the rest, so an entry's expected count per kill is what it was. The faction rolls
both, and its `eliteDrop` is its rare table. Bosses: chance-1 entries become `<boss>_always` (kind `always`), the rest
`<boss>_rolls` the same way. Scrapborn designs the brief doesn't name (swarmer, the Nest, the Midden giant) take the
scrapborn default (`scrap_common` x1; the Nest structure as a hulk).

## B. Player wreck salvage

`salvageShare` (data/rules.json `death`) of the standing, non-free parts, picked by the payout dice as before, but each
drops as the **refined materials of its bill** (`recipes.partInputs`: plate, wire, ...), not as a placeable item.
Components in a bill (chips, servos) do not come back. Cargo still all goes in the wreck. (`death.ts salvage`)

## C. The pickup panel

- **What is in reach**: every pod within `PULL_RANGE` (380) of the hull, the same radius the auto pull used. The server
  works it out for each pilot every 10 ticks and sends `lootNear { pods: [{ id, items, wreck? }] }` only when the list
  or a pod's contents changed (a wreck: `mine`, or `lock` seconds until it opens to all). Not a per-tick record.
- **Panel** (`client/src/ui/pickup/`): F opens it (Esc or F closes; it does not block flying). Rows grouped by item
  with amounts across pods; wrecks as a row each with the owner timer. Click a row: take that item; Take all, or
  Enter while open. Items that won't fit show greyed "Hold full"; a take that would use space a ghost reserves warns.
- **Taking is one decision message**: `lootTake { item? }` (none: all). The server checks range, the wreck's keeping,
  and hold space, takes from the nearest pods first, and gives through the normal give path, which sends `gained` and
  the `PickupItem` effect (the tractor line from pod to ship) that pulled pods already used. No fire or input latency.

## D. Auto-pickup and ghosts

- **Ore** (categories mineral, gem, volatile: what mining yields) auto-collects while `Collect all ore` is on (default
  on: `profile.pickup.oreOff` absent).
- **Ghosts** (`ShipRecord.wants`, on the ship's record): `{ item, n? }`. No `n`: unlimited, always collects, reserves 5
  units of its volume. With `n`: reserves `n - held`, collects up to `n`, then the ghost is removed (the stack is now
  real). Ore and other auto pickups can't use another ghost's reservation; a ghost's item uses its own and free space;
  a manual take may use reserved space (the panel warns). Pure rules: `common/src/econ/holdGhosts.ts` (both sides).
- Pods are pulled only by a ship that would auto-collect something in them, and on contact only that part is given;
  the rest stays for the panel. Mining chunks are ore, so mining feels as before.
- Ghosts stay with the ship: a different ship has its own; a death clears them (the record's design is rebuilt bare).
- **Templates** (`profile.pickup.templates`, up to 12): "Save current ghosts as..." and "Load" (replaces the current
  ghosts) from the hold. Messages: `ghost { item, n?, remove? }`, `ghostTemplate { save | load | remove }`,
  `pickupPrefs { ore }`.

## E. The item catalogue picker

Opened from the hold (`+ Want item`) and its Templates menu. Reuses the field guide's item icons
(`guideChips.itemIcon`), category icons and level gates (`levels.ts`). Sections: Mining (ores, gems), Enemy drops
(by enemy, Low/Medium/High), Components, Refined materials, Salvage (items that come from scrapping and wrecks),
Templates; a search box. Each tile says where it comes from ("Scrap Nest den · rare", "Nebula tar rocks", "Not in
Sol"). Items above the pilot's level show with a lock and their level. Model: `client/src/ui/pickup/catalogue.ts`.

## F. Training

One step after "Mine the belt": "Loot in reach" (`panel: pickup`), teaching F and Enter. `TUTORIAL_PANELS` gains
`pickup`.

## Ambiguities resolved

- **The key**: G is the autopilot. F was bound to an unused "Tractor beam pickup" action: it is now "Pickup panel".
- **Elites' "rare table"**: an explicit `eliteDrop` per faction / design / den design, so a design whose list has no
  rare table (a mite) still has a defined extra roll (scrapborn: `scrap_rare`; in the den: `nest_rare`).
- **The den rolls** differ from the same designs outside it, so a third override level (`spawns.<system>.loot`) was
  needed; it is keyed by design and only exists for `sol_scrap_nest`.
- **"Ore"** for the switch: minerals, rough gems and volatiles, i.e. everything a rock gives.
- **Unlimited ghost reservation**: 5 units of space always kept free for it (not "5 minus held"), so a ghost item can
  keep coming in however many are held.
- **Fly-to-ship**: the server gives at once and the client draws the existing tractor effect; pods are not split and
  re-pulled (that would cost anchors and time for no gameplay).
- **Wreck salvage "refined materials"**: only refined-category inputs of the bill; components are dropped.
- **Boss loot conversion**: grouping a boss's chance entries into one rolled table keeps each item's average; the
  odds of getting two specific rare items in one kill shift a little. Accepted ("averages roughly").
