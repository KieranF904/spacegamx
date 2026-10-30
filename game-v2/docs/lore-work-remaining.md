# Lore: work remaining

Written 2026-10-25, after the first integration pass. The two Claude Docs are the source of truth. The **secret canon** (`TjjYsuevNmvAkM1SwhGpXc`) decides what exists and is never quoted in game. The **public canon** (`NcmnFC36qfqFVJHdcXjCv3`) is everything a player may learn. `docs/lore-canon.md` records what the game's text says now. Read it before writing anything.

`docs/lore-integration-plan.md` is the original plan. Parts of it no longer apply:
- **Dropped:** the Kindling, and one-off server-wide scripted events.
- **Changed:** New Meridian keeps its name (its origin is a mystery). "The Ark" is the order, never the ship. Greyseam has no grades.

## Done in this pass (for reference)

- **Re-canon of all existing text** (quests, people, systems, items, bosses, factions, stations, field guide, strings):
  - The colony is thousands of years old.
  - The first ship is unnamed; New Meridian's name has no agreed origin.
  - Greyseam is ungraded; cores whisker.
  - Scrapborn are feral cores; their salvage is said to be cursed.
  - Pilots call the signal the heartbeat; the observatory calls it natural; 7-K is catalogued.
  - The Helios Directorate is seeded; the Gardener exists only as folklore (Joe, Sander).
  - New topics for Quinn, Kerr (including her gap), Marrow, Brannoch and Achebe.
  - The Void Leviathan is no longer called a "herald".
- **Stillstones:**
  - Per-stone `size`, `state` (active, scarred, dead, shattered), `scar` and `rough`, with matching mechanics, map, markers and autopilot.
  - New placement: 3–4 in the main systems, fewer plus dead or shattered ones in the dangerous systems; sizes halved after review.
  - New look as lit polygons in `client/src/rendering/StillstoneMesh.ts`: crown, rosette and nested-polygon carvings in weathered rock.
- **Records (codex):** `data/codex.json` and a Records tab in the pilot log. Unlocks come from conditions, a dialogue line `{codex}`, quest rewards and items. Each unlock is logged to telemetry as `codex_<id>`. 17 entries so far.
- **The Ark:** reputation `ark` and the Ark Hall in Sol, plus a herald, the Keeper, a Quartermaster, an Expedition Master at the Maw, a depot hand and a settler. Seven quests (`ark_01`–`ark_07`).
- **Leestone:** ore, refined stone and plate, mined in the Maw. The material is deliberately heavy and not better. Quest refit steps can now require a material (`refit.material`), and there is an `ark-tender` plan.

Nothing has been deployed. Every test passes (545 tests).

## Done in pass 2

