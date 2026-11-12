# Weapon modifiers (2026-11)

The modifier lab (`prototypes/modifier-lab/`, source of truth `treat.js`, checks `treat.check.mjs`) ported into the game
on the ports core. Dev server only until Kieran reviews it.

## What the player builds

| Part | What it does |
| --- | --- |
| Mount / Double mount / Triple mount | A line part (energy passes through like a conduit) with 1 / 2 / 3 sockets on one side. Each filled socket treats 24 / 30 / 40 E a second and burns 1 E a second of upkeep from the mount's own held power. Mounts never gate guns: unpowered, energy still passes, untreated. |
| Coil, Resonator, Chamber, Prism | Modifier blocks. Placed against a mount's socket they give Velocity, Rapid, Explosive, Split. |
| Arc lattice, Condenser, Brand, Rail driver | Special modifiers: Chain, Heavy, Burn (each uses hopper material), Hyper (uses extra power). |
| Arc salt / Cryo fluid / Pyre gel hopper | Holds the material a special uses. Filled whenever the ship's ports are filled (placeholder: free). Never ammunition. |
| Conduit II / III (and corner, joiner, splitter, passthrough, combiner) | Line tiers: a tier I line part carries 2 effects and 120 treated E/s, II 3 and 300, III 4 and 900. Power is never limited by tier. |

Rules (all from the lab):

- A mount takes one kind (the first in socket order) or exactly one recipe's kinds. Only Double/Triple fuse. A fused
  mount gives the recipe's own effect at the mount's full amount, and not its parents'.
- Recipes: Coil + Prism = Pierce, Chamber + Resonator = Wave. The table is data (`tuning.json modifiers.recipes`).
- Effects travel from a mount down the line to the guns it reaches: through conduits, mounts, joiners and splitters;
  never through batteries, capacitors or the core.
