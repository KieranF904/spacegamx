# The Brood Mother: fight design

Status: design only (2026-10-30). Nothing here is built. Follows `docs/boss-design.md`; the worked examples are the Scrap
Mother (`server/src/game/brains/scrapMother.ts`, which extends `StagedBrain`) and the Pyreclast. Her look is done
(`scripts/bespoke/brood_mother.mjs`, 117 pieces); her brain (`server/src/game/brains/broodMother.ts`) is an empty
`StagedBrain` with the Scrap Mother's tables and `loop: [[], [], []]`.

Everything marked **NEW** is work that does not exist yet. Everything else is an existing `StagedBrain` primitive or a
`BrainHost` / `ShipBridge` call already in the code. Numbers are starting values to be tuned by the audit in section 7.
Ticks are 1/60 s.

## 1. Identity: what this fight is

One line: **a nursery that freezes you in place while its young come for you.** She is the only boss whose pressure is a
*meter* (chill) rather than only hit points, and the only one whose adds are the point of the fight in two of three
stages.

| | Scrap Mother | Pyreclast | Brood Mother |
|---|---|---|---|
| What she is | a hoard welded into a nest | a molten engine of turrets | a living nursery: fins, arms, eggs, a frost gland |
| Core verbs | haul (magnets), grind, scissor welders | barrage, broadside, lance, vent | **spawn, tether, chill** |
| Signature | pull you in, grind or snap shut | clockwise turret order, red lanes | **a rope you cut at the tip, and a cold that stacks** |
| Adds | scrap mites (kamikaze) | drones | frost larvae (kamikaze + chill), stages 1 and 3 only |
| Damage window | iris (150%) vs brace (40%) | vent (150%) vs brace (40%) | **hatch (150%) vs shell closed (50%)**: the window opens exactly when the swarm comes out |
| Punishes | standing still, flying away from the haul | lingering near her hull | **kiting from far (stage 3), hugging her (stage 2), ignoring the young (stage 1 and 3)** |
| Read | grey/green, mechanical | red/orange, fire | slate shell, pale rime, **violet light**, no other boss uses violet |

The gimmick set, and what makes each different from the two bosses before her:

- **Chill (existing mechanic, one system with the cold).** Her chill takes **warmth**: `ShipBridge.frostHit(eid,
  amount, ticks)` takes `amount` off the ship's warmth meter (0..1, less the hull's insulation), the same meter
  Borealis's cold runs down (`server/src/game/Warmth.ts`, `common/src/ships/warmth.ts`); frozen through (0) the ship
  seizes up (an EMP) for `ticks` and comes out with a little warmth back (`THAW`, 0.15), and not again inside the EMP
  immunity window. The Frostbite Lance and frost-gemmed guns use the same meter. The pilot reads it as the **frost
  vignette** (`client/src/ui/FrostVignette.ts`: ice in from the screen's edges, a flash at the rim on a sharp hit, and a
  small chip with the percent). So a pilot who flew a long way out through the cold arrives with less to spare.
- **Tether (NEW).** A rope from the tip of one of her arms to your ship that reels you towards her tail. You beat it by
  thrusting away, or by **shooting the arm tip off** (a part, so "parts matter" is satisfied, and the tip is small enough
  that side-mount and turret builds can do it while fixed guns keep their nose on her body).
- **Brood.** Larvae that burst in a chill. Spawned from her egg sacs in stage 1 and from her clutch of eggs in stage 3.

Lore and tone: neutral, observational, as in the Scrap Mother's intro. See section 10 for the text and the questions it
raises. No claim in this document about *what* she is, *why* she is there, or *who* named her is stated as fact; every
such claim is a question for Kieran.

## 2. Level, location, arena

- **Level 8**, as now (same as the Scrap Mother and Rimeback; one below the Hushwing at 9, one above the Hoarfrost
  Matriarch at 7). Borealis jobs run levels 6 to 9 (`docs/lore-canon.md`), so she is the system's mid-tier staged boss.
  See open question 2: she could be 9.
- **Lair (56000, 54000)**, in `borealis`. The star is at the system origin, so she sits 77.8k from it: past the main
  belt (outer edge 63.2k), short of the Rime Shoal (86k to 98k), about 20k outside Boreas Major's orbit (57.2k) and
  nowhere near a planet's surface. It is open space. **There is no wall, rock or lair feature to help or hinder**:
  no `surface`, no `pocket`, no `fixedWalls` question. (The Scrap Mother has a cave round her; the Pyreclast has lava.)
- **Neighbours** (straight-line from the lair): the Curtain zone (centre 30000, 42000; radius 9000) and the Aurora Knot
  stillstone (33000, 47000) are 23k to 29k west, the Frost Brood's nesting ground; Rimeback (55000, 15000) is 39k north;
  the Hushwing (16000, 58000) is 40k west; the Hoarfrost Matriarch (37007, -39650) is 95k away; the Shoal Roost orbits
  at 92k radius (period 2400 s) and may pass within ~14k of the lair. Nothing aggros into her fight: her `aggro` is 3600
  and `leash` 8000, and every neighbour is more than 20k away. A pilot arriving from the Curtain flies past roosts of
  `frost_shard` / `frost_warden` on the way, which is the right warm-up and needs no change.
- **Hazard.** Borealis rates `cryo` 3 (`systems.json hazardRatings`): away from heat, cold builds up on a ship, about
  5 minutes from warm to frozen through (`hazards.json warmth`). Below half warmth guns recycle 15% slower, below a
  quarter thrust and steering drop 20% too (`WARMTH_STAGES`). Her lair is 77.8k out, far from the star's warmth (it
  reaches 9000 past the surface, so 23k from the centre) and from either station, so pilots arrive part-chilled and her
  chill lands on top: **her chill numbers below were set for a meter of their own and should be retuned against the
  shared one** (see section 11, question 5). Cold no longer costs battery capacity, and has no tolerance (conduits are
  gone); insulating hulls (`materials.json insulation`, at most 30%) only slow it.
