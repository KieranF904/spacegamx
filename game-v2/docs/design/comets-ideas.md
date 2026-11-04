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

*This is now folded into 2.10, as the inside of the long comet. Below is the stand-alone version, a short run with no
exit at the end, for Halvorsen.*

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

### 2.10 Inside the comet, out of the system (Kieran's idea)

**Kieran's version:** "You press X to enter an instance inside of it; if you stay on it until it leaves the system,
you can exit into a secret system."

**Fantasy:** fly into a comet as it rounds the sun, survive inside it as it heads out into the dark, and come out
somewhere no chart shows.

This takes over the nucleus run (2.3) and the thaw finds (2.4): they become the inside of this comet. Halvorsen could
keep a short version with no exit at the end.

**The comet:** It needs a new comet, because Halvorsen's aphelion (78,900) is inside Sol. Call it "the Long Comet"
until it has a name. Its orbit is very eccentric (e ≈ 0.9) with a period of about 3 hours, so its aphelion is far
beyond Sol's charted edge. The **shelf** is a fixed radius, past the outermost chart: crossing it outbound is "leaving
the system". The orbit is tuned so the comet takes about **20 minutes from perihelion to the shelf**. That is the
length of a full stay.

#### How the instance works

- **Entering:** while the comet is within the entry window, from about 3 minutes before perihelion to about 5 minutes
  after it, X near the nucleus enters the interior. This is the same X path as `Surfaces.descend`/`pocketAt`, but with
  a **moving entrance**: its position comes from `cometPosition(tick)`, not a fixed point. Outside the window the
  chart line shows the countdown, and X does nothing.
- **What the instance is:** a pocket system with terrain (tunnels of ice, built by a generator script in the style of
  the Ashfall cavern), run as an instance using the siege moons' `instance.slots` (`GameData.getSystemInstances`).
  There is **one public instance per passage**: everyone who enters during that window joins the same copy, and a
  party always lands together. If a passage is crowded (above a cap, say 16), a second copy opens, as the seam
  allows. The copy is cleared after it closes and nobody is left in it.
- **The clock is the orbit:** everything inside keys off the comet's distance from the star, `r(tick)`, which every
  client computes. A **heat phase** (warm, active, near the star) turns into a **cooling phase** as it heads out.
  Geysers, ice gates and the cold are all timetables seeded by `(comet, passage)`, so the client simulates the
  interior exactly, with no messages.
- **Leaving early:** at any time, fly into an open vent, or press X at a vent, and you leave. You come out next to the
  comet's current position in Sol (`pocketExit` with the moving entrance), with a modest share of its velocity. If
  you leave late in the stay, that is far out, and it is a long way home.
- **The payoff:** when the comet crosses the shelf, the **far vent** opens deep inside for about 3 minutes. Anyone
  who reaches it can exit into the secret system. Anyone still inside when the instance closes is pushed out at the
  comet's position beyond the shelf, which leaves a long cruise home.

#### What makes staying hard

- **Cold that climbs with r:** the cryo rating rises as the comet goes out, so the warmth meter falls. If your ship
  seizes, the ice holds you until you thaw, which costs time; seize too often and you miss the far vent. Insulated
  hulls and the hearths below make it survivable.
- **Ice gates that freeze shut:** passages close in order on the outbound timetable, so the route to the far vent
  narrows. Fall behind and your side of the comet seals off from the far vent. You can still leave early, but not go
  through.
- **Geysers:** during the heat phase, geysers fire often (telegraphed, timed by seed). As it cools, they fire rarely
  but harder. The first build has them deal damage and heat rather than push, so they act only on the server and
  prediction is untouched. Pushes (in the shared flight step) can come later, with golden traces.
- **Riders:** a nest deep inside (2.5) hatches packs while the comet is warm, sized to the pilots in the instance.
  Outbound they go dormant, and the ones still about are slow but tough.
- **Dying** is ordinary death: you respawn at your station, and your cargo drops as a pod inside the instance, where
  others can find it.

#### Activities in the interior

These are things you can only do inside a comet, so going in pays even if you never ride it out. Each one behaves
differently as the comet heats and cools.

