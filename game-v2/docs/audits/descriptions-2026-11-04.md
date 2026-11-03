# Item, map and station descriptions, 2026-11-04

Kieran's note: many item and planet descriptions volunteer too much (history, who buys it, rumours, the assayer's opinion), "Leestone for example". Each text below was cut to a plain chart entry: what it is, where it is found, what it is for. Practical facts were kept (what it refines into, what a drop is needed for, who wants a quest item). Ids and names are unchanged.

Where the text is shown: items.json `description` in item tooltips, the cargo and station windows; systems.json `description` on map hover cards (planets, moons, structures, nests, stillstones, zones, regions, surfaces); stations.json `market.note` under the station window title.

Reviewed and left as they were because they are already plain: most ore, refined, ammo, consumable and gem-socket item texts, gems.json summaries, mining.json (names only), most nest, stillstone and zone texts, station descriptions, and station.json track "about" lines (these mention features still to come; left for Kieran to decide).

## Items

**iron_ore**
- Before: The backbone of every hull. Found in almost every belt.
- After: Common ore found in almost every belt. Alloyed into plate.

**nickel_ore**
- Before: Alloyed with iron into hull plating.
- After: Common ore. Alloyed with iron into hull plating.

**cobalt_ore**
- Before: Dense blue ore from dangerous belts. Refined into cobalt superalloy.
- After: Ore from dangerous belts. Refined into cobalt superalloy.

**neutronium_ore**
- Before: Impossibly dense ore from the deepest, deadliest belts (the Void, the Maw). Refined into Mk V plating.
- After: Ore from the Void and the Maw. Refined into Mk V plating.

**crystal**
- Before: Glasswater's crystal: the clearest greyseam anyone has found. Hums under a scanner. Focuses beams and stores charge.
- After: Crystal ore from Glasswater. Focuses beams and stores charge.

**void_opal**
- Before: A gem that shifts colour as you turn it. Only the hardest mining tools crack it free. Very valuable to traders.
- After: A gem. Only the hardest mining tools crack it free. Very valuable.

**ferrite_ore**
- Before: Dense, magnetic iron ore, thick in the Maw's slag. Heavy plate that holds its place in a gravity well.
- After: Dense iron ore, thickest in the Maw. Refined into ferrite plate.

**chromite**
- Before: Black, glassy chromium ore. Hardens steel for railgun barrels and armour-piercing slugs.
- After: Chromium ore. Hardens steel for railgun barrels and armour-piercing slugs.

**aurum**
- Before: Gold-bright flecks in noble ore, only found by refining it. Conducts like nothing else.
- After: A trace metal found by refining copper ore. A very good conductor.

**pale_iridium**
- Before: A trace metal in ice and volatile ore, found by refining it. Very dense, and it stops radiation.
- After: A trace metal found by refining ice and volatile ore. Very dense; stops radiation.

**voidglass**
- Before: A natural glass, in traces through crystal ore and richest in gem seams. Found by refining. Refiners say a batch of it hums for a while after.
- After: A trace glass found by refining crystal ore, richest in gem seams.

**aurora_rime**
- Before: Ice grown inside the aurora, threaded with greyseam, from the floes of the Rime Shoal. Under a scanner it barely hums at all. Refined into hush panes.
- After: Ice from the aurora floes of the Rime Shoal. Refined into hush panes.

**singularity_dust**
- Before: Specks of collapsed matter in the mega rocks of the Maw and the Void, found only by refining them.
- After: A trace material found by refining the mega rocks of the Maw and the Void.

**hush_pane**
- Before: Aurora rime pressed into a pane. Behind one, a receiver hears nothing but hiss. Borealis Research pays for every one.
- After: Aurora rime pressed into a pane. Borealis Research buys them.

**singularity_grain**
- Before: Refined singularity dust: specks of collapsed matter, pressed into grains. Rare, and valuable to traders.
- After: Refined singularity dust. Rare and valuable.

