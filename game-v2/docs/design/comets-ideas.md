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
you can exit into a secret system." Once the comet has left your system, leaving the comet takes you to the secret
system.

**Fantasy:** fly into a comet as it rounds the sun, survive inside it as it heads out into the dark, and come out
somewhere no chart shows.

This takes over the nucleus run (2.3) and the thaw finds (2.4): they become the inside of this comet. Halvorsen could
keep a short version with no exit to anywhere new.

**The comet:** It needs a new comet, because Halvorsen's aphelion (78,900) is inside Sol. Call it "the Long Comet"
until it has a name. Its orbit is very eccentric (e ≈ 0.9) with a period of about 3 hours, so its aphelion is far
beyond Sol's charted edge. The **shelf** is a fixed radius past the outermost chart: the comet crossing it outbound
is "leaving the system". The crossing tick is pure orbit maths, the same on every client; call it **T0** for that
passage. The orbit is tuned so the comet takes about **20 minutes from perihelion to the shelf**.

#### How the instance works

- **Entering:** X near the nucleus enters the interior, from about 3 minutes before perihelion to about 5 minutes
  after it. This is the same X path as `Surfaces.descend`/`pocketAt`, but with a **moving entrance**: its position
  comes from `cometPosition(tick)`, not a fixed point. Outside that window the chart line shows a countdown, and X
  does nothing.
- **What the instance is:** a pocket system with terrain (tunnels of ice, from a generator script in the style of the
  Ashfall cavern), run as an instance using the siege moons' `instance.slots` (`GameData.getSystemInstances`). There
  is **one public instance per passage**: everyone who enters during that window joins the same copy, and a party
  always lands together. Above a cap (say 16), a second copy opens. A copy is cleared once it has closed and nobody
  is in it.
- **The clock is the orbit:** everything inside keys off the comet's distance from the star, `r(tick)`, which every
  client computes. A **heat phase** (warm and active, near the star) turns into a **cooling phase** as it heads out.
  Geysers, ice gates and the cold are timetables seeded by `(comet, passage)`, so the client simulates the interior
  exactly, with no messages.
- **The exit rule (one rule, two outcomes):** at any time, fly out of any open vent, or press X at one, and you
  leave the comet.
  - **Before T0**, you come out in the home system, next to the comet's current position (`pocketExit` with the
    moving entrance). Leaving late puts you far out, with a long way home.
  - **From T0 on**, you come out in the **secret system**. The HUD changes from "Leaves the system in 4:10" to
    "Outside the system: vents lead out" at T0, so the switch is never a surprise.
- **The far vent (a better way out, not the only one):** one vent deep in the comet, behind the ice gates, opens at
  T0. Leaving through it after T0 lands you at the **heart** of the secret system, by the wreck field and the richest
  ice, and opens that pilot's cache for the visit. Any other vent lands you at the system's **rim**: safe, but a long
  fly in. Reaching the far vent is the interior run's reward, not a gate on the secret system.
- **Closing:** at T0 + 15 minutes the comet freezes through, and anyone still inside is put out into the secret
  system at the rim. So arrivals on a passage fall between T0 and T0 + 15.

#### What makes staying hard

- **Cold that climbs with r:** the cryo rating rises as the comet goes out, so the warmth meter falls. If your ship
  seizes, the ice holds you until you thaw, which costs time. Insulated hulls and hearths (below) make it
  survivable.
- **Ice gates that freeze shut:** passages close in order on the outbound timetable, so the route to the far vent
  narrows. Fall behind and you may be cut off from the far vent, but never from the plain vents.
- **Geysers:** in the heat phase they fire often (telegraphed, timed by seed). Cooling, they fire rarely but harder.
  The first build has them deal damage and heat rather than push, so they act only on the server and prediction is
  untouched. Pushes (in the shared flight step) can come later, with golden traces.
- **Riders:** a nest deep inside (2.5) hatches packs while the comet is warm, sized to the pilots in the instance.
  Outbound they go dormant, and the ones still about are slow but tough.
- **Dying** is ordinary death: you respawn at your station, and your cargo drops as a pod inside the instance, where
  others can find it.

#### Activities in the interior

These are things you can only do inside a comet, so going in pays even if you never stay to the end. Each one plays
differently as the comet heats and cools.

1. **Core sampling.** Hold a mining beam steady on a banded ice wall while a strata readout fills, layer by layer.
   - *Heat:* the outer layers boil off and expose deeper, richer strata, but the wall spits vapour that knocks your
     aim.
   - *Cooling:* the wall goes still and easy to read, but only shallow layers are left before it freezes over.
   - *Rewards:* "comet cores" (an item) that Quinn's observatory buys for standing and credits, plus trace accrual.
     Each core records the passage and depth, and a set from different depths is worth more.
   - *Solo/group:* solo. Pilots on neighbouring walls each sample their own.