1. **Core sampling.** Hold a mining beam steady on a banded ice wall while a strata readout fills, layer by layer.
   - *Heat:* the outer layers boil off and expose deeper, richer strata, but the wall spits vapour that knocks your
     aim.
   - *Cooling:* the wall goes still and easy to read, but only shallow layers are left before it freezes over.
   - *Rewards:* "comet cores" (an item) that Quinn's observatory buys for standing and credits, plus trace accrual.
     Each core records the passage and depth, and a set of cores from different depths is worth more.
   - *Solo/group:* solo. Pilots on neighbouring walls each sample their own.
2. **Thaw salvage (2.4).** The heat exposes one seeded wreck or cache per passage, frozen in the ice, and the ice
   refreezes over it on the way out.
   - *Heat:* the ice is soft, so cutting the wreck free is quick, but geysers make it dangerous.
   - *Cooling:* the ice hardens again, cutting slows, and finally the find seals.
   - *Rewards:* salvage credits, parts, and logs that file records (each with an owner).
   - *Solo/group:* everyone who cut or towed is paid, not just the last shot.
3. **Chimney climbing.** Fly up a geyser chimney between eruptions to reach the upper galleries: a timing puzzle on a
   seeded timetable that anyone can learn.
   - *Heat:* eruptions come every few seconds, so the gaps are short.
   - *Cooling:* eruptions are rare, so the gaps are long, but the chimney walls ice over and narrow.
   - *Rewards:* the galleries hold rime crystal, a cold-only material found nowhere else, used for insulated plate.
   - *Solo/group:* solo skill. A ribbon for climbing every chimney in a passage.
4. **Hearths.** Tap a thermal vent with a small `construct` job (parts from your hold) to light a hearth: a warmth
   source for every ship near it, as stations are now.
   - *Heat:* hearths aren't needed yet, and building is cheap.
   - *Cooling:* they become the only warm places, and each fades unless someone feeds it ice.
   - *Rewards:* builders and feeders are paid for the warmth others draw (the Support ledger). This is what lets a
     group stay to the end.
   - *Solo/group:* a soloist can manage one. A group can keep a chain of hearths alive toward the far vent. This is
     the group activity.
5. **Charting the passage.** The side passages open differently each passage, from the seed. A scanner pulse charts
   the gallery you are in, and charting every gallery fills that passage's map, which the Miners' Guild buys.
   - *Heat:* the chart changes as passages melt open.
   - *Cooling:* gates freeze, and a finished chart shows the route to the far vent early.
   - *Rewards:* Guild credits and standing. A party pools its chart, and each member is paid for the galleries they
     scanned.
   - *Solo/group:* a party covers the galleries faster, and nobody is paid less for it.
6. **Clearing the clutch.** Break the riders' nest (2.5) while it is warm and hatching.
   - *Heat:* the nest hatches waves.
   - *Cooling:* it goes dormant, which makes it easier to break, but it is deep in, behind gates that are closing.
   - *Rewards:* a warband-style bounty for everyone who fought, and a quieter outbound leg for everyone inside.
   - *Solo/group:* packs are sized to the pilots taking part.

#### The secret system

- **What it is:** a full pocket system, the comet's far cloud: a dark, cold sector of ice bodies with no star.
  Placeholder name: "the Far Cloud", named by whoever charted it. It needs no instance: it is public and shared, and
  it holds no state that a pilot's visit changes.
- **Worth the trip:**
  - rock and ice found nowhere else, with high trace tiers (pale iridium, a little voidglass);
  - rime crystal in bulk;
  - a field of frozen wrecks from earlier crews, whose logs are records with owners;
  - a cache for each pilot on each visit (`recover`);
  - a plan found only here (an ice-runner hull);
  - later, a boss built to boss-design.md, fought in the cold.
