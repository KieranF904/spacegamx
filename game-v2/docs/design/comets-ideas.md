# Comets: content ideas (proposal, 2026-11-04)

Proposal only. Nothing here is built. Written for Kieran to pick from.

## 1. Comets today

There are three separate things called "comet", and they don't know about each other.

1. **Comet Halvorsen** (data/systems.json, Sol `comets[]`, `CometData` in common/src/data/schemas.ts) is the only
   comet you can see. It is scenery. It follows a Kepler orbit (`cometPosition` in common/src/world/planets.ts,
   deterministic since the 2026-11-04 maths pass): a = 52,000, e = 0.517, 45-minute period. That puts perihelion at about
   25,100 (the star's radius is 21,000; the Helios Array's rail is at 26,000, so it dips just inside the Array) and
   aphelion at about 78,900. It moves at roughly 70 u/s far out and 215 u/s at perihelion, and spends about 7 minutes of
   each orbit within 35,000 of the star. The client draws a nucleus, a coma and ion and dust tails that grow as it nears
   the star (client/src/rendering/Scenery.ts `CometView`). It has a map marker and a hover chart line (SystemMapUI), a
   nav marker (NavMarkersUI), and a warp target on the map. It has no collision and no server entity, gives nothing, and
   affects nothing.
2. **Comet rocks** (data/mining.json `types.comet`: hardness 1, 80 ice / 15 helium-3, `traceBoost` pale iridium) are
   ordinary belt asteroids that appear in several fields (Borealis shoal 10%, and others). There is also a legacy
   `comet` entry in common/src/data/definitions/AsteroidDefinition.ts with drift and visual type `comet`.
3. **"The comet is passing"** (mining.json `comet`: every 3 days for 2 hours in Sol and Borealis;
   `GameServer.cometNow`/`watchComet`) is a wall-clock timer. While it runs, comet rocks in those systems mine at trace
   tier 4 (rich pale iridium), and every pilot gets a toast at the start and the end. It is unrelated to where
   Halvorsen actually is, and Borealis has no visible comet.

Loose ends worth knowing: **Helium-3** has no recipe that uses it. It turns up in one quest step and one station
price, and the items.json description says it is "skimmed from comet tails and gas giants", but nothing skims comet
tails. The game plan already promises "rare volatiles in comet tails" (game-plan.md, item 20). No codex record, person
or quest mentions Halvorsen.

## 2. Ideas

They share these assumptions:

- **The orbit is the schedule.** A comet's whole story is a pure function of `(comet data, tick)`. Its passage number
  is `floor((tick / periodTicks) + phase / 2π)`. Anything seeded by `(comet id, passage number)` (fragments, vents,
  what the thaw exposes) is known to every client without a message. The server only decides who took what, and
  spawns enemies.
- **Open to whoever is there.** Everything happens in the public system. Nothing is a one-off: each comet repeats every
  orbit, forever.
- **Groups get it easier.** Group size never thins what each pilot gets. Rewards are rates per pilot (as with traces);
  a wing adds its usual `wingBonus`; group-only gates are avoided.
- **Chart lines stay plain.** For example: "Comet Halvorsen. Long elliptical orbit, 45 minutes. Near the sun its tail
  carries helium-3 and ice; fragments break off." Mood and lore go to people and records, each with an owner.

### 2.1 Tail skimming (the volatile harvest)

**Fantasy:** dive into a comet's glowing tail as it rounds the sun and come out with a hold full of helium-3.

**Minute to minute:** The map shows Halvorsen inbound with "perihelion in 6:40". You warp to a point ahead of it,
turn, and match its speed as the tail sweeps over you. Inside the ion tail (a cone behind the nucleus, away from the
star, the same shape the client already draws), a collector part, or any ship more slowly, gathers volatiles at a
rate. The rate is highest deep in the tail and close to perihelion. The tail moves at up to 215 u/s and swings round
the star, so staying in it is a flying skill: you fly a curve, not a holding pattern. Near perihelion you are 4,000
from the star's surface, so star heat and the thermal hazard push back on long, greedy dives.