2. **Thaw salvage (2.4).** The heat exposes one seeded wreck or cache per passage, frozen in the ice, and the ice
   refreezes over it on the way out.
   - *Heat:* the ice is soft, so cutting the wreck free is quick, but geysers make it dangerous.
   - *Cooling:* cutting slows, and finally the find seals.
   - *Rewards:* salvage credits, parts, and logs that file records (each with an owner).
   - *Solo/group:* everyone who cut or towed is paid, not just the last shot.
3. **Chimney climbing.** Fly up a geyser chimney between eruptions to reach the upper galleries: a timing puzzle on a
   seeded timetable that anyone can learn.
   - *Heat:* eruptions every few seconds, so the gaps are short.
   - *Cooling:* rare eruptions and long gaps, but the walls ice over and narrow.
   - *Rewards:* rime crystal, a cold-only material for insulated plate.
   - *Solo/group:* solo skill. A ribbon for every chimney in one passage.
4. **Hearths.** Tap a thermal vent with a small `construct` job (parts from your hold) to light a hearth: a warmth
   source that warms every ship near it, as a station does now. There is no payment for it; that can come later if
   it's needed.
   - *Heat:* not needed yet, and cheap to build.
   - *Cooling:* hearths become the only warm places, and each fades unless someone feeds it ice.
   - *Solo/group:* a soloist can manage one. A group keeps a chain of them alive toward the far vent, which is what
     lets a group stay to the end.
5. **Charting the passage.** Side passages open differently each passage, from the seed. A scanner pulse charts the
   gallery you're in, and a full chart sells to the Miners' Guild.
   - *Heat:* the chart changes as passages melt open.
   - *Cooling:* gates freeze, and a finished chart shows the route to the far vent early.
   - *Rewards:* Guild credits and standing. A party pools its chart, and each member is paid for the galleries they
     scanned.
   - *Solo/group:* a party covers it faster, and nobody is paid less for it.
6. **Clearing the clutch.** Break the riders' nest (2.5) while it is warm and hatching.
   - *Heat:* it hatches waves.
   - *Cooling:* it goes dormant and is easier to break, but it is deep in, behind gates that are closing.
   - *Rewards:* a warband-style bounty for everyone who fought, and a quieter outbound leg for everyone inside.
   - *Solo/group:* packs are sized to the pilots taking part.

#### The secret system

- **What it is:** a pocket system, the comet's far cloud: a dark, cold sector of ice bodies with no star.
  Placeholder name: "the Far Cloud", named by whoever charted it. **Each passage gets its own copy** (instance slots
  again), shared by everyone who came out of that passage's comet, so everyone in a copy shares one clock (below). A
  copy is cleared when nobody is left in it.
- **Worth the trip:**
  - rock and ice found nowhere else, with high trace tiers (pale iridium, a little voidglass);
  - rime crystal in bulk;
  - a field of frozen wrecks from earlier crews, whose logs are records with owners;
  - a per-pilot cache, opened by arriving through the far vent;
  - a plan found only here (an ice-runner hull);
  - what the late arrivals leave behind (below).
- **No services:** no station, repair, refinery or resupply. Your ammunition, field kits and hold space decide how
  long you can hold out once the escalation starts. That suits it, so it stays.
- **Getting home** (all three ways available):
  1. **The slow way, always open:** fly past the edge and you come out in the home system beyond the shelf, then
     cruise and jump home. Logging out there returns you to your station, as logging out in a hazard already does.
  2. **The comet's return:** as the comet crosses the shelf inbound, about 2.5 hours later, its vent opens in the Far
     Cloud. That is long after the escalation peaks, so in practice it is for the very well-armed. Enter and run the
     interior in reverse (warming as you go), and exit at perihelion beside the inner stations.
  3. **Your own beacon:** a `construct` job builds a per-pilot return beacon. From then on you can leave from it to
     the home system's rim at any time. It changes no world state, and it is the sensible exit once things get
     loud.

#### Soft pressure: the Far Cloud wakes up

It is quite safe at first. After a fixed time, ships start appearing, and stronger ones over time, until you leave or
die. Nothing destroys parts or drains your hull just for being there. The pressure is enemies you can see coming and
choose to leave before.

**The clock:**
- It runs from **T0**, the passage's shelf crossing, not from each pilot's arrival. Everyone in one copy shares it,
  so a group can never split its own clock.
- A pilot who stayed in the comet longer arrives later and simply has less quiet time. That is their trade, and the
  HUD makes it plain.
- Everything below is a timetable seeded by `(comet, passage)`, so clients know exactly when the cues come. The
  server spawns enemies on schedule as ordinary packs, flown by the ordinary pilot-body AI. Nothing new goes on the
  wire.

**The curve** (minutes after T0; the numbers are a first guess):