- **Home.** `homeR: 5000` (the Scrap Mother's), `leash 8000`. She keeps within 5000 of the lair; her darts and swim use
  `homeward()` to bend back in. In open space with nothing to hide behind, the only cover is the larvae and the rings
  she makes, so she must never leave rock-free "loose" debris: **crumble everything** (`ships.shed` crumble, section 3).
- **Arena options for later** (not in scope): a ring of ice floes at ~4500 from the lair would give the tether something
  to snag on and give fixed builds cover from the stage 3 whiteout; it needs terrain/obstacle support that open-system
  bosses do not have. Recorded as open question 6, not designed.

Size (from the piece file, scale 1.25, 24 world units a cell): fins reach about 980 either side of her middle line, her
beak about 930 ahead, her arms about 1620 aft; the stage 2 spindle is about 640 wide by 2550 long; the stage 3 gland is
about 370 long by 190 wide with six eggs of about 140 across. So **radius is roughly 1600 (stage 1), 1300 (stage 2),
350 (stage 3)**: she shrinks hard, as the guide wants. Check with `derived.radius` (the connectivity probe in guide
section 7 prints it).

## 3. Her body and what comes off

From `brood_mother.mjs`. `rigid: true` (she flies as built; parts are hidden in the shader, breaking pieces costs no
rebuild). 117 pieces: **stage 1 = 72, stage 2 = 34, stage 3 = 11**.

| Stage | Pieces (blueprint fn) | Ruin? | Beaten by | Moves that depend on them |
|---|---|---|---|---|
| 1 the veil | scale0..11 _l/_r (24; `armor`, `conduit`), frill0..8 (18; `hull`), arm0a..arm2c (18; `conduit` root, `hull`), sac0/sac1 (4; `brood_bay`), horn (2; `armor`), tooth0/1 (4; `armor`), rays_l/_r (2; `bone_frame`, skeleton) | no | **all non-skeleton pieces shot off** (70), skeletons never decide | `hatch`: sacs. `flick`: horns. `tether`: arm tips (`arm0c`, `arm1c`). Scales bare the rays (skeleton) as they go. |
| 2 the mantle | seg0..7 _l/_r (16), keel0..2 (3), beak, palp _l/_r (2), gland0/1 _l/_r (4; `generator`), spine0..2 _l/_r (6; `armor`), siphon _l/_r (2; `plasma_drive`) = 34 | **yes** | all 34 wrecked | `breath`: beak + glands (length scales with glands). `volley`: spines. `swim`: siphons. Her steering: palps do nothing mechanically (look and `smother`). |
| 3 the clutch | s3_egg0..2 _l/_r (6; `brood_bay`, ruin), s3_antler _l/_r (2; `generator`), s3_siphon _l/_r (2; `plasma_drive`), s3_core (`core`, ruin) | eggs and core | **eggs (6) and core (1) wrecked** (antlers and siphons can be shot off but need not be) | `clutch`: eggs. `antlers`: antlers. `whiteout`: core. Brace/open window: eggs. |

What the transitions do (all standard `StagedBrain`, no new code):

- **1 to 2** (`blowStage`): she goes invulnerable, holds 45 ticks, then every surviving stage 1 piece group is blown away
  outermost first (horns and frill, then scales and arms), 6 ticks apart, `crumble` 200. The skeleton rays go last in a
  single blast. About 2.5 s end to end.
- **2 to 3**: the mantle (wrecks) is blown away piece by piece outermost first (beak and palps first, keel and siphons
  last). The gland and eggs are bared.
- **Death**: 75-tick shudder with bursts on random deciding pieces, then `burst()` throws everything. The six eggs blow
  with her, as the generator's comment promises.
- `forceShed(n)` already works (inherited); keep it working as the brain grows.

## 4. Phases

`bosses.json` `phases` must have **four** entries. `StagedBrain.rage()` is `view.phase >= 4`, and `view.phase` counts
phases entered, so the current 3-entry list can **never** enrage her. (The Scrap Mother and the Pyreclast have four.)

| # | `at` (integrity) | Meaning | Brain effect |
|---|---|---|---|
| 1 | 0.85 | still stage 1; her sacs wake | none beyond the line (flavour, like the Scrap Mother's brood racks line) |
| 2 | 0.667 | stage boundary: fins gone, stage 2 | brain switches stage via `shedding()` |
| 3 | 0.334 | stage boundary: mantle gone, stage 3 | same |
| 4 | 0.15 | **enrage** `enrage: 1.3` | `rage()` 0.8: rests and warnings x0.8; +1 larva a hatch; +1 tether target; chill x1.25 |

Triggers are `stagedIntegrity` thresholds, as for the other staged bosses. The stage changes are driven by deciding
pieces being gone (`currentStage`), not by integrity, so the two coincide only because each stage is an equal share of
the bar.

### Tables (`StagedTables`)

| | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| `loop` | `hatch`, `flick`, `tether` | `breath`, `volley`, `swim` | `clutch`, `antlers`, `whiteout` |
| `range` | 2300 | 1500 | 1150 |
| `circle` (rad) | 0.30 | 0.45 | 0.55 |
| `rest` (ticks) | 100 | 80 | 60 |
| `haste` | 1 | 0.85 | 0.75 |
| `drive` | 0.12 | 0.20 | 0.30 |
| `homeR` | 5000 | | |

Reasons: stage 1 she is wide (fins +-980) and floats; 2300 keeps her fins off the pilot while her horns and tethers
reach. Stage 2 is the dense spindle that closes in. Stage 3 is a small, quick body (350 radius) that darts before every
move (`around()` wraps each move with `dart(1000, 20, 24)`, exactly as the Scrap Mother's seed does).

### Stage 1, the veil (100% to 66.7%): hold off, send the young, rope you in

Range 2300. Her horns do the shooting; her arms trail aft; her sacs are slung on the two outer arms.

1. **`hatch`**: sacs launch larvae.
   - Tell: a `gather` circle on each working sac for `haste(34)` ticks (34 at stage 1), she holds still (`this.hold`-style
     `want = { move: 'hold' }`). That stillness is a free-damage window on the fins.
   - Effect: each working sac (`working('brood_bay')` filtered to stage 1, up to 4) launches **2 larvae** (+1 enraged,
     +`floor((fighters - 1) / 2)`), fanned 0.9 rad, speed 12, via `mobs.spawn('frost_larva', ...)` (NEW mob, section 8).
     `launchFx` at each sac.
   - **Cap: 6 + 4 x fighters live larvae** (solo 10). Launches stop at the cap; `drones` is pruned against `mobs.has` as
     the Scrap Mother's `brood()` does.
   - Duration ~84 ticks (34 warn + 50 settle).
   - Counter: kill sacs (small `brood_bay` parts on the outer arms) for no more hatch; kill larvae on the way (hp 60,
     `arm` 24 ticks flying straight out before hunting). Flak splash is the natural answer (Burst, Cloudmaker).
2. **`flick`**: horns shed rime shards in aimed fans (her one "gun").
   - Tell: per working horn (up to 2) a `bossTelegraph` `line`, kind `flick`, from the horn mount along the lead aim,
     width 160, `haste(40)` ticks.
   - Effect: **3 volleys, 22 ticks apart, 4 shards a volley** in a 0.5 rad fan, centred on the target's lead each time
     (re-aimed every volley, so turning dodges). Fan alternates +-0.08 rad so you cannot park in one gap. Shard =
     NEW weapon `rime_shard` (speed 11, damage 50, size 11, life 280: the Scrap Mother's `scrap_chunk` profile). Gaps
     between shards at 1500 range are about 250 wide, larger than a corsair.
   - Totals: <= 24 shards in flight (2 horns x 3 x 4).
   - Counter: strafe across the lanes; shoot a horn off for half the volume, both for none.
   - Duration ~106 ticks.
3. **`tether`**: the signature.
   - Tell (45 ticks): a thin pale `tether` line (NEW telegraph kind) from each anchor to its target; anchors are the tips
     of her **outer two arms** (`broodmother_arm0c_*`, `arm1c_*`; `named()` returns -1 once a tip is shot off).
     Targets: the primary target, plus the next-nearest pilot within 5000 if any (`this.pilots()`), otherwise both lines
     on the target.
   - Effect (100 ticks): each tether pulls its pilot towards its anchor with the standard `pull` strength, **0.5 world
     units a tick, falling to 0 at 3400 range** (guide: 0.5 to 0.6 beatable by thrusting away). A tether is **cut the
     instant its tip part is gone or wrecked**. Pull is on the pilot, not the area, so it needs a single-target version
     of `pull` (NEW primitive `tetherPull`, section 8).
   - Snap: at tick 70 of the 100 a circle telegraph (radius 320, 30 ticks) at the tip; at the end `land()` there for
     **90 damage + 0.5 chill** if the pilot is inside. Thrust away or cut the tip and the snap hits nobody.
   - Anchored to the arm tips, which trail aft, so a reeled pilot slides towards her tail, past the fin edge, not into
     her face. She holds still during the cast (`move: 'hold'`).
   - Counter: **fixed-mount builds** keep the nose on her body and cut the tip with the same guns (a tip is a small
     `hull` part but it sits on the tether line, so it is on the line to her anyway); **turret builds** can thrust
     directly away while their guns track.
4. **Between moves** (passive, every ~90 ticks, `IDLE_HORN`): one horn fires a single aimed shard with a `haste(36)`
   line. Keeps stage 1 from being a total rest between moves without becoming a dominant passive source.

Loop time: ~100 + 84 + 100 + 106 + 100 + 175 = about 665 ticks, 11 s a loop.

Pieces shot off: horns end `flick`; the 4 sacs end `hatch`; both outer-arm tips (4 parts) end `tether`; the rest are
plating. Scales that go reveal the skeleton, as designed. The stage ends only when **all 70** non-skeleton pieces are
gone (no `ruin` pieces in stage 1; by the guide, "a stage without any is beaten by all of it"). That is a lot of
plating: see the HP targets in section 7 and open question 3.

### Stage 2, the mantle (66.7% to 33.4%): the spindle closes in, breathing cold

Range 1500, lighter, `drive` 0.20. The long thin body presents its beak at you (cone ahead) and its flanks to a circler.

1. **`breath`**: she exhales a frost lane from the beak.
   - Tell: she turns to face (`hold(18)`), then a `bossTelegraph` `line`, kind `breath`, from the beak along her heading,
     **width 900, length 2400 x (0.5 + 0.5 x working glands / 4)** (2400 with all four glands, 1200 with none), warning
     `haste(55)` (47 ticks). The breath width is the beak's cone approximated as a lane, which is how `line` telegraphs
     work.
   - Effect: **60 ticks**. Every pilot in the lane takes **3 damage a tick** (thermal) and **0.02 chill a tick**
     (`frostHit`): 50 ticks inside seizes you. Escaping sideways (450 to the edge) takes about 32 ticks at cruise, which
     costs ~0.64 chill and no seize. Heading is locked once the breath starts.
   - Counter: strafe. **Fixed-gun builds' natural tangential circling is exactly the escape**; a pilot parked in her
     face is the one punished. Shooting glands off shortens the lane.
2. **`volley`**: her six ice spines fire icicles.
   - Tell: each working spine (up to 6) draws a `line` (width 70) at its aim for `haste(30)` ticks.
   - Effect: spines fire in `clockwise()` order, 14 ticks apart, **2 rounds**: round 1 at the target's lead, round 2 at
     the target's *current* position (a fake). Icicle = `rime_shard` at x1.3 speed. <= 12 in flight.
   - Counter: the second round punishes a pilot who dodged the first with a flat sidestep. Spines are `armor` parts at
     the flanks, soft on a side pass.
3. **`swim`** (needs a siphon): a siphon-powered pass.
   - Tell: she turns to the target (`hold`, `face`), a wide `dash` line (width = hull radius x 0.9, length 3200) for
     `haste(70)` ticks, as the Scrap Mother's `charge`.
   - Effect: `impulse` 22 along her heading (x0.6 with one siphon, none with none), for 40 ticks. Every 6 ticks she
     leaves a **rime wake** patch (radius 220, 150 ticks, tracked in a list, **max 10**, oldest dropped): standing in one
     adds 0.03 chill a tick and 8 damage every 20 ticks (the Scrap Mother's `pools` pattern with chill added).
   - Recovery: **45 ticks spent**, drifting: the stage 2 damage window, visible.
4. **`smother`** (an `interrupt`, conditional punish; at most once per 720 ticks): if the target stays within 900 of her
   middle for 150 ticks she curls her palps in. Tell: a circle telegraph (radius 1000, `haste(45)` ticks), then **80
   damage, 0.7 chill, and a shove outwards** (NEW primitive `shove`: sets Velocity away from her). Reasoning: stage 2
   is the "closes in" stage, and without this a pilot would simply sit on her flank inside the breath lane's blind
   side. This is the "standing still punished more" rule applied to hugging her.
5. **Between moves**: palps fire one aimed shard each every ~90 ticks (`IDLE_PALP`), 0.6 damage scale.

Stage 2 spawns **no larvae** (relief for the player, and for the server).

Loop time ~ (80 + 18 + 47 + 60) + (80 + 30 + 84) + (80 + 70 + 40 + 45) ~ 635 ticks, about 10.5 s.

Pieces wrecked: glands shorten `breath`; spines end `volley` (all six); siphons end `swim`. She does not use
`smother` if none of her palps stands, or only if the target is that close: no part dependence needed.

### Stage 3, the clutch (33.4% to 0): the hardest

Small, quick, darting. Range 1150. The pressure is **two things at once**: a swarm and the cold, with the most room
to bleed damage.

1. **`clutch`**: her eggs hatch.
   - Tell: `gather` circle on each working egg (radius 160), `haste(30)` ticks (23 tick at stage 3), she holds.
   - Effect: each working egg (up to 6) launches **2 larvae** (+1 enraged), cap **4 + 3 x fighters** (solo 7).
     Launching **opens the shell window: `taken()` returns 1.5 for 150 ticks** (a breathing violet ring round her,
     kind `hatch`, telegraph radius = hull reach + 300).
   - Otherwise `taken()` is **0.5 while any egg stands**, 1.0 with no eggs left (and `clutch` is then skipped). So
     killing eggs removes both the swarm and the brace, in exchange for the window you lose: the player's call.
   - Counter: the window coincides with the swarm. The skilled play is to open it by letting her hatch at a moment you
     can afford, kite the larvae through the window while the window's 150% hits her.
2. **`antlers`**: her two ice antlers sweep.
   - Tell: two `line` telegraphs (width 90, length 3600) from the antler mounts at their start angles, `haste(45)`
     ticks (34 at stage 3).
   - Effect: **beams sweep through 0.9 rad each side of the target's bearing over `haste(90)` ticks**, both antlers in
     the same rotational direction offset by 0.35 rad, so the pair acts as a revolving gate (the Scrap Mother's
     scissor closes; this rotates). Damage 8 a tick thermal via `beam()`, plus **0.015 chill a tick** (NEW: a chill
     rider on `beam`, section 8). `bossBeam` message for the client, kind `antler`.
   - Counter: pass through the gap between the two beams (0.35 rad), or fly out of arc. Shooting the antlers off ends
     it (they are not deciding).
3. **`whiteout`**: the cold closes in.
   - Tell: a large circle (radius 1700) around her for `haste(60)` ticks (45 at stage 3).
   - Effect (100 ticks): **everyone between 900 and 1700 of her takes 0.02 chill a tick** (50 ticks to seize; outside
     1700 no chill, so you cannot hide from it by kiting); inside 900 there is no chill. The safe ring is inside, so
     it forces pilots **in** to her eggs and antlers, and pushes long-range fixed builds (Longbarrel, Lance, Needle)
     close. Two rings of 20 rime shards with 2 gaps of 3, turning, from the core, at tick 25 and 70 (reusing the
     Scrap Mother's `ring()` pattern); ring speed 0.6 of a shard (slow orbs).
   - Counter: close in during the warn, then thread the rings.
4. **Every move starts with a dart** (`around()` wraps each with `dart(1000, 20, 24)`; `haste` shortens it).
5. **No idle fire in stage 3** (`passives` does nothing): the darts and the hatch are the pressure.

Loop time: ~3 x (60 rest + 24 dart + ~190 move) ~ 800 ticks (13 s).

Rage (phase 4): rests x0.8, warnings x0.8, +1 larva per egg, `whiteout` gets a third ring, chill x1.25.

## 5. Adds and spawns: summary

| Where | What | Per launch | Cap (live) | Source | Stops when |
|---|---|---|---|---|---|
| Stage 1 `hatch` | `frost_larva` | 2 per sac (up to 4 sacs = 8), +1 enraged, +1 per 2 extra fighters | 6 + 4 x fighters (solo 10) | `brood_bay` sacs | all four sacs shot off |
| Stage 2 | none | | | | |
| Stage 3 `clutch` | `frost_larva` | 2 per egg (up to 6 = 12), +1 enraged | 4 + 3 x fighters (solo 7) | `brood_bay` eggs | all six eggs wrecked |

`frost_larva` (NEW, `data/mobs.json`): kamikaze, **hp 60, radius 24, speed 17, accel 0.75, turn 0.07, life 600, arm 24**,
blast `fuse 40, radius 150, damage 40`, **plus `chill: 0.35`**. Look: pale shell, violet glow (`#cf7cff`). It is
a scrap mite with a slightly bigger blast and the chill rider. Three bursts in a row seize a ship; the brain's chill
immunity rule (section 8) prevents lock-chains.

Existing rules apply: mobs are cleared on `stop()` (stage change), on `dispose()`, and `mobs.clear` handles owner
cleanup. Larvae owned by the boss scale with `view.damage`.

## 6. Counterplay and build notes

**What her parts and materials reward** (`materials.json`): shell resists kinetic 0.9 / thermal 1.15; rime kinetic 0.95 /
thermal 1.25; ice kinetic 1.15 / thermal 1.3 / energy 0.8; membrane about neutral; gland energy 0.7 / kinetic 1.1.
(Resist above 1 means she takes more.) So:
- **Thermal (laser, lance family: Glint, Cutter, Searchlight) is best against her**; the horns, teeth, spines and
  antlers (ice) take 1.3x. Frostbite Lance's `cryo` is untested against her: check its damage type resists before
  promising anything.
- **Energy (pulse, arc, EMP) is the weakest into her gland and eggs** (0.7 and 1.05): Strobe/Spark builds will drag in
  stage 3. Acceptable and readable: note it in the field-guide line.
- Kinetic is mid (0.9 on the plating, 1.1 on the heart).

**Fixed versus turret.**
- *Fixed guns* (Pip, Hammer, Longbarrel, Bastion, Cutter, Needle, Coilgun, Spear, Lance, Dart, Swarm, Hammerhead, Eel,
  Leviathan) keep only a 2 degree gimbal, so the pilot must point the ship at the target. Stage 1's wide fins make
  that easy; stage 2's long thin spindle is a **lengthwise** target (640 x 2550) that a fixed-gun pilot aligns to by
  flying down her flank, which is also where the breath lane is not; stage 3's 190-wide gland and 140-wide eggs are
  small targets only reachable by fixed guns in the 900 safe ring or between darts. The `clear` lanes (1 to 4 cells
  ahead) matter for long fixed guns: the Lance's 4-cell lane means the nose of a Lance build is bare, and the
  tether pulling that nose towards her tail does not cost a gun.
- *Turrets* (Rattler 270, Lobber 360, Glint 240, Strobe 220, Twinlink 180, Searchlight 360...) keep firing while
  thrusting away from a tether or out of the breath lane. Strongest against the larvae swarm.
- *Side mounts* (Burst, Cloudmaker, Swarm, Searchlight, Tesla fire at 90 degrees to their attach edge) shine on the
  flank pass: a pilot flying past her fin or spindle fires out of the side without turning, so a long broadside
  against stage 1/2 plates is more effective than usual, and tether tips (trailing small `hull` parts) are an
  easy side-mount target. Cloudmaker's splash is the best answer to a larva swarm.
- The *mounting rules* put an `attach: back` restriction on most weapons, so builds with many weapons tend to be
  hull-forward and thin: they are the ones the breath lane punishes most and that benefit most from cutting the
  tether tips.

**Her turning rate (`turn`).** The Scrap Mother's is 7, the Pyreclast's 1 (`bosses.json turn` multiplies her
blueprint's turn, up to `MAX_TURN`; `Bosses.ts` applies it at spawn, per boss, not per stage). Proposal: **5**. Reason:
- She must be **slower than a good pilot's circle** at stage range so that a fixed-gun pilot who strafes round her
  flank wins angle on her soft sides (glands, siphons, spines), which is the whole counterplay to the breath lane and
  the antlers. At 7 (the Scrap Mother) she almost tracks a circler; at 1 (the Pyreclast) she is a turret platform.
- She must be **quick enough** that the breath and the beams cannot simply be sidestepped by one early move: they lock
  heading on cast and the telegraph shows the cast heading, so turning rate decides how long a lateral circler is
  safe. Target (measure it, section 7): her rotation rate is about 60 to 70% of a starter ship's circling angular
  rate at 1500 range. If a throwaway test shows she out-turns a circling corsair, lower `turn` to 4; if a fixed-gun
  pilot cannot get behind her, raise it to 6.
- The stage 3 darts give the small body the "quick" feel without needing a higher `turn`.
This is a per-boss value; the design does not need a per-stage `want.assist`, though the Scrap Mother's brain has
the hook if stage 3 wants more.

## 7. Tuning targets

Per the guide's audit method (tough pilot, `scaleHp` x40, standing still versus circling, damage attributed to
source). The Scrap Mother's measured baseline: about **1.1k / 1.7k / 2.8k damage a minute** (moving) by stage; stage
health about **61k / 40k / 16k**; 2 to 2.5 minutes a stage for a level 8 ship (corsair ~670 DPS on paper, lancer ~840).

| Target | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| Stage health (absolute; set by piece HP and the `hp` multiplier) | ~58k | ~42k | ~28k |
| Time to kill, typical level 8 party of 1 (~420 effective DPS, 60% uptime) | 2.0 to 2.5 min | 1.5 to 2 min | 1.5 to 2 min (braced mostly, window 30% of the time: average multiplier 0.8) |
| Her damage a minute, **moving** tough pilot | ~1.0k (17 DPS) | ~1.7k (28 DPS) | ~2.8k (47 DPS) |
| Her damage, **standing still** | >= 2.0k | >= 3.4k | >= 5.6k (>= 2x the moving figure at every stage) |
| Share of the stage's damage from any single passive source | <= 35% | <= 35% | <= 35% |
| Larvae bursts as a share of stage damage | ~25% | 0 | ~30% |
| Chill seizes a moving pilot (per minute) | <= 1 | <= 2 | <= 2 (and never twice within 5 s) |
| Mobs alive at once | <= 10 (solo) | 0 | <= 7 (solo) |
| Projectiles alive at once | <= 30 (24 shards + passive) | <= 14 (12 icicles + 2 palp shards) | <= 44 (2 rings x 20 + spares) |
| Telegraph/wake structs tracked | <= 3 | <= 10 patches | <= 6 |

Total solo time ~5.5 to 7 minutes of exposure; with respawn 600 s the boss is farmable at about the cadence the
Scrap Mother has. HP is the main knob after the audit; the `hp` multiplier is 0.14 (the Scrap Mother's), keep it and
adjust only if piece HP lands far from the stage targets above (her `brood_*` materials have toughness 80 to 96 and
density 0.6 to 0.75, lighter than the Scrap Mother's alloys).

**Performance** (guide section 8): the server fight cost is 0.25 to 0.4 ms a tick on the existing bosses (worst ~5 ms of a
16.7 ms budget). Budget for her: **no more than 0.5 ms average, 6 ms worst**; time `server.step()` per stage with the
throwaway probe (`defineQuery` at module level). Her projectile budget is above; keep mobs <= 12 across the system, since
mobs travel as `EntityType.Enemy` in snapshots. Stage 1's hull is the heaviest on the client (72 pieces plus two
skeletons, built in the worker once, ~230 to 270 ms); stage 3 is light (11 pieces). Do not add pieces to stage 1.

**Audit expectations to check** (the order the Pyreclast got wrong): damage rises stage by stage for the moving pilot;
standing still is punished at every stage; no single passive source dominates; and chill does not dominate. If
standing-in-the-lane chill is the main way people die in stage 2, the lane is too wide.

## 8. Data and code changes needed

Checklist, in rough build order.

**Data**
- [ ] `data/bosses.json` `boss_brood_mother`:
  - [ ] drop `_placeholder`; set `title`, `intro`, `phases` (four, see section 10);
  - [ ] `phases` becomes `0.85 / 0.667 / 0.334 / 0.15` with `enrage: 1.3` on the last;
  - [ ] `turn` 7 to 5 (section 6);
  - [ ] `loot`: add `frost_heart` (section 9), keep the existing four;
  - [ ] keep `level 8`, `hp 0.14`, `damage 1`, `speed 2.5`, `respawnSeconds 600`, `behaviour` (aggro 3600, range 1800,
        leash 8000), `design: brood_mother`, `asDesigned: true`, `brain: brood_mother`.
- [ ] `data/mobs.json`: `frost_larva` (section 5), with the `chill` field. `Mobs.ts` `MobDef.blast` gets `chill?:
      number`, and the burst calls `ships.frostHit(pilot, chill, ...)` for pilots hit.
- [ ] `data/ships/tuning.json` `weapons`: `rime_shard` (`type: projectile`, speed 11, damage 50, life 280, size 11,
      spread 0, pen 0); `common/src/ships/damage.ts` `TYPE_BY_KIND`: map `rime_shard` (kinetic default is fine; thermal if
      we want her shots to read as cold).
- [ ] `data/items.json`: reword `frost_heart` (section 9). `data/codex.json` / `strings`: a field guide line if wanted.
- [ ] `data/ships/materials.json` and `client/src/ships/hullLook.ts` `HULL_MAT`: already present for the five brood
      materials; confirm each has its `emit` (violet) there.

**Code (new work)**
- [ ] `server/src/game/brains/broodMother.ts`: replace the placeholder. Tables from section 4; `make()` for the nine
      moves; `interrupt()` for `smother`; `around()` for stage 3 darts; `passives()` for stage 1 horn and stage 2 palp
      idle fire; `taken()` for the brace/window; `onStop()` clearing patches, tether state and window.
- [ ] **NEW primitive `tetherPull(pilot, x, y, r, k)`** on `StagedBrain` (a single-pilot `pull`).
- [ ] **NEW primitive `shove(x, y, r, speed)`** (sets Velocity away from a point), for `smother`.
- [ ] **NEW `chill(pilot, amount)` helper** wrapping `host.ships.frostHit(pilot, amount, SEIZE)`. `ShipBridge.warm`
      already refuses a second seize while seized or inside `EMP_IMMUNE_TICKS` (240) after one (the meter sits at 0
      till then); if 300 ticks immune is still wanted, lengthen it here.
- [ ] Chill rider on `beam()` (an optional argument), used by `antlers`.
- [ ] `BossFx.ts` (client): telegraph kinds `flick`, `tether`, `breath`, `wake`/`pool`, `smother`, `hatch`, `whiteout`;
      beam kind `antler`; colour set pale violet/magenta that reads against Borealis's blue-white aurora (guide
      pitfall: test the real background).
- [ ] `client/src/rendering/weapons/weaponStyles.ts`: `rime_shard` look.
- [x] A HUD chill read: the warmth meter (`ShipBridge.warmthOf`) goes to the pilot as snapshot `data[13]` (percent)
      and shows as the frost vignette and its chip (`client/src/ui/FrostVignette.ts`). Open question 5.
- [ ] `server/src/game/Bosses.ts` `BRAINS` and `brains/ids.ts` `BRAIN_IDS` already list `brood_mother`; nothing to add.

**Tests** (`server/src/game/broodMother.test.ts`, copy `scrapMother.test.ts`'s `world()`, `place()`, `advance()`):
- [ ] lair is at (56000, 54000) in `borealis`; level 8; brain `brood_mother`; four phases, the last with `enrage`;
- [ ] every piece has a stage (72/34/11); stage 2 and the eggs and core are `ruin`; stage 3 `under`; she flies as built
      (com, mass, thrust unchanged after shedding);
- [ ] stage 1: `hatch` -> `flick` -> `tether` in loop order, each warned before it lands; sacs off, no hatch; both
      horns off, no flick; tips off, no tether; **a tether is cut when its tip is shot off mid-cast**; pull is under
      0.6 a tick and zero at 3400; the cap holds (10 solo, 6 + 4f);
- [ ] stage 2: `breath` -> `volley` -> `swim`; lane length shrinks as glands go; `smother` fires only after 150 ticks
      within 900, at most once a 720 ticks; wake patches cap at 10; no larvae;
- [ ] stage 3: `clutch` -> `antlers` -> `whiteout`; `taken()` is 0.5 with an egg standing, 1.5 for 150 ticks after a
      hatch, 1.0 with no eggs; caps 7 solo; chill inside 900 is zero and outside it nonzero during `whiteout`;
- [ ] chill: one seize at most per seize + immunity window per pilot; the warmth meter does not leak between pilots
      (`server/src/game/warmth.test.ts` covers the meter itself);
- [ ] redirect: a hit on a later stage's part goes to the current stage; wrecks pass hits on;
- [ ] each stage ends: invulnerable, blown away piece by piece, the next can be hurt;
- [ ] death: last deciding piece wrecked, shudder, everything thrown at once, `bossDefeated` sent.
- [ ] throwaway audit (in a temporary folder, deleted after): per stage, still versus circling, tough bot,
      attribution by `hitProjectile` kind, `splash`, `burn`, `contact`, chill seizes; check section 7's targets.

**Screenshots (native renderer, no browser)**
- [ ] `node scripts/native-render/render.mjs boss:brood_mother --light dark --damage 0.4 --out brood-mother.png`
      renders the full design (`--zoom`, `--bg`, `--scale`, `--w`, `--h` as the CLI header lists; keep the service warm
      with `--start` and stop it with `--stop`/`--once`).
- [ ] Per-stage stills need a viewer param to show a stage (no `stage` or `shed` parameter exists in
      `client/src/viewer/params.ts` today). Small NEW work: a `stage=1|2|3` param that hides what the earlier stages
      would have blown away. Until then, stage stills come from the live `forceShed(n)` path, which the guide drives
      with the browser tools (`scripts/boss-shots`); for this project use the native renderer only for the full design.
- [ ] Telegraph and move stills (tether line, breath lane, wake, hatch ring, whiteout) can only be seen in a live
      client; flag to Kieran to review those himself (we cannot capture them here without a browser).
- [ ] Connectivity probe: `createShipState` + `rebuildShip`, `derived.orphanGroups` must be empty for the full design
      and with stage 1, then stages 1 and 2, removed (guide section 7). The generator ensures overlap but the
      three-stage hold-together check was written for the Scrap Mother.
- [ ] `npm run build:common` after any `common/` change; root tests `npx vitest run --pool=forks --no-file-parallelism`.

## 9. Rewards

- **Existing loot** (keep): `frost_gland` 3 to 6 (100%), `aurora_rime` 6 to 12 (100%), `ice` 6 to 12 (100%),
  `sapphire` 1 to 2 (40%); 2400 xp, 2400 credits (the Scrap Mother's figures).
- **Legendary: none for now (Kieran, 2026-10-31: undecided).** The notes below stay as options. `docs/parts-redesign.md` §6: legendaries need one very rare boss part, rolled per pilot per kill and
  only while you do not already hold one. Currently mapped: Prism Shard (Prism Colossus 6%), Rustjaw's Cog (Rustjaw 5%),
  **Heart of Hoarfrost (Hoarfrost Matriarch 5%)**, Warden's Ember (Cinder Warden 4%, the Pyreclast 6%), Void Pearl (Void
  Leviathan 4%), Fragment of the Maw (3%). **No legendary is tied to the Brood Mother**, and there are exactly six
  legendary models (Hive, Frostbite, Cinder Bloom, Prism, Phase, Singularity), all taken.
- **Proposal (cheap, follows the Pyreclast precedent):** add `frost_heart` to her loot at **4%**. The Warden's Ember is
  already shared between the Warden and the Pyreclast (its description names both). Then two bosses feed the Frostbite
  Lance (level 12), one at level 7 and one at level 8 (30+ minutes of fight, so a bit rarer). With a 600 s respawn,
  4% is about 25 kills, 5% (the Matriarch) about 20. The item's description would change from "cut from the Hoarfrost
  Matriarch's wreck" to name both sources; that is a one-line `items.json` edit, and a lore claim: it says that a Brood
  Mother also has a heart, which implies something about what she is (open question 4).
- **Alternative (needs Kieran's call):** a seventh legendary tied only to her. The natural fit is something that hatches
  or tethers, a weapon that uses her own verbs (a launcher that throws larvae, or a tether beam). This needs a
  `models.mjs` family and entry, a `tuning.json` weapon, a recipe and a `WeaponType` style, plus the artefact item. It
  is a scoped feature, not part of this doc.
- **Cosmetic/trophy idea (optional):** her `frost_gland` drop count scales 3 to 6; a player who cuts all four stage-1
  sac parts earns nothing extra by design (no per-part loot), to keep farming simple.

## 10. Intro, title and phase lines (lore rule applied)

The Scrap Mother's intro is "Something huge and patched together stirs in the hollow at the heart of the junk, grey
veins glinting in the rock around it." I model the Brood Mother's on that: only what a pilot can see.

Current placeholder text and what is wrong with it:
- **Title "Frost Brood Giant"** asserts that she *is* a Frost Brood, which is a claim about her nature. The only other
  place the game says a boss is Brood grown huge is Rimeback's intro ("A Frost Brood colony grown into a single mass of
  ice and shell"), which is already narration stating it as fact. Do not repeat the pattern.
- **Intro** "Something vast unfolds out of the aurora: fins of pale shell, arms trailing behind, eggs glowing in them"
  is observational except "eggs", which names what the glowing things are. A pilot can see glowing things; they cannot
  see eggs from outside.
- **Phase lines** such as "Something violet glows inside" are fine (observation); "The Brood Mother's shell falls away"
  names her as a Brood Mother, which is a name some character has to have given.

Proposals (all observational; nothing says what she is, what she wants, or where she comes from):
- `title`: **"Pale Giant of the Aurora"** (a description; avoids "Frost Brood", "mother", "queen").
- `intro`: **"Something vast and pale unfolds out of the aurora, past the belt: broad fins, arms trailing behind, a
  violet light glowing in them. Frost Brood drift in round her."** The last sentence is an observation that Brood are
  present and is consistent with the Curtain being their nesting ground (system description) without saying why.
- `phases`:
  1. 0.85: **"The glow along her arms brightens."**
  2. 0.667: **"Her fins tear away."**
  3. 0.334: **"Her shell falls away. A long violet light burns inside."**
  4. 0.15: **"She is coming apart, and faster for it."**
  (None names her as a Brood or a mother.)

**Applied (2026-10-31)**, with Kieran's answer to open question 1: title and phase lines 2 to 4 as above, but in "it"
("Its fins tear away."; line 1 is for when her moves exist). The intro drops "Frost Brood drift in round her" (no
Brood spawn at her lair, so a pilot wouldn't see it) and ends "Pilots call it the Brood Mother." so the name has an
owner: the pilots, not the narration.

Where a lore claim would need an owner:
- Who calls her "the Brood Mother", and why? Names in this game are given by someone. A pilot's label, a line from
  Maya (Borealis Research) or Sander (Thawline), or a codex record (an observatory log of the largest Brood seen) would
  each own it. Without one, the name is a bare label on a health bar, which the other bosses also are.
- That she lays eggs and shields young: shown visually, never stated. If a character should say it ("it's nesting"),
  they are the owner; the codex already has Maya treating Brood behaviour as animal behaviour (`brood_at_peak`), which
  is the existing voice for it.
- Whether the signal (the "heartbeat") affects her. The Brood scatter at its peaks (Maya's `brood_at_peak`, main_04).
  A tempting idea is that she does not scatter, or that peaks change the fight. **Do not do this without a canon
  decision.** It is not in this design.

## 11. Open questions for Kieran

Answered by Kieran (2026-10-31). Decided items are applied; "later" items stay open.

1. **Her name and who owns it.** *Answered:* "Brood Mother" is only what people call it. It is a mysterious, ancient
   entity whose lore will be fleshed out later. In game the name is attributed to pilots (her intro ends "Pilots call it
   the Brood Mother.") and nothing says what it is, where it came from, or that it is a Brood or a mother. Her text now
   uses "it". **Applied** in `bosses.json`: title "Pale Giant of the Aurora", the observational intro from section 10,
   and the phase lines without the name. Nothing in game states that it is ancient: that is canon for later, with an
   owner when it's written.
2. **Level.** *Decide later.* Stays 8 for now.
3. **Stage 1 length.** *Decide later.*
4. **Legendary.** *Decide later; no legendary drop for now.* Her loot has none (it never had one; `frost_heart` stays
   the Hoarfrost Matriarch's alone). The section 9 proposal and the seventh-legendary alternative are both undecided.
5. **Chill.** *Answered and built:* her chill feeds the warmth meter (the same one the cold runs down) and the frost
   vignette (`ShipBridge.frostHit` -> `warm`). *Open:* her per-move chill amounts (breath 0.02 a tick, larva 0.35,
   whiteout 0.02 a tick, and so on) were tuned for a meter that starts full every fight; against a pilot already
   part-chilled from the flight out they bite harder. Retune when her moves go in.
6. **Arena.** *Answered:* a separate enterable area will be designed later, away from the open world. Not in this doc;
   she stays at her open-space lair until then.
7. **Turn rate.** *Decide later.*
8. **Peaks (the heartbeat).** *Decide later.* Still not designed; no interaction until there is canon for it.
9. **Cold tolerance.** *Answered and built:* a warmth meter (cold builds up away from heat; insulating materials slow
   it, nothing stops it). The conduit rule is gone from `hazards.json`; the field guide's "Cold and warmth" section
   explains it.