- **Getting home** (all three ways available):
  1. **The slow way, always open:** fly past the pocket's edge and you come out in Sol beyond the shelf, then cruise
     and jump home. Logging out there returns you to your station, as logging out in a hazard already does. Nobody is
     ever trapped.
  2. **The comet's return:** as the comet crosses the shelf inbound, its vent opens in the Far Cloud. Enter, survive
     the run in reverse (it warms as you go, so hearths matter less and geysers wake up), and exit at perihelion
     beside the inner stations.
  3. **Your own beacon:** a `construct` job in the Far Cloud builds a per-pilot return beacon. From then on, you can
     leave from it to Sol's rim at any time. It changes no world state.

#### Soft pressure: why you don't stay in the Far Cloud forever

The aim is a growing reason to leave, never a timer that kills you. Every rule here is per pilot, deterministic (it
depends only on time since that pilot arrived and what they did), and blind to group size. The slow way home stays
open always: no rule here ever traps anyone.

Options:

- **A. Deep chill (a hazard that wears parts).** Separate from warmth, which recovers: a per-pilot exposure meter
  rises with time in the Far Cloud. After a grace period (say 20 minutes) it lowers your parts' maximum HP a little
  each minute ("frost-brittle"), to a floor (say 60%). It never destroys anything. It only makes a fight there riskier
  and leaves a repair bill. Any station mends it, as part damage is mended now, and leaving resets the meter.
  Insulation slows it. Hearths slow it for everyone near them, which helps groups and never hurts them.
- **B. No services.** No station, repair, refinery or resupply. Your ammunition, field kits and hold space are the
  natural clock. This costs nothing to build, because it is simply true of the place.
- **C. Finds that thin out.** A per-pilot visit ledger, a rate rather than a roll, like traces. Mining yield and trace
  accrual run at full rate for the first 25 minutes of a visit, then taper to 25% by 60 minutes. Each per-pilot cache
  opens once per visit. A visit only starts by riding the comet in again, so the taper resets naturally and leaving
  never loses anything.
- **D. The good way home closes.** The comet's return (way 2) is the fast, comfortable way back, and its vent is open
  only during the inbound shelf crossing. Miss it and you are left with the slow way or a beacon. This is a nudge,
  not a door shut: the slow way never closes.

**Recommendation: B + C, with a light A.**
- B is free, and it already makes long stays self-limiting for fighters.
- C removes the *reason* to stay without punishing anyone for staying. It is the fairest lever: a pilot who lingers
  loses only extra yield, never what they already earned.
- A, kept mild (a floor, mended at any station, slowed by hearths), adds a felt, visible reason to head home. The HUD
  shows "Frost-brittle: parts at 85%".
- D comes for free with the comet's return and needs no rule of its own. Use it as flavour, not as the pressure.
- Reject anything that destroys parts, damages hulls over time, or closes the slow way home.

#### Timing and how players find out

- **How often:** one window per orbit, about every 3 hours. The almanac (2.8) shows "Long Comet perihelion in
  1:12:40", and inside, a HUD timer counts down to the shelf. Every time is computable from the orbit on the client.
  A second long comet in another system (Borealis) could offer a second schedule, so a missed window isn't a 3-hour
  wait.
- **Secret but discoverable:** the *how* is plain, which lore rule 6 requires. The chart line reads: "Comet on a long
  orbit past the system's edge. Vents open near the sun: you can fly inside." The interior's HUD shows "Leaves the
  system in 14:20", and the far vent's prompt is plain when it opens. *What* is out there stays unknown until you go:
  - the Far Cloud isn't on anyone's map until they have been there (per-pilot discovery; clients are told its id only
    then, as siege instances are);
  - people talk about it with owners: an ice-crew pilot of Sander's says someone rode the comet out and came back
    with frozen cargo, and the Guild calls it a tall tale;
  - a thaw-find log records a crew who stayed in too long.
- A ribbon for the first exit, and a record for each log, turn it into a collection.

#### Netcode and existing systems

- **Instance and terrain:** a pocket with terrain is what Ashfall's cavern and the siege moons already are. The
  terrain is static data that every client loads, and collision (`collideTerrain`) is already in the shared step, so
  flying inside is predicted exactly. The instance slots come from the siege moon seam. No new kind of world sim is
  needed.
