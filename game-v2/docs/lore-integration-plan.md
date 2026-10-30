# Lore integration plan

Written 2026-10-25. A plan only; nothing here is implemented.

Sources:
- **Secret canon** (author only, never quoted in game): "Lore Directions for the Space Game", Claude Doc `TjjYsuevNmvAkM1SwhGpXc`.
- **Public canon** (everything players may learn): "Player-Facing Lore: What the Cluster Believes", Claude Doc `NcmnFC36qfqFVJHdcXjCv3`.
- What the game says today: `docs/lore-canon.md` (the October pass) plus a full audit of `data/*.json`, `fieldGuide.ts` and the engine (summarised in §1 and §14).

How to read it: §1 is the gap, §2 the decisions that block everything else, §3–§13 the work in phases (each tagged **data** / **small code** / **new system** from the engine audit), §14 the engine work pulled together, §15 the order and milestones. Every phase ends with a `docs/lore-canon.md` update, since that file is what keeps later text consistent.

---

## 1. Where the game stands against the canon

### 1.1 Direct contradictions (must change)

| The game says | The canon says | Where in the game |
|---|---|---|
| The colony is **200 years** old | **Thousands of years**; the arrival is myth, settlements disagree on the ship's name and numbers | `systems.json:6` Sol; `:2207` Glasswater "two hundred years of records"; `people.json:148` Brannoch, `:394` Kerr; `quests.json:2490` tn_beacon, `:2642/2669` ice_03; "first decade" in `people.json:655`, `quests.json:2642`, `items.json:1847` |
| The ark is the **Meridian**, named everywhere (New Meridian city, Meridian Institute, "Meridian lander", Meridian Beacon) | The ship is a **late reveal**, unnamed until then (*Meridian* is a working name only); the Scrapborn are **not** its drones | `systems.json:6, 1223, 2390, 2406`; `factions.json:7`; `people.json:184, 278, 284, 289, 655`; `quests.json:1795, 1798, 1989, 2421, 2456, 2462, 2512-2519, 2642`; `items.json:1790-1797, 1847` |
| **Scrapborn** = the ark's old salvage drones gone feral (a software fault) | Feral machines that happen to some cores, rarely; nests always round greyseam; parts "cursed"; the colony blames core design | `factions.json:4-7`; `quests.json:307`; `items.json:1767` |
| **Lodestones** ("Ancient Lodestone"), "Sol is thick with them", "we keep charting new ones" | **Stillstones**: 50–few hundred km, one or two a system at most, found "within living memory" only rarely; too-flat faces, repeating angles, fractal veins, night-side glow, slow spin; scarred sections; built on at known risk | `tuning.json:51`; `systems.json` 9 Sol lodestones + wardens, 2 Ashfall, 3 Borealis, 1 Nebula, 1 Void, 2 Cinder, 2 Glasswater, 1 Maw; `people.json:98-106` Okafor; `fieldGuide.ts:161`; `quests.json:2616` |
| Greyseam has **grades** (raw, refined, **core-grade**) | "Mined, refined, installed; nobody sorts it into types or grades" | `people.json:141-152`; `items.json:801, 810`; `stations.json:51` "grades greyseam by the gram"; `docs/lore-canon.md` terms table |
| The signal is **"not human"**, "something out past the Maw is broadcasting" (main_04/05) | The observatory calls it natural (Maw or pulsar); nobody states a source; the "it's aimed/alive" readings belong to named factions, never to the narration | `quests.json:569, 587, 609, 627` |
| Void Leviathan is "**Herald** of the signal" | "Herald" is the Ark's word | `bosses.json:524` |
| Rimeholt's bastion "has held the ice road **for a century**" | ice_03 says it was found standing when the first crews came | `systems.json:2554` (internal conflict too) |

### 1.2 Canon content with no presence in the game at all

The Ark (order, heralds, practices, halls, depots, Maw expeditions, the relic); leestone / "Ark stone"; whiskering; the Helios **Directorate** as an actor; Bellwether; the Gardener folk belief (only a superseded doc mention); the signal catalogue (7-K, 12-A, "character"); Sabine's dish experiment; the Failure; the Cenotaph; the Kindling as a server decision; the lost-ship reveal; a codex; derelict logs as a feature; most of the 40-odd hints and all 12 planted contradictions.

### 1.3 Already aligned (keep; touch only for terminology)

Halden / New Halden (Halden moon, Halden Ring, Brother Aske, caches that "behave unusually well"), the Helios Array's Halden arc and drones "on a schedule nobody wrote", Terra Nova's salts / storms / mountain, Greyback "same batch", Vigil's log "faulty clock", Kerr's drift and pauses, Hale's "coincidence", Kask's "convergent language", Vesper Station, Glasswater crystals, the Brood scattering at peaks, the Curtain / hush panes / Aurora Knot, Kiln, Halcyon's improving yield, the Heart's death silencing the signal, Hollow Crown's ledger. Pell, Osei, Maya, Quinn, Orrin, Sander and Holt all already speak in the right register.

### 1.4 Housekeeping found by the audit

- `patrol_01` has `chain: "traders"` but Achebe gives it.
- drift_03 says the Scrap Mother is north-west; drift_01's drone is south-west (check the actual lair at (-62000, 61000): that's north-west on screen if +y is down).
- `events.warband.*` and `events.peak.*` strings only exist as code defaults, not in `strings.json`.
- Derelicts have names but no text; `visuals.biome` and `visuals.ambient` are used but missing from `SystemVisualsData`.

