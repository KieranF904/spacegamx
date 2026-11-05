# Awareness: cells, effects not sources, encode once (design, 2026-11-04)

Status: **partly built** (phases 1, 3 and 4: see section 11's status lines). It sits on docs/design/netcode-lockstep.md (the lab's awareness,
pull-in and slots), docs/design/decision-inputs.md, docs/design/confirmed-hits.md parts C-G,
docs/design/packed-frames.md, docs/design/deterministic-maths.md and the two 2026-11-04 audits
(docs/audits/lockstep-alignment-2026-11-04.md, docs/audits/optimisation-before-after-2026-11-04.md). Code references are
to the working tree on `refactor/split` at 764619d.

## 0. Kieran's decisions (2026-11-04; they override the text below where they differ)

- **Cells.** Fixed 8,192-unit grid, origin at the system centre.
- **Focus = every cell within 19 km of your ship**, picked by distance, one flat threshold (no in/out hysteresis, no
  anchor cell), fixed whatever the zoom. A cell counts when its nearest point is within 19 km. That is 27 cells on
  average (25-30), about 1,800 km², roughly a third of today's 5,000 km² view circle (the 3x3 was 576 km²). Simulated bit
  for bit on the client's tick layer.
- **Fade from 18 km.** The client draws entities as ghosts from 18 km in, by distance, purely visual: nothing on the wire
  depends on it.
- **Ring = every cell within 35 km**, ghosts only, not simulated, flat threshold. About 75 cells in all, so about 48
  beyond the focus.
