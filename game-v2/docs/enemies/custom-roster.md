# Custom enemy roster (designed 2026-11-04, in the game 2026-11-05)

Kieran: "more custom geometry enemies that don't fit strictly in the grid-shaped cell layout. The more of these we
have, the less we need to re-make everything every time we change ship mechanics."

Nine small and medium enemies are built from bespoke pieces (any polygon), the way the Pyreclast and the Scrap Mother
are. Six replace a grid enemy and three are new.

## What's built (2026-11-05)

**In the game, in the old types' spawns.** `factions.json` `custom.types` puts each design in the place of a ship type:

| Design | Replaces |
|---|---|
| Censer | `cinder_zealot` |
| Maw Lurker | `maw_lurker` |
| Hookboat | `pirate_raider` |
| Rime Bell | `frost_shard` |
| Scrap Crawler | `scrap_crawler` |
| Helios Drone | `helios_drone` (new, below; also the training drone) |

The grid blueprints stay in `data/ships/blueprints/enemy/`, but nothing spawns them. Three were renamed
`grid_scrap_crawler`, `grid_maw_lurker` and `grid_helios_drone`, because the custom designs took their names.

**Built, not placed.** Rivet Sower, Slag Ray and Clinker have hulls, moves and stats. The Scrap Mother's and the
Pyreclast's stages place them in their dens.

**Open questions 1 to 3, settled:**
1. **Groups.** A blueprint part has an optional `group` (0 to 7). The order is fixed in
   `common/src/bodies/custom/roster.json`, core first, and only rigid designs use it.
   - A part going down takes the rest of its group with it (`common/src/ships/groups.ts`, `state.ts damagePart`).
     The rebuild treats a gone group as not intact.
   - Which groups are gone is one byte. It rides in the custom order, which already travels as a decision, so no
     damage row is added.
2. **Stats.** They are in an enemy-side table, `factions.json` `custom.designs`:
   - range and reach
   - HP per group at Mk I (shared among the group's parts by area)
   - each move's numbers and the guns between moves
   - firepower, for ratings

   The enemy AI no longer reads reach from a custom design's weapon parts.
3. **Grades.** `custom.grades` scales HP and damage for Mk I to V: hp 1 to 3.6, damage 1 to 2.6. Elites also take
   `rules.eliteHp`. `Enemies.design` no longer regrades a custom design's materials, so it looks the same at every
   grade. Faction `hpScale` and `damageScale` don't apply.

**Size (question 4).** The replacements keep the bigger, readable size: radius 123 to 183. The den enemies are kept
on the order of the grid enemies they live among: Scrap Crawler 102, Rivet Sower 100, Slag Ray 107 and Clinker 96 in
the generators' units (100 to 107 in the game's). That is about a grid Scrapborn hulk (113) or a Cinder Brand (109).
Their pieces still read at play zoom (`docs/panels/2026-11-05/enemies/*-play-zoom.png`). The Scrap Crawler does
both jobs at den size.

**Materials (question 5).** The Maw has `maw_slate` and `maw_glass`, and the pirates have `pirate_plate` and
`pirate_paint` (protocol 48). The Maw Lurker and the Hookboat are drawn in them.

**Moves.**
- **Shared code.** Each design's flight is a module in `common/src/bodies/custom/<id>.ts`. It rides on the shared AI
  pilot body as `AI_ORDER.CUSTOM`. That is the enemy AI's ENGAGE with the design index, the groups gone, and the
  move under way with its argument, an 8-bit seed and its start tick. The steps are explicit.
- **Server side.** What a move does to the world is the server's: `server/src/game/custom/` has `CustomEnemies.ts`,
  `moves.ts` and `kit.ts`.
- **Rule 6.** Every piece is read at the tick it acts.
- **Fire.** Shots go through the boss shot path (`GameServer.hostileShot`), not part guns.
- **Pulls.** A pull on a pilot made while the pilotless ships step is applied after they all have
  (`ShipBridge.pushQueue`). This way a body reads its target as its clients do.