- Strength of an effect on a gun = min(1, treated E/s reaching it ÷ the gun's load in E/s). Over-supply never dilutes.
- A full line part drops the weakest effect (ties: the last put in). Over a part's cap, all effects scale to fit.
- Ships with no mounts behave exactly as before, to the byte.

## Decisions made for the port (differences from the lab)

1. **Static sharing.** In the lab a mount's treatment is shared among the guns that are drawing at that moment. In the
   game it is shared among all the guns its line reaches, in proportion to their sustained load (shot energy ÷ beat, a
   beam's burn), whether or not they are firing. A gun's effects and strengths are then a pure function of the layout,
   so server, owner and every other client work them out alike with nothing on the wire. To review with Kieran.
2. **Strength steps.** Strength is stored as q in 1..15 (q/15). Wire quantisation only; no levels in the design.
3. **What is live.** Per shot, a 4-bit mask says which of the gun's (at most 4) effects are on it. An effect is off when
   one of its mounts holds no power for upkeep, or a special's hopper/buffer can't pay for the shot. The mask travels
   wherever `aug` travels (fire event, lane record, fire row: `part + 256 × ammo + 65536 × aug + 131072 × mask`).
4. **No new state arrays.** Mount power, hopper material and the Rail driver's buffer all live in `PortsState.held`
   (already packed, hashed and synced). `PortsLayout.mod` is optional and static.
5. **Rapid is energy neutral.** At rate × r a shot costs 1/r of the gun's shot, comes r times sooner and does
   1/r × total of the damage.
6. **Bounce** has no recipe and is left out until one exists.

## Effects

Numbers at full strength (`tuning.json modifiers`); strength k scales each change from none to full
(`fxTo(full, k) = 1 + (full − 1) × k`).

| Effect | Shells | Beams / pulses |
| --- | --- | --- |
| Velocity | speed × 1.8, range × 1.6 | range × 1.6 |
| Rapid | rate × 1.8, total damage × 1.2 | dps × 1.2 |
| Explosive | direct × 0.75, blast 0.32 of the damage in a 12 to 34 radius | a blast at the beam's end each damage step |
| Split | 3 shells in a 6° fan, the middle keeps most, total × 1.35 | 3 beams in the fan, same split of dps |
| Pierce | passes through up to 5 targets: 36/26/18/12/8% | the beam passes through the same way |
| Wave | width × 3.5, hits everything it crosses for 78% | width × 3.5, every target crossed |
| Chain | 4 jumps at 50%, reach 64 | same, from the beam's end |
| Heavy | damage × 1.6, speed × 0.62 | dps × 1.6 |
| Burn | 60% more as a burn over 3 s | same |
| Hyper | speed × 3.5, damage × 0.8 | range × 1.3, dps × 0.8 |

Each effect maps onto existing `WeaponTuning` behaviour where one exists (splash, pierce/pierceKeep, chain, ignite,
burst/spread, speed/life/size). Anything new is a `WeaponTuning` field read by the shared hit rules.

## Architecture

```
data/ships/tuning.json  modifiers        numbers, kinds, recipes, line tiers, names, colours
scripts/econ/models.mjs                  the parts (mounts, modifiers, hoppers, line tiers) -> data/ships/models.json
common/src/ships/modifiers/types.ts      shared shapes (GunFx, PortsMods, ModifierTuning), fxTo, rapidRate
common/src/ships/modifiers/fxDef.ts      fxDef(def, mt, gunFx, mask): a cached WeaponTuning transform; beam equivalents
common/src/ships/power/portsMods.ts      buildPortsMods (reach, shares, tier caps), portsModsTick (upkeep),
                                         portsFxLive, portsShotFx (the mask at spend; uses up hoppers/buffers)
common/src/ships/guns.ts / launch.ts     GunShot.fx, FireRecord.fx, gunDef(...fx), volleys rebuilt from the mask
server .../bridge/weapons.ts, Weapons.ts effects applied through the shared hit rules
client .../weapons/fx/modFx*.ts          one muzzle / tracer / impact layer per effect, on every gun
client hangar                            sockets, effect chips on guns, hopper fill, line-tier overlay
```

Seams: `portsMods.ts` knows nothing about shots; `fxDef.ts` knows nothing about ports. They meet at
`L.mod.gunFx[part]` and the mask. A new effect: a name appended to `modifiers.effects`, its numbers, a case in
`fxDef.ts`, a client layer. A new recipe or kind: a data row (and a part in models.mjs for a kind).

## Placeholders

- Hopper materials have no drop source yet: hoppers fill for free whenever the ship's ports are filled.

## Decided (2026-11-12)

- A gun's effects are a function of the layout, not of which guns are firing at the moment (the lab shared among the
  guns firing).
- The layout is the parts still alive: a modifier block, hopper or mount destroyed in battle changes the guns down
  its line at once (server/src/ships/bridge/modsLost.test.ts).
- Hoppers refill whenever ports are filled, not only at a station.
- Part costs use existing materials.

## Gun range (2026-11-12)

- The range's weapon picker has a Modifiers row (client ui/gunRange): the effects the pilot may fit (every part of one
  licensed at their level or owned: common gunRange/options.ts), up to four on at once.
- The server builds the cheat ship again with a deck behind the gun: one mount for each effect, its blocks, a hopper
  or reactor for a special (common gunRange/mods.ts). Chosen effects are kept across weapon changes in a visit.
- A range ship's effects are all at full strength and on every shot, whatever the line's cap or what its hoppers hold
  (rebuild.ts portsModsFull, guns.ts): the range shows what an effect does, the hangar shows what a layout affords.
- A gun fed by ammunition alone takes none there, as on any ship: the chips are greyed and say why.

## Explosive blast look (2026-11-12)

- Where: client `rendering/weapons/fx/mods/blast.ts`, called by the explosive layer's impact (shells) and by
  `modBlast` in `mods/index.ts` (a blast the server tells with no shell's hit: a beam's end, a way out of a hull).
- Going in: a white core flash and a hot swell, a shock ring racing out to the blast's real radius with a thin white
  ring behind it, sparks all round, embers that cool over about a second, smoke; on top of the fireball, fragments
  and smoke the layer already drew. Shells tint it towards the gun's own impact colour.
- What hangs: one mark a blast for 84 frames (1.4 s): a cooling glow, three smoke hazes swelling and thinning,
  embers drifting out and dying each in its own time. It rides the hull it went off on.