**scrap_electronics**
- Before: Salvaged boards and cracked cores. Every wreck has some; technicians check it under a microscope for whiskering before they trust it.
- After: Salvaged boards and cracked cores. Every wreck has some.

**nav_computer**
- Before: Jump plotting and scanners: current through a sliver of greyseam. Pilots swear some fly better than others; the yard says it's the batch.
- After: Plots jumps and drives scanners.

**quantum_core**
- Before: The heart of capital-class cores: greyseam packed dense, with more current through it than anything else aboard. Engineers argue over its firmware endlessly.
- After: The heart of capital-class cores.

**void_ichor**
- Before: Bled by wraiths. Refiners say it hums wrong, and won't say more.
- After: Dropped by wraiths.

**cinder_ash**
- Before: Ash from the Cinder Cult's altars, still warm. Used to fabricate the Cinder Bloom.
- After: Ash from the Cinder Cult's altars. Used to make the Cinder Bloom.

**rustjaw_cog**
- Before: A cog torn from Rustjaw's drive train, teeth still sharp. Very rare: few kills leave one whole. Rustjaw's Hive can't be made without it.
- After: A drive cog from Rustjaw. A rare drop; Rustjaw's Hive can't be made without it.

**frost_heart**
- Before: A dense blue core cut from the Hoarfrost Matriarch's wreck. Frost forms on anything that touches it. Very rare: few kills leave one whole. The Frostbite Lance can't be made without it.
- After: A core from the Hoarfrost Matriarch's wreck. A rare drop; the Frostbite Lance can't be made without it.

**cinder_ember**
- Before: A coal from a Cinder furnace, the Warden's or the Pyreclast's, still hot to the touch. Very rare: few kills leave one whole. The Cinder Bloom can't be made without it.
- After: A coal from the Warden or the Pyreclast. A rare drop; the Cinder Bloom can't be made without it.

**prism_shard**
- Before: A shard broken from the Prism Colossus. It splits any light that touches it. Very rare: few kills leave one whole. The Prism Splitter can't be made without it.
- After: A shard from the Prism Colossus. A rare drop; the Prism Splitter can't be made without it.

**void_pearl**
- Before: A smooth, dark pearl the size of a fist, found in the Void Leviathan's wreck. Very rare: few kills leave one whole. The Phase Cannon can't be made without it.
- After: A pearl from the Void Leviathan's wreck. A rare drop; the Phase Cannon can't be made without it.

**maw_fragment**
- Before: A dark, heavy fragment broken from the Heart of the Maw. Very rare: few kills leave one whole. The Singularity Launcher can't be made without it.
- After: A fragment of the Heart of the Maw. A rare drop; the Singularity Launcher can't be made without it.

**ancient_relic**
- Before: A small sealed case, far older than the colony: Halden work, collectors say, even the ones that turn up in the Maw. Nobody has opened one. Collectors pay well; fabricators pay better.
- After: A small sealed case. Sells to collectors and fabricators.