**The Clinker's `under` rule.** It now works outside a boss's stages (`common/src/ships/hitRules.ts underCover`).
While a plate covers a spot, a hit on the magma there goes to the plate. Once the plate is gone, the magma takes it.

**The Sower's mines.** They are a new `mine` mob behaviour (`rivet_mine`). A volley is one guide row, `LAUNCH`,
behind `CAPS.LAUNCHES` (262144). The row carries the pattern around a point on the guide grid and the ids as runs.
Each mine is run from that row, with no SYNC per mine (`common/src/guidance/launch.ts`).

**Tests.** Every design's moves and lost pieces are exact on the tick layer, with no control rows
(`server/src/net/decisions/customEnemies.test.ts`). That includes the Sower's mines, laid mid-tick, on a
`LAUNCHES` client. `server/src/game/custom/custom.test.ts` covers:
- groups
- the under rule
- the tables
- that every design holds together as built

- Generators: `scripts/bespoke/enemies/<id>.mjs` (shared helpers in `kit.mjs`; `build-all.mjs` runs them all). They
  write to `docs/enemies/designs/`: `<id>.pieces.json` (the bespoke pieces), `<id>.json` (the design),
  `<id>_damaged.json` (with its shot-off groups removed, for the still) and `<id>.meta.json` (its card).
- Stills: `scripts/bespoke/enemies/render.mjs`, a private copy of the native renderer on port 5318 that reads a mirror
  folder outside the tree (the same approach as `maw_heart_render.mjs`). Sheets: `scripts/bespoke/enemies/sheet.py`.
- Panels: `docs/panels/2026-11-04/enemies/`. `<id>.png` shows the grid enemy it replaces (if any), the design intact
  and the design damaged, all at one zoom. `roster.png` and `roster-damaged.png` show all eight. `play-zoom.png` shows each as big as it is on
  screen: at the game's default zoom (1) on top and zoomed out (0.45) below. All eight still read by silhouette and
  colour at both; rivets and thin struts disappear, as expected. The Rime Bell was the one that faded out, so it is now
  a quarter bigger. `<id>-v1-vs-v2.png` shows the first draft over the rework for the four designs reworked after review.
- The Maw Lurker is drawn with the Heart of the Maw redesign's proposed materials and surfaces. Those replace the Scrap
  Mother's tiles, so `render.mjs` renders the Maw designs in a second pass of their own (`surfaces: 'maw'` on the card,
  port 5319).

```
node scripts/bespoke/enemies/build-all.mjs
node scripts/bespoke/enemies/render.mjs        # docs/panels/2026-11-04/enemies
python scripts/bespoke/enemies/sheet.py
```

## Why custom enemies

A grid enemy is built from the player's parts. Every change to the player ship rules (energy ports, generators,
conduits, blast sizes, material grades) changes every enemy too, so the enemies have to be rebuilt and retuned. The
energy-ports direction (`docs/design/energy-ports-2026-11.md`) makes this worse. Under ports, a grid enemy only works
if its power chain is routed correctly, and the Cinder Zealot's lance would need two generators and a battery wired to
it.

A custom enemy doesn't use those rules. Its pieces are its own polygons. What each piece does is decided by the
enemy's own **body** (`common/src/bodies`), not by the part catalogue's power model. Changing the player ship rules
leaves it alone. It also reads better: each piece has its own shape, so a player can see what to shoot. Losing a piece
changes what the enemy does, so there's a reason to aim.

## The roster