- Way out (`out` on the detonation, whole degrees): a jet, not a ring. The flash is pushed ahead, two lances and
  lumps of fire along the heading, a tight cone of sparks, a few fragments, a small ring ahead of the hull; the
  embers and smoke are carried on down the heading. Nothing is thrown behind.
- Beam end: the same blast as going in with its own lumps of fire, each damage step feeding the spot.
- Which detonations: a shell's blast is drawn by its hit (the shot carries the explosive effect). A told detonation
  is a modifier's blast when it is a gun's kind, has no `from`, and either has `out` or is no wider than the
  modifier's widest blast (34: every burst a gun has of its own is told as 40 or more). Mortars, torpedoes, flak
  and the rest keep their own looks unless the shot carries the effect.
- Budget: a shell's blast is inside its shot's impact budget (CAP_IMPACT, thinned by quality and load). A told blast
  has 44 particles at most, thinned the same way. Blasts on one spot in one frame draw once; one on a spot still
  burning restarts it at half the particles; 32 spots hang at most (the oldest is put out). What hangs is direct
  draws, no pool particles.
- Scale: ring, flash, smoke and spark reach all follow the radius; counts follow the strength.

## Gun range rooms and admin ships (2026-11-12)

- The range is a list of rooms (systems.json `gunRange.rooms`; common `gunRange/layout.ts`). A room is data only: id,
  name, optional `light`, centre, size, wall, doors, spawn, targets. Every room's walls are in the one system's terrain;
  rooms stand 40 km apart, so nothing in one reaches another.
- Both rooms are 12000 x 6400 (twice the first range each way).
- Doors are data too: a room's `doors` list, each `{ wall, along, width, reach, to }`. `to` is `"exit"` or a room's
  id. Every room has one exit (west wall) and, in the wall across from it (east), a door to the other room. A door is
  drawn as a shut recess on the wall; the wall behind it is whole, so nothing leaves a room but by the key.
- Interact (X) within a door's `reach` goes through it: the exit back to the station, any other to the room it names.
  The pilot arrives just inside that room's door back, facing in. Away from every door X does nothing.
- The exit is green and signed EXIT; a door to a room is blue and signed with the room's name (DARK ROOM, TARGETS).
  The HUD prompt reads "Press X to leave the range" or "Press X to go through · Dark room".
- Targets room: two weak drones near the door; two mines (mob targets); three raiders in a line down-range, 600
  apart (pierce, blasts going in and out); a cluster of five drones 190 apart (chain, blast); the weak hulk and the
  Mammoth; a second weak hulk 10 km down the centre lane (velocity, falloff).
- Dark room (`light: 0.3`): dimmer floor, walls and lamps, less ambient light on the ships; one crowd of 18 small
  hulls of ten kinds in staggered rows about 160 apart, 3 km in from the door a pilot arrives by, each back 4 s
  after it goes down.
- A target is a ship (`ship` + `faction`) or a mob (`mob`, one that sits still). `ring: 0` is one of a group: no
  floor mark of its own. Only a room with a pilot in it has its targets up.
- Changing room: only through a door (no HUD switch, no message of its own). The ship flown, its weapon and its
  modifiers are kept. Entering always starts in the first room at its exit door; a respawn is at the exit door of the
  room they were in.
- Admin ships: the server's own admin rule decides (`conn.isAdmin`: real admins, and on the dev server its guests).
  An admin's range state carries `ships`: the plan library, then the dev test ships and remakes, none marked
  `retired`. Nobody else is sent the list.
- The picker shows Weapons / Ships tabs only to a pilot who was sent ships. A ship row sends `gunRangeShip { ship }`;
  the server refuses it from anyone who is not an admin. The design is flown as built (its weapon groups too) with
  the range's rules: full power, free ammunition, nothing saved. Modifier chips are put away while it is flown.
- Picking any weapon goes back to the cheat ship. The pilot's real ship and profile are never touched either way
  (server `game/gunRange/rooms.test.ts`, `isolation.test.ts`).

## Combos (2026-11-12)

