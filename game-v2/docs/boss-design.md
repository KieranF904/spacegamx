# Making a boss

Instructions for agents (and people) building a new staged boss, written from building the Pyreclast and the Scrap
Mother. Follow it top to bottom: design the look first, show it, then the fight, then tune by measuring. When a boss
teaches you something new, add it here.

Reference implementations:

| | Pyreclast | Scrap Mother |
|---|---|---|
| Hull generator | `scripts/bespoke/pyreclast.mjs` + `pyreclast_heart.mjs` | `scripts/bespoke/scrap_mother.mjs` |
| Brain | `server/src/game/brains/pyreclast.ts` | `server/src/game/brains/scrapMother.ts` |
| Tests | `server/src/game/pyreclast.test.ts` | `server/src/game/scrapMother.test.ts` |
| Data | `data/bosses.json`, `data/ships/materials.json` | same |

## 1. Design goals (what every boss must be)

- **Three stages, each its own fight.** Not "the same boss with less health". Each stage has its own loop of moves,
  its own movement habit (range, speed), and a different pattern to learn. The last stage is the hardest.
- **Readable.** Every attack that hurts is warned first (`bossTelegraph`), and the warning shows exactly where and when.
  Fast moves warn ~0.8–1.2 s, big ones 1.5–2 s, shortened per stage and when enraged, never below what a human can
  react to.
- **A fixed loop, not random picks.** Moves come in a set order per stage (`LOOP`), skipping any whose part is gone.
  Players learn the order. Random only within a move (which side it dashes), never which move comes next.
  The one exception is a conditional punish (the Pyreclast's charge only if you keep away, now and then).
- **Windows.** Each stage gives the player openings to deal damage: a move's recovery (an overshooting dash, a stun
  after a missed ram, a vent window where it takes more damage). Make them visible.
- **Parts matter.** Shooting a weapon part off (stage 1) or wrecking it (stage 2) stops that move. That's how a player
  makes a stage easier for themselves.
- **Movement punished in every stage, standing still punished more.** Verify by measurement (section 6), not by feel.
- **Neutral lore.** A boss's name, intro and phase lines must follow `docs/lore-canon.md`: every lore claim has an owner
  in-game, narration never states contested lore as fact. Read the canon entry for the boss before writing any text.

## 2. The stage machinery (already built: use it)

All in `common/src/ships/stages.ts`, `ShipBridge`, `ShipRenderer` and the brain kit. Data on each bespoke piece:

- `stage: 1 | 2 | 3`: which stage it belongs to. Every piece of a staged boss has one.
- `ruin: true`: worn out, it isn't lost; it stays on as a wreck (RUIN_HP left), shots pass it by, until the brain blows
  the stage away. Use it for stage 2's body and for stage 3's "round" (what the boss is beaten by).
- **Deciding pieces**: a stage with `ruin` pieces is beaten by those alone (the rest of it can be shot off but needn't
  be); a stage without any is beaten by all of it. Skeletons never decide.
- `skeleton: {...}`: look-only frame under stage 1's plating, drawn as lit geometry (`client/src/ships/skeletonBuild.ts`),
  revealed piece by piece as the plating over it goes; shots pass through it. Give it its own `palette`.