- **Dropped-cell cache.** (Superseded 2026-11-05, protocol 49: no log or replay. A ship leaving view is remembered at
  both ends for minutes and comes back with its keyframe and only what changed since: docs/areas/networking.md "The
  focus grid", docs/audits/focus-reentry-deltas-2026-11-05.md. The original text follows.)
  When a cell leaves the focus the client keeps its state, stamped with the drop tick, for 10 s.
  On re-entry it sends (cell, tick T, hash H). If the server's recorded hash for that cell at T matches and the cell's log
  since T is smaller than a snapshot, the server sends the log (inputs, decision inputs, entry records) since T and the
  client fast-forwards. Otherwise it sends a snapshot. The server keeps per-cell encoded logs for the hold period, shared,
  with no per-client cache state. The client caps its replay length.
- **No context inheritance. Effects, not sources.** Server-resolved scheduled waypoints go to focus entities whose target
  is outside the focus, and are derived locally when both ends are simulated. Updates are tick-stamped, at a predictable
  (not fixed) cadence when the server wants one.
- **Rebuilds at most once per ship per tick**, batched like damage.
- **Large ships** (255-part limits, turret arcs) are out of scope here.
- **Crowds (added 2026-11-05).** 300 pilots in one system is not a target: up to about 100 a system is, in smaller
  groups. A dense system degrades gracefully by three fallbacks, per system and automatic, each told to its clients
  stamped with a tick: a smaller focus, a wider snapshot window, then time dilation. They replace the per-entity crowd
  budget (phase 7, open question 7). Built: section 7.11.

Where the text below says "3x3", "9 cells", "the 16-cell ring", "anchor cell", "anchor hysteresis" (h_f) or "recentre",
read the rule above. What this changes:

- No anchor: the focus set is recomputed from your ship's position each window, so it moves by whole cells exactly when a
  cell's nearest point crosses 19 km. Dithering on a threshold costs a drop and a re-entry, which the 10 s cache makes
  cheap (a log replay, not a snapshot). That replaces the hysteresis; the bench counts re-entries and their size.
- The nearest focus edge is 19 km away at the nearest point, further on most sides: weapon reach never meets the edge,
  and resolved streams (6.6) are needed only for entities near the focus edge whose target is further out.
- Estimates (section 9): the focus is about 3x the cells of the 3x3 (27 vs 9) and about a third of today's view; the ring
  is 48 cells, not 16. Scattered and front layouts hold about 3x more pilots than the 3x3 figures say (still about a third
  of today); the ball is unchanged (everyone is in everyone's focus). Server cost per client is the same shape, with a
  larger constant, and the crowd bench (docs/audits/crowd-baseline.md) is the yardstick.
- Cell snapshots: a 19 km move is 2-3 cells at a time on the leading edge (about 3-5 new cells a second at cruise), so
  the log-replay cache matters more than the snapshot cache in 7.3.

## 1. Summary

**The problem.** The snapshot path does most of its work per client, multiplied by every ship in the system. Each snapshot,
for each client:

- `updateShipView` scans the system's ships.
- `systemRows` is built once per system, but each client walks all of it with its own keys (`lastEntityStates`).
- `Replication.forClient` walks every shadow.
- `sendShipUpdates` diffs that client's own copy of every ship's structure and part HP (`shipSynced`, `shipHpSent`).
- `HitLedger.plan` works out every hit again on that client's HP copy.
- A per-connection `PackedEncoder` bit-packs every byte, and permessage-deflate compresses it again per socket.

Today's view is 40 km in, 48 km out (`SHIP_VIEW_IN/OUT`), so in a busy system almost everyone is in almost everyone's
view. The cost is clients × entities, and the bytes grow with N² (optimisation audit: 20 heavy fighters, 221 KB/s egress).

**The recommended model**, in six rules:

1. **Cells.** Each system is cut into a fixed grid of square cells, 8,192 units a side. Every entity has exactly one
   **home cell** (where it is, with a little hysteresis). A cell is a list, not a copy of anything.
2. **Focus = every cell within 19 km of you.** Your client simulates, bit for bit, every entity homed in those cells
   (about 27), by distance, with no hysteresis (section 0).
   **Context ring = the cells within 35 km.** It is not simulated. It carries ghosts (low-rate closed-form legs, as
   map dots do today), designs and names sent ahead so an entry later is small, and nothing else.
3. **Send effects, not sources.** Things are self-contained by default:
   - A shell entering your focus from outside comes with its own entry record. Its parent never joins your set.
   - A bump, a pull or a told hit from an entity you don't hold arrives as a cause or result record, at its tick, on the
     entity you do hold.
   - An entity in your focus whose behaviour depends tick by tick on something you don't simulate (an NPC chasing a
     pilot in the ring, a missile chasing a target outside) gets **server-resolved controls**. That is its scheduled
     waypoints, a point and the tick to reach it sent 16 ticks ahead, flown by a shared steering law in common. It lasts
     as long as the dependency does, and the client never simulates the target.
   - When both ends are simulated, the client works the waypoints out itself and nothing is sent.
   - **Nothing needs inheritance** (simulating an outside entity), so context never chains (section 6).
4. **Cells are closed under simulation.** Any interaction between entities homed in different cells goes as a record.
   Given its records and its entities' resolved streams, a cell can be stepped on its own. That is what lets any client compose its focus from any 9 cells,
   and lets a cell's entry snapshot be encoded once and reused.
5. **Encode once.** The shared unit is an **entity block**: one entity's records for one snapshot window, bit-packed once
   with per-system wire ids and delta-coded against that entity's previous block. Every holder has every block since it
   entered, so the delta base is the same for everyone. On top of the entity blocks:
   - each cell adds cell records (births, removals, rock overrides) and **directional inflow blocks** (arrivals across
     each of its 8 borders);
   - a client's frame is a header, its own channel, and a copy of the blocks it needs.
6. **One wire shadow per entity, not per client.** "What holders have of it" (motion, part HP, structure, row key) is kept
   once per entity, because every holder got the same stream. Disagreement detection is:
   - that shadow, which is free and is the server's side;
   - a per-cell hash the clients send (1 byte a cell, rotating), plus the existing hit, own and body chains.

   Per-client state shrinks to the focus set, the own channel, the confirm level and a design set. Which resolved
   streams a client takes follows from its focus each window.

**What it buys** (section 9):
- **Server CPU** goes from clients × system entities to entities + clients × bytes copied.
- **Per-client bandwidth** in spread-out fights falls by a quarter to three quarters from the smaller focus alone
  (a 19 km focus, about a third of the area of a 40 km radius), and further, to roughly the input floor, as decision inputs and derived HP
  land.
- **A ball of 300 pilots** in one place stays O(N) per client and O(N²) in egress. No interest scheme removes that:
  everyone there is relevant to everyone. Encode-once makes it affordable in CPU. An in-focus priority budget (phase 7)
  is what would make it affordable in bytes.

## 2. Today, in the code

| per-client structure (ClientConnection) | what it is | cost shape |
|---|---|---|
| `shipView` | ships within 40 km (out at 48 km), party, target | a scan of every system ship, per client per snapshot |
| `lastEntityStates` (host map, by pilot) | every row's key as last sent | every system row compared, per client |
| `repKnown` | keyframe version per ship | `forClient` walks every shadow, per client |
| `shipSynced`, `shipHpSent` | that client's copy of each ship's structure and part HP | a diff per ship in view, per client; `HitLedger.plan` re-derives every hit on it |
| `debrisHeld`, `debrisRowOk` | debris it was told to derive and its acks | per client |
| `sentNames`, `designs`, `knownEntities` | one-time sends | per client |
| `packed` (PackedLink, PackedEncoder) | slots, last values, guesses | every byte bit-packed per client; the writer also builds a decoded copy (packed-frames.md, "Open") |

The motion shadow itself (`Replication.shadows`) is already **one per ship**, shared by every client, with per-client
knowledge only as a version number. The per-ship caches `hpWireOf` and `syncWireOf` are already "work out once per
snapshot". The design generalises what Replication already does for motion to everything else, and moves the per-client
part from "a copy" to "which blocks".

## 3. Research: how others do it

Links were fetched or seen during this research unless marked *unverified*. Summaries of long pages came through a fetch
tool, so the exact figures are "as summarised".

### 3.1 EVE Online (Destiny, ballparks, bubbles): the closest precedent

- **Model.** Destiny is a deterministic simulation that the server and every client run on the same code. The server
  simulates every ball in a system (the "ballpark"). The client simulates only the subset in its bubble ("grid"), from
  an initial state plus timestamped commands. With no course changes, nothing goes on the wire. Sources: Facing Destiny
  (https://www.eveonline.com/article/facing-destiny), Halldor Fannar's GDC 2008 talk "The Server Technology of EVE
  Online" (https://www.gdcvault.com/play/110/The-Server-Technology-of-EVE; slides
  https://slidetodoc.com/the-server-technology-of-eve-online-how-to/). The talk defines a "causality bubble" as the union
  of the spheres of influence, extruded in time, of the objects that touch the client: the same idea as an influence
  footprint.
- **Boundary.** On entering, the server works out the bubble's contents and sends them as the initial state. After that
  it sends only timestamped "state patches". A CCP post-mortem from 2003
  (https://www.eveonline.com/news/view/unscheduled-downtime-20-00-20-30-and-ctd) describes the dependency failure we must
  avoid. An NPC orbited a proximity sensor. The bubble's contents were sent but the sensor wasn't, because it "doesn't
  affect state", so the client crashed evolving an orbit with no target. CCP's fix was to warn and evolve incorrectly
  rather than crash. Lesson: **a simulated entity's dependencies must be explicit and shipped with it** (our section 6
  list), and a missing one must degrade, not crash. Message names from community emulators (`SetState`, `AddBalls`,
  `RemoveBalls` on a grid crossing) are *unverified*.
- **Cost.** "Fixing Lag: Drakes of Destiny" part 2
  (https://www.eveonline.com/news/view/fixing-lag-drakes-of-destiny-part-2-1) is the encode-once precedent. The
  add/remove pass had been O(observers × balls) and took over 15% of CPU in a mass test. CCP rebuilt it as one list per
  bubble with each ball's data gathered once, and serialised once per bubble, then one memcpy per observer.
  Part 1 (https://www.eveonline.com/article/fixing-lag-drakes-of-destiny-part-1-1) found desyncs from iteration order:
  a subset iterated in a different order from the superset. We already sort by id for the same reason (decision-inputs
  rule 5).
- **Overload.** When a node can't keep up, Time Dilation slows that node's clock (down to 10%) rather than dropping work
  (https://www.eveonline.com/news/view/introducing-time-dilation-tidi). Not right for an action game, but it is the
  honest answer to "a crowd in one cell": the cost there is inherent.
- **Grids.** Grids were dynamic and players manipulated them ("grid fu"). They were later made much larger (8,000 km,
  per forum and secondary sources). No primary source was found on bubble hysteresis or exit rules. **Fixed cells avoid
  the class of bugs and exploits that dynamic grids brought.**

### 3.2 Unreal Engine: Replication Graph and Iris

- **Grid with footprints.** The Replication Graph (https://dev.epicgames.com/documentation/unreal-engine/replication-graph-in-unreal-engine?lang=en-US)
  exists because per-actor, per-connection relevancy checks were Fortnite's server bottleneck (100 players, about 50,000
  replicated actors). `GridSpatialization2D` adds "Actors into each grid cell or room from which that Actor can
  potentially be seen or heard". Source walkthroughs (for example https://mapz.github.io/2021/11/24/UE4%EF%BC%9AReplicationGraph%E7%BD%91%E6%A0%BC%E5%90%8C%E6%AD%A5%E6%B5%81%E7%A8%8B%E5%88%86%E6%9E%90/)
  say a dynamic actor's `NetCullDistance` is turned into a cell rectangle, and cells are added and removed incrementally
  as it moves. A viewer just takes its cell's list. This is influence registration in a shipping engine.
  Static-actor handling is *unverified*. The grid node's API is at https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/ReplicationGraph/UReplicationGraphNode_GridSpatia-?lang=en-US.
- **Encode once.** The "fast shared" path (`FFastSharedReplicationInfo`,
  https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/ReplicationGraph/FFastSharedReplicationInfo)
  serialises a bunch once and reuses it across connections.
- **Dormancy.** An idle actor costs nothing. A dormant actor out of relevance is destroyed on the client after a cell TTL:
  a grace period, which is hysteresis in all but name.
- **Priority.** Priority accumulates from distance, starvation and game boosts.
- **Iris** (https://dev.epicgames.com/documentation/en-us/unreal-engine/introduction-to-iris-in-unreal-engine) keeps one
  quantised copy of all replicated state and does the quantise, compare and serialise work once, shared by every
  connection. It has a grid filter (`UNetObjectGridFilter`) and a priority that accumulates until an object is sent
  (https://dev.epicgames.com/documentation/en-us/unreal-engine/iris-prioritization-in-unreal-engine).
- **For us:** Iris's "one quantised copy" is exactly the per-entity wire shadow (rule 6).

### 3.3 Photon Quantum (deterministic predict/rollback)

- **What it culls.** "Prediction culling" (https://doc.photonengine.com/quantum/current/manual/prediction-culling)
  limits only the *predicted* frames to an area. Verified frames still simulate every entity: the filters "return all
  active instances when simulating a verified frame". Culling saves speculative CPU and hides nothing.
- **Cost of culling.** Culled entities can look different on screen. A shared RNG between culled and unculled entities
  makes the predicted and verified sequences part, so Quantum says to use one RNG per entity
  (https://doc.photonengine.com/quantum/current/concepts-and-patterns/optimizations).
- **No server AOI.** No server-side interest management for Quantum was found; Fusion, the non-deterministic product,
  has one (https://doc.photonengine.com/fusion/current/manual/advanced/interest-management).
- **For us:** a fully deterministic engine still simulates everything on the verified timeline. A hybrid that simulates
  only part of the world must, as we do, make everything outside it arrive as records. Quantum's per-entity RNG lesson is
  already our rule (`tickRng`, `hashUnit`).

### 3.4 SpatialOS (Improbable)

- **Interest.** Interest is read access through queries: sphere, box or relative constraints, class constraints, and
  "always interested". It is separate from authority, which is write access
  (https://patents.google.com/patent/US10579434B2/en; Unreal GDK docs via
  https://github.com/spatialos/UnrealGDK/pull/1201/files/e3461e210281a62a27327b81b38feb4f06919af5).
- **Cost.** Overlapping queries are merged so shared data goes once. GDK defaults: 150 m cull, characters 200 m,
  vehicles 400 m, plus lower-frequency outer rings. Improbable's own docs hosts no longer resolve.
- **For us:** queries by class (bosses farther than ships) are the right shape for the ring's prefetch, but a full query
  language is overkill.

### 3.5 MMO interest-management literature

- **Aura and nimbus.** Benford and Fahlén (ECSCW 1993,
  https://perso.lisn.upsaclay.fr/mbl/ENS/CSCW/2021/papers/Benford_CSCW1993.pdf) separate **focus** (where an observer
  attends) from **nimbus** (where an object projects its presence). Awareness of B by A is a function of A's focus and
  B's nimbus, and it is asymmetric. This doc uses Benford's words: our "influence footprint" is a nimbus, and the focus
  is our "focus". Boulanger et al. use "aura" and "nimbus" the other way round.
- **Grid versus radius.** Boulanger, Kienzle and Verbrugge (NetGames 2006,
  http://www.sable.mcgill.ca/~clump/papers/boulanger-06-comparing.pdf) compared eight AOI algorithms on real player
  traces. Square tiles (your tile plus 8 neighbours) cost a constant per query. Hexagonal tiles sent only 17% more updates
  than an exact radius. Smaller tiles filter a little better but cost much more CPU. Over-sending nearby state is
  defensible, since "missed interaction" is the worse failure.
- **HLA region matching.** HLA Data Distribution Management matches update regions to subscription regions by overlap.
  Grid-based matching (register a region in every cell it overlaps, then test exactly within a shared cell) is the
  standard way to make it cheap (Petty,
  https://www.uah.edu/images/research/cmsa/pdf/Pubs_Dr_Petty/Petty%202002%20Comparing%20DDM%201.3%20%201516.pdf).
- **Hysteresis.** No primary paper found on flapping. Practice is subscribe-near, unsubscribe-far
  (https://www.gamedev.net/forums/topic/609123-interest-management-in-an-mmo/), which the game (40/48 km) and the lab
  (1,500/1,700, plus 3 s sticky) already do.

### 3.6 Halo: Reach and Tribes (priority and scoping)

- **Tribes.** The TRIBES engine networking model (Frohnmayer and Gift,
  https://www.gamedevs.org/uploads/tribes-networking-model.pdf):
  - The simulation "scopes" objects per client.
  - Entering scope creates a ghost by guaranteed delivery; leaving scope deletes it.
  - Each ghost has a state mask of independent groups.
  - A packet is filled by status changes first (creates, deletes), then by priority, under a per-client bandwidth cap.
- **Halo: Reach.** In "I Shot You First" (Aldridge, GDC 2011, slides
  https://slidetodoc.com/i-shot-you-first-gameplay-networking-in-halo/), priority is computed per object per client
  from distance, direction, size, speed and boosts for shooting and damage. Packets are filled by priority, with no hard
  cull. Bandwidth grows about O(N²); about 1 kbit/s per biped per client.
- **For us:** creates (entries) jump the queue, but a cap on them per packet keeps a mass entry from starving
  everything else.

### 3.7 Valorant fog of war, Counter-Strike PVS (information leaks)

- **Valorant.** Riot's "Demolishing wallhacks with Valorant's fog of war"
  (https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war) builds on Unreal relevancy. An actor that
  isn't relevant to a player isn't sent. On the client it is made invisible and intangible, then despawned. When it is
  relevant again it is respawned and caught up.
  - **Pop-in.** Each actor's box is grown by its velocity × a look-ahead longer than the ping.
  - **Cost.** The first version used about 50% of server frame time; it now uses under 2%, by precomputed
    potentially-visible sets and "stays relevant briefly".
  - **Pitfall.** Logic driven by one-off events (RPCs) instead of state broke on re-entry (a defuse animation reset to
    the default pose). Riot fixed it by restartable, fast-forwardable effect containers.
- **Counter-Strike.** The Source engine sends only entities in the client's PVS
  (`SHOULDTRANSMIT_START`, dormant on exit;
  https://github.com/ValveSoftware/source-sdk-2013/blob/55ed12f8d1eb6887d348be03aee5573d44177ffb/mp/src/public/iclientnetworkable.h, *seen in search, not read*).
- **For us**, two lessons:
  - Grow the focus ahead of motion. The anchor hysteresis and the jump destination prefetch (section 7.4) do this.
  - **An entry must carry state, not replay events.** A boss telegraph or a beam under way must be in the entry as state
    ("ticks left"), as BossFx already draws.

### 3.8 Lockstep RTS and Planetary Annihilation

- **Age of Empires.** "1500 Archers on a 28.8" (Bettner and Terrano, GDC 2001,
  https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond):
  every machine simulates everything from commands, and desyncs are caught by checksums. There is no partial simulation,
  so fog of war lives inside the shared state and a maphack is possible. **This is where pure lockstep stops**: it
  cannot hide anything, and its per-client CPU is the whole world. No shipped lockstep game simulating only the visible
  part was found.
- **Planetary Annihilation.** ChronoCam (https://www.forrestthewoods.com/blog/tech_of_planetary_annihilation_chrono_cam/)
  is curve-based state sync, not lockstep:
  - A player gets curves only for its units and what they can see. An idle unit costs 0 bytes.
  - A cheater forcing fogged units visible sees only the last curve sent.
  - Our ring ghosts are the same thing: closed-form legs, sent again only on change.
- **Gaffer on Games.** "State synchronization" (https://gafferongames.com/post/state_synchronization/) describes the
  **priority accumulator**: each object adds its priority every frame, and a packet is filled in accumulator order under
  a budget; sent objects reset, so nothing starves. "Deterministic lockstep"
  (https://gafferongames.com/post/deterministic_lockstep/): bandwidth follows input size, not object count.

### 3.9 Others, briefly

- **Star Citizen.** "Network bind culling" and object container streaming load and unload per client around its
  position, with a "bloated" radius for radar and missiles (https://starcitizen.tools/Object_Container_Streaming).
- **PlanetSide 2.** No primary source on its relevancy was found. Community claims (about 1 km render for infantry and
  vehicles, threat-based selection) are *unverified*.
- **Overwatch.** Its GDC 2017 talk is about ECS and prediction, not relevancy.
- **Rollback (GGPO).** The whole state on every peer, with no interest management. Only Quantum's culling is relevant, and
  it culls prediction only.

### 3.10 The netcode lab (our own prototype)

docs/design/netcode-lockstep.md section 7, prototypes/netcode-lab/labserver.js `needs()` and `bundle()`:

- **Awareness.** A 1,500 / 1,700 radius, then **unlimited** pull-in closure since 2026-11-03 (it began as one hop). An
  AI needs its target and next target; a ship needs the shooters of shells that can reach it; a shooter needs the rocks
  its shells can reach.
- **Stickiness.** A pulled-in entity stays 3 s. With 1 s, 38% of entries were re-entries.
- **Results.** Unseen hits went to zero. The price is the set: with 24 bots around you, the client held 62 of 95
  entities on average (later 75 of 111). The lab's own open question 1 is "how big does the closure get in a crowded
  world?"
- **Other mechanisms.**
  - Slots per client: lowest free, quarantined for max(60 ticks, RTT + 250 ms), with 15 s of slot history.
  - A shell is named by (shooter slot, shot number).
  - Rock overrides go only if they changed since the client's copy was last right, which needs per-client memory.
  - `GONE` records for shells that hit something the client doesn't hold.
- **This design keeps** shell naming by owner and shot number, rock overrides, GONE, orders decided ahead and the 2 s
  background hash.
- **It replaces** pull-in closure with effects-not-sources (section 6), and per-client slots with per-system wire ids
  (section 8.6).

## 4. The recommended design

### 4.1 Terms

| term | meaning |
|---|---|
| cell | a square of side **C = 8,192** units in one system, fixed, indexed by `(floor(x / C), floor(y / C))` |
| home cell | the one cell an entity's records go in: the cell its position is in, changed only once it is `h_e = 256` past the border |
| anchor cell | (dropped: the focus is picked by distance, section 0) |
| focus | every cell whose nearest point is within 19 km of the client's ship: every entity homed there is simulated on the client's tick layer |
| ring | every cell within 35 km that is not in the focus: ghosts, prefetch, nothing simulated |
| footprint (nimbus) | the cells an entity's reach touches: its home cell ± `ceil(reach / C)` (section 7.1) |
| entity block | one entity's records for one snapshot window, encoded once |
| cell records | births, removals, rock overrides and destructions in a cell for one window |
| inflow block | per cell and per border direction (8): arrivals into this cell across that border, this window |
| resolved stream | an entity's tick-stamped waypoints (or, for a bodied boss, its controls and push), made by the server, which flies on them too; taken only by clients holding the entity but not its target (section 6) |
| waypoint law | the shared steering law in common that flies an entity to a scheduled waypoint (a point and the tick to reach it), and the planner that makes the waypoints when the target's state is known (6.3) |
| wire shadow | per entity: what every holder has of it (motion as today's Replication shadow, part HP as told, structure as told, status row key) |

### 4.2 The invariants

1. **Holders have every block.** A client that holds an entity has had every one of its blocks since it began holding
   it, plus an absolute starting state: its entry, in a cell snapshot or an inflow arrival. So one delta base serves
   every holder, and the wire shadow is everyone's copy.
2. **Cells are closed.** An interaction between entities homed in different cells is always a record:
   - a cross-cell contact as a cause with the other's state (part G's `CONTACT_FLAG.STATE`);
   - a pull as a cause;
   - a splash, chain or beam result as a told result;
   - a shell crossing a border as an arrival.

   An interaction inside a cell is derived by every holder of that cell (once its rule is in common). A cell can be
   stepped alone, given its inflows and the resolved streams of those of its entities whose targets are homed elsewhere
   (section 6).
3. **Inflows are directional.** A client takes cell b's inflow block for direction d exactly when b is in its focus and
   the neighbour of b in direction d is not. By induction, every entity homed in a focus cell is held: it was born there
   while the client had the cell, or it came in a cell snapshot, or it crossed from a focus cell the client held, or it
   arrived through an inflow the client took.
4. **Records are client-independent.** Whether a hit is told or findable, whether a shell is an arrival, whether a ship
   needs a keyframe: these are decided per entity, never per client. Per-client streams carry only the client's own
   ship, its validation level, which resolved streams it takes and its personal messages.

### 4.3 What a client's frame is

```
frame(client, window) =
    header (tick, own-channel length, the list of blocks that follow by id)
  + own channel (own row and causes, own told hits, hitFix, netCaps, personal messages: encoded per client)
  + for each focus cell: its cell records + the entity blocks of the entities homed there
  + for each focus cell: its inflow blocks for the directions that face out of the focus
  + the resolved-stream sub-blocks (waypoints) of focus entities whose target it doesn't hold
  + cell snapshots for cells that came into its focus this window
  + ring: ghost legs that changed, prefetch (designs, names) for the ring's entities it lacks
```

Everything but the own channel and the selection is encoded once per window, shared by every client that takes it,
and copied in. Today that work is done per client.

### 4.4 Each of Kieran's ideas

| # | idea | verdict | why, and how it changed |
|---|---|---|---|
| 1 | Batch rebuilds on the same increment as damage, at most once per ship per tick | **Adopted, refined** | Mostly true today: hits mark `ship.dirty`, and ships.tick step 3 rebuilds once. But direct `rebuildNow` calls remain (ghost, refit, heal, repair paths in bridge/damage.ts and rebuild.ts). A 3-tick window can hold several rebuilds, which costs keyframes ("rebuilt twice in a window", part G). Refined: one rebuild point per tick at a fixed phase; the rebuild becomes a stamped event in the ship's block; the structure as told lives once on the wire shadow, so a `shipSync` is encoded once per rebuild for all holders (`syncWireOf` is halfway there). The phase 0 bench counts rebuilds per ship per tick and per window first. |
| 2 | A spatial grid instead of per-client copies; 3×3 awareness per cell, rows encoded once and shared | **Adopted: the core** | Refined in two ways. The shared unit is the entity block, with cells as lists of blocks (as the Replication Graph and EVE's per-bubble lists), so inflows and resolved streams reuse the same bytes. The per-client copies are replaced by one wire shadow per entity, which needs invariant 1. |
| 3 | A context ring around the 3×3, not everything sent, maybe ghost graphics; a ship entering the 3×3 that interacts with the ring is pulled in | **Ring adopted; pull-in rejected** | The ring is ghosts plus prefetch plus the hysteresis band. "Pulled in because it interacts" is replaced by "its effect comes as a record, or its dependent gets resolved controls" (rule 3). |
| 4 | Snapshot shells and effects as they enter awareness, at the right tick, instead of pulling in parents | **Adopted: the default** | Shells get an arrival record in the inflow block of the border they cross, at the crossing tick. Needs shells quantised at spawn (confirmed-hits D8.1) so an arrival of about 12 B is exact. |
| 5 | Every entity and shell has its own context zone; derivable from its origin means no snapshot; a zone change sends one snapshot of everything new, bullets included | **Refined** | Derivability is built into invariant 3: a shell born in a cell you hold is derived; one crossing from a cell you hold needs nothing; one from outside comes through the directional inflow. The server keeps **no per-client derivability bookkeeping**. A focus change sends **cell snapshots**, one per (cell, tick), shared and cached (section 7.3). Per-entity zones (footprints) remain for prefetch, priority and spotting couplings, not for deciding what is derivable. |
| 6 | The ring fully simulated, drawn as ghosts, desync checked less often | **Rejected as the default** | 16 more cells to simulate is 2.8× the simulated streams and the client CPU. Worse, a ring entity simulated wrongly feeds the focus through the shells and contacts it derives, so a lower check rate there is a correction risk inside the focus. Section 5 has the table. |
| 7 | Everything registers in every zone its influence reaches; the ring isn't simulated unless its interactions cross in | **Refined** | Registration is kept, coarse and cheap (section 7.1). "Becomes simulated when an influence crosses" becomes "the influence crosses as a record". A continuous dependency becomes a resolved stream on the dependent (section 6). |
| 8 | Context inherited along a chain or tree of interacting cells | **Rejected as a mechanism, kept as a safety net** | Section 6.7: an unbounded closure turns a connected battle into the whole battle (the lab's data). With effects as records and resolved controls, nothing outside the focus is simulated, so the chain has depth zero. A light-cone bound (a test assertion) and a per-client stream budget only cap the pathological case. |
| 9 | Self-contained by default; inheritance only for continuous couplings | **Adopted** | Section 6.1: arrivals, then records, then resolved controls. The coupling table (6.4) leaves nothing that needs inheritance. |
| 10 | The remaining cases as "send its controls": server-resolved, tick-accurate controls for an entity in focus while it depends on something outside | **Adopted: replaces inheritance** | The decision-input pattern generalised: one stream per entity, encoded once, taken only by clients that lack the dependency. Sent as scheduled waypoints rather than per-tick controls (row 11). |
| 11 | Lower steering resolution: set points every N ticks flown by a shared steering law; then scheduled waypoints sent ahead, spaced by distance, with replacements on a swerve | **Adopted, merged** | One waypoint law per kind (6.3): the point and its arrival tick, planned 16 ticks ahead, spacing from time-to-target, a swerve check every 4 ticks. The set point is the decision, so the server flies on it too. |
| 12 | Proximity-based update rates | **Adopted, split** | For simulated entities, spacing follows the entity's distance to its own target or goal (game state, the same on every side). Per-viewer distance sets only unsimulated rates: ring ghosts, visual detail. Brain-made streams have no cadence rule at all: tick-stamped updates whenever the brain decides (6.3). |
| 13 | Derive set points locally when both ends are simulated | **Adopted: the default** | Missile guidance, mob follow and the AI pilot's fighting spot run on the client from shared state; nothing is sent. Brains with hidden choices still send decisions. A simulated ring would make more targets derivable, but it costs far more than the streams it saves (6.5). |

## 5. The context ring: simulated or not

Four options, per client, for the entities homed in its 16 ring cells. B is idea 6, C is idea 7 as first put, and D is
the recommendation.

| | A. ghost data only | B. fully simulated, ghosted, checked less | C. simulated only when an influence crosses in | **D. A + effects as records + resolved controls (recommended)** |
|---|---|---|---|---|
| bandwidth | legs on change, about 2-6 B/s an entity | full input, decision and fire streams of 25 cells instead of 9 (+178%) | A, plus a snapshot of each entity as it becomes simulated, plus its dependencies (the chain) | A, plus arrival and effect records only for what reaches the focus, plus waypoint streams for the few focus entities chasing something outside (about 0.2 KB/s in a busy front: 6.6) |
| server CPU | ghost legs encoded once per cell | encode once, but 2.8× the copies per client | per-client "what has crossed" bookkeeping, closure per client per tick (the lab's `needs()` is shells × ships) | inflows per cell border, encoded once; no per-client closure |
| client CPU | trivial | 2.8× the tick layer and hit finding | between A and B, spiky | the focus only |
| correction risk | none (not on the tick layer) | high: wrong ring state feeds focus hits and contacts, and a lower check rate means later fixes | must switch an entity to simulated *before* its influence lands (the lab stamps pull-ins about 15 ticks ahead from shell lines); late means a correction | none from the ring: everything that crosses is the server's record |
| complexity | low (map dots exist) | medium | high (switching, chains, stickiness) | medium (inflows, the coupling list) |
| what entering the focus costs | an entry (small, since the design and name are prefetched) | nothing | nothing for what was switched on | an entry (small) |

**When something does become simulated, what is sent:**

- **An entity entering the focus by moving.** Its arrival in the inflow block of the border it crossed. The arrival holds
  its state at the crossing tick, exact: body, held controls, its body's state if bodied (SYNC), status row, part HP
  against the prefetched design, its shot counter. Its live shells are separate entities with their own arrivals.
  Inputs from that tick on come in its block.
- **A cell entering the focus** (the client moved). That cell's **snapshot**: every entity homed there, as above; its
  live shells; rock overrides for rocks in it; pods. One per (cell, tick), shared by every client entering that cell
  then. Cached, too: snapshot(T0) plus the cell's blocks and inflows for T0..T serves an entry at T (section 7.3).
- **An entity that loses its target from the client's set.** No entry: the client holds it already. From that tick on
  it takes the entity's resolved stream. The server keeps that stream anyway (its own flight runs on it), so it costs
  only the copy.
- **Not "the parent's inputs from that tick".** Inputs are only enough with the state they start from, and the state is
  the entry.

## 6. Send effects, not sources

### 6.1 The rule

Kieran's rule, as refined in conversation. Three mechanisms, in order of preference:

1. **Self-contained entries.** An entity that crosses into the focus brings its own state: an arrival, or a cell
   snapshot. A shell from outside needs nothing from its parent.
2. **Effect and cause records.** A one-tick effect from a source outside the client's simulated set, onto an entity in
   its focus (or straddling it), goes as a record on the receiver at its tick. Examples: a bump, a pull, a told hit, a
   splash. The client applies it the way the own ship already applies a knock's cause. The source needn't be simulated.
3. **Server-resolved controls.** An entity *in* the focus may behave, tick by tick, according to something the client
   doesn't simulate. Examples: an NPC chasing a pilot in the ring, a homing missile chasing a target outside.
   - The server sends that entity's resolved, tick-stamped controls or set points, for exactly as long as the dependency
     lasts: until the target is held again, or the entity leaves the focus.
   - The client simulates the entity from those and never simulates the target.
   - This is the decision-input pattern generalised: a stream of a few bytes, one per entity, encoded once and taken
     only by the clients that lack the target.

**Inheritance** (a client simulating an outside entity over time) is needed for nothing today (6.4).

### 6.2 Set points and shared steering laws

Kieran's "lower the steering resolution": every steered kind is split in two.

- **A set point**: where the entity is heading. That can be a waypoint, a fighting spot, an intercept point, or a
  heading.
- **A steering law** in common: detTrig, turn-rate limited. It flies the entity toward its set point every tick, on the
  server and on every client.

The server's own simulation flies on the same set points, so **the set point is the decision**: both sides fly
identically. This is the commander/pilot split (decision-inputs 6.5) at a coarser grain. Turn limits keep the motion
smooth between updates.

**Who makes the set point decides how it travels:**

| maker | examples | on the wire |
|---|---|---|
| a **shared guidance law**: deterministic, no hidden logic or randomness, reading only the entity's own state and its target's | homing missiles, torpedoes and seekers (intercept point from the target's state); mobs' follow point; an AI pilot's fighting spot and aim point, worked out from its order with strafe way and aim error frozen into the order; the traffic autopilot along a leg | **nothing, when the entity and its target are both held: the client works the set points out itself (the default).** Otherwise the server's own outputs of the same law, as a stream, to the clients that lack the target |
| a **brain**: hidden choices or randomness | the AI commander (`ORDER`, `TARGET`, `WAYPOINT`), boss moves (`MOVE` and seed, `SIDE`, `STAGE`), patrol picks | decisions, as decision-inputs.md: always sent, tick-stamped, 16 ticks ahead where it can see them coming |

**A sent stream from a law is the law's output.** The server works the law out anyway, to fly the entity, so the stream
is just what it got. That is why a missile can switch between derived and sent mid-flight without changing a bit: its
target leaves your focus, and from that tick you take its stream. The switch is per client and the stream is per
missile. The client knows when to switch: it holds the missile and can see that it lacks the target.

### 6.3 Scheduled waypoints, and the cadence

Kieran's two refinements: steered entities follow **scheduled waypoints** (a point and the tick to reach it, sent
ahead), and their update rate depends on **proximity**. Both must respect one constraint: the server's own simulation
flies on the same waypoints.

**The waypoint law** (common; the set point of 6.2 made concrete). It is one flight model per kind, whether a client works
it out itself or is sent it:

- **Plan.** At a plan tick P, the planner predicts the target's position at the arrival tick A = P + L. That is the
  target's state at P carried on linearly; for a fighting spot, the target's state plus the order's offset. It quantises
  the point and makes it waypoint W, to be reached at tick A.
- **Fly.** Each tick the steering law flies toward W, timed to arrive at A, within the kind's turn and thrust limits.
- **Queue.** The next waypoint is planned at A - 16, so it exists 16 ticks before the current one is reached. Flight
  carries on through A with no gap, and a sent waypoint has a 16-tick lead buffer.
- **Swerve.** Every 4 ticks (on the 4-tick grid, staggered by wire id), the planner checks the target against the plan.
  If the target's predicted position at A has moved from W by more than max(64, 0.15 × the remaining distance), it
  issues a **replacement**: a new W and A, effective at the next grid tick (4 to 7 ticks later).
  - A replacement has a shorter lead than a planned waypoint. The tick-aligned layer still never sees it late
    (decision-inputs 2.3: decisions are in before the snapshot that covers their tick).
  - Only the drawn layer of a client whose own predicted ship is the target can see a missile swerve a few ticks late,
    and it is put right as today.
- **Spacing L** follows the time to intercept, τ = remaining distance / closing speed in ticks, rounded to the 4-tick
  grid:

| τ (ticks to target) | > 240 | 120-240 | 48-120 | 20-48 | < 20 (terminal) |
|---|---|---|---|---|---|
| homing missile, torpedo, seeker | 48 | 32 | 16 | 8 | 4 |
| mob (mite, drone, kamikaze) | 32 | 16 | 8 | 4 | 4 |
| AI pilot (fighting spot and aim point from its `ORDER`) | 60 (cruise, patrol: per leg) | 32 | 16 | 8 | 8 |

  - Far from its target, a missile commits to a point for most of a second. That makes it a little more dodgeable at
    range, as Kieran expects; a balance pass follows.
  - Close in, it replans every 4 ticks and stays lethal.
  - Traffic, escort wards and boss flight keep their decisions (`WAYPOINT` per leg; `WANT` and `MOVE`).
  - A guided missile's waypoint is its owner's cursor point: derived from the owner's inputs when the owner is held, and
    otherwise the owner's aim changes as a stream.
  - Tow and pod tractor laws run every tick (cheap, both ends attached or held).

**Who sends what, simply:**

- **Both ends simulated** (the entity and its target are held): the client runs the planner at the same plan and check
  ticks as the server, and **nothing is sent**. This is the default.
  - The cadence must be deterministic here, and it is: spacing and swerve checks follow game state (τ, the target's
    motion) and the tick, never a viewer.
- **The target not held:** the server sends the waypoints its planner made, tick-stamped, as the entity's waypoint
  stream. It is one stream per entity, shared by every client lacking the target and by the server's own flight. It is
  the same records the planner would have given that client, so switching between derived and sent mid-flight changes
  nothing.
- **Brain-made streams** (an AI commander's waypoint, a boss's move): **no cadence rule at all.** The brain sends a
  tick-stamped update whenever it decides (a new waypoint, a retarget, a sharp turn), and the client applies it at its
  tick. The only constraint is one stream per entity, shared by every client and the server's own simulation, so it
  can't vary per viewer.
- **Per-client view distance is used only for unsimulated data:** ring ghost rates, particles and trails, map dots.
  None of these are on anyone's tick layer.

**Quantisation:**

- **A waypoint** is relative to the entity's position at its plan tick, in steps of 4 units, signed 13 bits a component
  (±16 km), plus its arrival as a step of 4 ticks (5 bits: up to 124 ticks).
  - Both sides fly the quantised point, so it is exact by construction.
  - 4 units is under every hull, a missile's fuse and a fighting spot's slack.
- **An aim point**, where a law needs one beside the waypoint, uses q13 (the cursor grid).
- **A throttle**, where a law needs one, uses 4 bits (steps of 1/16, as `ctlOfPower`).
- **A record** is [dt][op 4 bits][dx 13][dy 13][arrive 5], about 5 B, or about 3-4 B as a step from the entity's last
  waypoint. It is a new decision op, `WAYPOINT` with an arrival tick (the existing op gains a field); wire bump.

**Overhead against per-tick resolved controls,** per entity whose target isn't held:

| kind | per-tick resolved controls | scheduled waypoints |
|---|---|---|
| homing missile | a turn a tick, 1-2 B: 60-120 B/s while in your focus | The stream itself: 5 B per 48 ticks far (6 B/s), per 16 mid (19 B/s), per 4 for its last ~20 ticks (75 B/s); about 15-25 B/s over a 4-5 s flight, plus about 1 replacement a second against a swerving target. **Per client it is far less** (Kieran's point): a missile in your focus whose target is outside is heading out of your focus, and leaves it long before the endgame. It costs you one or two midcourse waypoints, **5-10 B in all**. The fine endgame waypoints go to nobody who holds the target: those clients work the endgame out themselves. Only a client holding the missile but not its target at the end gets them, which is rare, since by then the missile is beside its target |
| AI pilot in a fight | control rows on change, about 50 B/s (pirates: 328 B/s for 5-7 AI) | 5 B per 8-16 ticks: **about 20-35 B/s**, aim included |
| AI cruising or patrolling | about 5-10 B/s | about 5 B a leg: under 1 B/s |

Per client: missiles about 10-20× less (a missile that only passes through your focus costs 5-10 B, against 60-120 B/s
for as long as it is there); AI in combat 1.5-2.5× less. The 16-tick lead makes a late waypoint rare.

### 6.4 Every candidate coupling, and what carries it

| coupling | carried as | inheritance? |
|---|---|---|
| a straight shell crossing in | **arrival** (spawn point, velocity, spawn tick, gun, owner, shot number, pierce passes); exact once spawns are quantised | no |
| an end-at-aim shell (mortar, aim burst) | arrival with its end tick | no |
| a homing shell in focus, target held | **derived**: its guidance law (6.2), state in its arrival or fire event | no |
| a homing shell in focus, target not held | **resolved set points**: its scheduled-waypoint stream (6.3) | no |
| a guided shell, owner not held | resolved set points: the owner's aim stream | no |
| an NPC or AI pilot in focus, target held | derived: its law from its `ORDER`, plus decisions | no |
| an NPC or AI pilot in focus, target not held | **resolved set points**: its waypoint stream (fighting spot and aim point), plus its decisions | no |
| a bodied boss in focus, target not held | **resolved controls**: its body's controls and push per change (Replication already records them for the bodied shadow), plus its outputs as records (fire events with aim, which exist; strikes and telegraphs as records). The rows path the legacy and STRICT clients already use, encoded once | no |
| a bodied boss outside, working on the focus (a magnet following it, strikes, beams, its shells) | **records**: pull causes on the pulled ships (part G's `PULL`, about 3 B a tick each), strike and telegraph records with place and tick, shells as arrivals | no |
| a contact or bump with a ship homed in another cell | **cause** with the other's pre-contact state (part G's contact row with STATE) in the receiver's block; cross-cell pairs never go through anyone's own contact pass | no |
| debris knocked by debris a client doesn't step | keyframed, as today (`Replication.knocks`) | no |
| splash, part blasts, chain and Tesla hops, EMP, frost | told results, status records | no |
| a held beam from outside (laser, lance, frostbite, Cutter, Tesla, Searchlight, repair, mining) | records: beam on and off, aim changes on the beam (drawn from the shooter's ghost), hits told. Even once beam damage is derived on clients, a beam crossing a focus border keeps its hits told: a few records a second while it lasts | no |
| tow beam, berthed and docked ships | **attachment**: the towed or berthed body is homed in its tower's or station's cell, so a pair never straddles a border | no |
| a static pull field (a collapsing star, a parked singularity orb) | one decision record {centre, r, k, until} (alignment audit group B) | no |
| gravity, stars, lodestones, planets, rock orbits, station orbits | world data both sides derive | no |
| an AI commander choosing a target across cells | server only; its decisions ride its block once held | no |

**What truly needs inheritance: nothing.**

**An optional optimisation, not the default: a shared target.** When several held entities chase one target the client
doesn't hold (three or more, say), their set-point streams together cost more than the target's own control rows. The
client may then take the target's rows (its resolved controls, also a shared stream) and work the chasers out itself. It
is a byte trade, never needed for correctness. Measure it in phase 6.

### 6.5 Should the ring be simulated, now that set points derive when both ends are held?

A simulated ring would make more targets derivable, and so need fewer set-point streams. It doesn't pay:

- **The saving.** In a busy front (L2, N = 100, lockstep-target bytes), the streams it would save are about 0.2 KB/s per
  client (6.6).
- **The cost.** Simulating the ring costs that ring's whole input stream, about 0.2 × 99 × 150 ≈ 3 KB/s, plus 2.8× the
  client's tick-layer CPU.
- **The problem only moves.** The ring's own outer entities then chase targets beyond it and need streams of their own.

So the ring stays unsimulated (section 5's option D), and derivation is the default only where both ends are already in
focus.

### 6.6 What resolved controls cost in a busy fight

Per client, in the busy front L2 at N = 100, with the lockstep-target bytes of section 9:

- **AI near the focus edge chasing a target outside.**
  - The edge band within AI reach (about 2.5 km of a 24 km focus) is about 37% of the focus area. About half of the AI
    there chase across, so about 18% of the AI in focus.
  - With 30 AI in focus, that is 5 entities × about 30 B/s of waypoints = **about 150 B/s**. As per-tick resolved
    controls, about 250 B/s.
- **Missiles in focus whose target isn't held.**
  - Each heads out of the focus and costs one or two midcourse waypoints before it leaves.
  - Say 3 a second pass through on their way out × 2 × 5 B = **about 30 B/s**. As per-tick turns while in focus,
    about 2 s each: 360-720 B/s.
  - Most missiles fired inside a focus chase targets inside it, at zero bytes.
- **Total: about 0.2 KB/s** while a fight sits on the focus edge (mostly AI), against 0.6-1 KB/s for per-tick resolved
  controls. 0 in a ball (L1: every target held). A few B/s scattered (L3). Every stream is encoded once, however many
  clients take it.

### 6.7 Kieran's chain/tree idea, assessed

Idea 8: a cell becomes context for you if it interacts with one that already is, chaining outward.

- **Blow-up risk.** In a connected battle (A fights B, B fights C, along a front), the closure is the whole front.
  Every pilot holds the battle, which is the N² of today with more CPU per client. The lab's data says the same at
  small scale: with no limit the client held 62 of 95 entities with 24 bots around it, later 75 of 111. Kieran's "I
  doubt it gets out of hand" holds for scattered fights; it fails exactly where the cost matters, in a large engagement.
  EVE's equivalent (grids merging into one bubble that holds everyone) ends in time dilation.
- **Prior art bounds it** by geometry (EVE bubbles, Unreal cull distances: no transitive pull-in at all) or by budget
  (Tribes, Halo, Gaffer: priority under a byte cap). None found chains interest transitively. Correction of the brief:
  the lab's pull-in isn't one hop. It was until 2026-11-03, and is unlimited since.
- **Kieran's own refinement removes the need.**
  - Influences carry their own context: a shell's arrival, a bump's cause.
  - Outside dependencies of focus entities come as resolved controls.
  - So no outside entity is ever simulated, and **the chain has depth zero**.

**The causality bound** (the coordinator's suggestion, checked):

- **The bound.** Influence travels at a finite speed. An error at distance d from the focus reaches it no sooner than
  d / v_max ticks. A chain therefore only needs to be deep enough that anything beyond it can't reach the focus before
  a check would have caught and fixed it.

  D = ceil(v_max · T_fix / C) cells

  - v_max is the fastest influence carrier: about 150 u/tick for a rail shell, 195 with Coil boost; 340 for a jumping
    ship, if a jump can touch anything.
  - T_fix is report cadence + one-way trip + judging + the fix's trip.
- **Numbers.**
  - At NORMAL, about 6 + 5 + 12 + 5 = 28 ticks: 195 × 28 = 5.5 km, so D = 1 cell.
  - At ROUGH, up to about 90 ticks: 17.5 km, so D = 3.
- **Verdict.** The bound is right in shape: depth needn't scale with the size of a battle, only with the check latency.
  But it only matters if a client simulates something from inferred state, and with effects, records and resolved
  controls none does.
- **Keep it as a test assertion.** Every influence landing on a focus entity from a source more than v_max · T_fix away
  must have been a record or a resolved stream by its tick.
- **Keep it as an emergency depth** if a future mechanic needs real chained simulation.

**The budget, the last safety net.** At most **64 resolved streams** per client, ordered by a Gaffer-style accumulator
(distance to the client's ship, and anything targeting it, first).

- Over the cap, the furthest dependent entities drop off the tick layer to a drawn-only state: interpolated rows, their
  shells and hits told.
- That costs more bytes and some exactness at the edge, and is never wrong.
- It should never trigger outside a crowd (6.6's numbers are 5-15 streams at a time).

## 7. The questions, answered

### 7.1 Influence registration

**Recommendation: yes, every entity registers a coarse footprint.** It is its home cell ± k cells, k =
ceil(reach / C), kept as a rectangle. It is used for:

- ring prefetch: designs and names of entities whose footprint covers your focus, sent at low priority;
- threat priority for ghosts and budgets;
- spotting couplings early.

It is **not** used for deciding what is simulated or derivable. Records and inflows do that.

Reach per kind (data/ships/tuning.json `weapons`; reach of a shell = speed × life, or maxSpeed × life):

| kind | reach | today's numbers |
|---|---|---|
| ship | the largest of: its guns' shell reach (augments included), its beams' range, tow range, its hull radius plus contact margin | shells: flak 1,700, Spark (arc × 5 life) about 3,300-4,000, cannon 7,200, rail driver 9,000 (11,700 with Coil boost), missile 11,440, torpedo 7,800; beams: Searchlight 7,650, laser 5,100, Tesla 660, Cutter 900. Most ships k = 1; long-range builds k = 2 |
| shell | its remaining line: its **itinerary**, the list of (cell, entry tick) along its straight path, worked out once at spawn; homing and guided shells: a circle of remaining speed × life, recomputed on each course record | the itinerary schedules the inflow arrivals exactly, with no per-tick test |
| beam | part of its ship's reach | |
| AI | its commander's sense radius (who it may pick), as well as its ship reach | lab: 1,600-2,500 |
| boss | its attack reach (bosses.json ranges 800-1,800), magnet and intake radii, body reads | k = 1 |
| pull field, orb | its radius | |
| gravity, planets, stars, lodestones | none: world data both sides have | |

**Kept cheaply:**

- The rectangle changes only when the entity's **home cell** changes, or its **reach** changes (a rebuild, refit or
  augment: rebuild already recomputes `derived`). Both are rare. Using the home cell rather than the exact position costs
  at most one cell of slack and removes all per-tick work.
- Per cell, a "reachers" list (entities homed elsewhere whose footprint covers it) is updated on those two events only.
  It costs 9-25 entries per ship. This is the Replication Graph's incremental add and remove.

**Alternatives looked at:**

- A per-tick exact radius per pair: the lab's `needs()` is shells × ships per tick, too dear at 300.
- Exact positions in footprints: per-tick churn for no gain.

### 7.2 Hysteresis and churn

- **Ships on cell borders.** Home-cell hysteresis h_e = 256: a ship changes home only once it is 256 into the next cell,
  so dithering on a border costs nothing. Each real change costs an arrival only in the inflow blocks of clients that
  had the old cell but not the new one, which are few.
- **The focus edge.** Superseded (section 0): a flat 19 km threshold, no hysteresis. A cell crosses it as your ship
  moves; dithering costs a drop and a re-entry, and the 10 s dropped-cell cache turns the re-entry into a log replay.
  At 1 km/s a cell enters about every 8 s per leading edge.
- **Ships at exactly weapon range.** Not a boundary any more: nothing is pulled in by range, so there is nothing to flap.
  The lab's 3 s stickiness is no longer needed for that.
- **Fast ships crossing many cells.**
  - Cruise and boost: a few crossings a minute.
  - Jump: 340 u/tick (20 km/s) crosses an 8 km cell every 24 ticks. For **the jumper**, the burn is a transit: no tick
    layer, ghost data only. The destination is known at charge start (90 ticks before), so the destination's 3×3
    designs prefetch during the charge, and its cell snapshots go at the burn's end tick. The burn costs one focus entry,
    not one every 0.4 s.
  - For **observers**, a jumping ship crosses their focus as an arrival and an exit. Shells can't come from it during
    the burn.
- **Teleports, respawns, system changes, rifts.** A full focus entry: 9 cell snapshots. Respawns already happen at the
  end of a tick, the lab's rule.
- **A cell's exit.** The client holds a dropped cell for 10 s (section 0 and 7.3), so re-entry costs a log, not a snapshot.

### 7.3 Cell entry snapshots: shared and cached

Dropped-cell cache (Kieran, section 0): the client keeps a dropped cell stamped with the drop tick for 10 s and sends
(cell, T, H) on re-entry. If the server's hash for that cell at T matches and the log since T is smaller than a snapshot,
it sends the log and the client fast-forwards, else a snapshot. The server keeps shared per-cell encoded logs for the
10 s hold period and nothing per client; the client caps its replay length. What follows is the snapshot cache, which
still serves first entries and mismatches.

- **Shared.** A snapshot of cell c at tick T is the same for every client entering c at T, so it is encoded once.
- **Cached.** Snapshot(T0) plus c's blocks and its inflows (all 8 directions) for T0..T is a valid entry at T. Invariant
  2 makes c steppable alone over T0..T, and the client drops duplicates of entities it already holds by id. So a cell is
  snapshotted at most once per K = 60 ticks however many clients enter it. The price:
  - the tail's bytes (at most a second of the cell's blocks);
  - the client fast-forwarding the cell (the lab's catch-up runs 30 ticks a frame).
- **Rebuild the snapshot** when the tail would be bigger than a fresh one.
- **Order.** Entries go first in a frame (Tribes: status changes first), at most 2 cells a window; the rest wait a window.
  An entity in a waiting cell that reaches the client's own ship is moved up by priority.

### 7.4 Cell size

**Recommendation: fixed, C = 8,192 (2^13, cheap to index).** The constraints:

- **Coupling reach must be ≤ C.** AI sense, boss reach, tow and contacts then stay within one cell of their receivers,
  so a focus entity's target is in its own cell or the next, and resolved streams are needed only near the focus edge
  (6.6). All of these are 0.3-2.5 km.
- **The focus should hold what you can fight up close.** A 6 km minimum edge distance covers the Spark (4,000), every
  beam but the Searchlight, flak, EMP and mortars. Rail (9-11.7 km), cannon (7.2), missiles and torpedoes from beyond it
  are arrivals: exact, about 12 B a shell, and only those whose itinerary enters your focus.
- **The screen.** The furthest flight zoom (InputManager `minZoom` 0.04) shows about ±24 km by ±13.5 km. Focus plus ring
  covers ±14 to ±22 km, with simulated motion inside 6-14 km. Further out, ghosts and today's map-dot legs (SimLod
  routes, `MAP_DOT_SLACK`) draw what's there.
- **Density.** A 19 km focus is about 27 cells, 1,800 km², against today's view circle of about 5,000 km² (40 km
  radius): about three times less area to simulate in spread-out play (the 3x3 was nine times less).
- **Smaller cells (4 km)** would put fights 3 km away into the ring, as unsimulated ghosts at the default zoom, and
  multiply arrivals. **Bigger cells (16 km)** bring today's 40 km view back.

**Adaptive** (quadtree, or splitting dense cells): rejected for the stream unit.

- Splitting and merging churns subscriptions, delta bases and caches, which are what make encode-once work.
- Dynamic boundaries were EVE's long-running source of grid bugs and exploits.
- A crowd's cost isn't a cell-size problem: 300 pilots in a 5 km ball fill any cell scheme.

Adaptivity belongs **inside** the focus as a per-client priority budget (phase 7), where it changes only which blocks a
client takes, not how blocks are made.

### 7.5 Dropping the per-client shadows

**What replaces them as the disagreement detector:**

1. **The server's side: the per-entity wire shadow.** It is Replication's shadow extended. The server compares its real
   entity with what holders have, after each tick, once per entity:
   - motion: as today;
   - part HP as told: today `shipHpSent`, per client;
   - structure as told: today `shipSynced`, per client;
   - status row key: today `lastEntityStates`, per client.

   A difference becomes a record in that entity's block (a keyframe, an HP record, a sync), for every holder at once.
   This costs no client anything.
2. **The client's side: hashes.**
   - The event chains stay as they are: hits (part D), own ship (part G), bodies (decision inputs), at their part E
     levels.
   - New: a **per-cell background hash**. The server computes, once per check tick (every 30 ticks), a 32-bit hash per
     occupied focus cell over the entities homed there, in id order, and keeps 4 s of them (cells × 4 B × 8 check
     ticks). A client sends 1 byte, the low byte of one of its focus cells at one check tick, rotating through its 9
     cells.
     - Cadence per zone: focus cells every 2 s each at NORMAL (4.5 B/s up for 9), every 6 s at ROUGH, every 0.5 s at
       STRICT. The ring has no hash (nothing simulated).
     - A mismatch twice running gets that cell's snapshot, shared and cached, with the client STRICT for it.
   - The lab's 2 s per-entity hash generalised, at a ninth of the bytes.
3. **Rotations and costs.** The server's per-cell hash is O(entities) every 30 ticks, not per client. A client is judged
   against a number already computed.

**Residual per-client state, unavoidable:**

- the focus set and anchor (9 cells and a tick);
- which resolved streams it takes (worked out each window from its focus and the targets in its entities' state, so
  nothing stored);
- its own channel: its own shadow version (`Shadow.own`), own causes, own checks, input queue, late flags;
- its hit journal: only for hits told *to it alone* (hits on its own ship, and everything at STRICT);
- its `ConfirmLevel`;
- the designs it has (a set of hashes, or a cache hash it reports on join);
- the per-client codec state of its own channel;
- chat, economy, party and map;
- its socket.

All are O(1) or O(its own activity), none O(system entities).

### 7.6 Encode once: ids, slots, deltas

**Ids: per-system wire ids with prefix widths, not per-client or per-cell slots.**

- **Per-client slots** (today's PackedEncoder, the lab) are what force per-client encoding: a reference means a
  different number to each client.
- **Per-cell slots** break on every border crossing (an entity changes number), break for footprints and for streams taken from other cells (one
  entity, several cells), and need a per-cell slot table in every cell snapshot.
- **Per-system wire ids** are a dense number per entity, allocated lowest-free with the lab's quarantine (max(60 ticks,
  largest RTT + 250 ms)), and mean the same to everyone. Coded with a 2-bit prefix: 0-63 in 8 bits, 64-575 in 11, up to
  4,671 in 14, else 18. Pilots and large ships live longest and take the low numbers.
  - The cost against per-client slots: about 2-4 bits per reference. A window has about one reference per entity, so
    this is noise against the CPU it saves.
- **Shells take no ids.** A shell is (owner wire id, shot counter mod 256). The counter is part of every entity's state,
  so it is in entries. A fire event then carries no ids at all, and removals, hits and GONE name a shell in 2-3 B.
  - The server keeps the map to its entity ids (decision-inputs 6.3, option 2, "derived ids"). The packed codec's
    "client needs the real entity ids" (packed-frames.md, "Shells") stops being true once removals, hit hashes and
    records all use this name.

**Delta bases are per entity.** An entity's block is coded against its own previous block (the packed codec's
guesses, moved from per-connection "last values" to per-entity), which every holder has by invariant 1. An arrival or
entry is absolute and resets the base for new holders; it equals the old holders' base by definition (the state at the
end of the last window).

**Frames are byte-aligned blocks.** Each block is padded to a byte, so a client frame is header + memcpy. The padding
costs about 4 bits per block, about 2 B/s per held entity at 20 Hz. Bit-concatenation with shifts is the alternative if
those bytes matter.

**Deflate.** For packed clients, turn permessage-deflate **off**:

- Packed frames barely compress: Hammerhead 961 raw against 926 deflated, packed-frames.md.
- Per-socket deflate is per-client CPU that undoes the sharing: zlib runs per socket, and its output can't be shared.

### 7.7 Derivable means never sent

**How the server decides per client, cheaply:** it doesn't.

- **The decision is per border.** At spawn, each shell's itinerary is computed. At each crossing tick, an arrival goes
  into the destination cell's inflow block for that border, encoded once.
- **Each client picks.** It takes the inflow blocks whose border faces out of its focus (invariant 3). A shell from a
  cell it held, or that crossed through cells it held, comes through no block it takes; it derived it.
- **One deduplication rule.** An arrival for an entity the client already holds (it entered a cell's snapshot and its
  inflow in one window) is dropped by id.

**What it must remember per client, and for how long:** only the current focus and the tick it changed. Focus changes
happen only at window boundaries, so the inflow choice for every record in a window uses one focus.

Nothing per shell and nothing per client per entity. Wire-id quarantine (global) covers id reuse, as the lab's slot
history did, for 15 s.

**Effects other than shells:**

- told results (splash, chains, burns), causes (contacts, pulls) and status changes go in the receiving entity's block,
  so every holder gets them;
- detonations and other eye-and-ear effects in the ring go as ghost effects (lazy, low priority), and beyond the ring
  not at all.

### 7.8 Bosses and AI with decision inputs at the boundary

- **Decisions ride the boss's or AI's block.** BodyNet's decision log per boss becomes that boss's block content:
  "decisions are the same for every client in a system: encoded once" (decision-inputs 4.1), now literally.
- **Entry** carries the SYNC (body state) in the boss's entry. That exists today: BodyNet syncs a boss a client can newly
  run. A boss entering mid-move sits that move out for that client (decision-inputs 2.4).
  - With shared blocks, the "sits it out" path is the boss's **rows variant**: keyframes plus control rows, encoded once
    per boss, only while some holder needs it.
  - Generally, an entity has up to two encodings a window:
    - **sim**: inputs, decisions and causes;
    - **rows**: motion as control rows and keyframes.

    Rows are made only if a holder takes them: a STRICT client, a client holding the boss but not its target, a
    client sitting a move out.
- **The body reads its target.** That is a coupling (6.4):
  - **A boss in focus, its target held:** the client runs the body. BodyNet's "can run" test (body on, in view, target
    itself or a ship it has) becomes "boss held, target held".
  - **A boss in focus, its target not held:** its resolved stream, which is the rows variant. That is the body's
    controls and push per change (Replication records them for the bodied shadow today), its fire events with their
    aim, and its strikes and telegraphs as records. The client never simulates the target.
  - **A boss outside the focus, working on it** (a magnet pulling a pilot at the focus edge, strikes landing there):
    records. Pull causes on the pulled ships, strike and telegraph records, shells as arrivals.

  No boss is ever simulated from outside the focus.
- **Cadence.** A boss's decisions are brain-made, so they have no cadence rule (6.3): tick-stamped when the brain
  decides, 16 ticks ahead where it can see them coming.
- **The 16-tick lead and coalescing are unchanged.** A decision is in the block for the window of the tick it was
  decided, before its effect tick.
- **The AI commander/pilot split** (decision-inputs 6.5) works the same way.
  - The commander's ORDER, TARGET and WAYPOINT decisions ride the AI's block. They are brain-made: tick-stamped when it
    decides.
  - The pilot is the waypoint law (6.3): a fighting spot and aim point planned from its order and its target's state.
    It is derived on the client when the target is held, and its resolved stream when not.
  - The commander's choice of a target in another cell is server-only and costs nothing. With AI sense of 2.5 km or
    less against C = 8 km, the target is in the focus or the ring, so streams are needed only near the focus edge.

### 7.9 Asteroids

Rocks are already seeded, plus an override table. With cells:

- **Home cell.** A rock's home cell at any tick follows from its orbit, which both sides compute (deterministic since
  the orbit sweep, with the f32 rule still to settle: alignment audit group F).
- **Entry.** A cell snapshot carries the overrides of rocks homed in that cell: damaged HP, or the destruction tick.
  These are few, so no per-client "changed since its copy was last right" memory is needed. The lab's rockSig was
  per-client memory that bought 67% fewer override records; with shared snapshots the dedupe goes, and overrides are
  2-6 B each.
- **Destruction** is a cell record in the rock's home cell. Regrowth after 90 s is derived from the destruction tick.
- **A rock crossing a cell border by its orbit** carries its override in the destination's inflow, if it has one.
  Orbits are slow, so this is rare.
- **Hits on rocks** stay told until rock HP is exact (blocked: alignment audit section 4). Then they are an intra-cell
  interaction like any other.
- **`asteroidSeed` on system entry** stays as it is (all rocks' parameters, by ranges).

### 7.10 Failure modes and security

**Information leaks:**

- **Ring ghosts** reveal positions out to about 22 km at low rate. Acceptable: the screen shows that far at full zoom,
  and today's 40 km view reveals more, exactly.
- **Inputs of everyone in focus** at full precision (aim, cursor distance) are already the cost of lockstep (the lab's
  open question 7). Inputs say no more than the motion they make.
- **Arrivals** reveal a shell's spawn point, so the shooter's position at the fire tick, even outside your focus. They
  are on screen anyway.
- **Boss decisions** 16 ticks early: accepted in decision-inputs 9.
- **Shared blocks can't hide per-viewer secrets.** Cargo contents, loot rolls, a cloak or a team-only beacon must never
  be in an entity block. If a hidden-entity mechanic is ever planned, it needs per-team block variants (an open
  question).

**Cheating via awareness:**

- **Focus is the server's.** It is computed from the ship's position on the server, so a client can't subscribe to
  distant cells.
- **A client lying in hashes** spoils only its own view (part E1).
- **A client asking for resyncs to flood** the server or learn things: cell snapshots on request are rate-limited (one per
  cell per 2 s, beyond that refused), and a snapshot only ever covers its own focus.
- **A modified client keeping exited entities** sees only stale state, as with PA's fogged units.

**The worst case, a crowd in one cell:**

- **Server CPU** stays O(entities) to encode plus O(clients × bytes) to copy, and copying is memcpy. Section 9 has the
  numbers.
- **Bandwidth** is inherently O(N) per client and O(N²) egress.
  - The input floor: about 90-150 B/s per held pilot, so about 45 KB/s per client at 300.
  - The VPS's uplink is shared with other projects (memory: vps-deploy), and 300 × 45 KB/s is 13.5 MB/s (108 Mbit/s).
- **Client CPU** stepping 300 replicas and casting every shell against every ship is the unmeasured risk. A client
  broadphase grid in SelfHits is needed past about 50 ships.
- **The answer is the crowd fallbacks (section 7.11), not a per-entity budget** (Kieran, 2026-11-05: they replace it).
  Everything held stays exact; a crowded system shrinks its focus, widens its window, then slows its clock.

### 7.11 Crowd fallbacks (built 2026-11-05: `CAPS.CROWD` 16384, protocol 41)

Kieran's decision: up to about 100 pilots a system is the target; these are tools for the rare dense case, per system
and automatic, applied in this order as the system's tick cost rises over budget and undone in reverse as it falls.
Each is told to the system's clients as a `crowd` message (tick, level, focus radius, window, rate), stamped with the
system tick it takes effect from. Code: common `network/crowd.ts` (the levels), server `net/crowd/CrowdControl.ts`
(costs, levels, telling), `sim/SystemClocks.ts` (each system's clock), client `state/GameState.ts` (`onCrowd`, the
clock) and `ui/TimeScaleBadge.ts`.

| level | focus | window | ticks/s | stage |
|--:|--:|--:|--:|---|
| 0 | 19 km | 3 | 60 | none |
| 1-3 | 16, 13, 10 km | 3 | 60 | 1: focus |
| 4-5 | 10 km | 6, 9 | 60 | 2: window |
| 6-9 | 10 km | 9 | 45, 30, 20, 15 | 3: dilation |

**Measuring and hysteresis.** Each base tick, the tick's time is shared out to systems by how many ships each has, and
each snapshot round's per-client time goes to that client's system; an own-clock pass (below) is charged whole to its
system. The cost is smoothed (α 1/30 per base tick). A system goes up a level when its cost has been over 13 ms for 30
base ticks running, at least 90 after its last change; down one when under 6 ms for 300 running, at least 300 after.
The gap (more than 2×) is wider than any one level's saving. `/crowd [0-9|auto]` (admin) pins a level for testing; with
no argument it prints the level and cost.

**1. Focus.** `FocusCells.view` takes the radius from the system's level; the ring stays 35 km. Cells past the new
radius drop as any leaving cell does (kept 10 s, the cache answers on the way back). The client's ghost fade follows:
the last km inside the radius (`ghostWeight(dist, focus)`).

**2. Window.** Snapshot rounds are per system: `SnapshotBuilder.due()` runs every 3 base ticks as always, minus the
systems whose wider window hasn't come round. What a round lets go of is let go only for the systems it was for:
removals and their wire ids, fire events, debris splits and touches, knocks, the shadows' windows (`Replication.begin/
endSnapshot(due)`), the hit records (`HitLedger.endSnapshot(skip)`). HUD numbers go in the round inside each second's
first window. Clients' own inputs still go on change; other pilots' ride the snapshots, so they relay later. The tick
layer simply waits longer (it was already driven by snapshot ticks); the client adds `(window - 3) × tick` to its
interpolation delay.

**3. Dilation.** Systems used to tick together, so this needed per-system scheduling:
- **Own clocks.** A dilated system takes a clock of its own (`SystemClocks`): an integer accumulator steps it `rate` of
  every 60 base ticks. Its tick is its own count of steps, so it falls behind the server's; the step is the same (same
  dt), so its simulation is unchanged and deterministic, only slower in real time. A rate change is said 30 of its
  ticks ahead and takes effect there on both sides. Back at full rate it keeps its own clock (still behind) until
  nobody is in it, then rejoins the server's.
- **Passes.** `GameServer.tick` walks the table in passes (`SimPass`): the main pass is every system on the server's
  clock at the server's tick; then each own-clock system due a step has its own pass at its own tick (`currentTick` is
  that tick for the pass, so everything that reads the tick reads the system's): its clients' inputs, the tick entries
  marked `pass` in the table (tickOrder.ts), then its snapshot round when its window comes (`ownRound`). Pass-aware
  entries skip what isn't the pass's (`SimPass.on`): station orbits, pilots, tows, docking, rifts, guns, shells, enemies,
  bosses, mobs, collisions, lod, the ships' walks (bodiesNow, shields, blasts, burns, kits, repair, rounding, contacts),
  replication, self hashes, lifetimes. The rest (economy, events, sieges, surfaces, pods, mining, hazards, cleanup) run
  in the main pass only, at the server's tick, for every system: in a dilated system they run at real-time pace.
- **Messages** from a client in an own-clock system are handled at that system's tick (`handleMessage`).
- **Travel** between systems on different clocks moves the ship's tick fields by the difference (`rebaseShipTicks`)
  and the server's tick-keyed notes of its client (`changeClock`: scheduled inputs and hashes dropped, live and sent
  ticks moved, its hit journal afresh). The client is told the new system's clock on entering (its tick now, its rate)
  and takes it at once.
- **Client.** `GameState.onCrowd`: a rate change turns the clock at its tick, carrying on from where it is; a tick far
  from its estimate (another system's clock) is taken at once. Prediction follows the clock (one step per tick number),
  so the pilot's own ship slows with the system. The HUD shows `TIME ×0.50` while slowed.

**Measured** (crowd bench `--crowd`, blocks bulk; docs/audits/crowd-fallbacks-2026-11-05.md): ball 300 climbs to level 9
in about 25 s and settles at 13.1 ms a base tick (budget 16.7; 35-48 ms without), 16 tick-layer disagreements in
150,753 checks. Ball 100 stays at level 0 until its hostiles pile up, then settles at level 5 (14.4 ms). Ball 50 and
spread 50/100 stay at level 0.

**Known gaps.**
- A dilated system's step lands in one base tick: at level 9 the base tick that carries it costs about 45 ms (p95 37-68
  ms at ball 300). Spreading a step over base ticks would need the step itself split.
- Main-pass-only entries see a dilated system at the server's tick: an event's or a zone's timers, set there, run in
  real time; one module setting a tick that a pass-aware one compares (an event's arrivals for the enemies) is off by
  the lag. Rare paths; none on the tick layer.
- A dilated system rejoins the server's clock only once nobody is in it.
- Legacy clients in a dilated system get snapshots at its ticks; their clock follows pongs (it snaps when far off),
  so they see it slowed with some jitter.

## 8. Today's mechanisms, mapped

| today | in this design |
|---|---|
| `shipView` (40/48 km radius, party, target) | the focus (cells within 19 km, flat); party and target as ghosts in the ring or the map unless in focus |
| `systemRows` built per system, then filtered and keyed per client | entity blocks built once per entity; cells list them |
| `lastEntityStates`, `repKnown`, `shipSynced`, `shipHpSent` per client | the wire shadow, per entity |
| `Replication.forClient` per client | gone: keyframes and control rows are block content |
| `HitLedger.plan` per client on its HP copy | per hit, once: told or findable for every holder; the per-client journal only for own and STRICT hits |
| `debrisSplit` per client, held and acked | a record in the parent's block; holders derive; the check folds into the cell hash; wrong means a cell resync |
| `broadcastNear` FX within 48 km | the cell's block for focus holders; lazy ghost effects for the ring; nothing beyond |
| projectile rows for out-of-view shells within 12 km (`SNAP_PROJECTILE_RANGE`) | arrivals in inflow blocks, exact |
| mob rows within 12 km | mobs in their home cell's blocks (rows today; the waypoint law after alignment group G) |
| AI control rows on every change (`Enemies.fly`), homing shells resent as rows on each course change | the waypoint law (6.3): derived when the target is held; otherwise scheduled waypoints, a few bytes per 8-48 ticks |
| BodyNet `OFF` (a boss a client can't run goes back to rows) | the boss's resolved stream (its rows variant), encoded once, for clients holding the boss but not its target |
| `sendMapDots` (legs past the view) | unchanged beyond the ring; the ring uses the same legs at a ghost rate |
| PackedEncoder per connection | per-entity encoders (sim and rows variants), per-cell records and inflows; one small encoder per client for its own channel |
| SimLod (distant ships off-line past 52 km) | unchanged: a dormant ship's cell has no holders |

## 9. Estimated costs

Back of envelope. The inputs are measured; the layouts and the model are not.

### 9.1 Inputs

- **Per pilot, own costs**, from the optimisation audit, caps 255, deflated:
  - alone: 92 B/s;
  - its own heavy fight: 445 B/s (Hammerhead);
  - headers: about 650 B/s at about 10 messages/s, coalesced.
- **Per other pilot near and fighting**, measured today: 520 B/s (Hammerhead), 150 (Pips), 657 (pirates). This model
  uses Hammerhead's 520: fire events, keyframes, status rows, HP, hit records.
- **The same pilot at the lockstep target** (decision inputs, groups B-E of the alignment audit): about 150 B/s. That is
  its control rows, 93 B/s packed and measured in the upload probe, plus about 50 of fire events, plus about 10 told
  residue. About 100 once guns are stepped on the tick layer.
- **A ring ghost:** 5 B/s (legs on change).
- **Arrivals:** about 12 B a shell, only when its itinerary enters your focus from outside it.

### 9.2 Layouts (every pilot fighting; NPCs left out)

- **L1, the ball.** All N within 5 km. Everyone is in everyone's focus and in today's view.
- **L2, the front.** N spread along an 80 km by 8 km line.
  - Today's 40 km view sees on average 75% of the line.
  - The focus (24 km wide) sees about 30%, and the ring another 20% as ghosts.
  - Arrivals at the focus edges: about +100-400 B/s.
- **L3, scattered.** N/5 groups of 5 over about 200 × 200 km.
  - Others in today's view: 4 + 0.126 (N - 5).
  - In focus: 4 + 0.014 (N - 5).
  - In the ring: 0.026 (N - 5).

### 9.3 Download per client, B/s (deflated payload; add about 650 B/s of headers to each)

"Cells" means phases 1-6 with today's derivation level: the same bytes per held pilot, fewer pilots held. "Target"
means cells plus the lockstep target per pilot.

| layout | N | today | cells | target |
|---|---|---|---|---|
| L1 ball | 20 | 10,400 | 10,400 | 3,400 |
| | 100 | 52,000 | 52,000 | 15,400 |
| | 300 | 156,000 | 156,000 | 45,400 (about 15-25 K with the phase 7 budget, unproven) |
| L2 front | 20 | 7,900 | 3,500 (+arrivals) | 1,400 |
| | 100 | 39,100 | 16,100 | 5,100 |
| | 300 | 117,000 | 47,500 | 14,300 |
| L3 scattered | 20 | 3,600 | 2,700 | 1,200 |
| | 100 | 8,900 | 3,300 | 1,300 |
| | 300 | 22,000 | 4,800 | 1,800 |

Server egress is N × that. For example, L1 at 300 is 47 MB/s today, 13.6 MB/s at the target, and about 5-8 MB/s with
the budget. L2 at 100 is 3.9 MB/s today and 0.6 MB/s at the target.

Reading it:

- **Edge costs.** L2's "cells" and "target" columns also carry the focus-edge costs: arrivals (about 100-400 B/s) and
  resolved waypoint streams (about 0.2 KB/s, 6.6).
- **Cells alone change nothing for a ball.** They change a lot for anything spread out (L2 -59%, L3 -45% to -78%).
- **The per-pilot cost is what the derivation work cuts**, and that is the other workflows' job.
- **Cells are the CPU fix; derivation is the bandwidth fix.** They multiply.

### 9.4 Server CPU shape

**Today, per snapshot (20 Hz).** For each client:

- O(system ships): view scan, `forClient`.
- O(system rows): key compares, with JSON keys for status rows.
- O(ships in view): HP and structure diffs.
- O(system hits): `plan`.
- O(its bytes): bit-pack and deflate.

So **O(clients × system entities + total bytes × (pack + deflate))**.

**L1 at 300, illustrative** (300 pilots, about 150 NPCs, about 1,500 live shells; per-unit costs are guesses for phase
0 to replace):

- **Visits.** 300 clients × about 2,000 rows and shadows = 600,000 entity visits a snapshot, 12M a second, many
  allocating (spread objects, JSON).
- **Packing.** 156 KB/s × 300 = 47 MB/s of bit-packing (at a guessed 5 ns a bit: about 1.9 s of CPU per second)
  **plus** deflate of the same (zlib, about 50-100 MB/s a core: half a core to a core).
- **Verdict.** That doesn't fit in a 16.7 ms tick on one thread. At the lockstep target bytes it still needs about a
  second of packing per second.

**Cells, per snapshot:**

- O(entities): block encode (each entity's window once), wire-shadow compare.
- O(occupied cells): cell records, inflows.
- O(clients × 9): selection.
- O(total bytes): memcpy.

**L1 at 300, the same guesses:**

- unique bytes about 450 entities × 26 B = 12 KB a snapshot, encoded once (about 0.5 ms);
- 300 × 7.8 KB = 2.3 MB copied a snapshot (about 0.3 ms);
- no deflate.

Two to three orders of magnitude less per client-entity pair. These are estimates; the phase 0 bench measures the real
per-row and per-bit costs first.

**Per-cell hashes:** O(entities) every 30 ticks. **Wire shadows:** the same O(entities) per tick Replication already
pays.

### 9.5 Client CPU

- **Spread-out play:** the focus is about a ninth of today's view area, so less tick-layer work than today.
- **The ball:** all N, as today plus the derivation the other workflows add, which is the unmeasured risk. The client
  broadphase and the phase 7 budget are the answers.

## 10. Open questions for Kieran (with the default if you don't say)

1. **Cell size.** Default: fixed 8,192. Smaller (4,096) means more arrivals and ghosts at normal zoom; bigger (16,384)
   gives back today's 40 km cost.
2. **Party members and your target.** Today they are always in view, wherever they are. Default: ghosts at a higher rate
   (1 Hz legs) when outside the focus, never simulated.
3. **Ring ghost rate.** Default: map-dot legs (resent when off by `MAP_DOT_SLACK`) plus a 1 Hz floor for ships whose
   footprint covers your focus.
4. **Shell spawn quantisation** (spawn and velocity on a wire grid, so arrivals are exact in about 12 B). This moves the
   goldens once. Default: yes.
5. **Cross-cell contacts always as causes with the other's state**, even for a client holding both ships. Default: yes,
   which keeps cells closed.
6. **Waypoint spacing and the swerve rule** (6.3). Default: the spacing table as written, a 16-tick lead, a swerve
   check every 4 ticks at max(64, 15% of the remaining distance). Missiles get a little more dodgeable at range: is
   that wanted? Default: yes, then a balance pass. The resolved-stream budget per client: 64.
7. **The crowd budget (phase 7).** Answered 2026-11-05: no per-entity budget; the crowd fallbacks instead (section 0,
   section 7.11).
8. **Jump transit.** Default: no tick layer during the burn; the destination's 3×3 prefetched from charge start.
9. **Hidden information.** Are cloaks, stealth or team-only things planned? Default: no, so one block per entity.
10. **Deflate off for packed clients.** Default: yes.
11. **Per-cell background hash cadence.** Default: each focus cell every 2 s at NORMAL, every 6 s at ROUGH, every 0.5 s at
    STRICT.
12. **The shared-target optimisation** (6.4): send an outside target's rows when three or more held entities chase it,
    so the client derives them. Default: off until phase 6 measures it.

## 11. Build plan

Every phase ends at a checkpoint, plus the standing ones: det:engines green, zero hit, own and body disagreements in
the probes, and the parity tests (replication, confirmedHits, selfHits, bodies, ownSim, packedFrames) green.

**Phase 0: the crowd benchmark baseline.** No game change.
- `server/src/bench/crowdBench.ts`: a real GameServer and N fake clients (`FakeHitsClient` with caps 383; plain byte
  counters past about 50, to keep the bench's own CPU out), in layouts L1, L2 and L3, at N = 20, 50, 100 and 300 with
  pilots fighting, plus a pirates and a boss variant.
- Record per tick:
  - `sendSnapshots` ms, split into view, rows, `forClient`, ship updates, `plan`, packing and deflate;
  - bytes per client and messages;
  - the per-row and per-bit costs section 9.4 guessed;
  - **rebuilds per ship per tick and per snapshot window**, and every `rebuildNow` call site that fired.
- One headless profile (`--cpu-prof`) of the 100 and 300 runs.
- *Checkpoint:* a table replacing section 9's guesses, committed with the bench.

**Phase 1: rebuilds at most once per ship per tick.**
- *Status (2026-11-04):* the batching is built. Every `rebuildNow` call except a body being made (spawnOn, spawnWreck)
  now marks the ship (`markRebuild`: shed, healAll, repair, setGhosts, setPartHp), and ShipBridge.tick step 3 rebuilds
  it once (bridge/rebuild.ts header). `standing()` and the boss brains' `drop` skip parts shed earlier in the tick; the
  dev `forceShed` settles between its steps. The crowd bench now counts repeats: 0 before and after, because its
  scenes never hit the off-tick paths, and its sim is byte-identical. The own-sim test with parts lost and a repair
  in the same tick showed 1 repeat and 3 keyframes of the pilot's own ship with the old code, and 0 and 0 now.
  The stamp, structure hash and cached sync wire form are still to do.
- Route every `rebuildNow` through `ship.dirty` and one rebuild pass at a fixed phase each tick.
- Stamp the rebuild tick and a structure hash.
- Cache the sync's wire form per ship per rebuild (a step past `syncWireOf`).
- *Checkpoint:* the bench shows at most one rebuild per ship per tick; "rebuilt twice in a window" keyframes counted, and
  down if the window rule allows; boss and debris tests green; goldens moved once if at all.

**Phase 2: client-independent records and the wire shadow** (still with today's radius view).
- Decide told or findable per hit, not per client, with own-ship and STRICT hits on a per-client side channel.
- Part HP and structure "as told" once per ship (`shipHpSent` and `shipSynced` become per-entity).
- Status-row keys per entity.
- Debris splits as a record every holder derives.
- *Checkpoint:* `plan` and ship-update ms flat in N for the same entities; parity tests green; bytes within 5% of
  phase 0.

**Phase 3: encode once.**
- *Status (2026-11-04):* built behind `CAPS.BLOCKS` (512, protocol 37), on the dev server by default. Done ahead of
  phase 2 (the snapshot walk is unchanged). Built: per-system wire ids (prefix widths, lowest free, told once per client);
  blocks for status rows, shell rows, keyframes, control rows and fire events, each made once a snapshot
  (`BlockStore`) and copied bit for bit; delta bases per entity (and per gun for shell rows), each block in a delta and
  an absolute form so holders that missed one get back in step with the next; per client only the wids it was told and
  its chain generations (`BlockPeer`); deflate off for blocks frames. Not built: shells named (owner, counter); effects,
  shipHps, shipSync and hits on the shared path. At ball 300 the tick goes from 48 to 36 ms, encode from 21.7 to 7.5 ms,
  and raw bytes rise 2 to 7%; agreement is identical (docs/audits/encode-once-2026-11-04.md).
- Per-system wire ids with prefix widths.
- Shells named (owner, shot counter).
- Per-entity blocks (sim and rows variants), delta-coded per entity.
- Client frames as copied blocks.
- PackedEncoder kept only for the own channel.
- Deflate off for packed clients.
- A wire bump.
- *Checkpoint:* packing ms per snapshot O(entities), not O(clients × entities); bytes within 10% of phase 2 (ids cost a
  little, padding a little); packedFrames' lossless test rewritten against blocks.

**Phase 4: cells and the focus.**
- *Status (2026-11-04):* built behind `CAPS.FOCUS` (1024, protocol 38), on the dev server by default, per section 0:
  common network/cells.ts (cells, home cells with 256 slack, the flat 19 km focus and 35 km ring, hashes, the log form),
  server net/cells/FocusCells.ts (the view by cells in place of `updateShipView` for capable clients; drops after the
  snapshot; shared per-(cell, tick) records; offers, logs from each shadow's kept control changes, refusals; ghosts as map
  dots; a jump's burn holds the focus still), client ships/cells/CellCache.ts (detach, hash, answer, attach and
  fast-forward) and GhostLayer.ts (markers; hulls fade over 18-19 km). Entries are not a separate cell snapshot: with
  BLOCKS each entering ship's keyframe and status row is already one shared block. Logs are kept per shadow (a ship moves
  between cells) and gathered per cell at re-entry; they are not pre-encoded bytes. On the crowd bench a capable client
  holds a third of the ships in spread and cruise layouts and gets 40-65% fewer bytes, agreement unchanged; the ball is
  4-7% up (ghost legs) (docs/audits/focus-grid-2026-11-04.md). Not done: design/name prefetch for the ring, the
  screenshot pass and panels.
- Home cells with hysteresis; anchor and 3×3 focus replacing `shipView`.
- Cell snapshots, shared and cached with a tail; exits.
- Ring ghosts from the map-dot legs; design and name prefetch.
- Jump transit.
- *Checkpoint:* L2 and L3 bytes per client down by about the section 9.3 "cells" column; entries per second and entry
  bytes per recentre measured; a screenshot pass at full zoom (ghosts beyond 6-14 km look right), with before and after
  panels in docs/panels/ (memory: dev-update-panels).

**Phase 5: arrivals and effects across borders.**
- *Status (2026-11-04):* the cause half is built behind `CAPS.CAUSES` (2048, protocol 39), on the dev server: contacts
  (every pair, a cell border or not), rebuilds and pilots' pulls go as cause records on the ships they moved, worked out
  on every client's tick layer with the shared function; contacts and rebuilds no longer keyframe other ships for such a
  client, and its own check covers every ship it holds (docs/areas/networking.md, "Other ships' causes"; measured in
  docs/audits/effects-2026-11-04.md). Not built: shell spawn quantisation and arrivals (out-of-view shells still come as
  rounded rows, their hits told), itineraries and inflow blocks, debris knocked by debris a client doesn't hold
  (keyframed as before).
- Shell spawn quantisation (a golden shift).
- Itineraries; directional inflow blocks; arrivals.
- Retire projectile rows for out-of-view shells.
- Cross-cell contacts and pulls as causes for everyone.
- Debris knocks across cells.
- *Checkpoint:* a fight straddling a cell corner, with shooters in four cells and observers in each, gives zero hit
  disagreements; arrival bytes measured; the light-cone assertion (section 6.7) as a test: every influence from beyond
  v_max · T_fix arrived as a record.

**Phase 6: resolved streams, waypoint laws and the cell hash.**
- *Status (2026-11-04, `CAPS.WAYPOINTS` 4096, protocol 40):* the waypoint law is built for homing shells and mobs
  (common guidance/; docs/areas/networking.md "Scheduled waypoints"): the server flies on it, a client derives the
  waypoints when it held the target through a window and takes the server's records otherwise (MODE per window),
  exact through the switch; checked on its own check. Measured in docs/audits/waypoints-2026-11-04.md (a missile
  barrage in focus: 2,168 -> 657 B/s). Not built: the AI pilot (needs the commander/pilot split), guided shells,
  the bodied boss's rows variant, the per-cell hash. A shell's or mob's "focus" is the 12 km projectile range.
- The waypoint law in common (6.3): the planner, spacing, swerve check and steering law.
  - Homing shells first; then mobs; then the AI pilot, with the commander/pilot split (decision-inputs stage 7).
  - The server flies on it. Goldens move: guidance changes behaviour, on purpose.
- Derived on clients when both ends are held. The `WAYPOINT` record with an arrival tick as the resolved stream
  otherwise. A bodied boss's rows variant as its stream.
- The coupling table (6.4) as tests: no outside entity simulated, every cross-border influence a record. The 64-stream
  budget.
- The per-cell background hash and cell resync; the levels per zone.
- *Checkpoint:*
  - A missile switching between derived and sent mid-flight (its target leaving and entering a client's focus) is bit
    identical to the server's every tick.
  - The boss probe with the boss in focus and its target outside, and with the boss outside pulling a pilot in focus,
    gives zero body and own disagreements.
  - Resolved-stream bytes in the L2 bench near section 6.6's estimate.
  - Injected drift (a cell entity moved 1 unit) is caught within one cadence and fixed by a cell snapshot.

**Phase 7: the crowd.** Status: **crowd fallbacks built** (section 7.11), in place of the in-focus budget.
- ~~The in-focus priority budget (exact K, rows variant beyond, accumulator ordering).~~ Replaced by the fallbacks.
- A client broadphase in SelfHits.
- The client frame profiled in a real browser (one headless browser, closed after: memory: dev-process-hygiene).
- *Checkpoint:* L1 at 300 within the target bandwidth (open question 7) and the client's tick layer under its frame
  budget; the server at under a third of its tick at 300.

Phases 2-3 help every layout and need no change to what anyone sees. Phases 4-5 are the visible change: the
smaller simulated area, and the ghosts beyond it. Each phase is behind a caps bit like the other netcode work, legacy
clients keep today's path, and the deploy freeze holds (memory: deploy-freeze).

## 12. As built (2026-11-05): the whole run, reviewed

Every phase above that was built sits behind its own caps bit, on by default only on the dev server and in dev
clients; a client without a bit gets the path it had before, and the review's caps matrix (each bit off in turn from
all of them, crowd bench ball 50 and spread 50) shows zero tick-layer disagreements in every combination.

| Bit | Value | Protocol | What it does | Needs |
|---|--:|--:|---|---|
| BLOCKS | 512 | 37 | snapshots as shared encode-once blocks (phase 3) | PACKED |
| FOCUS | 1024 | 38 | the focus grid: 19 km cells on the tick layer, 35 km ring as ghosts, dropped-cell cache (phase 4) | |
| CAUSES | 2048 | 39 | other ships' contacts, rebuilds and pulls as cause records, not keyframes (phase 5, the cause half) | OWN_SIM |
| WAYPOINTS | 4096 | 40 | homing shells and mobs on the shared waypoint law (phase 6, shells and mobs) | OWN_SIM |
| PILOTS | 8192 | 40 | the enemy AI flown by a shared pilot body from its commander's orders | BODIES, CAUSES |
| CROWD | 16384 | 41 | crowd fallbacks: smaller focus, wider window, per-system time dilation (phase 7, 7.11) | |
| STRUCTS | 32768 | 42 | every structure a ship flew, kept by its rebuild tick (two rebuilds in a window worked out) | CAUSES |
| CARGO | 65536 | 42 | a hold's mass changing as a cause before the tick's step | OWN_SIM or CAUSES |
| DEBRIS | 131072 | 44-47 | debris worked out from its split and run for its whole life on the client | |

PILOTS needs CAUSES since the review: without it a pilot's body read targets that contacts keyframed mid-window, and
ball 50 had 12 AI ticks off without a keyframe (now 0; such a client gets control rows, as before PILOTS).

**Not built from the plan:** phase 1's structure hash and cached sync wire form; phase 2 (records per entity rather
than per client: `HitLedger.plan`, `shipSynced`, `shipHpSent` are still walked per client, about 17 ms at ball 300 before
the crowd fallbacks); shells named by (owner, counter); shell spawn quantisation, arrivals and itineraries; the
per-cell background hash; guided shells, siege turrets, station defence and traffic on the waypoint law or the pilot
body; design and name prefetch for the ring; large ships (out of scope by decision).

The before and after numbers for the whole run are in docs/audits/netcode-all-2026-11.md.