- **Derelict logs as a feature:** `log: { codex }` on systems.json derelicts; read by flying within 900 of the hulk (a scan step's range is inside it) or by the salvage kill. Logs for the Vigil, the Perseverance, the Shattered Bell, the Halvard, and the new Ark Tender Grey Hour in its own Drift nest. The Bell's and the Halvard's log items carry the same records.
- **Bellwether, first act:** the Helios Seat, Director Mbeki, Engineer Rask, reputation `helios`, `bw_01`–`bw_04`, records `helios_performance`, `helios_drone_logs`, `kerr_array_recording`, and the leaked `ark_minute`.
- **kerr_03 "The Filaments":** record `kerr_filaments`; Quinn's electrochemistry topic.
- **Hints and contradictions from §2:** the lifeless rich seam (the Quiet Seam), cores that never whisker (Thule Works), an Ark ship that woke (the Grey Hour), a prune that was wrong (the Kessick relay), a cruel moment near Sol (tn_storms), a spike with no drop (Quinn), dates that disagree (Kask against Aske), a new stillstone with no signal (the Aurora Knot's charting), Helios drone logs, trace finds that follow players (Brannoch and the trace ledger), pruned sites that are long-worked (Okafor), the Ark ledger of wakings (the Patrol's appendix, `waking_table`). 16 new records (33 in all).

## 1. Story arcs still to build

### Bellwether and the Helios Directorate (Acts II–III)
With scripted events dropped, every beat is per pilot: quest steps, `after` lines and codex records.
- **Done in pass 2 (first act):** the Helios Seat, Director Mbeki, Engineer Rask, reputation `helios`, and `bw_01`–`bw_04` (haul, the curve, Kerr's recording, a load test that sets the date). See lore-canon.md "Bellwether".
- **Quest chain, still to build:**
  2. Construct a mast. This needs a new `structure` kind in `client/src/rendering/BuildSites.ts` (today it only draws `nav_buoy`). Until then bw_04's "Bellwether mast one" is only a hold marker on the rail; a `construct` job could slot in before bw_04 or replace its hold.
  5. Commissioning (`bw_05`, after bw_04; Mbeki has promised to call). The calibration pulse goes in a Directorate log, and 7-K's drop goes in the observatory catalogue. These are two separate records: no line ever connects them.
  6. Closure: projects stop failing; the shield "works".
- **Leaked Ark minute:** done in pass 2 as record `ark_minute`, a page Marek found packing a crate (his topic after bw_01). Mbeki only repeats the rumour. If the author decides the opposition was public (§6.3), the Director's Ark topic is the line to change.
- **Decoys:** two unrelated distant signatures off the bearing, a whisker wave in Glasswater refineries, and a feral swarm in Borealis.
- **Optional, needs per-pilot state:** after Commissioning, the glow in stillstone veins shifts hue very slightly for that pilot. This is a flag read by the client, which tints the glow lines in `StillstoneMesh.ts` / `LodestoneView`.

### The Failure (late Act III / Act IV)
- **Author's choice needed:** which world, and what the event is called (see §6). The plan recommended Verdance in Nebula Prime: "the Verdance Failure".
- **The city:** a surface with a city half dark. Needs a `ruined` fraction in `CityView.ts`, which is a small code change.
  - Scrapborn remnants at low standing density (passive groups, a new `ruin` nest look in `NestViews.ts`).
  - The Ark hall district still lit ("built sturdier").
- **Chain, told in aftermath:**
  1. Repeatable relief runs.
  2. Evacuation convoy escorts.
  3. A core recall: deliver core parts from storage. Taking fitted cores would need code.
  4. Three contradicting testimonies, as codex pages in each voice; the inquiry's verdict is supplier, firmware and a contaminated batch.
  5. The memorial.
- **Ark side:** the herald came a day early; the Keeper can't say why.
- **The distant signature:** afterwards, one Observatory catalogue line and one Kerr line ("I think they're related. I can't say how."), catalogued by bearing only and never named.
- **Unlock order:** several quest steps after Commissioning, with unrelated main-line steps between.

### The Cenotaph (Act IV, beyond the Maw)
- **First pass, data only:**
  - **System:** `cenotaph`, reached by a rift from the Maw gated on main_13. A dim star (a tuned `brown_dwarf` or sun), `visuals.biome: 'void'`, very low ambient light, darkness hazard.
  - **Shell:** fragments approximated with `ruin_ring` structures.
  - **Wardens:** a faction of passive groups that stay angry once provoked.
  - **Vault Camp:** an archivist reads the damaged last record one way; Brother Aske (who moves there) reads it the other.
  - **Fold quest:** scan the shell, run the breach course, recover and construct the apparatus, then hold.
  - **The ship-log line:** one line, once per profile, that says nothing about what it is. The author must approve the wording.
- **Proper pass, small code each:**
  - a `dim_star` central-body shader with slow threads of light;
  - a `shell` structure kind with partial arcs and a breach;
  - vault doors as pinned wards that open on a flag.
- **The lost ship:** the late reveal of the first ship's wreck and records (a relic with insight into the signal; "the first warning we obeyed"; never tied to the Ark by name). Where the wreck lies is still open (§6).

### Smaller threads
- **Maw records:** each sale to Horizon Watch unlocks one badly translated fragment, with several incompatible endings (a sickness in their machines, a war, a failing star, a god arriving).

## 2. Hints and planted contradictions not yet placed

Each needs an attributed line or record with its innocent reading (lore-integration-plan.md §13 has the full table).

- **A Halden ruin older than the Maw:** its dating is wrong, and nothing ever says so. (Pass 2's `halden_dating` already puts one Halden case from the Maw's debris older than Kask's breaking; a ruin would sit beside it.)
- **A kind echo in the Maw:** one presence near the shard ring that repairs ships (needs a repair hook on a ward), or something cheaper.

## 3. Mechanics not yet built

- **Hidden per-ship character and a whisker term:**
  - a seed and a `whisker` number on `ShipRecord` (profile v4);
  - salvage-sourced parts (Scrapborn, ruins, Bellwether) push it up; leestone armour share and the regimen (scrap and rebuild) bring it down;
  - it drives small cosmetic quirks only;
  - **lean is never a stat:** nothing in the UI, no tooltip and no scan ever shows it.
- **Codex follow-ups:**
  - records for finishing individual quest steps;
  - "It hums" unlocks on holding a trace, so buying one counts too; a refinery hook would be exact;
  - more entries as each arc lands.
- **"Cursed" salvage:** today it is only a superstition in dialogue. Feeding it into the whisker term above would make it quietly true.

## 4. Follow-ups from this pass

- **Ark Hall accent:** stations take their accent colour from their index, so the Hall can't be grey without a small client change.
- **Leestone on the wire:** `leestone` isn't in the binary wire dictionary. It works as a plain string; adding it needs a `PROTOCOL_VERSION` bump and the hash in `protocol.test.ts`.
- **Polishing the Grey (ark_02):** it accepts only an alloy 1×2 core (steps need an exact part id), and it has no core-swap step.
- **Stillstones:** now lit polygons (`StillstoneMesh.ts`), so they take every light and cost about what a station does. The field radius is still `size + 1250` after the sizes were halved; check the field still feels right.
- **Text nits:**
  - osei_01 says the Kestrel is "south of Sol Central", which doesn't match its position.
  - ice_03's "came off the same line as the first crews' own" reads a little oddly.
  - Kerr lost her six years when the hab's drives froze one winter.
  - The Scrap Mother's boss intro (`bosses.json`, `boss_scrap_mother.intro`) ends "The Scrap Mother wakes, and the nest hums with drones." That is the narration saying a machine woke, and "waking" is a pilots' word for cores (Marrow: "it's settling in"). Neutralise it (she "stirs", "comes up out of the junk") or put it in someone's mouth. The website's first update post (`site/seed/posts/02-the-scrap-mother.md`) quotes the intro and now stops before that sentence.
- **From pass 2:**
  - The Helios Seat has the same index-based accent problem as the Hall: it should read Directorate white.
  - "Bellwether mast one" (bw_04) and the stalled drone (bw_02) are only markers; nothing is drawn there.
  - The Quiet Seam is a zone label over the shoal's existing rock; it has no field of its own, so it mines like the rest of the shoal.
  - The Survey Dock and the Grey Hour Nest are fixed (`period: 0`) so quest spots and the wreck stay on them; the other two Helios docks still orbit.
  - The Grey Hour flies as the `ark-tender` plan (the hauler with leestone armour) until Ark ships get their own look (§5).
  - Absolute dates now exist in two records (`maw_breaking` about 11,000 years, `halden_dating` nearly 14,000). If the secret canon fixes ages, check these against it.

## 5. Visual direction still to apply

- **Leestone and Ark ships:** dense, dark, matte, nothing glowing. "Ark-heavy" should read at a glance; today an Ark tender is a hauler with leestone armour.
- **Bellwether:** clean Directorate white against the Array's old Halden arc.
- **The Failure's city:** half dark, cranes still, the Ark district lit.
- **The Cenotaph:** a grey-white dim star behind vast slate arcs, near-black ambient light, very slow threads of light, dark patient wardens.

## 6. Decisions the author still needs to make

1. The Failure's world, and what the event is called.
2. Where the lost ship's wreck is found, and how big the reveal is.
3. Is the Ark's opposition to Bellwether public, or only in leaked records?
4. The wording of the one Act IV ship-log line.
5. What sits at the far end of the bearing. The canon says leave it undecided until the universe expands that far.
6. Are the New Halden a human faith (as written now)?
7. Is "greyseam" final?