- `under: true`: drawn beneath everything (stage 3's heart), hidden until what covers it is gone.
- `Blueprint.rigid: true`: the boss flies as built throughout (fixed mass, centre of mass, thrust); its hull is built
  once and parts are hidden in the shader, so breaking pieces costs nothing.

Behaviour the server gives you for free:

- A hit on a later stage's part goes to the **nearest standing deciding part of the current stage**
  (`ShipBridge.cover`), at a reduced share: `bosses.json` `rules.stageCover` (0.4), or the boss's own
  `stageCover`. So the stage being fought is what to aim at, but a shot elsewhere still counts. Wrecks pass
  hits to the nearest piece still whole, in full.
- `stagedIntegrity`: each stage is an equal share of the health bar; phases in `bosses.json` key off it
  (thresholds at 0.667 and 0.334 are the stage boundaries).
- Brain hooks (`server/src/game/brains/kit.ts` `BossBrain`): `orders`, `integrity`, `invulnerable` (between stages),
  `taken` (damage multiplier: braced / laid open), `forceShed` (dev tool steps), `dispose`.
- `ships.shed(eid, groups, fling, crumble)`: blow parts off; `crumble` makes the debris break up within that many ticks,
  so no cover or damage-soaking junk lies around the arena. Always crumble mid-fight debris.

The stage transition pattern (copy from the Pyreclast brain): when `currentStage` moves on, the brain `stop()`s
everything (moves, swelling shots, drones, vent windows), becomes invulnerable, holds still, and runs a queue of timed
blows (`blows: {at, run}[]`) that blow the beaten stage away piece by piece, outermost first, core last. The final stage
ends with a shudder, then every piece blown apart at once (`burst`); the core going is what kills it.

## 3. Designing the look

Write a generator script `scripts/bespoke/<boss>.mjs` that writes `data/ships/bespoke/<boss>.json` (pieces) and
`data/ships/blueprints/enemy/<boss>.json` (design). Copy the helpers from `scrap_mother.mjs`: `part`, `pair` (left half
mirrored), `bar`, `band` (arc bands for radial rings), `ringPts`, `gear`, `rivets`, `stripes`, `dent`, `turret`, and
`unionOutline` (for the skeleton's outline and rim).

Concept first, in one paragraph per stage: what the boss *is* (a living thing? a machine? what does it eat?), what each
stage reveals, its silhouette, and its palette. Then:

- **Silhouette.** It must read at a glance from far away. Stage 1 sets the big shape (wings, arms, booms); stage 2 is a
  smaller, denser body; stage 3 is compact. Avoid plain rectangles: taper, offset, add protrusions.
- **Palette.** Every boss gets its own materials in `data/ships/materials.json` (`exclusive: "boss"`) and their looks in
  `client/src/ships/hullLook.ts` `HULL_MAT` (`any: true`, `emit` = its glow colour, `hot` = extra glow on powered parts).
  Pick a glow colour no other boss uses. Keep big plates mid-dark: a bright large flat plate reads as a white box
  (the Scrap Mother's first steel did). Mismatched materials panel to panel read as "salvage"; uniform reads as "built".
- **Detail is look only** (`PieceDetail`): `raise`, `recess`, `vent`, `channel` (glowing groove), `shard` (crystal),
  `ring`, `glow`, `halo`, `vein`, `bell`/`nozzle` (drives), `cable`, `beam`. Most take `color`. Use them generously:
  rivet lines along seams, hazard stripes on what moves, dents, glowing channels where power runs.
- **Weapons look like the boss.** Its projectiles' styles (`client/src/rendering/weapons/weaponStyles.ts`, new
  `WeaponType`s) and its telegraph colours (`client/src/ships/BossFx.ts`) match its palette, and stay brighter than
  the ground they're fought over.
- **Connectivity.** Bespoke parts join what they touch or overlap. Every part must reach the core through touching
  parts, **including after earlier stages are gone**: stage 3's pieces must hold to each other, not only to the stage
  2 body over them (the Scrap Mother's iris petals fell off as debris when the body blew; fixed by overlapping each
  ring course with the one inside it). Check with the connectivity test in section 7 for the full design and with each
  earlier stage removed.
- **Order.** Stage 3 parts first in the design (drawn under), then the rest. Exactly one `core`.
- **Size.** The Pyreclast is radius ~1135 world units, the Scrap Mother ~1365. Heavier hulls need lighter materials
  (`density`) or more drive: `bosses.test.ts` requires a boss with a `speed` to have at least 40% of a starter ship's
  acceleration.

Show the user before building the fight: render each stage in the real client (section 7) and send the panel.

## 4. Designing the fight

**Start from `StagedBrain`** (`server/src/game/brains/staged.ts`; the Scrap Mother extends it). It already does the
loop, flying, holding home, the stage transitions and blow-offs, the death burst, `forceShed`, and helpers (`hold`,
`dart`, `land`, `beam`, `scorch`, `pull`, `aimAt`, `clockwise`, `outermostFirst`, `working`, `named`). A new boss gives
it its tables (`loop`, `range`, `circle`, `rest`, `haste`, `drive`, `assist`, `homeR`) and writes `make(id)` and its
moves; optionally `passives`, `interrupt` (a conditional punish), `around` (wraps each move: stage three's darts),
`onStop`, `taken`. (The Pyreclast predates it and has its own copy of the same machinery.)

Per stage, a loop of 3–5 moves (`loop`), each a generator (`private *move(): Move`) that sets `this.want` each tick and
`yield`s. Flying is `fly()`: `want.move` (a direction or `'hold'`), `want.face`, `want.assist` (turn help for a heavy
hull), `want.impulse` (dashes, charges). Per-stage tables at the top of the brain: `RANGE`, `REST`, `HASTE`, `DRIVE`
(extra push for lighter stages), so stages differ in movement as well as attacks.

Move ideas that worked (Scrap Mother): magnets that drag you in followed by claws snapping shut ahead (counter: thrust away); an intake that sucks you towards grinding rotors; sludge that lands then pools and burns; scissoring welder beams that cross ahead; a brace (40% damage) broken only by an iris window (150%), and shooting off the parts that power the brace. Pyreclast: turret barrages in a fixed clockwise order; a broadside with red lanes; mortar walls that form a
lane the way you're flying with a cap ahead (brake or reverse out); dash chains whose last dash overshoots; a lance that
draws its line first, then sweeps; marks that land where you'd be flying straight on (turning dodges them); rings of
big slow orbs with gaps (your position always solid); spirals with aimed fans; homing seekers; a vent window where it
takes 150% and the rest of the time 40%.

Pulls (`pull`) push pilots' velocity each tick; keep them beatable by thrusting away (~0.5–0.6 world units a tick at the middle, none at the edge), and scale them by the parts powering them.

Bullet-hell shots: **few and big** (radius around the core's size), not many small ones: the same pressure, far fewer
entities, and they read better. Big shots hit as wide as they're drawn (`hitProjectile` radius).

Damage by source: tune each move's bite separately (`*_BITE` constants and weapon `damage` in
`data/ships/tuning.json`). Splash and burning (ignite) can dominate silently: measure them.

Boss arenas with rock that never changes: set `surface.fixedWalls: true` in `data/systems.json` so straight shots work
out their wall hit once. Never set it where walls move.

## 5. Tests to write

`server/src/game/<boss>.test.ts`, using the `world()` and `advance(server, eid, stage, step)` helpers (copy from
`pyreclast.test.ts`). At minimum:

- every piece has a stage; ruin/under flags are where intended; it flies as built (com, mass, thrust unchanged after
  all stages are shed);
- each stage's moves appear in their loop order, each warned before it lands;
- redirect: a hit on a later stage goes to the current one; wrecks pass hits on;
- each stage ends: invulnerable, blows away piece by piece, the next can be hurt;
- death: last deciding piece wrecked, shudder, every piece thrown off at once, `bossDefeated` sent;
- any special rule (charge only when kept away, vents change damage taken, parts disabling moves).

Run root tests with `npx vitest run --pool=forks --no-file-parallelism` and client tests the same way from `client/`.
Run `npm run build:common` after changing `common/`.

## 6. Tune by measuring

Write a throwaway audit test (in a temporary folder you delete afterwards) that, per stage, runs a minute of fight
against a pilot standing still and one circling, with a very tough pilot (scaleHp × 40, never mended), and attributes
damage to its source: the current move, each projectile kind (`hitProjectile`), `splash` (`splashAt`), `burn`
(`stepBurns`), `contact` (`resolveContacts`, labelled by what hit). Targets:

- for a moving pilot, damage per minute rises stage by stage;
- standing still is punished in every stage;
- no single passive source (resting turret volleys, burning, debris collisions) dominates a stage.

The Scrap Mother's measured targets after tuning (tough bot, damage per minute, moving): about 1.1k, 1.7k, 2.8k by stage; stage health about 61k / 40k / 16k (the last braced most of the time), aiming at ~2–2.5 minutes a stage for a level-8 ship (corsair ~670 DPS on paper, lancer ~840). Mobs slower than a moving pilot do nothing to one.

The Pyreclast's first pass had it backwards (stage 1 deadliest, stage 3 softest), and a third of stage 3's damage was
pilots colliding with lingering debris. Only measuring showed it.

## 7. Workflow and tools

1. **Generate**: `node scripts/bespoke/<boss>.mjs [preview.svg]` (the SVG is a quick outline check by stage).
2. **Connectivity check**: a throwaway test that loads the ship config, builds the design with `createShipState`, runs
   `rebuildShip` and prints `derived.orphanGroups` (must be empty), radius and mass.
3. **Wire up**: `data/bosses.json` (`design`, `asDesigned: true`, `brain`, `rigid` comes from the design), register the
   brain in `server/src/game/Bosses.ts` `BRAINS` and `server/src/game/brains/ids.ts`.
4. **Render the design**: stills of the design itself (no fight, no server) go through the **native renderer**
   (DEVELOPMENT.md "Asset viewer and renders"): a warm service, no browser, 15 to 30 ms a render. Run
   `npm run render -- boss:<name> --light dark --heat 0.8 --damage 0.4 --out shot.png` (a sheet of every stage, light
   preset, flames and transparent export work the same), or browse it at `http://127.0.0.1:5311/` once the service is up
   (`npm run render -- --list <name>`). It draws with the game's own hull shader, lighting, flames, bloom and sky. The
   browser viewer (`http://localhost:5273/viewer.html?asset=boss:<name>`) is still there for the live look, and
   `npm run render -- --browser …` is the heavy headless-Chrome path: only for checking the native one against the real
   client. For stages and moves in a live fight, **render in the real client** (the only job left for a browser):
   `scripts/boss-shots/shoot.mjs` drives headless Chrome over CDP
   (`node scripts/boss-shots/shoot.mjs http://localhost:5273/ <outPrefix> @steps.json`, `GPU=1` for the real GPU).
   `scripts/boss-shots/scrap_mother_stages.json` is a working example: it logs in as a guest, turns on god mode,
   teleports to the lair, pins the boss in front of the camera with everything else hidden, then for each stage sends
   `devBoss shed n` and screenshots. Compose panels with PIL. Needs the game server (3000) and Vite (5273) running:
   check the ports first, reuse what's running, kill only what you start, by PID.
   A killed boss respawns on a timer; restart your game server to get a fresh one.
5. **Dev tool**: the brain's `forceShed(n)` steps through the looks (shot off, wrecked, blown away) so every stage can
   be seen without fighting; keep it working as the brain grows.
6. **Ship it**: deploy with `bash deploy/vps/deploy.sh` (production turns dev tools off).

## 8. Performance

Measured on the Pyreclast and the Scrap Mother: server ticks average 0.25–0.4 ms per boss fight (worst ~5 ms) of a
16.7 ms budget; the client holds its frame rate through stage three's bullet hell. What to check for a new boss:

- **Server**: a throwaway probe that times `server.step()` per stage and wraps subsystems (`brain.orders`,
  `ships.tick`, `weapons.tick`, `collisionSystem`, `sendSnapshots`) for average and worst. Define any bitecs query
  once at module level: calling `defineQuery` in a loop registers a new query each call and makes every later
  `addComponent` slower (it fooled our first probe into "finding" 20 ms spikes).
- **CPU profiles in tests**: vitest's forked workers don't write `--cpu-prof` files; profile from inside the test
  with `node:inspector` (`Profiler.start` / `Profiler.stop`).
- **Client**: `scripts/boss-shots/shoot.mjs` can record frame times (a `requestAnimationFrame` loop in an `eval` step)
  and take a CPU profile (`{ cdp: { method: 'Profiler.stop', save } }`).
- **Whole-hull builds run in a worker** (`client/src/ships/hullWorker.ts`): a rigid design's hull and skeleton are
  asked for as soon as its body arrives (on screen or not), and drawn once they come back (~230-270 ms of work, off the
  main thread; the main thread builds it itself only if the worker can't start). Chunks merge hulls by block copies of
  packed typed arrays (~7 ms for a boss, ShipBatch `mergeInto`). Keep stage 3 pieces reasonable in count all the same:
  a much bigger hull takes longer to appear.
- **Dev step numbers**: `forceShed(n)` that lands exactly on a stage's last step lets the brain blow that stage away
  (or kill it) on the next tick; to film a stage's wrecked look, stop one step short.

## 9. Pitfalls we hit

- A detail or polygon edge that only *nearly* touches its neighbour doesn't join: overlap a little.
- Shell heredocs eat quotes and escapes: write scripts and test text with the editor, then apply them.
- Body-riding telegraphs (`bodyId` set) must be drawn at the rotated offset, not the raw one.
- Telegraph and projectile colours that match the arena floor disappear: test against the real background.
- Moving a ship between render chunks must copy its damage row to wherever it actually landed (fixed in `ShipBatch`).
- The old boss stays reachable: when replacing a boss's design, keep its old blueprint file until the new one ships.