| | design | faction | replaces | role | radius | parts / groups | level | threat |
|---|---|---|---|---|---|---|---|---|
| 1 | Scrap Crawler | Scrapborn | `scrap_crawler` | puller / brawler | 146 | 14 / 8 | 3-6 | medium |
| 2 | Rivet Sower | Scrapborn | new | mine layer | 157 | 9 / 6 | 4-7 | medium |
| 3 | Slag Ray | the Pyreclast's cavern | new | skirmisher / area denial | 159 | 7 / 5 | 26-32 | medium |
| 4 | Clinker | the Pyreclast's cavern | new | tank / artillery | 124 | 13 / 7 | 26-32 | high |
| 5 | Censer | Cinder Cult | `cinder_zealot` | sniper / lancer | 140 | 9 / 6 | 15-20 | medium |
| 6 | Maw Lurker | Maw Spawn | `maw_lurker` | sniper | 165 | 7 / 6 | 24-30 | high |
| 7 | Hookboat | Pirates | `pirate_raider` | puller | 138 | 11 / 5 | 8-12 | medium |
| 8 | Rime Bell | Frost Brood | `frost_shard` | swarmer / support | 125 | 6 / 5 | 6-9 | low |
| 9 | Helios Drone | Helios Drones | `helios_drone` | passive / welder | 64 | 11 / 6 | 1-3 | low |

Radius is in world units (24 to a cell). The grid enemies they replace are about 60-100 across their radius. The
custom ones are a little bigger so their pieces read at game zoom; each design's `scale` in `write()` is a single
number to change. The kit writes that scale onto each piece as `fine`, so its seams and bevels are drawn at its size
(a share of a cell otherwise: heavy, inked outlines on a hull drawn small) and its detail is outlined in shadow, not
black; painted detail is toned a quarter of the way to grey (restyle, 2026-11-05). A **group** is one destroyable piece. It may be drawn as several polygons (a claw is an arm, a palm
and a finger), but it breaks as one. With eight groups or fewer, which pieces are gone fits in one byte.

### 1. Scrap Crawler (Scrapborn; replaces `scrap_crawler`)

A salvage crab: two mismatched carapace plates (rust and faded paint) over a riveted spine, a greyseam lamp in its
back, a copper-wound electromagnet between two crusher claws, two hind legs braced out, one worn drive.

- **Behaviour:** it turns its magnet on you and drags you in, then the claws snap shut just ahead of it.
- **Pieces:** `magnet` (gone: no pull, so it has to crawl up to you at its slow pace); `claw_l` / `claw_r` (each one
  gone halves the snap; both gone, it rams instead); `shell_l` / `shell_r` (armour: each one gone bares the spine and
  lamp on that side, so shots to that side hit the core); `legs` (armour); `drive` (gone: it drifts and can only turn).
- **Look (rework):** the first draft's clean teal strips read as high-tech. It now keeps the Scrap Mother's greyseam
  green, but only as low leaks through grime and a dirty lamp, with warm amber work lamps. The Rivet Sower's mines are
  lit unevenly, and some have gone dead.
- **Why it's better:** the grid crawler is a 5x4 block with one cannon, and nothing about it looks like what it does.
  This one shows its threat (the magnet and claws), and you can stop the threat by shooting it.

### 2. Rivet Sower (Scrapborn; new)

A long salvage beetle: a gear-rimmed drum magazine at its tail with lit rivet mines round its rim, two panniers of spare
mines slung either side, two long sensor whiskers, two small drives.

