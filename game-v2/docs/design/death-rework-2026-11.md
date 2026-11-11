# Death, backups, wrecks and the repair bank (rework, 2026-11-11)

Kieran's decisions (condensed in the brief). This replaces section 6 of `field-fabrication.md` ("respawn in the same
design, the bank pays") and the bank's respawn role in section 2.4. The rest of field fabrication stands.

## The rules, and the code they change

| # | Rule | Code |
|---|---|---|
| 1 | A death loses the ship. It goes back to its hangar slot as its design with **every part missing** (all ghosts, the core too), marked `lost` and on order: the hangar re-fabricates and rebuilds it in full from storage, as for any order. Nothing of it is kept but the design (gems on its guns go too). | `server/src/game/pilots/death.ts` (`loseShip`), Hangar's existing `lost` handling (it can't be flown until whole) |
| 1 | `MaterialDef.persistent` (ships/materials.json): in the schema, unused; no material sets it | `common/src/ships/types.ts` |
| 2 | The pilot respawns in a **backup**: the starter (free, always offered) or one of their own ships that qualifies: build points at most `backupCost` (1.25) times the starter's, no part above the starter's grade (tier), every part licensed at level 0. A backup that dies is lost like any ship; the free starter is the floor (losing it makes no plan) | `common/src/econ/backups.ts` (the rule), `server/src/game/pilots/backups.ts` (options, the free starter, the choice), `respawn { backup }`, `backups` message |
| 3 | The wreck holds **all** of the cargo, the machines' contents and `salvageShare` (0.25) of the ship's parts (picked by the payout dice; since 2026-11-11 each as the refined materials of its bill, not as parts: loot-pickup-2026-11.md B). Owner only for `wreckOwnerMinutes` (5), then anyone for `wreckOpenMinutes` (5), then gone. A death inside a boss chamber leaves it outside: past the barrier at the arena's `outside` point (the Pyreclast's cavern, the Scrap Mother's nest: shared systems, so that is the chamber's own entrance), or for an instanced surface arena (the Deep Foundry, whose copy is cleared) in orbit in its parent system | `death.ts` (`leaveWreck`), `PilotHost.wreckSpot`, `hosts/pilots.ts`, `Surfaces.orbitSpot`, `LootPods` (keep + life) |
| 4 | The station bank mends a ship that **survived**: damaged parts, and destroyed parts that were built. A part never built (planned in the build view, `ShipRecord.unbuilt`) or not rebuilt since a death (a ghost) needs full fabrication. The free part pays level-0 parts only; deposits pay any part. Cost `BANK.repairShare` (0.5) of the part's inputs (times the missing HP share for damage) | `common/src/econ/field/bank.ts`, `RepairBank.ts`, `bridge/rebuild.ts repairStep` (skips unbuilt parts), `field/plan.ts` + `FieldShips.install` (keep `unbuilt`) |
| 5 | No bank in the field: the fabricator and refiner work from the hold only | `FieldShips.pay` (bank spare removed), `wiring/net.ts` |
| 6 | Quitting mid-fight: the ship lingers (combatLock.ts) and a death while it lingers goes through `onDestroyed` like any other | checked, with a test (`death.test.ts`) |

## Ambiguities resolved

- **"All of the cargo"**: the secure hold no longer applies on a death, and safe space (inner Sol) no longer keeps the
  hold: one rule everywhere, since the pilot comes back in another ship whose hold may be smaller. The cargo panel's
  secure-hold hint goes. (`secureHold` stays in common, unused by death.)
- **"Share of its parts as salvage"**: a share of the parts themselves, chosen by the payout dice
  (`round(parts x share)`), each in its placeable form (`placeCost`: a module as its item, structure as its plates),
  not the old ore-and-components breakdown. Parts the free starter came with are never salvaged, scrapped or refunded
  (`ShipRecord.free`), so dying or scrapping in it can't mint materials.
- **"Cost"** for backup eligibility is build points (`buildPoints`, what the hangar already calls a ship's cost);
  **"tier"** is the highest part grade (`partGrade`); **"available at level 0"** is `partLicensed(part, [], 0)`.
- **Which ships are offered**: hangar ships that qualify, aren't `lost`, and have their core built. They fly as they
  stand (missing parts stay missing). The free starter takes a free hangar slot (or one past the bays, dropped when it
  is left), and is dropped when the pilot respawns in, or flies, another ship.
- **A ship identical to the starter** (the one a new pilot is given) is the floor too: losing it makes no plan.
- **Logged out while dead**: the death already made the starter active, so they log back in flying it.
- **The free part's role**: no respawn payment any more, so its whole balance (not just the top half) pays station
  repairs of level-0 parts. The `repairBank` message keeps its shape (`spare` is now that whole balance).
- **Field drain and speed (point 5)**: unchanged. A Field Fabricator draws 40 E/s, the most of any part (the Sparrow T
  makes 70), runs at speed 1 (a Sparrow's parts take 90 s), and the core's own at 0.25 with no draw; it already
  competes with guns and shields for power. That reads as heavy and slow, so nothing was adjusted.
- **Old saves**: `ShipRecord.owed` is no longer read or written by the bank (owed parts are just ghosts now: the
  hangar or a fabricator builds them). A save whose active ship is a ghost-cored lost ship is not possible from this
  code (the death makes the starter active).

## Deploy-time notes

- `ShipRecord.loaner`, `ShipRecord.owed` and the v6 `fieldUpdate` migration are still there (scheduled to go at deploy).
  When they go: drop `owed` from `cleanRecord` and `capture`, and the `fixLoaners` path; nothing here reads them.
- `persist.ts flyLoaner` (a saved ship that fails the rules flies the starter in its place) is a different thing and
  stays: its death costs the cargo and leaves the saved ship as it was.
- The JSON messages changed, all additive (`respawn.backup`, the `backups` message, `wreck.open`). The wire hash did not
  (`npm run wire:bump` found nothing to bump), so PROTOCOL_VERSION stays 68: an old client still respawns (in the
  starter) and ignores `backups`. Bump it by hand at deploy if old clients should be turned away.
- Live saves: a ship an old death left with owed ghosts keeps them as plain ghosts (the hangar or a fabricator builds them); the bank no longer pays them at login.
- `data/rules.json` gains a `death` section (`wreckOwnerMinutes`, `wreckOpenMinutes`, `salvageShare`, `backupCost`).
