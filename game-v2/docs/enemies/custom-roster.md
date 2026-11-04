# Custom enemy roster (design only, 2026-11-04)

Kieran: "more custom geometry enemies that don't fit strictly in the grid-shaped cell layout. The more of these we
have, the less we need to re-make everything every time we change ship mechanics."

Eight small and medium enemies built from bespoke pieces (any polygon), the way the Pyreclast and the Scrap Mother
are. Five replace a grid enemy, three are new. **Nothing here is in the game**: no file is in `data/`, and the live
enemies are unchanged.

- Generators: `scripts/bespoke/enemies/<id>.mjs` (shared helpers in `kit.mjs`; `build-all.mjs` runs them all). They
  write to `docs/enemies/designs/`: `<id>.pieces.json` (the bespoke pieces), `<id>.json` (the design),
  `<id>_damaged.json` (with its shot-off groups removed, for the still) and `<id>.meta.json` (its card).
- Stills: `scripts/bespoke/enemies/render.mjs`, a private copy of the native renderer on port 5318 that reads a mirror
  folder outside the tree (the same approach as `maw_heart_render.mjs`). Sheets: `scripts/bespoke/enemies/sheet.py`.
- Panels: `docs/panels/2026-11-04/enemies/`. `<id>.png` shows the grid enemy it replaces (if any), the design intact
  and the design damaged, all at one zoom. `roster.png` and `roster-damaged.png` show all eight.

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
| 4 | Clinker | the Pyreclast's cavern | new | tank / artillery | 119 | 10 / 8 | 26-32 | high |
| 5 | Censer | Cinder Cult | `cinder_zealot` | sniper / lancer | 140 | 9 / 6 | 15-20 | medium |
| 6 | Maw Lurker | Maw Spawn | `maw_lurker` | sniper | 161 | 9 / 6 | 24-30 | high |
| 7 | Hookboat | Pirates | `pirate_raider` | puller | 138 | 11 / 5 | 8-12 | medium |
| 8 | Rime Bell | Frost Brood | `frost_shard` | swarmer / support | 101 | 6 / 5 | 6-9 | low |

Radius is in world units (24 to a cell). The grid enemies they replace are about 60-100 across their radius. The
custom ones are a little bigger so their pieces read at game zoom; each design's `scale` in `write()` is a single
number to change. A **group** is one destroyable piece. It may be drawn as several polygons (a claw is an arm, a palm
and a finger), but it breaks as one. With eight groups or fewer, which pieces are gone fits in one byte.

### 1. Scrap Crawler (Scrapborn; replaces `scrap_crawler`)

A salvage crab: two mismatched carapace plates (rust and faded paint) over a riveted spine, a greyseam lamp in its
back, a copper-wound electromagnet between two crusher claws, two hind legs braced out, one worn drive.

- **Behaviour:** it turns its magnet on you and drags you in, then the claws snap shut just ahead of it.
- **Pieces:** `magnet` (gone: no pull, so it has to crawl up to you at its slow pace); `claw_l` / `claw_r` (each one
  gone halves the snap; both gone, it rams instead); `shell_l` / `shell_r` (armour: each one gone bares the spine and
  lamp on that side, so shots to that side hit the core); `legs` (armour); `drive` (gone: it drifts and can only turn).
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

A lump of cooled slag that crawls: five crust plates domed over a pool of magma, a vent at its crown, two banded
chimneys on its back plates, a blunt beak of crust. Lava glows in the cracks between the plates, and floods out where a
plate comes off (see `clinker-damaged.png`).

- **Behaviour:** it settles into a lane and lobs magma over the rock from its chimneys, in a fixed left-right order.
- **Pieces:** `plate0`-`plate4` (crust: they soak fire; once one comes off, the magma under it is bared and takes 150%,
  but hitting the magma also splashes the shooter if they're close); `chimney_l` / `chimney_r` (each one gone removes
  half its volleys; both gone, it crawls at you to ram); `core` (the vent and the magma: under the plates, so while a
  plate covers a spot, hits there go to the plate, which is the bespoke `under` rule).
- It's a small version of the Pyreclast's "a vent window where it takes 150%": a tank you get through by cracking it,
  not just a big health bar.

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

A splinter of dark rock that hunts: a chunky knot of slate, a long obsidian horn forward with a gold-lit groove down it
(its rail), one gold eye beside the horn's root, broken glassy shards grown out at odd angles (two to the left, one of
them reaching forward, two to the right), gold light in the cracks of the knot at its root. Stand-in materials
(leestone, pyre glass) until the Maw has its own, as for the Heart's redesign.

- **Behaviour:** it hangs far off in the shard field, its eye draws a thin gold line on you, then the rail fires one
  heavy slug.
- **Pieces:** `eye` (gone: its line wobbles and its shot spreads, so it moves closer to make up for it); `rail` (gone:
  it closes in and rams with the knot); `flank_l` / `flank_r` (glass shards as armour on each side); `vents` (gone: it
  drifts more slowly and can't keep its range).
- **Why it's better:** the grid Lurker has a railgun and two missile pods on an 8x5 grid, the same shape as everything
  else there. This one reads as part of the shard ring (dark rock with gold seams, like the Heart), and its one threat
  is a single line you can watch for.

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
so every core here is small and sits in a recess or under another part. Drives use `pyre_steel` or `scrap_steel`,
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
   dictionary.
6. **Which to build first**: the Hookboat and the Crawler need nothing that doesn't exist yet except the move module
   and `group`. The Sower needs mob LAUNCH ids (decision-inputs stage 8). The Clinker needs the `under` hit rule on a
   non-boss.
7. **More factions**: Void Wraiths, Scavenger Drones, Redtooth and the Helios Drones have no designs yet. Names and
   flavour for any of these need an owner in game text (lore-canon rules). Nothing in this doc is player-facing text.