---

## 2. Decisions needed before writing (blockers)

These are the author's calls. Recommendations are given; the plan assumes them unless changed.

1. **Renaming the Meridian.** The city, institute, beacon, lander and "the old girl" lines all leak the name.
   *Recommend:* rename the city **Landfall** (settlers' plain name for "where we came down"), the institute the **Landfall Institute**, the beacon a **Landfall Beacon** ("a colony-era beacon; which landing, nobody agrees"), and the Lighter Halvard "a colony lander of the first age". Keep `New Meridian`'s id strings out of player text; ids can stay (`meridian_beacon`) or be migrated with a profile step. Ice_03's "cut from the same seam as the ark's own" becomes "from a seam the first crews worked", still "same batch".
   Alternative: keep *Meridian* as one settlement's myth-name among several, and reveal that it was right. Weaker reveal; not recommended.

2. **Dates.** Pick concrete numbers so every text agrees: *recommend* "a little over four thousand years" for the arrival (vague in speech: "four thousand years, give or take the calendar you use"); records "go back about nine hundred years" (so the pulsar's steadiness, Kerr's "drift across the records" and Hale's dating all have a horizon); the Halcyon foundry still "forty years"; Rimeholt's bastion "standing when the first crews came" (fix `:2554`).

3. **Greyseam grades.** *Recommend:* drop "core-grade" as a grade. Keep the phrase as technician slang for *how a sliver gets cut* ("core cut"), not a type; Brannoch's "Same batch" stays. The assay office "grades ore by the gram" (purity of the rock), never greyseam itself.

4. **How many stillstones.** The public doc says one or two a system at most; the secret doc says Sol's are "many and old". *Recommend:* public doc wins for everywhere but Sol; Sol keeps **three** (the most in the cluster, remarked on), everywhere else one, Ashfall two (Halden country). The rest of today's lodestones become ordinary "knots": small greyseam-rich rocks with no jump bonus, or are removed. The Wardens' Lodestone stays as Sol's third stillstone (scarred).

5. **Which world for the Failure.** Requirements: established, populous, long-settled, roughly on a bearing from the Helios Array but slightly off, known to players, not near Sol. *Recommend* **Verdance** (Nebula Prime's toxic world; "toxic" reads afterwards as the ruined, flooded-with-cascade-failure world; players pass it in Act II; Nebula Prime is where the signal arrives cleanest, which gives sceptics their off-line argument). Name: **the Verdance Failure** / "the weeks the lights went out". Needs a surface (`verdance_surface`) with a half-dark city.

6. **Cenotaph scope for v1.** Full (new central-body shader, shell kind, wardens, vaults, fold quest, the one log line) or staged (data-only approximation first). *Recommend* staged: §11 lists both.

7. **Open canon questions to settle only when needed:** the lost ship's wreck location (recommend the Cenotaph's outer shell debris, Act IV, so the reveal lands with the fold); whether the Ark's opposition to Bellwether is public or leaked (recommend leaked: a Directorate minute found in a Bellwether salvage pod); Kindling once per server or reversible (recommend once).

---

## 3. Phase A: the re-canon pass (text only) — **data**

The cheapest phase and the one everything else leans on. No mechanics change.

### A1. Global renames
- `Meridian` → per decision 1 (city, institute, beacon, lander, "the old girl" line, Osei's title and shuttle name, Marrow's pointer, osei_02/03, tn_storms, tn_beacon, ice_03, `items.json` beacon and log). Update `quests.test.ts:503` comment.
- `200 years` / `first decade` → decision 2 wording, in all nine places listed in §1.1.
- `Lodestone` → `Stillstone`: `tuning.json` `lodestoneName`/`lodestoneShort` ("Stillstone"), every `systems.json` lodestone `name`/`description`, zone `lodestone_wardens` → "Wardens' Stillstone" (keep the id; `routePlan.test.ts` uses it), Okafor's topic, `fieldGuide.ts:161`, ice_02 line, the Aurora Knot stays named but is described as "a small stillstone, rough, its veins not quite the right colour" (it is one of the Gardener's new ones; never said).
- "Herald of the signal" (Leviathan) → "Where the signal echoes" or "The thing in the dark".

### A2. Scrapborn reframe
- `factions.json` scrapborn description: "Feral machines. It happens to a core now and then, the Patrol says: a fault in the architecture. Nobody agrees which architecture. They gather greyseam into nests and leave everything else."
- drift_01 intro and `items.json` drone_core; the Scrap Mother intro keeps "round the richest greyseam"; add the pilot superstition line somewhere Achebe can say it: "Don't fit salvage off them. Cursed, the old hands say. Second-hand parts are second-hand, I say."
- Ashfall's passive nest keeps "leave pilots alone unless shot" (good: not an army).

### A3. The signal, in character
- main_04 Maya: "a carrier wave, and it isn't human" → "a carrier wave, and I can't find a transmitter. My colleagues say the pulsar."
- main_05 Orrin: "something out past the Maw is broadcasting" → "the Watch says it's loudest at the Maw. Quinn says that proves nothing. Ask Kerr; she won't tell you either."
- Add the observatory's standing position to Quinn's greeting: natural effect, Maw or pulsar, "and the drift Kerr goes on about is her instruments".
- Add the catalogue vocabulary: Quinn or Maya refer to "**7-K**, the one that sits over Terra Nova" and "12-A" in passing; a topic "Why the numbers?" ("we catalogue the ones with a shape. Most of it has none.").

### A4. Greyseam grades (decision 3)
Brannoch's topic, `nav_computer`, `quantum_core`, `stations.json:51`, `docs/lore-canon.md`.

### A5. Fix the housekeeping items in §1.4 (chain, bearing, strings, type fields).

### A6. Update `docs/lore-canon.md` to the new terms, and add the public doc's seven **Rules for writing** verbatim at the top (attribute everything; never confirm or deny; ordinary explanation in the same breath; nobody right about the whole; events stay in their own records; nothing needed is hidden; the cluster never speaks).

Tests that must still pass: `borealis.test.ts`, `surfaces.test.ts`, `quests.test.ts`, `fieldTasks.test.ts`, `drift.test.ts`, `safeguards.test.ts`, `siegeProfiles.test.ts`, `sieges.test.ts`, `nests.test.ts`, `routePlan.test.ts`, `validateGameData.test.ts`. None should need changes if ids are kept.

---

## 4. Phase B: stillstones — **data + small code**

### B1. Data (decision 4)
- Cut the Sol set to three: a large old one near the inner lanes (today's `sol_lodestone_1`), one on the Reaches road, and the **Wardens' Stillstone** (scarred). Ashfall two (one near the Halden Ring, one far out). One each elsewhere; Borealis keeps the Aurora Knot *in addition* (small, new, rough).
- Rewrite descriptions to the canon's look: "From a way off it's a lone rock. Closer, the faces are a touch too flat, the edges meet at the same angles, and the veins branch the same way whether you're a kilometre out or a hundred. The night side glows. Jump drives like it; nobody knows why." Each one gets one line of its own (what's built on it, who died on it, what the settlers say).
- The scarred one: "A third of it is dark: dead veins, fractured faces, and a drive gets less out of it there. Something happened; the Guild says a quake."
- Camps on stillstones: the existing `zone` + nest mechanism already puts Redtooth and pirate camps on the Wardens' one. Add an **Ark waystation** (Phase C) on Sol's inner stillstone and a settler camp on Ashfall's.

### B2. Small code
- Per-instance `scale` (visual size; stillstones are huge relative to the 300-unit lodestone), `field`, `charge`, `rangeBoost` on `LodestoneData` (`schemas.ts:210`, `validateGameData.ts:405/712`, `jumpFields.ts lodestoneAt/fieldCharge`, `Scenery.ts LodestoneView`). Scarred = a lower `charge`/`rangeBoost` and a `scar` angle range the view draws dark.
- `LodestoneView` redraw: faceted, repeating-angle outline (seeded from id), fractal vein texture (reuse `AsteroidLook` vein code), slow spin via `asteroidSpin`-style per-id rate, a dim glow that is stronger on the side away from the star (needs the star direction, which `Lighting` already has). Remove the violet glyph pulse (nothing built).
- Map, far-zoom markers, nav markers and `routePlan` already handle lodestones; they need the new size only.
- "After the array, the glow shifts hue slightly": a global `veinHueShift` in `systemInfo` or a client constant toggled by the Bellwether flag (Phase F). Cheap once a server-wide flag exists (§14.1).

### B3. Deferred
A runtime "prune" that scars a stillstone during play is a **new system** (server-wide state + replica cache invalidation). Not needed for the canon: scars are historical. Skip unless the Failure arc wants one on-screen prune.

---

## 5. Phase C: the Ark — **data (mostly)**

The biggest content add. Everything here is People, quests, stations, nests and factions data.

### C1. Reputation and faction
- `quests.json reputations`: `ark` "The Ark".
- `factions.json`: `ark` as a **non-hostile** faction entry for ships (Ark expedition tenders, grey, leestone-plated, slow: `drive` 0.8 and heavy armour so "Ark-heavy" is visible in play). Used by traffic and escorts, never spawned as hostiles.

### C2. Places
- **Ark Hall, Sol** (`sol_station_ark`, design `bastion` or `citadel` with a grey palette; near the inner stillstone; services repair/storage/market, no fabricator: they don't make things, they keep them). Description: old, plain, leestone-faced, "the order's oldest halls".
- **Ark Waystation** on Sol's inner stillstone (a nest-kind `dock`, passive, or a parked person craft): "short tenures; a crew is rotated out every forty days".
- **Ark Depot** in Sol's middle region: ordinary stone, stacked old machinery. One of the pruned-history sites (a scorched half). Sceptics' favourite argument.
- **Leestone camp at the Maw's edge** (`maw_camp_ark`, person Expedition Master, `craft`): where the dutiful mine. Friction with the Cult: a Cinder shrine nest nearby with roaming nomads.
- Ark halls in the Failure's ruins (Phase H).

### C3. People (new)
| id | name | where | role | voice |
|---|---|---|---|---|
| `herald_grey` | "the herald" (no name given) | moves: Sol Hall by default; `moves` to a station when a scripted warning is active (§14.2) | Herald | Says almost nothing. Greeting: "You must leave." Topics: "Why?" → "I carry the word. I don't read it." |
| `ark_keeper_sol` | Keeper Anselm Vey | Ark Hall | Middle rank: logistics, records | Dry, dutiful, confident, wrong about every reason. Topics: the practices (each with its stated reason), "polishing the grey", why leestone, the Directorate. |
| `ark_quarter` | Quartermaster Rhee | Ark Hall | Vendor by rank | Sells leestone plate, the core regimen kit, Ark plans (a slow heavy hull). |
| `ark_expedition` | Expedition Master Idunn Kol | Maw edge camp | The most devoted | "Many don't come back. That's the duty." Mocked by Kask's crews. |
| `ark_depot` | Depot hand Marek | Sol depot | The sceptics' witness | "We keep the old stock here. Cheap stone. Twice it's burned." |
| `cynic` (optional) | Dockhand Ferro | Sol Trade Hub | Holds "the Ark causes the disasters" | Gives the conspiracy reading in one topic. |

### C4. Quests (chain `ark`, Sol → Maw; levels 3–24)
1. **A Bag by the Door** (lvl 3): courier for the Hall; Vey explains the one rule. Reward: rep, a *packed bag* consumable (an insurance bond re-skinned: "the bag by the door").
2. **Polishing the Grey** (lvl 4): the core regimen as a tutorial: refit, scrap a part and rebuild it from new plate (uses the hangar's scrap; teaches "retire parts on schedule"). Marrow's comment: "Ark ships fly no better."
3. **Short Tenures** (lvl 5): hold at the waystation on the stillstone for the rotation; escort the relieved crew's tender home. Vey: "Complacency kills."
4. **The Word** (lvl 6, scripted-event aware if §14.2 exists; else staged): a herald appears at Sentinel Watch and says leave; the player evacuates a settler craft from a Reaches camp; a raid (existing event kind) hits the camp an hour later. No reason ever given. Outro: Achebe: "They've never been wrong. I hate it."
5. **Old Stock** (lvl 8): the depot. Haul old machinery to be scattered; find that the depot's last fire took a herald's own tender. Sceptic line from Marek.
6. **Ark-Heavy** (lvl 10): build or fit leestone armour (Phase D), fly a course; Marrow times you and laughs. Reward: Ark hull plan.
7. **Expedition** (lvl 20, Maw licence): escort the leestone expedition to the Maw's edge, hold against Cult nomads, mine leestone. Kol: "A useless rock, they say. We mine it anyway."
8. **What the Hall Knows** (lvl 24, after main_13): Vey, for once uncertain in private: the top of the order "hears a voice, not a reason"; he will not say more, and the player gets nothing but a flag. (Canon: the relic. Never shown.)

### C5. Hints and contradictions placed here
- "Wakings almost never involve Ark-maintained cores (a statistics table nobody reads)": a Sol Patrol item `waking_ledger` or a Hall topic with the innocent reading ("fewer, newer, better kept").
- **An Ark ship that woke**: derelict `Tender Grey Hour` in the Drift, leestone-lined, logbook meticulous to the last day, now a Scrapborn nest core. Both sides use it.
- **Ark depots get pruned**: Marek.
- **The Ark opposed Bellwether** (Phase F): a leaked minute.
- Heralds are **never** tied to the Gardener by any text.

---

## 6. Phase D: leestone — **data + small code**

- `items.json`: `leestone_ore` (mineral, family exotic, tier 4, "dense, dark; the Maw's debris is thick with it; only the Ark buys it"), `leestone` (refined, "Ark stone"), traces across the cluster as a rare carrier (`mining.json` traces: a very low rate everywhere, high in the Maw's shard field).
- `materials.json`: `leestone` grade **Mk III-equivalent output but 1.8× density and a high `exotic` resist**, traits `heavy`, `costly_repair`. It is deliberately **not** a better material: heavier and slower, "no measurable benefit". It's a flavour choice players make for the Ark's sake, and the hidden effect (§14.3, optional) is never shown.
- `parts.plates`: a leestone plate; fabricator shows it under Armour.
- Ark Quartermaster sells plate by rank; Horizon Watch's market buys ore at a poor price ("nobody else sees the point").
- Hint: "its grain looks worked" in the ore description; Kask: "the Maw's pressures".
- Small code only if a trait effect is wanted: e.g. `leestone` armour on a ship lowers its "exposure" score (§14.3). Otherwise data only.

---

## 7. Phase E: the signal, the observatory, Sabine, the Gardener, the codex

### E1. The signal catalogue — **data**
- Quinn's topics: "the catalogue" (numbers for the shapes: 7-K over Terra Nova, 12-A near Cinder, two faint ones by bearing only), "Kerr" (her drift is noise, her gap proves it), "the pause" (after main_12/13: "recorded nothing unusual").
- **Sabine's gap**: Kerr's own topic admits "I lost six years. The hab flooded. Quinn loves that."
- Maya's Brood: "the only creatures that do", Maya's reading: animal behaviour.

### E2. Sabine's dish — **data**, side quest `kerr_03` **The Filaments** (lvl 9, after kerr_02)
Bring her powered greyseam-bearing parts (scrap electronics) and a cell; hold at her hab while she runs current; she shows threads under a microscope and "the faintest shape in the hum". Not reproducible on the second try. "I don't know what it means. Don't let anyone tell you they do." The game never links it to Bellwether; Quinn calls it electrochemistry.

### E3. The Gardener folklore — **data**
Never a character or quest giver. Appears only as what people say:
- A settler topic at Tinder Claim and Thawline: "the Gardener takes the proud ones" with the lost convoy and the refinery that burned.
- Joe: sells "Gardener's luck" charms; "the boards share a feed".
- The **prune that was wrong**: a Trade Consortium project (a relay with no greyseam in it) burned; believers can't explain it; Joe shrugs.
- The **cruel moment near Sol**: tn_storms gets one added line: the storm that missed Landfall hit a survey team carrying ore to the stillstone works. Osei: "Weather."
- A **Rustjaw relay spike with no drop** (Phase F support): Quinn's catalogue entry years back; "nothing weakened afterwards".
- Terra Nova as 7-K's home: never said; only "7-K sits over Terra Nova" and "some read it as aimed".

### E4. Codex — **new system (small)**
The canon's hints need somewhere to accumulate without the narration linking them.
- `data/codex.json`: entries with `title`, `body` (attributed, in a named character's or document's voice), `source` (who says it), `unlock` (a `Cond`: flag, boss, visit, has, done, event), `tab` (Peoples, Places, The Signal, Records, Rumours).
- Profile: `codex: string[]` read, with a `fresh` badge; `migrateProfile` v4.
- Server: on any flag/quest/visit change, evaluate unlocks, toast "New record: …", `pilots.track('hint_<id>', …, once)` for the telemetry (§14.5).
- Client: an eighth field-guide tab **Records**, entries greyed until found.
- First entry per the design note: refining a rare trace unlocks a page that says only that it hums.
- Also the home for: derelict logs (§7.5), inquiry testimony (Phase H), Directorate logs (Phase F), the Maw records (Kask buys writing: each sale can unlock one fragment, badly translated, several incompatible endings), the Halden last record (Phase I).

### E5. Derelict logs — **data now, small code later**
- Now: the ice_03 pattern (recover a log item, a person reads it; description carries text) for Vigil, Perseverance (rename: "Colony Ship Perseverance" is fine, a later-age colony ship), the Tender Grey Hour, the Shattered Bell.
- Later: a `log` field on `DerelictData` shown on a successful `scan` and filed in the codex.

---

## 8. Phase F: Bellwether and the Helios Directorate — **data + small code + one new system**

Acts II–III. Human-made, visible, one array, closed with closure. It must lose the ore.

### F1. The Directorate as an actor — **data**
- Rename nothing: the **Helios Directorate** "runs the cluster's infrastructure" and is seated at the Helios Array. Add a station **Helios Seat** (`sol_station_helios`, design `observatory` or `ring`, on the Array's radius), people **Director Ilse Mbeki** (competent, confident, optimising the wrong number) and **Engineer Tove Rask** (performance charts; "efficiencies compounding").
- Reputation `helios` "Helios Directorate".
- Topics: "what keeps wrecking your projects?" ("I don't need to know what. I need it to stop."), "what is the shield against?" ("whatever it is"), "the Ark" ("Trust us, they said. Show us, we said."), the Rustjaw relay spike ("a fault; nothing weakened").

### F2. Quests (chain `bellwether`, lvl 8–28, interleaved with main)
1. **Groundwork** (8): haul greyseam-bearing scrap and power cells to the Seat (`deliver`).
2. **Segment 50** (10): `construct` a Bellwether mast on the Array's radius (needs a new `structure` kind drawn by `BuildSites.ts` — **small code**).
3. **The Curve** (12): fetch Rask's performance logs from three Helios service docks; her chart bends upward ("compounding"). Codex: the design software "keeps recommending tighter crystal spacing" (optimisation).
4. **Drift** (15): Kerr asks for a recording from the array; she hears a faint character creeping in; Quinn: instrument drift. (Decoy: a whisker wave in Glasswater refineries that same window, unrelated, with its own job.)
5. **Commissioning** (18, Act III, after main_09): the switch-on. A **one-off server event** (§14.2): "Bellwether online" galaxy news, the pulse logged as a calibration (codex: Directorate log, by bearing), the 7-K catalogue entry drops to a fraction (codex: observatory), the Directorate declares success, the stillstone vein hue shifts (B2). Three separate records; no text joins them. Per-pilot version if the event system is deferred: the quest's `after` lines and codex unlocks do the same work.
6. **Closure** (20): the Directorate's medal; projects stop failing; Mbeki: "The shield works." Vey (Ark): nothing. A salvage pod from array maintenance drops the leaked minute: the Ark opposed it and gave no reason.
7. **Legacy** (optional, 22+): array-salvage parts enter the market as a curiosity ("Bellwether brass"); ships fitted with them whisker sooner (§14.3 hidden). Never said.

### F3. Decoys to place
At least two unrelated distant signatures in Quinn's catalogue that fall off the bearing, and two unrelated outbreaks (the whisker wave above; a feral swarm in Borealis's sift).

---

## 9. Phase G: Scrapborn, whiskering and "my ship is waking" — **data + small code**

- **Whiskering as a word**: technicians' topics (Marrow, Pell, Rask): threads under a microscope, usually harmless, "folklore, all of it wrong". A codex page.
- **Cores that never whisker**: one manufacturer in Marrow's talk ("Thule Works cores never show it; their supplier's seam is boring") = the lifeless rich seam contradiction, placed at Thule (Sol) as a huge, quiet greyseam deposit with no nests and no anomaly: a mining field that's purely profitable.
- **Hidden per-ship character** — **small code**: a seed on `ShipRecord` (profile v4) and a tiny derived quirk list (`character.ts`): ±1–2% turn rate, a jump that charges a hair faster, a gun that runs hot: cosmetic-scale. Shown nowhere as a stat. Old pilots' topic: "My ship is waking." Marrow: "Manufacturing variance." Salvage-sourced parts (Scrapborn, Failure ruins, Bellwether brass) nudge the seed's "whisker" term (§14.3) and the quirks grow slightly; still never shown.
- Scrapborn nests: keep "always round greyseam"; add "their cores are heavily whiskered" to the drone_core description; "old cores rot" as the innocent line.

---

## 10. Phase H: the Failure — **data + the event system**

Late Act III / early IV, several steps after Commissioning with unrelated main-line steps between. Told in aftermath, never a boss fight.

- **World** (decision 5): Verdance gets `verdance_surface` with a city **Greenhollow**, half its districts dark (CityView: a `ruined` fraction — **small code**: unlit blocks, broken towers; palettes already exist). Scrapborn remnants at standing low density as a passive-then-provoked nest kind `ruin` (**small code** in `NestViews` for the look; AI is data). Ark hall district with its lights on ("built sturdier").
- **Trigger**: the one-off event "The Verdance Failure" (§14.2) with galaxy news in stages (day 0 "cores outperforming", day 1–3 "Scrapborn in the cranes", week 6 "it burns out"), or, without the event system, gated per pilot on `done: bellwether_05` + two main steps, with the news lines as quest `after` toasts.
- **Chain `failure`** (lvl 22–28), person **Relief Coordinator Adaeze Nwosu** at the Nebula Observatory, then on Verdance:
  1. **Relief Run**: repeatable deliver (medical, cells, food) to Greenhollow.
  2. **Convoy**: escort evacuation freighters out of orbit through remnants.
  3. **The Recall**: deliver core parts from storage/cargo for certified stock (deliver of `part:*:core:*`; taking fitted cores is a small code change, skip).
  4. **Testimony**: three talk steps (an inquiry clerk, a crane operator, the supplier's engineer) that contradict each other; codex pages in each voice. Verdict: supplier, firmware, contaminated batch.
  5. **The Memorial**: a visit step; one line from Nwosu; no reward but rep and a ribbon.
  6. (**A day early**, in the Ark chain): the herald came; most who obeyed lived; Vey can't say why only a day.
- Salvage from the ruins: a new mineral `ruin_salvage` ("sells well; second-hand parts from a disaster zone") feeding §14.3.
- **Later, optional**: the distant signature as one Observatory catalogue line and one Kerr line ("I think they're related. I can't say how."), unlocked after the memorial. Never named.

---

## 11. Phase I: the Cenotaph — **data approximation first, then small code**

### I1. Approximation (data only)
- System `cenotaph`, sector `beyond`, danger 7, `restricted` by main_13 done (the rift opens when the Heart dies: today a `Portal kind 1` rift from the Maw gated on the licence from main_13's reward).
- Central body `brown_dwarf` tuned dim and white-grey (`hue`, `detailColors`), `visuals.biome: 'void'`, `ambient 0.04`, hazards `darkness`, `gravitational_anomalies`. The "threads of light running off" are not possible yet.
- Shell fragments: three `ruin_ring` structures at radii 40k/55k/70k in Halden style (full circles today; the breach is implied by a zone named **The Breach** where the hostile density is zero and the station sits).
- Wardens: faction `wardens`, Mk V, **passive** groups in `knot` nests on the shell radii; `angrySeconds` long (or the permanent grudge, small code). "Not hostile on sight, relentless once provoked."
- Station **Vault Camp** (New Halden and Watch jointly, uneasy): people **Archivist Hesper Lund** (Watch; reads the last record one way) and **Brother Aske** (`moves` here after ice_04; reads it the other). Both readings in the codex. Neither confirmed.
- Quest chain `cenotaph` (lvl 30+): the shell (scan steps on fragments), the breach (course), the vaults (recover the apparatus pieces, `construct` the apparatus: new `structure` kind — small code for its look), **The Fold** (hold while it runs; a wardens wave; then the wardens' faction `hpScale` and the vault locks drop for *this pilot* via flags). Outro: nothing stated. Leaving the system the first time after: the ship log line (a toast styled as the pilot's own log, once per profile, flag `spoke`): one line, no lean. Draft: *"Kept the pieces apart. You'll want to do the same."* (author to approve; it's the only line anything ever says).
- The lost ship (decision 7): wreck `Colony Ark` in the outer shell debris; its log (codex) describes a relic with insight into the signal and "the first warning we obeyed". Never ties the Ark by name.

### I2. Proper version (small code, after I1 lands)
- `CentralBodyShaders`: a `dim_star` type (grey-white disc, faint threads drifting outward very slowly), its own light branch.
- `Scenery.ts`: a `shell` structure kind: partial arcs (`arcs: [{from, to}]`), tilt/thickness, inner-face vault markers; a `breach` gap.
- Wardens' permanent grudge; vault "doors" as pinned ward bodies that open on the flag.

---

## 12. Phase J: the Kindling revised — **new system (small-medium)**

The one place the server decides something. The canon: igniting Ashfall's brown dwarf needs refined greyseam "in quantities beyond anything gathered in one place"; the New Halden back it loudest; the server chooses.
- A **server-wide pooled construction**: a store document `world.kindling` with `delivered`, `goal`, `state: open|lit|failed|closed` (§14.1). A `contribute` step type that adds to the pool (small code), New Halden preachers at Tinder Claim as the givers, the Guild against it, Aske for it.
- When the goal is met the server rolls (seeded by the server's launch id so it's once per server): **lit** (Ashfall's central body becomes a dim sun: requires the runtime `systemInfo` change + `replicaEnv` invalidation — the one real world-state change in the plan) or **failed** (the Halden Ring's fate: a new scorch and a prune-style nest of Scrapborn on the dwarf). Either outcome is read every way by every faction; Aske's lines branch on the state.
- Until the world-state change is built, ship it as a per-pilot ending (flags) with news lines, and leave Ashfall as is.

---

## 13. Phase K: placing the hint catalogue and planted contradictions

Each row names where it already lives or where this plan puts it.

| Hint / contradiction | Where | Phase |
|---|---|---|
| Two cores from one seam handle alike | Greyback, Brannoch, ice_03 | exists |
| Nothing non-core misbehaves; every core can | Marrow topic | G |
| A core above spec is whiskered more often | Rask / Marrow topic | G |
| Refinery yield improves with the same stock | Pell, Halcyon | exists |
| Trace finds rise with players, not rock | Brannoch topic; traces ledger already behaves so | E |
| Thread textures in veins, "a mineral habit" | `AsteroidLook` already draws them; a Guild codex page | E |
| Sabine's dish | kerr_03 | E |
| Helios drones on no schedule; segments on no chart | exists; add the "segments on no chart" log item at a Helios dock | F |
| Bellwether's upward curve, creeping character, tighter spacing | bellwether_03/04 | F |
| 7-K drops after the spike; luck thinner | bellwether_05 codex; Osei's later topic "the storms stopped missing" | F |
| A wreck that logs after its crew died | Vigil | exists |
| Signal then a stillstone years later; none after 7-K; hue shift | Okafor's charting topic (rewritten to two records in history), Aurora Knot; B2 hue shift | B/F |
| Pulsar never drifted a tick | Glasswater | exists (reword the years) |
| Stations share rumours in the same words | Joe | exists |
| Heartbeat pauses and drifts | Kerr, main_12/13 | exists |
| Hollow Crown ledger / Vesper | far_05 | exists |
| Nests round greyseam; whiskered cores | drift, drone_core | exists / G |
| Scrapborn salvage whiskers sooner | §14.3 hidden; Achebe's "cursed" | G |
| Frost Brood scatter from character | Maya | exists |
| Terra Nova salts, mountain | Osei | exists |
| Maw words match trade terms | Kask | exists |
| Cinder Reach swelling dated to the first heartbeat | Hale | exists |
| Halden sealed caches behave well | Aske, halden_cache | exists |
| Directorate calibration pulse by bearing | bellwether_05 codex | F |
| Failure: Scrapborn tore cities; herald a day before | failure chain, Ark chain 8 | H/C |
| Failure salvage whiskers sooner | ruin_salvage hidden | H |
| Distant signature by bearing | Kerr + Observatory codex lines | H |
| Wakings almost never Ark cores | Hall ledger topic | C |
| Ark halls still run in the ruins | Greenhollow | H |
| Leestone richest in the Maw, grain looks worked | item text, Kask | D |
| Pruned sites are long-worked | depot, Marek; Okafor's "the old sites" | C |
| **Dates that disagree** | Kask's Maw records vs Aske's Halden dating, in codex pages | E |
| **A kind echo in the Maw** | a passive `maw` nest near the shard ring whose group heals pilots (reuse the repair `siphon`/station repair hook on a ward: small code) or, cheaper, a derelict whose field repairs: Kask: "a repair drone somebody lost" | H-ish, optional |
| **A cruel moment near Sol** | tn_storms added line | E |
| **A prune that was wrong** | Joe / Consortium relay | E |
| **Sabine's gap** | Kerr topic | E |
| **A spike with no drop** | Quinn's Rustjaw relay entry | E/F |
| **A lifeless rich seam** | Thule field + Thule Works cores | G |
| **A Halden ruin older than the Maw** | Glacia's dating in Lund's talk vs Kask's | I |
| **Cores that never whisker** | Thule Works | G |
| **Ark depots get pruned** | Marek | C |
| **An Ark ship that woke** | Tender Grey Hour | C |
| **A new stillstone with no signal** | Aurora Knot's record: "nobody was listening on that bearing" | B |

Rules checked on every line: attributed; innocent reading in the same breath; no two records in one sentence; nothing needed hidden in a hint; only Kerr says "I don't know".

---

## 14. Engine work pulled together

Ordered by how much they unlock.

### 14.1 Server-wide world document — **small new module**
`WorldState` following `Achievements`' `loadDoc/saveDoc('world')`: flags (`bellwether_online`, `failure`), counters (`kindling.delivered`), the concentration index (sum of fitted cores across saved profiles, recomputed on save). A new `Cond` kind `world: {flag}` / `worldAtLeast` in `dialogue.ts`, `CondContext`, validator `condSpec`. Sent to clients once in `welcome` (for hue shifts and news). Unlocks: F5 as a real event, H trigger, J, B2's hue shift, the design note's "quirks get stranger as the index rises" (feeds §14.3's term).

### 14.2 One-off scripted events — **new system, small-medium**
`data/events.json` scripted entries: `id`, `when` (a world/pilot condition such as "any pilot finished bellwether_04 and the server has been up N hours"), `steps[]` (news, announce, objective banner, set world flag, codex unlock for everyone, spawn a nest for a duration), `once: true` recorded in the world document. Reuses `Achievements.news`, `host.announce`, `objective`. Unlocks: Commissioning, the Failure's staged news, herald appearances (a herald `moves` to a station for an hour before a raid event: tie `raid` events to a preceding scripted "herald" step with a chance, so heralds are *always* right).

### 14.3 Hidden exposure/whisker term — **small code**
A per-`ShipRecord` seed + `whisker` number (profile v4), nudged by salvage-sourced parts (Scrapborn, ruin, Bellwether brass), reduced by leestone armour share and by the regimen (scrap-and-rebuild). Read by `character.ts` for the cosmetic quirks only. **Lean is never a stat**: no UI, no tooltip, no scan shows it. (Optional, much later: a vanishingly rare "waking" that turns a long-neglected, heavily salvaged ship's loaner into a Scrapborn encounter. Not in this plan.)

### 14.4 Codex — **new system, small** (§E4)

### 14.5 Hint telemetry — **small code**
`pilots.track(conn, 'hint_<id>', {}, true)` from codex unlocks and chosen dialogue topics. Lets the author see which hints get noticed, as the canon asks.

### 14.6 Scenery and shaders — **small code each**
Stillstone look + per-instance fields (B2); `shell` structure kind and `dim_star` body (I2); `BuildSites` kinds for the Bellwether mast and the fold apparatus; `NestViews` kinds `ruin` and `waystation`; CityView `ruined` fraction.

### 14.7 Runtime world change (Kindling "lit") — **new system**
Re-sending `systemInfo` and invalidating `replicaEnvs` for one system, keeping prediction deterministic (a tick-stamped switch). Only J needs it; do last or never.

### 14.8 Not planned
Collidable kilometre-scale bodies; cross-system scripted convoys (heralds stay as moving people and single-system traffic); item instance data (the seed route replaces it); on-screen prunes of stillstones.

---

## 15. Order, milestones and checks

| # | Milestone | Phases | Mostly | Done when |
|---|---|---|---|---|
| 1 | **Re-canon** | A (+ decisions 1–4) | data | every test passes; `grep -i "meridian\|200 years\|two hundred\|lodestone\|core-grade\|herald of"` over `data/` returns only ids; `lore-canon.md` updated |
| 2 | **Stillstones** | B | data + small code | Sol has 3, others 1–2, new look live; jump tests updated for per-instance fields |
| 3 | **Records** | E4, E5, 14.5 | new small system | codex tab, first entry from a rare trace, derelict logs for 4 wrecks |
| 4 | **The Ark & leestone** | C, D | data | the `ark` chain 1–7 playable in Sol/Maw; leestone mined, refined, fitted; Ark-heavy is measurably slower |
| 5 | **Voices** | E1–E3, G | data + 14.3 | Quinn/Kerr/Joe/Marrow topics; Thule field; hidden quirks exist and show nowhere |
| 6 | **World document & scripted events** | 14.1, 14.2 | new systems | a herald precedes raids; a world flag can gate a topic |
| 7 | **Bellwether** | F | data on 6 | Commissioning fires once per server; three records, three places |
| 8 | **The Failure** | H | data on 6 + small code | Verdance surface, relief chain, inquiry pages, memorial |
| 9 | **The Cenotaph (approx.)** | I1 | data | reachable after main_13; wardens passive; fold quest; the one line |
| 10 | **The Cenotaph (proper)** | I2 | small code | dim star shader, shell arcs, breach |
| 11 | **Kindling** | J, 14.7 | new system | pooled delivery; the server decides once |

Each milestone: `npm run build:common`, `npx vitest run --pool=forks --no-file-parallelism`, a headless live check after deploy, and a `lore-canon.md` update. Writing passes 1, 4, 5, 7, 8 are the heavy ones and are good subagent work (one agent per chain, briefed with the public doc only, never the secret one, plus `lore-canon.md`); engine items 14.1–14.4 are single-owner work.

---

## 16. Visual direction (from the canon, for the art passes)

- **Greyseam**: dull, cold grey, faint self-glow in veins; never glyphs, never "built". Already right in `AsteroidLook`.
- **Stillstones**: faceted grey mass, too-regular angles, fractal veins, night-side glow, slow spin; scars as dead dark regions. The Aurora Knot rougher, its glow a different tone.
- **Halden work**: slate, notched never-square, thin cold inlay (exists). Their caches: small slate cases.
- **Leestone / Ark**: dense, dark, matte, almost brown-black; Ark ships and halls are plain, heavy, unlit by anything that glows. "Ark-heavy" should read at a glance.
- **Bellwether**: clean, bright, new Directorate white against the Array's old Halden arc; the one thing in the cluster that looks like confident engineering.
- **The Failure's city**: half dark; cranes still; Ark hall district lit.
- **The Cenotaph**: the most striking system: a grey-white dim star behind vast slate arcs, near-black ambient, threads of light moving very slowly, wardens dark and patient.
- **Scrapborn**: junk round a greyseam lump (exists); their cores, if shown, threaded white like frost.

---

## 17. Writing checklist (paste into every content brief)

1. Attribute everything to a person or a document.
2. Never confirm or deny; answer lore questions in character or not at all.
3. The ordinary explanation in the same breath, from someone who means it.
4. Nobody is right about the whole; only Sabine Kerr says "I don't know".
5. Keep events in their own records: the calibration log, the 7-K drop and the inquiry never share a sentence or a speaker.
6. Nothing a player needs is hidden in a hint.
7. The cluster never speaks, except the one Act IV line, which says nothing about what it is.
8. Lean is never a stat; no text calls any greyseam kind or cruel.
9. Hints point at the ore, never at a mind. Players should end suspicious of their own ship.
10. The secret canon is never quoted, paraphrased or linked anywhere players can see, including comments in data files.