**Rewards / who:** Helium-3 and ice, plus a small pale-iridium trace accrual (reusing the trace ledger, so it is a
rate, not a roll). Best for new to mid pilots in Sol. It gives Helium-3 a job, which should come with a sink (see 2.9).

**Frequency / discovery:** Every 45 minutes, for about 7 minutes of good skimming. The system map shows the next
perihelion countdown, and the comet's chart line says what the tail holds. A Miners' Guild person gives the first
"go skim the tail" job.

**Solo / group:** Fully solo. In a wing, each pilot skims at their own rate plus the wing bonus. Nothing is shared or
split, and there is no cap per comet.

**Reuses:** `cometPosition`, the tail geometry in Scenery (moved to common so the server and client agree), gathering
via collector or mining tools, `pilots.give`, the trace ledger, star heat and the near-star hazard. **New:** a
`tailAt(comet, tick, x, y)` test in common, and a per-pilot skim accumulator on the server, ticked once a second as
Hazards is.

**Netcode:** Very cheap. The tail is a function of the tick, so the client can show its own skim meter predicted, and
the server corrects only the total (once a second, on the pilot row or a small message).

**Size:** S.

**Risks:** Could become AFK-able if the tail is wide and slow. Weight the rate toward the inner tail near perihelion,
where it moves fastest. The tail is drawn with shaders, so the readable edge must match the server's cone; hand the
cone to the shader rather than eyeballing it.

### 2.2 Calving (fragments on a known path)

**Fantasy:** the comet sheds chunks of bright ice as it heats up. Crack them before they boil away.

**Minute to minute:** On the way in, past a set distance from the star, the nucleus drops a fragment every N seconds.
Each fragment is a real minable rock (comet type, `traceBoost`, rich trace tier). It leaves with a small seeded kick
and then drifts on the comet's orbit, falling behind. Each fragment shrinks with time ("sublimating") and is gone a
few minutes after perihelion. Pilots strung along the orbit chase the fresh ones near the nucleus (rich, fast-moving)
or pick off the older ones trailing behind (slower, half gone). You can see the whole spray on the map as a dotted arc.

**Rewards / who:** Ice, Helium-3 and rich pale iridium. This **replaces the 3-day wall-clock timer**: the "comet
passing" bonus becomes a physical event that happens where the comet actually is. Good for every level, because the
trace rate scales with tool tier.

**Frequency / discovery:** Every orbit. The nav marker shows "calving" while it lasts. The old global toast could be
kept as a once-a-day notice for the biggest passage (2.8).

**Solo / group:** Open to all. Each fragment's ore goes to whoever mines it, as with any rock. To avoid
first-come-takes-all, make fragments plentiful and give each one enough ore for several pilots. Mining stays per-hit,
so a group strips one rock faster but each pilot keeps what they cut.

**Reuses:** Asteroid mining end to end, `traceBoost`/trace tiers, the `MiningHost.traceTier` hook (it gets a
"fragment" check instead of `cometNow`), `AsteroidOrbits`' seeded rock params. **New:** a "fragment" rock lifetime:
spawned and expired by `(comet, passage, index)`, with a shrink curve. A server system spawns fragments on a schedule
that the client also knows.

**Netcode:** Good. Fragment positions come from `(comet orbit, passage, index)` plus a seeded kick (closed-form
drift, like the asteroid timetable), so clients spawn and fly them with no messages. Only mining damage, which
already exists, goes over the wire.

**Size:** M. The asteroid timetable assumes rocks live forever; adding a lifetime is the real work.

**Risks:** Asteroid systems are hot paths (collision grid, orbit timetable). Fragments must go through the same
seeded path, not a special case. Rocks that despawn mid-mine need clean handling (a beam on a vanished rock).

### 2.3 The nucleus run (an icy interior you fly into)

**Fantasy:** the comet's crust cracks open near the sun, and you fly into the ice tunnels before it seals again.

**Minute to minute:** Around perihelion the nucleus shows open vents (a moving pocket entrance). X near a vent takes
you into a pocket built from terrain: an icy cavern in the style of the Ashfall cavern (data/terrain plus a generator
script). Inside:

- tunnels of solid ice;
- geysers that fire on a timetable seeded by passage and push ships, which can be telegraphed exactly;
- cold, using the warmth meter (a cryo rating inside the pocket), so you can't loiter;
- ice seams to mine;
- at the bottom, a chamber with the run's prize (2.4).

The vents close a set time after perihelion. Anyone still inside is pushed out with the outgassing at the nearest
vent, which is a dramatic exit rather than a death.

**Rewards / who:** Mid to late. Rich comet seams (high trace tier), Helium-3, and whatever the thaw has exposed. The
cold and the geysers ask for an insulated, nimble build, which gives build choices a job.

**Frequency / discovery:** Every orbit, with the vents open for about 10 minutes. The map shows "vents open in 3:10".
The tunnel layout is fixed per comet, so it can be learned. The geysers' timing and which side passages are open
change with the passage seed.

**Solo / group:** A public pocket, shared by whoever enters. Geysers and cold are per ship, so groups don't make it
harder; a wing helps by mining and scouting in parallel.

**Reuses:** Pockets (`pocketAt`, `pocketExit`), terrain (`collideTerrain`, `rayTerrain`, generator scripts), warmth,
mining, and the way pockets already empty and come back. **New:** a moving pocket entrance (its position from
`cometPosition` instead of fixed x, y, plus an open window), a closing rule that pushes pilots out, a geyser kind
(force fields on a timetable, deterministic in the shared flight step), and the cavern art.

**Netcode:** Good. The terrain is static data, geysers are a timetable, and the entrance is a function of the tick.
The geyser impulse has to live in the shared flight step so prediction agrees. That is the one careful bit.

**Size:** L (pocket plus terrain plus geysers plus art).

**Risks:** Build size. Forces in the flight step touch the netcode's most sensitive code, so they need golden traces.
The moving entrance means every client's prompt and route code must use the moving position; pockets are fixed
today.

### 2.4 What the thaw gives up (a frozen wreck each passage)

**Fantasy:** every pass, the sun melts away a little more ice and exposes something that has been frozen in it for
centuries.

**Minute to minute:** On each inbound passage, one seeded find from a pool comes out on the nucleus surface, or at the
bottom of the run (2.3) if that is built. Possible finds:

- a frozen wreck to salvage (derelict machinery, with salvage pay and a tow);
- a sealed cache (a `recover` field task);
- a pocket of rare ice.

Some wrecks carry a log that files a record (wreck logs already do this). Which find comes up is
`pool[hash(comet, passage) % n]`, so a pilot who checks the almanac knows which passage brings the wreck they want.

**Rewards / who:** Salvage credits and XP, a chance at parts, and records. Records drive a collection goal: "you have
read 3 of the 7 logs frozen in Halvorsen". Mid level.

**Frequency / discovery:** One per orbit. The chart line for the comet names the current find in plain terms: "Exposed
this pass: a frozen hauler (salvage)".

**Solo / group:** Shared like derelicts today: whoever lands the last shot on the core gets the salvage. That race is
the weak spot. Better: everyone who scans or tows it within the window is paid, as event participation already pays
everyone who helped.

**Reuses:** Derelicts (`spawnWreck`, logs, `towDelivered`), operations' `recover`/`scan`, codex records. **New:** a
wreck pinned to a moving body, and the pool.

**Netcode:** Fine. A derelict is an ordinary ship entity. Pinning it to the comet means a pinned ship whose anchor
moves (`ShipBridge.pin` with a moving anchor), or putting it inside the pocket where nothing moves.

**Size:** S if it lives inside 2.3; M on its own (moving pin).

**Risks / lore:** Each log needs an owner and a plain reading. For example, a Guild survey tag: "the Guild says it is
an old prospector who rode the comet and froze". Nothing may say the comet carries anything on purpose. The
Lighter Halvard pattern (an early lander with a log) fits well.

### 2.5 Riders (a nest on the ice)

**Fantasy:** something has built a nest on the comet, and every time it nears the sun, the warmth wakes them up.

**Minute to minute:** A nest rides the nucleus. In Borealis it would be the Frost Brood, who already scatter at signal
peaks; in Sol, a small Scrapborn nest drawn to the comet's greyseam. Far out, the nest is quiet. Inbound, it launches
packs as the comet warms, and they defend the skimmers' best spots (2.1) and the fragments (2.2). Kill the nest's
packs and you are paid, as with a warband. If the nest is broken, that passage's skimming is safe. It rebuilds by the
next orbit.