The rule: every hull a shot goes through counts as a hit. A shot "shares" when its def has `pierceFracs` (Pierce or
Wave); hull `i` along it takes share `pierceFracs[i]` (the last share past the list's end). A gun without modifiers
has no `pierceFracs` and hits, tells and draws exactly as before.

Shells (server `game/Weapons.ts`, rules in common `ships/hitRules.ts`):
- Explosive: a blast where the shell goes into each hull, of that hull's share (radius unchanged), and a second blast
  of the same share where it comes out. The hull it ends in has its end blast, scaled by the share it carried there.
- Exit point: worked out once, at the hit. The shell's line is cast back at the hull from beyond its far side; the
  first part met is where it leaves. The point is fixed in space (the hull's drift is not followed) and the blast
  goes off on the tick the shell is past it. A shell that ends inside the hull never sets it off. Nothing left
  standing on the line: the exit is the entry point.
- Burn: every hull lights, the first at full heat and each later one by its share against the first's. (The dice
  roll first built here, share as chance, is gone: see "Burn: spreading fire" below.)
- Chain: arcs from every hull it goes through. One struck list for the whole shot: the owner, every hull it hit,
  every ship an arc reached. No arc goes to a ship on it.
- Split: a shell that breaks into shards (a Prism's) breaks once, at its first hull; the core carries on.
- Mobs: a sharing shell blasts in and out of a mob, arcs from it, and does not strike it twice. Mobs cannot burn.

Beams (server `ships/bridge/beamFx.ts`):
- Every hull a sharing beam burns gets its own blast, arcs and fire, by the burn that hull took (`beamEnd`'s `more`).
- Exit blast: on each hull the beam goes right through (not the last one its pierce allows), where the line, cast
  back from where it stops, leaves the hull. None if rock stops it inside.
- Burn: every hull lights, the first as hot as an unshared beam's, each later one by its share against the first's.
  (No roll any more: see "Burn: spreading fire" below. The "tick it came onto the hull" rule now decides when a held
  beam lights its deeper layers.)
- Chain: one struck list for the beam (shooter, every hull burned, every arc's target). A Tesla's own leaps skip the
  hulls it burned through too.

On the wire:
- `detonation` has an optional `out`: the shot's heading where it leaves a hull, whole degrees 0..359. Only an exit
  blast carries it.
- Told to everyone: shell exit blasts, a shell's blast into a mob, a beam's blast into each hull behind its first and
  every beam exit (`host.beamBlast`; kind is the weapon's key, radius the blast's). A shell's entry blast on a ship
  goes the confirmed-hits way (`hitEndFx` returns it for a sharing pass with a blast), derived by clients.

Prism shards: built with fxDef's `child` variant, cached per gun. They carry the gun's effects without Rapid and
Split. Split on a gun that already shatters adds shards (5 to 7 at full) and makes no volley; shards never split.

Tests: `server/src/game/modifierCombos.test.ts` (pair matrix for shells and beams, plain guns unchanged, Prism),
`common/src/ships/hitRules.combos.test.ts` (shares, the fire on every hull), `fxDef.test.ts` (child, Prism).

## Burn: spreading fire (2026-11-12)

Burn was weak and did nothing with the other effects. Now its fire spreads over the hull, and it combines.
All of it is a Burn modifier's only: a fire carries the rules as `ignite.fire` (shells) or `beamEnd.burn.fire` (beams),
set by fxDef. A fire without them (magma, Cinder Bloom, vents) burns, tells and looks exactly as before.

Base: `modifiers.burn.total` is 0.78 (was 0.6): one burn is 0.78 of the hit again over 3 s.

The spread (common `ships/fire.ts`, run by the server's burn step every 10 ticks; numbers in `modifiers.burn.fire`):
- Neighbours are the parts joined to a part (the design's joins). Gaps and destroyed parts stop it.
- Every `beat` (30 ticks) each burning part rolls once for each joined, standing, unlit neighbour. Chance:
  `min(cap 0.35, base 0.06 + per 0.05 x burning neighbours of the source) x fade 0.8^generation`.
- When a fire's time is up it rolls to burn on: `min(surviveCap 0.6, survive 0.2 x burning neighbours) x 0.8^gen`.
  No neighbour burning: no roll, it ends on time as a fire always did.
- Every spread or renewal is a generation on: heat x `keep` 0.7, time x `time` 0.7 (rounded to 10 ticks, at least 10).
- Hard caps per shot: last generation `gens` 3; nothing burns past `total` 600 ticks from the shot; at most `parts` 8
  parts lit. Worst case by the rules is x7.78 of a lone burn.
- Rolls are `hashUnit(ship, source part, target part, tick)` (survival: the part twice). No Math.random.
- A destroyed part's fire goes out and lights nothing. Damage is the igniter's. Shields and armour as any burn step.
- A new shot on a burning part starts its own fire there (generation 0, its own caps). A held beam's fire is one
  shot's until that shot's 600 ticks are up, then the next.
- Part way Burn strength scales `base`, `per` and `survive`.
- Measured (fire.test.ts, every part of each hull x 40 seeds, as a multiple of dps x time): raider x1.73, gunship
  x1.85, arrow x1.99, bulwark x2.00, drum x2.02, halberd x2.08, Mammoth x2.18, Midden x2.21. Mid-size mean x1.98,
  largest seen x5.53. A lone part is x0.94 (the 10-tick step).
- Mobs have no burn mechanic: unchanged.

With the other effects (these replace the share-as-chance dice roll of the Combos section):
- Split + Burn: every shell of the fan, and every beam of a split fan, lights what it hits, always, at its share.
- Pierce or Wave + Burn: on each hull the shot lights `layers` 3 parts: the struck one and the next along its line
  into the hull (the exit cast, parts already found left out), each deeper one x `layerKeep` 0.7. The first hull
  burns at full heat, hull i at share i / share 0. Part way Burn: `1 + round(2 x strength)` layers.
- Beams the same per pierced hull. A held beam relights the struck part each step as before; the deeper layers are
  lit once, on the tick it came onto that hull (a tick off the hull and back lights them again).
- Explosive + Burn: each standing part the blast reaches rolls to catch: `chance` 0.5 at the middle falling to 0.3
  of that at the edge, heat x `scale` 0.5, at most `max` 4 parts a blast. Roll: `hashUnit(shooter, ship, part, tick)`.
  Entry, exit and end blasts all do it, each by its share.
- Chain + Burn: each arc lights the part it strikes, at the arc's falloff share x `arc` 1. A Tesla's own leaps too.

Netcode: the server decides, and tells. Clients do not derive the spread.
- Why: a client does not know a broadcast fire's start tick, nor the burning set when it comes into range, and its
  part-death timing differs. A derived spread would drift with nothing to correct it.
- What is sent: one `ignite` per part that catches or burns on. `ignite` gained an optional `gen` (generation + 1;
  absent on every other fire, so those are byte-identical). As text 17 bytes against 16 plain.
- A shell's own fire on the struck part still goes the confirmed-hits way (derived, `gen` 1 set from the def).
  Layers, blast fires, arc fires and all beam fires are told (`host.fireLit`). Beam fires were never told before:
  a held beam's is told once every 30 ticks while it stays on.
- Rate: a mid-size hull averages about 2 extra parts lit per ignition, so about 2 to 3 ignites over the fire's life.

Look (client `ships/damage/fires.ts`, only for an ignite with `gen`):
- Flames licking off the part, a steady flickering glow under them, embers rising, thin smoke left behind the ship.
- Size by generation (1, 0.8, 0.64, 0.52). Tinted with the Burn effect's colour.
- A flare when a part catches; a part lit by spread gets a lick of flame across from the burning part nearest.
- Burned out: a dark char on the part for 7 s, a dull red heart for the first 1.5 s, a wisp of smoke now and then.
- Bounds: 120 fires and 40 chars kept; 10 parts a ship throw particles (the rest only glow); 48 particles a frame.

Tests: `common/src/ships/fire.test.ts`, `server/src/game/burnSpread.test.ts`, `server/src/game/modifierCombos.test.ts`,
`client/src/ships/damage/fires.test.ts`, `fxDef.test.ts`.