**railgun_quench**
- Before: Railgun slugs with a cryogen core: poor slugs, 30% less damage, but Cinder Cult ships take two and a half times that (Forgemaster Hale's pattern: "cold cracks hot plate"). Not the Cult's great ones. 200 a crate. Pressed only by your own station's armoury.
- After: Railgun slugs with a cryogen core: 30% less damage, but 2.5 times that against Cinder Cult ships (not their great ones). 200 a crate. Pressed only by your own station's armoury.

**cannon_hv**
- Before: Cannon shells that fly half as fast again (as far as ever: they just get there sooner). 150 a crate. A cannon fires its own plain shells without them.
- After: Cannon shells that fly 50% faster. 150 a crate. A cannon fires its own plain shells without them.

**fractured_plating**
- Before: A slab of the Kestrel's hull, split clean along a seam. Dr. Osei wants it.
- After: A slab of the Kestrel's hull. Dr. Osei wants it.

**crucible_pattern**
- Before: Old Pell's drawings for a field crucible: how the Halcyon foundry poured its first steel.
- After: Pell's drawings for a field crucible.

**field_crucible**
- Before: A crucible small enough to fly, hot enough to make steel. Dr. Osei's experiment.
- After: A portable crucible for making steel. Dr. Osei's experiment.

**probe_core**
- Before: The memory of one of Sabine Kerr's listening probes, full of static.
- After: The memory core of one of Sabine Kerr's listening probes.

**drone_core**
- Before: The core of a Scrapborn relay drone, more or less in one piece. The Sentinel Watch yard wants a look at it. The old hands say it's cursed.
- After: The core of a Scrapborn relay drone. The Sentinel Watch yard wants it.

**smuggler_cache**
- Before: A sealed cargo cache from the Lanes, still warm. The Patrol will want to see inside.
- After: A sealed cargo cache from the Lanes. The Patrol will want to inspect it.

**vigil_log**
- Before: The Dreadnought Vigil's last log, pulled from its bridge. The Tenth Fleet's final hours, and three days of entries after its crew was logged dead. Warden Holt puts that down to a faulty clock.
- After: The Dreadnought Vigil's bridge log, pulled from the wreck.

**meridian_beacon**
- Before: A landing beacon older than any record, dug out of the Pale Reef on Terra Nova. The Museum Guild argues over whose landing it marks.
- After: A landing beacon dug out of the Pale Reef on Terra Nova.

**buoy_frame**
- Before: A nav buoy's base ring and keel. The first piece to go up.
- After: A nav buoy's base ring and keel.

**buoy_mast**
- Before: A nav buoy's mast: the spine everything else hangs on.
- After: A nav buoy's mast.

**buoy_cell**
- Before: A pair of power cells for a nav buoy, good for a decade on a trickle.
- After: A pair of power cells for a nav buoy.

**buoy_dish**
- Before: A nav buoy's dish and transponder: what Traffic actually talks to.
- After: A nav buoy's dish and transponder.

**halvard_log**
- Before: The flight log of the Lighter Halvard, an early colony lander, lost on the ice road centuries ago.
- After: The flight log of the Lighter Halvard, an early colony lander lost on the ice road.

**halden_cache**
- Before: A small sealed case of slate, cut out of the ice under Glacia. It's light. Whatever is inside, there isn't much of it.
- After: A small sealed case of slate, cut out of the ice under Glacia.

**leestone_ore**
- Before: A dense, dark stone, found in traces in rock across the cluster and thickest in the Maw's shard ring. Its grain looks worked; Horizon Watch's assayers put that down to the Maw's pressures. The Ark buys it. Nobody else much wants it.
- After: A dark, dense stone. Found in traces in rock across the cluster, thickest in the Maw's shard ring. Refined into leestone.

**leestone**
- Before: Dressed leestone: dark, dense and dear. Only the Ark builds with it, so everyone calls it Ark stone. Nobody else sees the point.
- After: Refined leestone. Made into leestone plate.

**leestone_plate**
- Before: Leestone faced on a steel backing: Ark plating. Heavier than steel, no tougher than titanium, and dear to patch. The Ark says it's tradition and durability; pilots call the ships that carry it Ark-heavy.
- After: Hull plating: leestone faced on a steel backing. Heavy.

**ark_old_stock**
- Before: A crate of retired machinery from the Ark Depot: pump housings, coil packs, a core cradle. Every piece logged, tagged and taken out of service long before it wore out.
- After: A crate of retired machinery from the Ark Depot: pump housings, coil packs, a core cradle.

**helios_cell**
- Before: A pallet of Helios Directorate power cells, stencilled for the Seat. Heavier than it looks.
- After: A pallet of Helios Directorate power cells, for the Seat.

**helios_perf_logs**
- Before: A Helios service dock's performance logs: output per tonne of greyseam on the Array's rail, week by week. Engineer Rask wants them for her chart.
- After: A Helios service dock's weekly performance logs. Engineer Rask wants them.

**helios_drone_logs**
- Before: A month of one Helios drone's service log, pulled from a drone stalled on the Array's rail.
- After: A month of one Helios drone's service log.

**kerr_recorder**
- Before: One of Sabine Kerr's listening recorders, older than you are and wrapped in tape. She wants it back with half a minute of the Helios Array on it.
- After: One of Sabine Kerr's listening recorders. She wants it back with half a minute of the Helios Array recorded on it.

## Map cards (systems.json)

- Before: An ocean world with a breathable atmosphere, and the colony's first settled world. Descend with X in orbit.
- After: An ocean world with a breathable atmosphere. Descend with X in orbit.

- Before: A blue ice giant with a thin ring, on the outer edge of Sol. Survey drones sent close to it have a high loss rate.
- After: A blue ice giant with a thin ring, on the outer edge of Sol.

- Before: A dark planetoid split along a single greyseam vein about a hundred kilometres long. The Miners' Guild works the seam.
- After: A dark planetoid with a long greyseam vein. The Miners' Guild works the seam.

- Before: A ring of solar collectors around the sun, serviced by automated drones, and the seat of the Helios Directorate. Its oldest arc is of unknown origin.
- After: A ring of solar collectors around the sun, serviced by automated drones. The seat of the Helios Directorate.

- Before: A brown dwarf with a dense, dusty asteroid belt. Halden ruins are found throughout the system. Prospectors work the belt; Redtooth raiders operate from an outpost in the outer system.
- After: A brown dwarf with a dense, dusty asteroid belt and Halden ruins. Prospectors work the belt; Redtooth raiders hold an outpost in the outer system.

- Before: A banded gas giant nearly as large as its star. Its larger moon, Halden, is where the first Halden ruin was found; the Redtooth dig there.
- After: A banded gas giant nearly as large as its star. The Redtooth dig on its moon Halden.

- Before: A ruined Halden structure: a ring around the brown dwarf, broken into arcs and scorched on the side facing the star. Its purpose is unknown.
- After: A ruined Halden ring around the brown dwarf, broken into arcs.

- Before: A small stillstone in the Curtain, first charted a few years ago. Jump drives charge faster within its field. A Frost Brood roost surrounds it.
- After: A small stillstone in the Curtain. Jump drives charge faster within its field. A Frost Brood roost surrounds it.

- Before: A young star inside its birth cloud. Rich asteroids and poor visibility. The observatory here reports the clearest signal reception in the cluster.
- After: A young star inside its birth cloud. Rich asteroids and poor visibility. Nebula Prime Observatory is here.

- Before: A red giant shedding its outer layers and expanding unusually fast. Ember dust fills the inner system; the belt is slag and iron.
- After: A red giant. Ember dust fills the inner system; the belt is slag and iron.

- Before: A supermassive black hole with a bright accretion disk, circled by a ring of shards from a destroyed world. Horizon Watch recovers inscribed fragments from the debris.
- After: A supermassive black hole with a bright accretion disk, circled by a ring of shards. Horizon Watch recovers inscribed fragments from the debris.

- Before: The remaining half of a broken planet. The rest of it forms the shard ring.
- After: Half a planet, beside the shard ring.

- Before: A pulsar system with a frozen field of crystal and ice. The pulsar's period has not varied in recorded history.
- After: A pulsar system with a frozen field of crystal and ice.

- Before: A ringed ice world with crystal plains, lit by each sweep of the pulsar's beam.
- After: A ringed ice world with crystal plains.

- Before: A grey-green ocean world at the edge of the field. The Halcyon foundry, sealed for forty years, lies in its crust.
- After: A grey-green ocean world at the edge of the field, with the sealed Halcyon foundry in its crust.

- Before: Terra Nova's moon. A bastion of unknown origin stands in its central crater and is attacked every night.
- After: Terra Nova's moon. A bastion stands in its central crater and is attacked every night.

- Before: Glacia's moon. A bastion of unknown origin stands on it and is attacked every night, harder than Selene.
- After: Glacia's moon. A bastion stands on it and is attacked every night, harder than at Selene.

- Before: The surface of Ashfall: a cracked crust over molten rock, glowing through every seam. A cave opens in the rock to the north.
- After: The surface of Ashfall: cracked crust over molten rock. A cave opens in the rock to the north.

- Before: A cavern under Ashfall's crust: a long canyon in the dark, its floor cracked with glowing seams, running to a vault where the Pyreclast waits.
- After: A cavern under Ashfall's crust: a long canyon running to the vault where the Pyreclast waits.

- Before: The sealed Halcyon foundry beneath Halcyon's crust. Its furnace is still burning.
- After: The sealed Halcyon foundry beneath Halcyon's crust.

- Before: Inside the Scrap Mother's nest, out in the Drift: a thick field of rock and junk, grey veins showing in much of the stone, round an open hollow where she waits. A lane runs in from the south.
- After: The Scrap Mother's nest in the Drift: a thick field of rock and junk round an open hollow where she waits. A lane runs in from the south.

## Station market notes (stations.json)

**glasswater_station_relay**
- Before: Relay: a little of everything, at a price.
- After: Relay: a little of everything.

**void_station_lantern**
- Before: Black market: no questions, steep prices.
- After: Black market: steep prices.

**ashfall_station_claim**
- Before: Prospectors: they pay over the odds for common ore.
- After: Prospectors: pay above market for common ore.

**sol_station_ark**
- Before: Plain stores at plain prices. The Hall pays well for leestone, since nobody else will.
- After: Plain stores at plain prices. Pays well for leestone.

**sol_station_helios**
- Before: Directorate procurement: fair prices, paid on the minute, itemised.
- After: Directorate procurement: fair prices.

## Moved out of descriptions, already in a codex record

- Leestone: Ark stone (Horizon Watch assay sheet), Ark-heavy (Ilse Marrow), The Ark's practices (Keeper Vey). Covers who buys it, the regular grain, "no tougher than titanium", "Ark-heavy".
- Trace metals and batch hum (voidglass, scrap electronics, nav computer, quantum core): It hums (refinery assay note), Greyseam (shipyard inspection notes), Kerr's notebooks. Rime "barely hums" is also said by an NPC in people.json.
- Vigil log: The Vigil's last log. Halden cache: Halden caches. Halvard log, Shattered Bell log: their own records. Ancient relic as Halden work: The age of the Halden.
- Maw shard ring origin: The breaking of the ring. Halden Ring scorching and "first ruin on Halden": The Halden Ring.
- Cinder ash, Ark old stock "retired early": The Ark's practices.

## Moved out and NOT in a codex record (for Kieran to decide)

These lines were removed from descriptions and are not recorded anywhere else in the game data.

- Resonant Crystal: "the clearest greyseam anyone has found. Hums under a scanner."
- Void Ichor: "Refiners say it hums wrong, and won't say more."
- Quench Slugs: Forgemaster Hale's pattern, "cold cracks hot plate." (attributed to Hale)
- Relay Drone Core: "The old hands say it's cursed." (attributed to old hands)
- Drowned Beacon: "older than any record" and "The Museum Guild argues over whose landing it marks."
- Helios Directorate Power Cell: "Heavier than it looks."
- Aurum: "gold-bright flecks ... conducts like nothing else" (the conductivity is kept as "a very good conductor").
- Ice giant in Sol (planet 5): "Survey drones sent close to it have a high loss rate."
- Helios Array: "Its oldest arc is of unknown origin."
- Halden Ring: "Its purpose is unknown." The ring itself is covered by The Halden Ring.
- Glasswater: "The pulsar's period has not varied in recorded history."
- Halcyon foundry: "its furnace is still burning" (the Halcyon foundry), covered in part by the Shattered Bell's manifest.
- Red giant: "expanding unusually fast."
- Nebula Prime: "the clearest signal reception in the cluster" (Dr. Quinn says this in her codex record).
- Terra Nova and Glacia moons: "a bastion of unknown origin" (now just "a bastion").
- Stillstone in the Curtain: "first charted a few years ago" (the Aurora Knot charting notice covers the charting).
- Terra Nova: "the colony's first settled world."
- Station notes: "no questions", "paid on the minute, itemised", "since nobody else will" (tone only).