**Rewards / who:** Mid level: bounty pay, Brood rime or Scrapborn salvage. It adds danger to skimming and calving, so
the safe-or-rich trade has a cost.

**Frequency / discovery:** Every orbit, from the warm-up onwards. A nav marker shows "hostiles on the comet".

**Solo / group:** Packs are sized to the pilots taking part (as Events do), so a group gets a fair fight and pay per
head isn't cut.

**Reuses:** Nests and packs (`NestData` with an orbit, `nestPosition`), Events (warband-style pay to everyone who
fought), Roaming, and system memory for the nest's clock. **New:** a nest whose orbit is a comet's Kepler orbit (a
nest orbit kind), and a "launches by heat" trigger.

**Netcode:** The nest's position is pure. Packs are ordinary enemies (the pilot-body AI). No new wire.

**Size:** S–M.

**Risks:** Danger 1 Sol must stay gentle, so make Sol's riders small. It is a good fit for a second comet in Borealis
(2.8), which would also make the existing "Sol and Borealis" timer honest.

### 2.6 Comet runs (a course in the tail)

**Fantasy:** race the comet round the sun, threading the gates the Patrol's pilots set in its tail.

**Minute to minute:** A `course` field task whose rings are placed relative to the comet: offsets from the nucleus in
the comet's frame, so the whole course sweeps round the star with it. You start at the coma as it crosses a line (a
fixed perihelion "start gate"), then thread rings down the tail and back to the nucleus. The comet's speed changes
along its orbit, so the course plays differently on the way in and the way out. Time trial, per pilot.

**Rewards / who:** Everyone. Credits and XP per finish, a ribbon for times, and a per-week ranking (Achievements
already ranks). It is a pure flying test, and a good place to try a new ship.

**Frequency / discovery:** Every perihelion. Taken from a person at Sol Central ("the tail run") or a board.

**Solo / group:** Solo runs side by side, each with their own timer. A party variant could score the party's best
three, so more pilots can only help.

**Reuses:** Operations `course` (rings, the clock, back to the start), rankings and ribbons. **New:** rings expressed
in the comet's frame (one transform), and a start window.

**Netcode:** Rings are a function of the tick, so the client knows exactly where they are. Only ring passes are judged
on the server, as today.

**Size:** S.

**Risks:** Speed-matching a 215 u/s comet may favour fast ships too much. Tune the course to the slow arc, or set
target times per hull class.

### 2.7 A moving jump field (the comet as a conveyor)

**Fantasy:** catch the comet out in the dark and let it fling you across the system.

**Minute to minute:** The coma works as a small, weak stillstone field. Inside it, the jump drive charges faster and
reaches further (`fieldCharge`, `fieldRangeBoost`), and the boost grows with the comet's speed. Clever pilots learn
the comet's timetable as a shortcut. Meet it at aphelion near the Reaches, ride the coma in, and jump from perihelion
with a boost to the inner stations. It is pure navigation knowledge, with no item reward.

**Rewards / who:** Time saved. Mostly for mid and late pilots who run routes. It also ties comets into the jump-drive
mechanics, which already treat orbiting stillstones as part of the shared flight maths.

**Frequency / discovery:** Always on. The chart line says "Its coma charges jump drives, as a stillstone does". The
route planner (routePlan.ts) could learn to use it later.

**Solo / group:** Neutral.

**Reuses:** jumpFields.ts (stillstones already orbit, and replicas and prediction fly by them deterministically), and
`cometPosition`, which is already deterministic. **New:** a comet entry in the field environment, with a radius tied
to the coma.

**Netcode:** Excellent. It is the same path stillstones take today, so prediction stays exact. Every client already
knows where the comet is.

**Size:** S.

**Risks / lore:** Stillstones are a careful lore item ("jump drives work better near them; nobody knows why").
Comets doing the same thing could read as a connection. Give it an ordinary, attributed reading: a Guild pilot says
"it's the ice charging the lattice, same as any cold cloud". Do not make it a stillstone mechanic in the text. Field
stacking with real stillstones also needs a rule.