| Time | What happens |
|---|---|
| 0–20 | Quiet. No hostiles. |
| 20–30 | Cues only (below). |
| 30 | **Watchers**: one or two, keeping their distance. |
| 40 | **Rime packs** begin: small, at the system's grade. |
| 55 | **Rime wraiths** join. |
| 70 | **Notched hulls** join. |
| Every 15 min from 70 | A champion. |

After 30, the wave budget grows about 25% every 10 minutes, with no cap except the top grade. Over 90 minutes it
outclasses anything but a determined group, and by 120 it is a last stand. Leaving is always one vent or the edge
away.

**Groups and per head:**
- The budget is a base plus a per-pilot share for **pilots present in the copy**, spawned near each pilot in
  proportion, as siege nights size their waves.
- A group faces more ships, but no more per head, and has more guns and hearths, so it is never harder per head.
- A pilot who leaves takes their share of future waves with them; the packs already out stay out.

**How it's signalled.** The mechanic itself is plain (lore rule 6). The Far Cloud's chart line reads: "No stations.
Hostile ships appear here after about half an hour, and grow stronger." The HUD shows the time since the comet left
the system. The *subtle* cues are the mood, and every one of them is something a pilot can also see on the HUD:
- **From 20 min:** the dull grey veins in the ice bodies (greyseam, as in any rock here) brighten slightly, a client
  shader keyed to T0.
- **From 25 min:** the comms hiss picks up a slow pulse, quiet at first. Nothing labels it, so pilots will call it
  what they like.
- **From 28 min:** the scanner starts returning ghost contacts that vanish when you look.
- **At 30 min:** the first watcher holds at the edge of view and doesn't attack.

#### The late arrivals (enemies, with their lore kept subtle)

Each kind has a plain chart line about what it does, a look that hints, and a record with an owner and an ordinary
reading. No narration says what any of them are, and no line connects them to each other or to the heartbeat.

1. **Watchers** (from 30). Frost-caked Scrapborn drones that shadow you at range, keep to the ice bodies'
   greyseam-heavy faces, and break off if chased. Chart: "Scrapborn drones, rimed over. They follow; they rarely
   fire."
   - Canon fit: Scrapborn always gather round greyseam, and the Far Cloud's ice is full of it.
   - Drop: scrap cores. Under a microscope, these are thick with whiskering.
   - Owners: Marrow says "cold whiskering, it happens in any core left out long enough". Achebe says "second-hand
     parts are second-hand".
2. **Rime packs** (from 40). Scrapborn frames grown over the frozen wrecks' hulls. They hunt in packs, fly the way
   the wreck they're built on flew, and go for whoever is mining.
   - Drop: salvage from those wrecks, now and then with a fragment of that wreck's log.
   - Owner: the Guild calls them "Scrapborn that found a good heap", the ordinary reading.
3. **Rime wraiths** (from 55). Pale, half-there shapes that **condense** near the brightest veins, as Void Wraiths
   do, and scatter into ice fog when broken.
   - Drop: **rime dust**, which hums under a scanner, as Glasswater's Resonant Crystal does.
   - Owners: Quinn's reading is charged ice fog and static discharge, "the comet's own dust, ionised". Kerr, if
     asked, says only that the hum is the same shape as the one she records, and that she doesn't know what it
     means.