- **Timing:** the interior's phase, gates, geysers and the far vent's opening are pure functions of
  `cometPosition(c, tick)` and the passage seed. The server decides only entry, exit, spawns and payouts. The ice
  gates are timed terrain pieces, solid only between their times; `collideTerrain` needs a "solid at tick" check,
  which is the one change in shared flight code. The Kepler solve needs checking at e ≈ 0.9 (start E at π, or more
  steps) and golden-tracing, because gate timing and the moving entrance depend on it.
- **Wire:** nothing new per tick. Entry and exit are travel messages, as pockets use now. A protocol bump is needed
  only for the moving entrance's data and the far vent's prompt.

**Solo / group:**
- Solo: everything is completable alone with a well-insulated ship.
- Groups: one shared public instance per passage, threats sized per head, caches and cores per pilot. Hearths and
  charting reward working together, so a group stays longer more easily, and nobody earns less for being in one.

**Reuses:** pockets (`pocketAt`, `pocketExit`), siege instance slots, terrain and its generator scripts, warmth
(cryo) and heat sources, Operations (`recover`, `construct`), the Support ledger, derelicts and logs, codex, nests and
Events pay, ribbons, and the almanac.

**New:**
- the long comet;
- a moving, timed pocket entrance;
- the passage-keyed instance life;
- timed ice gates in terrain;
- geyser and hearth sources;
- core sampling and chimney content;
- the Far Cloud and per-pilot discovery;
- the return beacon.

**Size:** L, in two slices:

- **(a)** the long comet; X to enter a near-empty ice instance; leaving early; cold rising with r; the far vent at the
  shelf into a sparse Far Cloud; the slow way home.
- **(b)** the activities, ice gates, riders, the comet's return and the beacon.

**Risks:**
- The ice gates change shared collision, so they need golden traces.
- A crowded public instance needs a cap and an overflow copy.
- A 3-hour cadence suits an occasion but punishes someone who just missed it.
- Lore: everything out there needs an owner, and nothing may suggest the comet *takes* anyone anywhere. The plain
  reading is orbital mechanics.

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
3. **Inside the comet, out of the system (2.10).** This is Kieran's idea, and it absorbs the nucleus run (2.3) and
   the thaw finds (2.4).
   - It is a public instance you enter with X, worth entering for its activities alone (core sampling, chimneys,
     hearths, charting).
   - Staying to the end exits into the Far Cloud.
   - It is all keyed to the comet's distance from the star, so clients simulate it exactly. The server decides only
     entry, exit, spawns and pay.
   - It is built from existing seams: pockets, terrain, siege instance slots, warmth, Operations.
   - It is L, and it builds straight on the passage clock from the first slice.

Next after those: **the moving jump field (2.7)** is S and very elegant to network, but it needs a lore decision
first. It would also make a nice reward on the comet's return trip.

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
asteroid timetable. 2.10's slice (a) follows:
- the long comet's data;
- X to enter a near-empty ice instance, through a moving, timed entrance;
- leaving early;
- cold rising with distance from the star;
- the far vent at the shelf, opening into a sparse Far Cloud;
- the slow way home, with soft pressures B and C.

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
7. **Halvorsen's interior (2.3):** should Halvorsen also get a short run with no exit, or should only the long comet
   have an inside?
8. **Thaw finds (2.4):** do frozen-wreck logs belong to existing threads (the early landers, the Lighter Halvard
   pattern), or stay as stand-alone prospector stories?
9. **Inside the comet (2.10):**
   - How often should the window open? Every 3 hours, or more often with a second long comet (Borealis)?
   - Is about 20 minutes from entry to the far vent the right length for a full stay?
   - One public instance per passage, with an overflow copy above a cap (16?), or one copy per party, as sieges do?
   - Which activities first? My order: hearths and core sampling, then thaw salvage, charting, chimneys, the clutch.
   - Should geysers push ships (shared flight code, golden traces), or only damage and heat (server-side, safer)?
   - Which of the three ways home first? The slow way is the minimum.
   - Soft pressure in the Far Cloud: is B + C with a mild deep chill (A) right? What floor and grace period?
   - What should the Far Cloud hold, and should it get a boss eventually?