### 2.8 The almanac (more comets, a calendar, and prediction)

**Fantasy:** know the sky. Be where the big one comes in before anyone else turns up.

**Minute to minute:** Add comets to other systems with different periods: a short 20-minute sungrazer in Cinder
Reach, a Borealis comet on a 3-hour orbit (riders, 2.5), and a long 1-day "great comet" whose perihelion is a big
open event across a system. A station's "almanac" panel, or the map, lists upcoming perihelia across the cluster:
"Halvorsen 12 min, Sol; Ostrander 2 h 40, Borealis; the great comet Thursday 19:00, Glasswater". Quinn's observatory
offers a recurring scan job: be at a predicted point and hold a reading as the comet passes (the `hold`/`scan`
operations). Getting there on time is the challenge.

**Rewards / who:** The almanac is the glue that makes 2.1–2.6 findable and plannable. The scan jobs pay observatory
standing. The great comet is the scheduled "everyone shows up" moment, without being a one-off script: it repeats on
its orbit.

**Frequency / discovery:** By definition. Every comet's next perihelion is computable on the client (`cometPosition`
plus the period), so the almanac costs no server work.

**Solo / group:** Neutral. The great comet makes lots of people gather in one place, so it must stay public and pay
per head.

**Reuses:** systems.json `comets[]` (data only), SystemMapUI's comet drawing, Quests/Operations `scan`/`hold`, the
observatory people. **New:** the almanac UI, and a long-period comet. Its orbit is huge, so it is out of view most of
the time, which may need a "far" draw.

**Netcode:** Zero. It is all derived from data and the tick.

**Size:** S for data plus the almanac, M with jobs.