4. **Notched hulls** (from 70; champions are the largest). Heavier ships plated in dark slate, with notched,
   never-square corners and a thin cold inlay: the visual language of Halden work, which the text never names here.
   They move slowly, keep formation, and turn to face whoever is nearest the far vent's landing.
   - Drop: a **small sealed case**, like the Redtooth Hold's crates. Collectors buy it unopened.
   - Owners:
     - Aske (New Halden) says the sleeper's priests kept watch out here too.
     - The collectors (Ancient Relics' line) say "Halden work, collectors say", as with the cases from the Maw.
     - Marrow's plain reading: Scrapborn bolting old salvage onto their frames.
     - Nobody agrees, and nothing settles it.
5. **The wreck field's Ark tender** (scenery, not an enemy). One frozen wreck carries leestone plate, and its log
   reads, in part: "Word came down at the Hall before we left: half an hour out there, no more. We stayed for the
   ice."
   - Owners: the log, and the Keeper's line ("The word comes down. I keep the books.").
   - It never says how the herald knew. Players can match its half hour to the clock themselves, and nothing in the
     text does it for them.

Rules kept (docs/lore-canon.md):
- every claim is held by someone who might be wrong;
- each strange thing comes with an ordinary reading in the same breath;
- the cluster never speaks (the pulse is never words, and nothing addresses the pilot);
- no record connects the enemies to each other, to the heartbeat or to the herald's word; players do that.

#### Timing and how players find out

- **How often:** one entry window per orbit, about every 3 hours. The almanac (2.8) shows "Long Comet perihelion in
  1:12:40". Inside, the HUD counts down to T0. A second long comet in another system (Borealis) could offer a second
  schedule, so a missed window isn't a 3-hour wait.
- **Secret but discoverable:** the *how* is plain. The chart line reads: "Comet on a long orbit past the system's
  edge. Vents open near the sun: you can fly inside." The HUD names the switch at T0. *What* is out there stays
  unknown until you go:
  - the Far Cloud isn't on anyone's map until they have been there (per-pilot discovery; clients are told its id only
    then, as siege instances are);
  - people talk about it with owners: an ice-crew pilot of Sander's says someone stayed in the comet and came back
    with frozen cargo, and the Guild calls it a tall tale;
  - a thaw-find log records a crew who stayed in too long.
- A ribbon for the first arrival and a record for each log turn it into a collection.

#### Netcode and existing systems

- **Instance and terrain:** a pocket with terrain is what Ashfall's cavern and the siege moons already are. The
  terrain is static data that every client loads, and collision (`collideTerrain`) is already in the shared step, so
  flying inside is predicted exactly. Instance slots come from the siege moon seam, and both the comet and the Far
  Cloud use them, one copy per passage.
- **Timing:** the interior's phase, gates, geysers, T0, the exit rule and the Far Cloud's escalation are all pure
  functions of `cometPosition(c, tick)` and the passage seed. The server decides only entry, exit (which side of T0),
  spawns and payouts.
  - The ice gates are timed terrain pieces, solid only between their times. `collideTerrain` needs a "solid at tick"
    check, the one change in shared flight code.
  - The Kepler solve needs checking at e ≈ 0.9 (start E at π, or more steps) and golden-tracing, because T0 and gate
    timing depend on it.
- **Wire:** nothing new per tick. Entry and exit are travel messages, as pockets use now. A protocol bump is needed
  only for the moving entrance's data.

**Solo / group:**
- Solo: everything is completable alone with a well-insulated, well-stocked ship.
- Groups: one shared public copy per passage, with the interior and the Far Cloud each sized per head, and caches and
  cores per pilot. Hearths and charting make working together easier, and a group can hold out longer against the
  escalation without anyone earning less.

**Reuses:** pockets (`pocketAt`, `pocketExit`), siege instance slots and wave sizing, terrain and its generator
scripts, warmth (cryo) and heat sources, Operations (`recover`, `construct`), Scrapborn and wraith ships, derelicts and
logs, codex, nests and Events pay, ribbons, and the almanac.

**New:**
- the long comet;
- a moving, timed pocket entrance;
- the passage-keyed instance life and the T0 exit rule;
- timed ice gates in terrain;
- geyser and hearth sources;
- core sampling and chimney content;
- the Far Cloud, with per-passage copies, per-pilot discovery and the escalation timetable;
- rimed and notched enemy looks;
- the return beacon.

**Size:** L, in two slices:
- **(a)** the long comet; X to enter a near-empty ice instance; the exit rule either side of T0; cold rising with r;
  a sparse Far Cloud with the escalation (watchers and rime packs only) and the slow way home.
- **(b)** the activities, ice gates, the far vent's landing and cache, riders, the wraiths and notched hulls, the
  comet's return and the beacon.

**Risks:**
- The ice gates change shared collision, so they need golden traces.
- Crowded copies need a cap and an overflow.
- A 3-hour cadence suits an occasion but punishes someone who just missed it.
- The escalation must stay readable, so ships appear at range, with no spawns on top of a pilot.
- Lore: the hints must stay arguable. If playtesters read the notched hulls as "obviously the Halden", tone the look
  down, not the owners' lines up. Nothing may say the comet or the cloud wants anyone gone.

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
   - Once the comet has left the system, leaving it puts you in the Far Cloud, which wakes up after half an hour.
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
- the exit rule either side of T0, into a sparse Far Cloud;
- the first two steps of its escalation (watchers, rime packs);
- the slow way home.

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
   - Is about 20 minutes from entry to T0, plus up to 15 more inside, the right length for a full stay?
   - One public instance per passage, with an overflow copy above a cap (16?), or one copy per party, as sieges do?
   - Which activities first? My order: hearths and core sampling, then thaw salvage, charting, chimneys, the clutch.
   - Should geysers push ships (shared flight code, golden traces), or only damage and heat (server-side, safer)?
   - Which of the three ways home first? The slow way is the minimum.
   - The Far Cloud's escalation: is 30 quiet minutes right, and how steep should it get (+25% every 10 minutes)?
   - Do the lore hints (whiskered cores, rime dust's hum, the notched hulls, the Ark tender's half hour) sit at the
     right subtlety, or should any be cut?
   - Should the clock be one per passage (as proposed), or should each pilot get their own from their arrival?
   - What should the Far Cloud hold, and should it get a boss eventually?