- **Behaviour:** it gets ahead of you, drops a line of mines across the way you're flying, then turns away.
- **Pieces:** `drum` (gone: it lays no more mines); `sensors` (the whiskers; gone: it drops mines in a fixed ring round
  itself instead of across your line); `pannier_l` / `pannier_r` (gone: that pannier's mines go off on the spot,
  hurting the Sower and anything near it; shooting a pannier as it passes a packmate is a reward); `drive` (one group:
  gone, it can't get ahead of you any more).
- In the Scrap Mother's den it turns the open floor into lanes and makes players choose a path, so the den isn't just
  a target range.

### 3. Slag Ray (Pyreclast's cavern; new)

A manta of cooled crust: two broad swept wings of obsidian scaled with ash and cracked with lava, a ridged body over a
molten heart with gill slits glowing down its back, two curled horns either side of an ember mouth, a long whip tail.

- **Behaviour:** it sweeps past in long arcs, spitting a short cone of embers ahead of it and leaving a burning slag
  wake behind.
- **Pieces:** `tail` (gone: no wake); `wing_l` / `wing_r` (gone: it rolls towards the missing wing and can't hold a
  straight pass, so its arcs tighten and it's easy to lead); `horns` (gone: no ember cone).
- It fills the cavern with something that moves while the Pyreclast stays put. The wake denies space for a while
  without lots of projectiles: the wake is one shape-hazard, sent with the move (see Build).

### 4. Clinker (Pyreclast's cavern; new)

A tortoise of cooled slag. It has an oval shell of four crust plates around a lava vent at its crown: a beaked front,
a right, a back carrying two banded chimneys, and a left. Each plate is a raised scute in a bevelled frame, with growth
ridges and a single crack of lava down it. A darker rim runs round the edge. The plates part along the diagonals, so
the magma under the shell shows as a glowing X; where a plate comes off, the magma floods out (`clinker-damaged.png`).
The first draft was a lumpy pile of random shards (`clinker-v1-vs-v2.png`).

- **Behaviour:** it settles into a lane and lobs magma over the rock from its chimneys, in a fixed left-right order.
- **Pieces:** `plate_front` / `plate_right` / `plate_back` / `plate_left` (crust, each with its length of rim and the
  front one with the beak: they soak fire; once one is off, the magma under it is bared and takes 150%, but hitting the
  magma also splashes the shooter if they're close); `chimney_l` / `chimney_r` (each one gone removes half its volleys;
  both gone, it crawls at you to ram); `core` (the vent and the magma under the plates: while a plate covers a spot,
  hits there go to the plate, which is the bespoke `under` rule).
- It's a small version of the Pyreclast's "a vent window where it takes 150%": a tank you get through by cracking it,
  not just a big health bar. You can see which plate to crack.

### 5. Censer (Cinder Cult; replaces `cinder_zealot`)

A cult lancer built like a swung censer: a long black reliquary hull inlaid with brass and gilt rivets, a forked lance
(a fire-glass blade between two brass-edged tines), a fire grille over its core, a brazier of embers at its back hung
on chains from two swept vanes.

- **Behaviour:** it holds off at range, draws its lance's line on you (a telegraph) and fires down it 1.2 s later.
- **Pieces:** `lance` (gone: no shot; it dives to ram with its blunt nose); `brazier` (gone: packmates near it no
  longer get its 25% faster fire, so shoot this first in a cult pack); `vane_l` / `vane_r` (gone: it turns slowly
  towards that side, so its aim lags if you circle the other way); `drive`.
- **Why it's better:** the zealot's plasma lance is two grid cells with nothing to show they're a lance. Under ports
  it would need a full power chain to fire at all. The Censer's lance is one piece you can see and shoot off, and its
  warning line is part of what it does.

### 6. Maw Lurker (Maw Spawn; replaces `maw_lurker`)

A small kin of the Heart of the Maw, in its v3 visual language. A seed of shard-ring crust in uneven plates, with one
gold eye in a socket at its front. The heartbeat's veins branch back from the eye across the crust and fade from gold
to ember as they go, as on the Heart. A long horn of heartstone points forward with a vein down it (its rail). Two
roots sweep back from glowing knots on its flanks, and a short tail root ends in a knot of crystal. It uses the Heart
redesign's proposed materials (`maw_crust`, `maw_heartstone`, `maw_seamglass`), so it looks related to its boss. The
first draft was a spike with loose shards (`maw_lurker-v1-vs-v2.png`).

- **Behaviour:** it hangs far off in the shard field, its eye draws a thin gold line on you, then the rail fires one
  heavy slug.
- **Pieces:** `eye` (gone: its line wobbles and its shot spreads, so it moves closer to make up for it); `rail` (gone:
  it closes in and rams with the seed); `root_l` / `root_r` (shoot a root's knot and the root goes; each one gone, it
  drifts and turns slowly towards that side); `tail` (gone: it can't hold its range and drifts in).
- **Why it's better:** the grid Lurker has a railgun and two missile pods on an 8x5 grid, the same shape as everything
  else there. This one looks like a small version of the Maw's boss, and its one threat is a single line you can watch
  for.

### 7. Hookboat (Pirates; replaces `pirate_raider`)

A whaler gone bad: a long narrow hull in grey with a red band, a barbed harpoon gun on its bow with a rope winch behind
it, a wheelhouse aft to starboard, a rusted outrigger pontoon to port on two struts carrying a gun turret, two
mismatched drives.

- **Behaviour:** it harpoons you from the bow (a tether) and reels you towards its pack while the outrigger gun fires
  on you.
- **Pieces:** `harpoon` (bow gun and winch; gone: no tether); `outrigger` (pontoon, struts and gun; gone: no gun, and it
  lists, so its turns go wide one way); `drive_l` / `drive_r` (mismatched: losing one makes it crab sideways);
  `core` (inside the wheelhouse; nothing shows until the hull is gone).
- **Why it's better:** pirates get a fight with an idea in it (get harpooned and dragged to the pack; counter: thrust
  away or shoot the bow). The raider has a cannon and a generator block, the same as a player starter, and it changes
  every time the player rules do.

### 8. Rime Bell (Frost Brood; replaces `frost_shard`)

A drifting creature of ice: a faceted bell of rime with ridges of clear ice, a violet gland glowing at its crown, a
membrane frill around its back edge, three crystal tendrils trailing.

- **Behaviour:** they come in threes and keep at mid range. Each bell's frill pulses an EMP ring in turn, and the
  tendrils shed ice splinters when you get close.
- **Pieces:** `frill` (gone: no EMP); `tendril_l` / `tendril_c` / `tendril_r` (each one gone means fewer splinters);
  `core` (the bell and gland).
- **Why it's better:** the shard is a shield-and-EMP grid ship. A Frost Brood enemy should look like an animal, which
  matches how the game's people talk about them (Maya: "animal behaviour"). Six parts make it cheap enough to send in
  swarms.

### 9. Helios Drone (Helios Drones, Sol; replaces `helios_drone`; added 2026-11-05)

One of the Array's maintenance drones that strayed, as `docs/lore-canon.md` has them. It is drawn as Directorate
engineering:
- a slim titanium service chassis with a little brass trim (about the grid drone's bulk)
- a sensor dome lit on one half and cracked dark on the other (half-blind)
- a light jointed welding arm ending in a torch
- two solar panels on thin booms, in the stations' own solar cells (`surface: 'solar'`), and one small drive

It is a starter's first kill, a little smaller than the starter ship.

- **Behaviour:** passive. It drifts on its round and noses in to weld whatever comes within reach (`torch`).
- **Pieces:**
  - `torch`: gone, it can't weld.
  - `eye`, `panel_l`, `panel_r`: these do nothing to its flight.
  - `drive`: gone, it drifts.
  - `core`: the service cell under the chassis.
- No new lore or player-facing text. Its name and faction are the ones the game already had.

## Build notes (on the existing architecture)

**Hull.** Each is a bespoke design like the bosses: `data/ships/bespoke/<id>.json` plus
`data/ships/blueprints/enemy/<id>.json` with `rigid: true`. It flies as built, its hull is built once, and shot-off
parts are hidden in the shader. They have 6-14 parts each against a typical grid enemy's 12-20, so they cost no more to
simulate or snapshot. One addition is proposed: a `group` on each blueprint part (the kit has it as `_group`). Today a
bespoke part is lost on its own, so a claw's three polygons would break one at a time. With `group`, `ShipBridge`
sheds the group together, and a body reads "is the magnet there" as one bit.

**Materials.** Only the bosses' own materials (`scrap_*`, `pyre_*`, `brood_*`) and `leestone` / `titanium` read as
hull at this zoom. The catalogue's other materials (`dense_ferrite`, `conductive_steel`, `steel`) show a 2-cell panel
grid that makes them look like grid ships again. A `core` part shows its glowing honeycomb wherever it isn't covered,
so every core here is small and sits in a recess or under another part. The Maw Lurker uses the
Heart redesign's proposed materials (rendered in their own pass). Drives use `pyre_steel` or `scrap_steel`,
because other materials give purple or blue housings. The Maw and the pirates use stand-ins: they should each get two
materials of their own (`maw_slate`, `maw_glass`; `pirate_plate`, `pirate_paint`), as the bosses did.

**Flying.** All eight fly on the shared AI pilot body (`common/src/bodies/aiPilot.ts`, decision-inputs section 12):
the commander's `ORDER` / `TARGET` / `SIDE` decisions as today, with `range` from the enemy's card. What's new is
small per-enemy **move modules** in `common/src/bodies/` (the Brood Mother pattern, section 6.6: explicit steps, no
generators). Each move starts from one decision, with an 8-bit seed for any rolls inside it:

| enemy | decisions | what the body does on both sides |
|---|---|---|
| Crawler | `PULL` on/off | magnet pull on its target (a pull field like the Scrap Mother's), claw snap when in reach |
| Sower | `LAY` (angle q8) | flies to a point ahead of the target's line and drops N mines along it (mine ids from the move's tick: a LAUNCH, stage 8) |
| Slag Ray | `PASS` (side, seed) | one arc pass; the ember cone and the wake as one shape-hazard spawned with the pass (no per-ember entities) |
| Clinker | `VOLLEY` | the chimney volley in its fixed order; telegraph rings where shells land |
| Censer | `LANCE` (aim q13) | the line telegraph, then the beam down it 1.2 s later |
| Lurker | `AIM` (aim q13) | the gold line, the slug; spread from the seed when the eye is gone |
| Hookboat | `HARPOON` (aim q13) | the harpoon shot; on a hit, a tether that reels the target (beatable by thrusting away, the pull rule in boss-design 4) |
| Rime Bell | `PULSE` | the EMP ring; splinters as a fixed fan when a target is close |

Under rule 6 of decision-inputs ("structure at the tick"), each move checks its piece's group bit at the tick it
fires, so a piece shot off on tick k stops working from tick k + 1 on both sides. No power is involved: a custom
enemy's weapons are boss-style kinds (`tuning.json` boss weapons fired through `BrainHost.fire`), not part functions
with ports, so the energy rework leaves them alone. Their `fn` in the blueprint only picks the look.

**Wire.** Groups are at most 8 per design, so which groups are gone can travel as one byte where a ship's damage row
travels today. That's the same as or less than a grid enemy.

## Open questions

(Questions 1 to 6 are settled: see "What's built" at the top. The original text is kept below.)

1. **The `group` field**: add it to blueprint parts (and shed groups together in `ShipBridge`), or keep one polygon
   per destroyable piece and live with fewer shapes? The designs assume `group`.
2. **Where custom enemies' stats live**: a `custom` table in `factions.json` (hp per group, move numbers), or an
   enemy-side version of `bosses.json`? Today the enemy AI takes reach and range from the blueprint's weapon parts,
   and custom enemies don't have those in the usual sense.
3. **Grades**: `Enemies.design` regrades grid enemies by material. Custom enemies would need a grade scale (hp and
   damage only), or one design per tier.
4. **Size**: the custom enemies are 100-160 units across their radius, against the grid ones' 60-100. Should they be
   scaled down to the old sizes (one number per design), or should the bigger, more readable size become the rule?
5. **Own materials for the Maw and the pirates** (see Build notes): a protocol bump each, since they're not in the wire
   dictionary. The Maw Lurker already uses the Heart redesign's proposed ones, so it gets them when the Heart does.
6. **Which to build first**: the Hookboat and the Crawler need nothing that doesn't exist yet except the move module
   and `group`. The Sower needs mob LAUNCH ids (decision-inputs stage 8). The Clinker needs the `under` hit rule on a
   non-boss.
7. **More factions**: Void Wraiths, Scavenger Drones, Redtooth and the Helios Drones have no designs yet. Names and
   flavour for any of these need an owner in game text (lore-canon rules). Nothing in this doc is player-facing text.