**Risks:** A 1-day orbit at a big a, with high e, puts the comet far outside the system. Check the Kepler solve (12
Newton steps) at e near 0.95 and keep it deterministic. Lore: Quinn owns "they're just ice"; keep any omen talk in
superstitious mouths (Sander's ice crews). Do not tie the great comet to the heartbeat.

### 2.9 Fresh volatiles (trade, with Helium-3 given a job)

**Fantasy:** a perishable haul. Get the comet ice to market before it boils off.

**Minute to minute:** Comet ice and tail Helium-3 come aboard "fresh": they lose a share each minute while you are
warm, and keep in cold systems or in insulated holds. Stations that want them (refinery hubs, the Ark Hall? the Helios
Seat's reactors) pay a premium for fresh volatiles, shown live on the market board. The run is: skim at perihelion,
then race inward to the buyer, or carry out to Borealis where the cold preserves it, for a longer but surer sale.
Separately, give Helium-3 sinks:

- a refinery recipe for a fusion or boost cell (a consumable that tops up the battery or speeds a jump-drive
  cooldown);
- an input to higher-tier reactor parts, in step with the energy direction (ports core, pulsed lasers).

**Rewards / who:** Credits for traders, and a reason for haulers to exist near comets. It is new and mid level
content.

**Frequency / discovery:** Tied to 2.1 and 2.2. Markets advertise "buying fresh comet ice" around perihelion.

**Solo / group:** Neutral. A hauler in the wing could carry everyone's haul, which is a nice role.

**Reuses:** Market demand shifts (market.ts), insulation (materials.json, for cold), recipes and items. **New:** a
perishable stack rule. This is the expensive bit: stacks are plain `{id, n}` today, so decay needs a timestamp or a
per-pilot "fresh" ledger like traces.

**Netcode:** Server-side economy only. No flight impact.

**Size:** M (perishability), S for just the Helium-3 sinks.

**Risks:** Perishables touch inventory conservation rules ("items conserve"). A ledger (fresh units owed, decaying)
is safer than mutating stacks. Keep it out of the energy and thermal coupling that energy-system.md defers.

### 2.10 Riding a comet to a hidden sector (Kieran's idea)

**Fantasy:** grab hold of a comet as it whips round the sun and let it carry you out past the edge of the charts, to a
place no jump drive can reach.

**The comet:** This needs a new comet, not Halvorsen. Halvorsen's aphelion (78,900) is well inside Sol. Call the new
one "the Long Comet" until it has a name. It sits on a high-eccentricity orbit (say e ≈ 0.9) with a period of about
3–4 hours, so its aphelion is far beyond Sol's charted edge (beyond 250,000). Because the orbit is so eccentric, it
spends only about 15 minutes in the inner system and the rest of the time far out. It is drawn at its real position
like Halvorsen; out past the map edge it shows as an arrow with a distance.

**How you ride it (latching):**

- **Boarding.** The ride starts in the comet's lee: a box behind the nucleus, in the comet's own frame, sheltered by
  the coma. On the outbound leg, from perihelion until a set "last boarding" point, a pilot who flies into the lee
  and matches its speed for about 3 seconds gets the prompt "Hold to latch on". Once latched, the ship is carried.
- **While latched,** its position is the comet's position plus an offset in the comet's frame. The pilot steers that
  offset around inside the lee box at reduced thrust, and does not fly freely. It is a kinematic mode in the shared
  flight step: a carried ship needs no physics, and a replica needs only a flag and an offset. That is cheaper on the
  wire than a free ship.
- **Jumping** while latched lets go. The jump drive can't be used to ride.

**The ride (about 8–12 minutes, perihelion to the "shelf"):**

- **Heat first.** Boarding is near the star, so the near-star thermal hazard and star heat apply.
- **Jets.** As the nucleus warms, jets fire from its surface on a timetable seeded by passage number. Each is
  telegraphed (a vent glows, then fires) and sweeps part of the lee box. If a jet catches you, it knocks you off: you
  unlatch with the comet's velocity plus a kick. The timetable is pure, so prediction gets the knock exactly right.
- **Debris.** If calving (2.2) is built, fresh fragments tumble through the lee. They are ordinary collisions, and a
  hard knock moves your offset.
- **Then cold.** The ride heads into the dark, so a cryo rating builds along the way and the warmth meter falls. If
  your ship seizes, you lose your grip and fall off. Insulated hulls ride further, which gives a build choice weight.
- **Riders** (2.5), if built: a few nest packs ride along and pick at latched ships. They do damage only and don't
  knock you off, but they add pressure while you dodge jets.
- **Falling off before the shelf** is not a death. You are flung outward at comet speed, far from anything, and
  coast or jump home. That is a real cost in time, but nothing is lost.

**Arrival (the "shelf"):** The comet crosses a fixed radius, the shelf, which is a circle on the system map. Every ship
still latched at that moment is taken into the hidden sector (`travelTo` into a pocket, as pockets work today). Only
ships that are latched at the crossing go in, which is what keeps the sector unreachable any other way. It isn't on
any gate or rift, and warping or jumping to the comet out there gets you nothing, because the passage is earned by
the ride.

**Where it goes:** A pocket system (`pocket`, with its own terrain and fields): the comet's far reach, a dark, cold
sector round a frozen cloud of ice bodies. Placeholder name: "Halvorsen's Reach" or "the Far Cloud", named by whoever
charted it. Worth the trip because it holds:

- **Rich ice and rock found nowhere else:** high trace tiers (pale iridium, a little voidglass), aphelion ice, and a
  cold-only material for insulated plate. That gives cold builds an economy.
- **A frozen wreck field** of earlier crews who rode out. Their logs are records with owners: a Guild prospector, a
  Patrol report, an ice-crew legend with its plain reading. It pairs with the thaw finds (2.4).
- **A cache for each pilot on each visit** (a `recover` task), and later perhaps a boss built to boss-design.md,
  fought in the cold.
- **A plan found only here** (an ice-runner hull), so the trip feeds progression and not just credits.

**Getting back (three ways, all available):**

1. **The slow way, always open.** Fly out past the pocket's edge and you are put back in Sol, far beyond the shelf
   (`pocketExit` at the comet's far position). From there you cruise and jump home: several minutes and a few jumps.
   Nobody is ever trapped. Logging out there sends you to your station on login, as logging out in a hazard already
   does.
2. **The comet's return.** Hours later the comet turns inbound and crosses the shelf. A ship latched on in the sector
   at that time rides it back in, and is dropped at perihelion near the inner stations with a jump-field boost. It
   is fast and spectacular, and it has its own "last call" countdown inside the sector.
3. **A beacon you build.** A `construct` field task in the sector (parts from your hold) builds your own return
   beacon. Once built, you can leave from it straight to Sol's rim at any time. It is per pilot, so no world state
   changes, and a pilot's party can use it with them. It is a mid-term goal for regulars.

**How often, and how players predict it:** One outbound window per orbit (about every 3–4 hours), with boarding open
for about 5 minutes after perihelion. The orbit is data, so the next window is computable on every client. The
almanac (2.8) lists "Long Comet perihelion in 1:12:40", and the chart line shows the shelf crossing time.

**Secret but discoverable:** The *how* is plain, which satisfies lore rule 6 (nothing a player needs is hidden in a
hint). The chart line reads: "Comet on a long orbit past the system's edge. Ships can latch on in its lee while it is
outbound." The lee prompt appears to anyone who matches the comet. What is *out there* is unknown until you go:

- the sector is not on anyone's map until they have been (per-pilot discovery, and clients are told the pocket id only
  then, as siege instances are);
- the shelf circle is drawn only after a first ride;
- people talk about it with owners: an old ice-crew pilot claims a crew rode the comet out and came back with frozen
  cargo (Sander's crews, superstitions), and the Guild calls it a tall tale;
- a thaw-find log (2.4) records a crew holding on.

A ribbon for the first ride, and a record for each log found, make it a collection to complete.

**Fit with jump drives, map, orbits and netcode:**

- **Jump drives:** latching and jumping exclude each other. The sector is a pocket, so no drive reaches it. On the
  way home the comet's coma could give the jump-field boost (2.7) as a reward.
- **Map:** the comet's position, the lee and the shelf crossing are all functions of the tick. The map draws the
  comet's orbit (already done), a boarding countdown, and the shelf once the pilot has discovered it.
- **Orbits:** `cometPosition` is already deterministic. The Kepler solve needs checking at e ≈ 0.9 (12 Newton steps;
  start E at π for large e, or add steps) and golden-traced, because carried ships' positions now depend on it.
- **Netcode:** A latched ship's wire state is a flag plus a small offset. Its world position is derived exactly by
  every client. Jets come from a seeded timetable, so knock-offs are predicted. The server decides only latch, unlatch
  and the shelf transfer: three events, each easy to validate. This needs one new flight mode in the shared step,
  with golden traces and a protocol bump.

**Solo / group:** Solo is complete. A party that is latched at the crossing arrives together in the same pocket. It
is public: everyone who rode that passage shares it. The sector's threats are sized per head, and its caches are per
pilot, so riding as a group only helps:

- more guns against riders on the way;
- shared beacon use at home;
- a light "draft" bonus: ships deeper in the lee behind another latched ship are sheltered from one jet in three,
  which is seeded and predictable.

**Reuses:** Pockets and `travelTo`, terrain, warmth (cryo) and the near-star hazard, Operations (`recover`,
`construct`), derelicts and logs, codex, ribbons, `cometPosition`, nests (riders), and the almanac. **New:** a long
comet, the latched flight mode (shared step, replicas, wire), the jet timetable, the shelf transfer, per-pilot
discovery of a pocket, the sector itself (terrain, fields, contents), and the return beacon.

**Size:** L. Two slices:

- (a) the latch and the ride, with the shelf dropping you into a small, mostly empty pocket and the slow way home;
- (b) the sector's contents, the comet's return and the beacon.

**Risks:**

- The latched mode touches the flight step, the most sensitive code there is. It needs golden traces, a protocol
  bump, and prediction tests for latch and unlatch.
- A 3–4 hour cadence suits an occasion but could frustrate someone who just missed it. The almanac and a second, more
  frequent long comet in another system help.
- AFK riding: the ride must ask for something (jets, cold, riders) or it becomes a free taxi.
- Lore: whatever is out there needs owners, and nothing may suggest the comet *takes* people anywhere on purpose.
  The plain reading is orbital mechanics.

## 3. Recommendation

**Top 3**

1. **Calving (2.2) together with tail skimming (2.1)**, as one "perihelion" event. Together they turn the comet from
   scenery into a recurring, readable event every 45 minutes, and they deliver the game plan's "volatiles in comet
   tails". They replace the disconnected 3-day timer with something physical. Both are predictable from the tick plus
   a seed, so they are nearly free to network. They are open to everyone, and they reuse mining and the trace ledger
   almost unchanged.
2. **The almanac (2.8)**, starting with just the data plus a "next perihelion" countdown on the map and chart. It is
   cheap, and it is how players find every other comet idea. Adding a Borealis comet makes the existing "Sol and
   Borealis" bonus honest.
3. **Riding a comet to the hidden sector (2.10).** It is the strongest "enter the comet and do a special thing" idea,
   because it gives the comet a destination. Every part of it is predictable from the orbit: the boarding window, the
   jets, the shelf crossing. The server decides only latch, unlatch and transfer. It reuses pockets, warmth,
   Operations and derelict logs. The thaw finds (2.4) slot in as the sector's wreck logs. It is L, and it builds
   straight on the passage clock from the first slice and on the almanac.

Next after those: **the nucleus run (2.3)**. It is the other "inside the comet" piece, but it overlaps 2.10's appeal
for more art cost. **The moving jump field (2.7)** is S and very elegant to network, but it needs a lore decision
first. It would also make a nice reward on the comet's return ride.

**First slice to build** (S–M, about one session)

1. Common: `cometPassage(c, tick)` (passage number, time to perihelion, "warm" fraction from r) and `tailAt(c, tick,
   x, y)` (the ion-tail cone, the same one the client shader draws). Unit-test both against `cometPosition`.
2. Server: replace `cometNow`'s wall clock with "a comet in this system is warm", and add the skim accumulator (2.1)
   ticked once a second. Skimming pays Helium-3, ice and trace accrual at a rate scaled by warmth and depth in the
   tail. It goes through `pilots.give` and the ledger, with the wing bonus on top. New knobs in mining.json
   (`comet.skim`), with validators.
3. Client: a perihelion countdown on Halvorsen's chart line and nav marker, a "skimming" HUD chip with the predicted
   rate, and the tail edge matched to the server cone.
4. One Helium-3 sink (a refinery recipe for a boost cell) so the haul is worth something.
5. Data: a plain chart description, and one Guild line (with an owner) that mentions skimming.

Calving fragments (2.2) are the next slice, once the passage clock exists, because they need rock lifetimes in the
asteroid timetable. The comet ride's slice (a) follows: the long comet's data, the latched flight mode with golden
traces, the jet timetable, and the shelf dropping riders into a near-empty pocket.

## 4. Open questions for Kieran

1. **The old timer:** retire the 3-day "comet passing" wall-clock bonus in favour of the real orbit, or keep it as a
   rarer "great passage"?
2. **How often:** is 45 minutes right for Halvorsen as an event, or should it be slower (2–3 hours) so it feels like
   an occasion? The orbit's period is a single data field.
3. **More comets:** which systems? Borealis (riders) and Cinder Reach (a sungrazer) are the natural ones. Should a
   once-a-day great comet exist?
4. **Helium-3's job:** boost or jump cells, reactor parts, or just a valuable trade good? This touches the energy plan.
5. **Comet coma as a jump field (2.7):** is that acceptable given the stillstone lore, if the text explains it as
   cold-cloud physics?
6. **Perishable cargo (2.9):** is decaying cargo something you want in the game at all?
7. **Interior run (2.3):** worth the L build now, or after the siege and boss work settles?
8. **Thaw finds (2.4):** do frozen-wreck logs belong to existing threads (the early landers, the Lighter Halvard
   pattern), or stay as stand-alone prospector stories?
9. **The comet ride (2.10):**
   - How often should the window open? Every 3–4 hours, or more often with a second long comet elsewhere?
   - Is a kinematic "latched" mode OK, or would you rather riders fly free in formation? Free flying is simpler for
     the netcode but tiring for 10 minutes.
   - Which of the three ways home do you want first? (The slow way is the minimum.)
   - What should the hidden sector hold, and should it get a boss eventually?
