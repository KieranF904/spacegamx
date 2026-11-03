# Confirmed hits (design, 2026-11-04)

Status: **built** (A: protocol 26; B: no wire change; C: protocol 27, on for the dev server only). What differs from the design is in the "as built" sections at the end; the measured result is docs/audits/confirmed-hits-impact-2026-11-04.md.

Today the server works out every hit and sends the results: ~40 B a landed hit over four messages (`projectileHit`,
the shell again in `removed`, `damage`, a `shipHps` entry), plus `ignite` and `detonation` as plain keyed objects. In
heavy fights that is the biggest cost after the shells themselves. This design changes three things:

- **A. Quick wins.** Hot plain messages go into `COMPACT`; a few messages stop repeating. One protocol bump.
- **B. Shared rules.** What a shell hit does to a ship moves from the server's bridge into `common`, so the server and
  the client run the same function.
- **C. Confirmed hits.** For capable clients the server sends "shell s hit part p of ship t" (about 3 B), and the client
  works out the rest. It sits behind a per-player switch; clients without it get today's messages, unchanged.

The server stays authoritative. It alone decides hits, damage, kills and rewards. A later phase (not this one) has
clients detect hits themselves; nothing here blocks it.

Read with: `docs/audits/network-message-catalogue-2026-11-03.md` (sizes, surprises),
`docs/audits/network-fixes-impact-2026-11-03.md` (probe method), `docs/audits/netcode-dual-mode-2026-11-03.md`
(islands, per-client caps), `docs/areas/networking.md`.

## The one idea that makes C safe

**The server runs the client's derivation itself**, for each capable connection, on that connection's copy of the part
HP (`ClientConnection.shipHpSent`, which it already keeps). Then:

1. It attaches to the hit record only what the client would get wrong (a damage number, an ignite part, "a shield took
   it").
2. It updates `shipHpSent` with what the client derived. `sendShipUpdates` already sends only parts where
   `shipHpSent` differs from the truth, so any HP the client got wrong is corrected in the same frame.
3. Frame order is `... snapshot, hits, shipHps, hpCheck`. A wrong derivation is overwritten before anything is drawn.

So a wrong or missing client input costs bytes (today's `shipHps`), never correctness. Nothing has to be exact for C to
be correct; it has to be exact to save bytes. The measurement in section 7 shows how often it is.

---

## 1. Quick wins (A): one bump for the lot

| # | change | where | today -> after (per message) | notes |
|---|---|---|---|---|
| A1 | `ignite` into COMPACT: `['ignite', ['bodyId','part','ticks']]` | protocol.ts COMPACT | 36 -> ~9 B (m) | Gale fight: 32/s |
| A2 | `detonation` into COMPACT: `['detonation', ['kind','x','y','radius','from','mob']]`, with `kind` sent as a code | protocol.ts, new common/src/network/fxKinds.ts | 39 -> ~13 B; 53 -> ~20 B with `from` (est; 15 / 22 measured with kind as a string) | Gale fight: 35/s, 25% of its bytes |
| A3 | `intercept` into COMPACT: `['intercept', ['bodyId','part','proj','x','y','fx','fy','down']]` | protocol.ts | 70 -> ~26 B (m) | `down` goes as 0/1 like any boolean |
| A4 | `bossTelegraph` into COMPACT: `['bossTelegraph', ['shape','kind','x','y','ticks','angle','length','width','radius','bodyId']]` | protocol.ts | 75-97 -> ~35 B (est) | `shape` and `kind` stay strings (short, rare) |
| A5 | `pong` into COMPACT: `['pong', ['clientTime','serverTime','tick','serverProcessing']]` | protocol.ts | 73 -> ~22 B (m) | still its own frame (Outbox.send) |
| A6 | `bossBeam`, `bossCharge`, `bossBlow` into COMPACT, fields in interface order | protocol.ts | 64 / 40 / 29 -> ~20 / 12 / 8 B (est) | rare; free in the same bump |
| A7 | `asteroidSeed`: `ids` and `indices` as runs `[start, count, ...]` (`packRuns` in common/src/ships/debris.ts, or a 6-line twin) | SnapshotBuilder.enterSystem (~l.826), client GameState.handleAsteroidSeed | 3,127 -> ~60 B (est), per system entry | JSON message, not COMPACT; the shape change rides the same bump |
| A8 | `people` sent once at login: Quests' login path calls `sendPeople(conn, true)` right after `send(conn)` already sent it (Quests.ts ~l.357-358). Drop the `force` there | Quests.ts | -4 KB a login | `People.shown` already de-duplicates |
| A9 | `items` only on change: per-connection key (as `People.shown`) in `Pilots.sendItems` | Pilots.ts ~l.1116 | -185-300 B a duplicate; covers the login double | the message is a full state, so skipping a copy changes nothing on the client |
| A10 | `party` only on change: per receiver, keep the last JSON and send when it differs (membership changes always send). Round `x`, `y` to 1,000 and `hull` to 5% first. Check what reads member `x`, `y` on the client (SocialUI, the map); if only the map and rally, 1 km is plenty | Party.ts `broadcast` | ~350-500 B/s per member -> a few B/s while flying | |
| A11 | `ops` only on change: per connection JSON key in `Operations.sendViews` | Operations.ts ~l.762 | ~320 B/s -> at most 1/s while a timer runs | `timer` is whole seconds, so the view changes at most once a second |

### Detonation kind codes (A2)
- New `common/src/network/fxKinds.ts`: `FX_KINDS: readonly string[]`, append-only (indices are the wire format). Seed
  it with every kind sent today: the weapon kinds in `WEAPON_KIND_TYPE` order, then `arc`, `tesla_arc`, `mob_burst`,
  `mob_fizzle`, `eruption`, `synapse`, and the staged bosses' kinds (grep `type: 'detonation'` under server/src: Weapons.ts,
  GameServer.ts l.1474 and l.2267, brains/pyreclast.ts, brains/staged.ts).
- Add `fxKinds: FX_KINDS` to `wireTables()` so the hash covers it.
- Packing: a per-type hook table next to `COMPACT` (`COMPACT_HOOKS: Record<string, { pack(m), unpack(m) }>`), called by
  `packCompact`/`unpackCompact`, as `packSnapshot` is for snapshots. The detonation hook turns `kind` into its index when
  listed, else leaves the string (an unlisted kind still works). Unpack turns a number back into the string. The client
  sees the same `ServerDetonationMessage` as today; no handler changes.
- `mob` stays a string (boss fights only, <1/s).

### Not in A (looked at, left)
- Other pilots' status rows resent for a cursor-distance change: changes what others see; later.
- `playerState` copies, the own row's constants, the status row repeating the keyframe: snapshot format changes; they
  belong with the bit-packed format.
- Client -> server JSON (`stateHash`, `ping`): needs a client outbox; separate work.
- Dead message types: no bytes; tidy later.

### A's bump
- `npm run wire:bump "COMPACT rows for ignite, detonation (kind codes, fxKinds.ts), intercept, bossTelegraph, pong, boss beam/charge/blow; asteroidSeed as runs"`.
- Expected golden change: `server/src/golden/frameHash.golden.json` (bytes on the wire change). Nothing else.

---

## 2. Shared rules (B)

### What computes a hit's consequences today (all server-only unless marked common)

| consequence | file : function | inputs |
|---|---|---|
| shell damage at spawn | game/Weapons.ts `spawn`: `Projectile.damage = (def.damage ?? 14) × damageScale` | `def` = `gunDef` (common launch.ts: gems, ammo, grade, size, model); `dry` strips effects. `damageScale` = `shot.damageScale` (common shot.ts: `max(satisfaction, minWeaponSatisfaction) × strength`) × ports shot `dmg` (common guns.ts `portsSpendShot`) × `b.damageMul` (bridge/weapons.ts: ward scale × wing bonus) × ammo round `scale` (game/Ammo.ts `spend`) |
| what it hits with | Weapons.ts `hitOf`, `vsOf` | `weaponHit(kind, def, tier)` (common damage.ts), `vsShield`, `vsHull`, `bane` from def |
| struck part | bridge/weapons.ts `hitProjectile` -> `segmentHit` -> `castShip` -> `castParts` (common collide.ts) | target pose, geometry, `standing` (common stages.ts) |
| part that takes it | bridge/weapons.ts `cover` | stages (common stages.ts: `stageOf`, `currentStage`, `stageParts`, `deciding`, `standing`), `partDistance`, `coverMemo` |
| amount modifiers | bridge/damage.ts `hurt` | stage cover (`host.stageCover`: Bosses def or rules, default `STAGE_COVER` 0.4, bridge/core.ts), `splashTaken` (catalog function), bane (`host.baneFaction`), taken (`host.takenScale`: boss brain) × `MARK_TAKEN` while marked |
| shield soak | `hurt` | `ship.shield`, `vs.shield`; sets `shieldHitTick`, calls `host.shieldBroken` |
| armour, penetration, material | `hurt` -> `hitMultiplier` (**common** damage.ts) | part material and fn, `HitInfo` |
| ruin floor | `hurt`: piece `ruin` -> `RUIN_HP` (**common** stages.ts) | catalog |
| HP change | `damagePart` (**common** state.ts) | marks `dirty` on an HP band change |
| glancing | `hurt` sets `b.lastThrough = through × min(1, taken)`; `hitProjectile` reports `lastThrough < GLANCING` (0.6, bridge/core.ts) | |
| critical | nothing sets it for ships (the `damage.critical` field is unused) | |
| invulnerable | `hurt` -> `host.invulnerable` (god, docked, person craft, boss brain) | |
| part destroyed | hp <= 0, then bridge/damage.ts `partDeaths` at the tick's rebuild: `partDestroyed`, seeded blasts, `rebuildNow` -> `shipSync` | |
| ignite | Weapons.ts `onShipHit` -> bridge/damage.ts `ignite`: the struck part if alive and attached, else `closestPart(x, y)`; `ticks = def.ignite.ticks`; dps × damageScale; then `stepBurns` | |
| pierce | Weapons.ts `onShipHit`: `pierceLeft` from `def.pierce`, `hit` exclusions, `damage × (pierceKeep ?? 0.75)` per pass, a detonation when `pierceKeep` is set | |
| shell removal | GameServer `collisionSystem`: `onShipHit` returns spent -> `Dead` + `pendingRemovedEntities` | |
| end effects | Weapons.ts `detonate`: `splashAt`, `empAt`, a `detonation` if `bursts(def)`; `shatter` (split) | |
| chain arcs | Weapons.ts `chain` | every ship's place, `canDamage` |
| HP on the wire | net/SnapshotBuilder.ts `hpWire` (to 0.1, never rounded to 0) | |

### New module: `common/src/ships/hitRules.ts`

| export | moved from / new | what it is |
|---|---|---|
| `GLANCING`, `STAGE_COVER` | bridge/core.ts (re-export there) | constants |
| `hpWire(h)` | net/SnapshotBuilder.ts | part HP to 0.1 |
| `bursts(def)` | game/Weapons.ts (re-export there) | does a shell's end need telling |
| `coverPart(catalog, ship, part, geoms, at?, memo?)` | bridge/weapons.ts `cover` (ShipBridge keeps its delegator) | the part that takes a hit |
| `partHit(ctx, ship, part, amount, vs, mods)` | new: the body of `hurt` after the invulnerable check | mutates `ship.shield`, `ship.hp`, `shieldHitTick`; returns `{ part, dealt, soak, hull, through, glancing }`. `ctx = { catalog, tuning, geoms }`; `mods = { tick, stageCover, bane (multiplier), taken (boss × mark) }` |
| `shellAmount(def, strength, passes)` | new | `def.damage × strength × pierceKeep^passes`: the amount a client can know |
| `igniteRule(ship, struck, def)` | new | `struck` if `def.ignite`, the target is a `ship`, and the struck part is alive and attached after the hit; `-1` otherwise (server: `closestPart`; client: needs the record's override) |
| `hitEndFx(kind, def, gone)` | new, from `detonate` and `onShipHit` | `{ kind, radius }` or null: gone -> `bursts(def)` ? radius `splash?.radius ?? emp?.radius ?? 40`; not gone and `pierceKeep` set -> radius 40 |
| `deriveShellHit(view)` | new | the **client view**: `shellAmount` -> `coverPart` -> `partHit` with shield 0 and default mods -> `hpWire` -> `igniteRule` -> `hitEndFx`. Returns `{ part, dealt, hpAfter, ignite, fx }`. Used by the client and by the server's per-connection check |

Server after B:
- `hurt` = invulnerable check + `partHit(...)` with mods from the host + the bookkeeping it does today (`lastDamaged`,
  `lastHitBy`, `shieldBroken`, `b.lastThrough`). Same numbers, same order of float operations.
- `cover` delegates to `coverPart`. `Weapons.detonate` and `onShipHit` use `hitEndFx` and `bursts`.
- Rule: B is a pure move. No golden changes. `parity.golden.json`, `frameHash.golden.json` and `shipBridgeApi.json`
  must stay as they are.

### What the client needs, and whether it has it

| input | has it? | from |
|---|---|---|
| shell kind, gun part, ammo, augmented | fire-event shells: yes. Own shells (rows): **no** -> add `gun` to projectile rows (C) | `snapshot.f`; `snapshot.p` |
| the gun's def (gems, grade, size, model, ammo mods, aug mods) | yes | blueprint (shipSync) + the fire record, as `volleyShells` builds it |
| weapon strength, grade | yes | `ship.derived.weapons` |
| power satisfaction < 1, ports shot `dmg`, wing bonus, ward scale, ammo scale, dry rounds | no | the record's `D` override when it changes the number |
| target blueprint, catalog, geometry, detached | yes | shipSync |
| target part HP | yes, to 0.1 | shipSync, shipHps, its own derivations |
| exact shield | no (status % only) | the record's `S` flag |
| boss stage cover, boss taken, mark, bane, invulnerable | partly | view uses defaults; `D` override + shipHps correction when they matter |
| hit tick, target pose at it | tick: the record; pose: `ShipReplicaSet` at that tick | |

Cross-engine note: `sizeMods` uses `Math.pow`, and `penetrationMul` only `+ - * /`. A 1-ulp difference in a sized
gun's damage could flip a tenth in `hpWire`. The hpCheck (3.6) catches it; R4 (deterministic maths) removes it.

---

## 3. The hit record (C)

### 3.1 Which hits get a record (per connection, else today's messages)

| # | condition |
|---|---|
| E1 | the connection has the `HITS` capability (section 4) |
| E2 | the shell flies straight (`firesStraight(def)`) and the connection has its gun: a fire event or a row with `gun` went to it (`conn.shellsKnown`) |
| E3 | the target is in `conn.shipView`, not in `debrisHeld`, and `conn.shipSynced.get(t).rebuilds === ship.rebuilds ===` the rebuild count when it was hit |
| E4 | the connection is within `FX_RANGE` of the hit, or fired the shell (as `damage` today) |

E3 means a hit on a ship that rebuilt before the snapshot (the killing hit, usually) goes the old way. Measure how
often (7).

### 3.2 Encoding (current codec, one COMPACT row per frame)

`['hits', ['h']]`: `h` is a flat array of integers. Per hit:

| field | value | bytes |
|---|---|---|
| `ds` | shell id minus the previous hit's shell id in this message (the first: the id itself). Signed | first 3, then usually 1 |
| `m` | meta: bits 0-2 `ticksAgo` (snapshot tick minus hit tick, 0-7, clamped), bit 3 `N` a target follows, bit 4 `G` gone (shell spent), bit 5 `L` glancing, bit 6 `X` extras follow | 1 (always < 128) |
| `t` | target id, only when `N` (the first hit always has it) | 3 |
| `p` | the struck part (as `castShip` found it, before cover) | 1 (3 if >= 128) |
| `e` + values | only when `X`. Mask: bit 0 `D` dealt × 10 follows; bit 1 `S` a shield took some (no value); bit 2 `I` ignite part follows (-1: none). Bit 3 reserved (an explicit hit point, for curving shells later) | 1 + 1-3 |

- Hits go in the server's order (collision order). The client applies them in that order, as the server's check does.
- Several hits batch in one message per frame. A message of one hit is ~11 B (2 B row overhead + 3 + 1 + 3 + 1); each
  further hit on the same target ~3 B (est).
- `S` always comes with `D`. With `S` the client does not derive HP; the shipHps that follows has it.
- New interface `ServerHitsMessage { type: 'hits'; h: number[] }`. Packing helpers in new
  `common/src/network/hits.ts`: `packHits(records)`, `unpackHits(h)` (both ends), `ShellHitRecord`.

### 3.3 What it replaces, for a connection that got the record

| today | after |
|---|---|
| `projectileHit` (13 B) | derived: shell line at the hit tick cast against the struck part |
| the hit's share of `damage` (~10 B) | derived, or `D` |
| the `shipHps` entry for the part (~4-5 B) | derived; sent only when the derivation was wrong |
| the shell's id in `snapshot.removed` (3.5 B) | `G` |
| `ignite` from the hit (36 B, ~9 after A) | derived, or `I` |
| plain end `detonation` (hit point, pierce pass) | derived (`hitEndFx`) |

### 3.4 What still goes as today

| event | decision | why |
|---|---|---|
| `partDestroyed`, ship `death`, `debrisSplit`, rebuild `shipSync` | as today | carry what the client can't know (blast, credit, structure) |
| splash damage (flak, missile, mortar, magma, torpedo) | as today: `damage` + shipHps | many targets, falloff by geometry; a later island |
| chain arcs (Spark) | as today, COMPACT `detonation` with `from` + `damage` | the next target needs every ship's exact place and `canDamage` |
| beams, pulses, boss beams | as today | not shells |
| burns ticking | as today (shipHps, `damage` every 30 ticks) | spread rules are server-side; derivable later |
| contacts, part blasts | as today | |
| hits on mobs, asteroids, walls | as today | mobs and rocks are other islands |
| homing, guided, lobbed, held shells; shards | as today | not straight (E2); their rows already carry positions |
| point defence `intercept` | as today, COMPACT (A3) | |
| EMP, frost | as today (status rows) | |

### 3.5 What the client derives, and when

The record is handled on arrival (today `projectileHit` waits up to 2 ticks; a record waits for the snapshot, up to 3).
Hit tick = the tick of the snapshot just processed minus `ticksAgo`.

| consequence | how |
|---|---|
| shell's gun and def | the client's shell table (3.7) |
| hit point | shell line at the hit tick (`spawn + v × (tick - spawnTick)`, one step long) cast against the struck part only (`castParts` with `j === p`) at the target's replica pose for that tick; on a miss, the point of the line nearest the part's centre. Cosmetic |
| damage number | `D / 10`, else `deriveShellHit(...).dealt`. Summed per (target, owner, glancing) within the message, as `flushDamage` sums today |
| part HP | unless `S`: `ship.hp[cover part] = hpAfter` (on the 0.1 grid) |
| fire | `I` if present, else `igniteRule`; ticks from the def |
| shell removal | `G`: removed now, by the same rule as `snapshot.removed` (GameState: delete, or `lateRemovals` if made in this snapshot). Not `G`: its pass count goes up |
| effects | `hitEndFx`; the `projectileHit` look (sparks, sound, tracer stop, `PLAIN_HIT_LOOKS`) |

Implementation: the client turns each record into the messages it would have got (`projectileHit`, `damage`,
`ignite`, `detonation`) and passes them through `handleServerMessage`. Every existing handler and effect works
unchanged. HP goes straight into `ShipStore` (then `fillHull`).

### 3.6 Drift safety: hpCheck

The per-connection check makes HP exact by construction. What is left: a client that could not apply a record (shell
table miss), cross-engine float differences, bugs.

- Server -> client COMPACT `['hpCheck', ['id','sum']]`, sent after shipHps in the frame. `sum` =
  `hpChecksum(hp)` in hits.ts: `Σ round(hp[i] × 10) × (i + 1) mod 65536` over `shipHpSent`.
- Which ships: per capable connection, those whose `shipHpSent` changed by a derivation since their last check,
  round-robin, **one ship a second**. Idle: none. Cost ~8 B/s in a fight (est).
- Client: compares with its own HP. On a mismatch, or a record it could not apply, it sends `hpResync { ids }`
  (JSON, `MESSAGE_LIMITS` 10/s). The server fills `shipHpSent.get(id)` with `NaN` and clears `shipSynced.get(id).hpAt`;
  the next snapshot sends every part.
- Counted per connection (mismatches, resyncs). Target: 0 mismatches a minute.

### 3.7 Shell table (client)

`client/src/ships/hits/ConfirmedHits.ts` keeps `id -> { owner, gun, kind, def, strength, grade, spawnTick, spawnX,
spawnY, vx, vy, passes }`, filled when a fire event is rebuilt (`ShipClient.preSnapshot`) or an own row with `gun`
arrives. It is independent of entity pruning, dropped on `G`, on removal, and after `life + 60` ticks. A miss -> the
record's HP is not applied and `hpResync` goes for the target.

### 3.8 Own shells

Projectile rows get one optional field at the end of the tail: `gun` = part + 256 × ammo + 65536 × aug (the fire event's
packing), for shells fired by a gun. `Projectile.gun` (new i32 component field) is set in `Weapons.spawn` from
`shape.gun`; `fireWeapons` passes the same value it puts on the fire event. Rows are shared per system, so everyone pays
~2-3 B per row (~100 B/s in the Hammerhead fight, est) to save ~30 B per hit. Matching own predicted shots instead
(WeaponFx `claim`) is fuzzy; not for gameplay.

### 3.9 Server flow per snapshot

| step | where | what |
|---|---|---|
| hit | bridge `hitProjectile` -> `host.notifyShellHit({ proj, target, part, x, y, dealt, glancing, soak, rebuilds })` (replaces `notifyProjectileHit` + `notifyDamage` for this hit) | `HitLedger.hit`: stores it; sends `projectileHit` now to **legacy** connections only (as today); `Outbox.addDamage(..., shell)` |
| derivable effects | Weapons `onShipHit` / `detonate` at a ship hit -> `host.hitFx(proj, msg)` for `ignite`, pierce and end `detonation` | sent now to legacy connections; kept on the ledger hit for fallback. Chain arcs still use `host.broadcast` |
| shell spent | `collisionSystem`: `ledger.end(proj, gone)` | sets `G` |
| plan | `GameServer.sendSnapshots`: `ledger.plan()` before `flushDamage` | E1-E4 per hit per capable connection; marks the damage it covers |
| damage | `Outbox.flushDamage` | legacy: today's sums. Capable: sum minus the hits it covers; nothing when <= 0.05 |
| syncs | SnapshotBuilder | `sendShipUpdates` split: syncs before the snapshot (as now) |
| snapshot | SnapshotBuilder | sent; a connection with records always gets one; gone shells it covers left out of `removed` |
| hits | `ledger.writeFor(conn)` | per hit: `deriveShellHit` on the connection's view (the live `ShipState` with `hp` read from `shipHpSent` and shield 0, one scratch object per connection; the def from the shell's gun, as the client builds it, not the server's true def) -> `D`/`S`/`I` when the truth differs; `shipHpSent` updated unless `S`; `hpAt` cleared. A hit that fails E3 now (target left view) gets its stored legacy messages instead |
| HP diff | SnapshotBuilder | the HP half of `sendShipUpdates`, after the hits: unchanged code, compares with the updated `shipHpSent` |
| hpCheck | ledger | after shipHps |

---

## 4. The per-player switch

| piece | design |
|---|---|
| bits | `CAPS = { HITS: 1 }` in common/src/network/hits.ts. Later islands take the next bits (`DEBRIS`, `DAMAGE`, `NPC_SIM`, as the dual-mode audit lists) |
| client announces | `ClientJoinMessage.caps?: number` (JSON field: no hash change). Game.ts adds it to its three `join` sends |
| client setting | URL `?hits=0` or `?hits=1` wins; else a dev settings checkbox "Confirmed hits" (localStorage); default on in dev builds (`import.meta.env.DEV`), off in production builds until shipped |
| server accepts | `conn.caps = (msg.caps ?? 0) & ctx.allowedCaps` in `handleJoin`. `allowedCaps` = a GameServer option `netCaps`, `DEV_MODE ? CAPS.HITS : 0` in server/src/index.ts (as `guestAdmin`), env `NET_CAPS` to allow it in production later |
| server tells | `welcome.caps` = the accepted mask; the ping panel shows "hits: on/off" |
| A/B toggle | admin command `caps <name> hits on|off`: flips the bit server-side at the next snapshot. Safe both ways: turning off stops records (shipHps diff covers the rest); turning on needs only the client's shell table, which a capable client always keeps |
| legacy | a connection without the bit takes exactly today's path, byte for byte (`projectileHit` and effects at hit time, full damage sums, removals) |

---

## 5. Seams (files)

New:

| file | owns |
|---|---|
| common/src/ships/hitRules.ts | the shared rules (section 2) |
| common/src/network/hits.ts | `CAPS`, `ShellHitRecord`, `packHits`/`unpackHits`, `hpChecksum` |
| common/src/network/fxKinds.ts | `FX_KINDS` and the detonation pack hook (A2) |
| server/src/net/hits/HitLedger.ts | collect, plan, `writeFor(conn)`, legacy fallback, the per-connection check and `shipHpSent` update, hpCheck rota, counters |
| client/src/ships/hits/ConfirmedHits.ts | shell table, `expand(msg)` -> messages + HP, hpCheck compare, `hpResync` |

Changed (each a few lines unless noted):

| file | change |
|---|---|
| common/src/network/protocol.ts | COMPACT rows (A, `hits`, `hpCheck`), `COMPACT_HOOKS`, interfaces (`ServerHitsMessage`, `ServerHpCheckMessage`, `ClientHpResyncMessage`), `join.caps`, `welcome.caps`, projectile row `gun` tail field |
| common/src/network/PROTOCOL_CHANGELOG.md | by `wire:bump` |
| server/src/ships/bridge/damage.ts | `hurt` calls `partHit` (B) |
| server/src/ships/bridge/weapons.ts | `cover` delegates (B); `hitProjectile` reports `notifyShellHit` (C) |
| server/src/ships/bridge/core.ts | host interface: `notifyShellHit`, `hitFx`; constants re-exported |
| server/src/game/Weapons.ts | `bursts`/`hitEndFx` from common (B); `hitFx` for derivable effects; `gun` on spawn (C) |
| server/src/GameServer.ts | host wiring lines; `ledger.end` in `collisionSystem`; `ledger.plan()` in `sendSnapshots`. No kind branches |
| server/src/net/snapshot/Outbox.ts | `addDamage(..., shell?)`, covered subtraction in `flushDamage`, a `skip` filter on `broadcastNear` |
| server/src/net/SnapshotBuilder.ts | `sendShipUpdates` split in two; `writeFor` after the snapshot; removals skip; `hpWire` from common; `gun` in rows (moderate) |
| server/src/net/ClientConnection.ts | `caps`, `shellsKnown`, `shellPasses`, `hpDirty`, counters |
| server/src/net/auth.ts | `caps` in join, `welcome.caps` |
| server/src/net/handlers/flight.ts, MessageLimits.ts | `hpResync` handler and limit |
| client/src/Game.ts | `caps` on join |
| client/src/app/serverMessages.ts | `HANDLERS` entries `hits` (expand, then `handleServerMessage` each) and `hpCheck` |
| client/src/ships/ShipClient.ts | feed the shell table from fire events and own rows; expose the expander |
| client/src/state/GameState.ts | `removeShell(id)` with the `lateRemovals` rule |

---

## 6. Tests

| test | what |
|---|---|
| B safety (before any B code) | `server/src/game/hitRules.golden.test.ts`: a seeded list of ~500 hits (cannon, railgun pierce, magma, arc, flak splash, a boss stage, a ruin piece, a shield, a mark, a bane round) through the real `ShipBridge`; record `(dealt, glancing, part, hp after, shield after)`; pin as JSON. Must pass unchanged after B |
| shared rules | `common/src/ships/hitRules.test.ts`: `partHit` and `coverPart` cases; `deriveShellHit` equals `partHit` when the view has the true inputs |
| **parity (C)** | `server/src/net/hits/confirmedHits.test.ts`: a real GameServer over `LocalTransport`, two fake clients (real `ShipStore`, `ShipReplicaSet`, `ConfirmedHits`), one with `HITS`, one without. Scripted fights: Pips on a freighter, railgun pierce, magma ignite, arc chain, a staged boss, a shielded pilot, a marked target. After every frame: both clients' part HP equal the server's wire HP for every ship in view; damage summed per (target, source) per second equal within 0.1; ignite (body, part, ticks) multisets equal; removed shell sets equal by the end; 0 hpCheck mismatches |
| ledger | records the server sends equal what `packHits`/`unpackHits` give back; legacy fallback when E3 fails at write time; turning the bit off and on mid-fight keeps parity |
| protocol | protocol.test.ts round trips for every new COMPACT row: `ignite`, `detonation` (listed kind, unlisted kind string, `from`, `mob`), `intercept`, `bossTelegraph`, `pong`, boss trio, `hits` (one hit, many, new targets, negative deltas, each extra), `hpCheck`; projectile row with and without `gun`; `asteroidSeed` runs; `packHits` fuzz (1,000 random batches) |
| client | `ConfirmedHits.test.ts`: a recorded legacy hit and its record expand to the same messages and HP |
| goldens (expected, on purpose) | `frameHash.golden.json` (A and C: wire bytes change); `serverMessages.json` (new `hits`, `hpCheck`); `clientMessages.json` (new `hpResync`). `parity.golden.json` and `shipBridgeApi.json` must not change |

---

## 7. Measurement

Probe: `scratchpad/net/netAudit.ts` (copy into server/src/bench to run, delete after; `runall.sh <outdir> <names>`).

**Before (record first, on the current tree, into `scratchpad/net/before-hits/`):** `idle`, `P_pip`, `P_hammerhead`,
`P_spark` (2 Sparks + 2 Chainsaws, the "Gale" fight), `P_heavy`, `npcfight`, `boss`, `debris`, and `P_beam` (a
non-shell control). Per pilot (shooter A, observer B): raw and deflated B/s, messages/s, and B/s for `projectileHit`,
`damage`, `shipHps`, `removed`, `ignite`, `detonation`, `intercept`, `bossTelegraph`, `pong`, own shell rows. The
catalogue's figures are the reference (e.g. Hammerhead 2,905 B/s, Gale 5,368).

**After A:** same runs. Expect Gale `ignite` + `detonation` ~2,505 -> ~1,050 B/s.

**After C:** the probe's fake clients announce `HITS` with `CAPS=1` (A capable, B not; then both). Extra numbers:
records/s; old-path hits/s by reason (E2, E3, E4); extras per 100 records (`D`, `S`, `I`); shipHps entries/s; hpCheck
mismatches/min and resyncs; `ledger.plan` + `writeFor` ms per snapshot. Expect `projectileHit` + hit `damage` + hit
`shipHps` + shell removals (~1,144 B/s in Hammerhead) to drop to ~300 B/s of `hits` (est), less `gun` on rows
(~+100). Write it up in `docs/audits/` in the impact report's form. If `D` appears on more than ~30% of records for one
cause (wing bonus, shield, satisfaction), make that input client-known next.

---

## Task list

### A. Quick wins (one bump)
1. Record the "before" runs (section 7).
2. `fxKinds.ts` + `COMPACT_HOOKS`; COMPACT rows for `ignite`, `detonation`, `intercept`, `bossTelegraph`, `pong`, boss beam/charge/blow (A1-A6).
3. `asteroidSeed` as runs, server and client (A7).
4. `people` once at login; `items`, `party`, `ops` only on change (A8-A11).
5. Round-trip tests; `npm run wire:bump`; regenerate `frameHash.golden.json`; `npm test`, both typechecks; measure.

### B. Shared rules (no wire or golden change)
1. Pin the hit golden (section 6) on the current code.
2. Add `common/src/ships/hitRules.ts`: move `GLANCING`, `STAGE_COVER`, `hpWire`, `bursts`, `cover`; add `partHit`, `shellAmount`, `igniteRule`, `hitEndFx`.
3. Point `hurt`, `cover`, `Weapons` and SnapshotBuilder at them; the golden and all tests pass unchanged.
4. Add `deriveShellHit` and its tests.

### C. Confirmed hits
1. Caps: `CAPS`, `join.caps`, `welcome.caps`, `conn.caps`, `netCaps`/`NET_CAPS`, URL/settings toggle, admin command.
2. Protocol: `hits`, `hpCheck`, `hpResync`, projectile row `gun`; `hits.ts`; round-trip tests; bump.
3. Server: `Projectile.gun`; `notifyShellHit` and `hitFx` seams; `HitLedger` (hit, end, plan, writeFor, fallback, check); Outbox damage coverage; SnapshotBuilder order split and removal skip.
4. Client: `ConfirmedHits` (shell table, expand, HP, removal); `HANDLERS`; ShipClient feed; `GameState.removeShell`.
5. hpCheck and `hpResync`.
6. Parity, ledger and client tests; golden updates (`frameHash`, `serverMessages`, `clientMessages`).
7. Probe with caps; measure; write the audit; decide what to make client-known next.

---

## Part A as built (2026-11-04, protocol 26)

Built as designed. Differences from the text above:

- The eight new `COMPACT` rows are appended after `mapDots`, not placed earlier. Existing codes keep their numbers.
- `COMPACT_HOOKS` (protocol.ts) has two entries: `detonation` (kind by number, `FX_KINDS` in `fxKinds.ts`) and `intercept` (`down` as 0/1). Both undo themselves on unpack, so no client handler changed.
- `fxKinds` is in `wireTables()`, so the hash covers it. Weapon kinds come first in `WEAPON_KIND_TYPE` order; `fxKinds.test.ts` holds that. The list also has `tesla_arc`, `mob_burst`, `mob_fizzle`, `eruption`, `synapse`, `scrap`, `sludge`.
- `asteroidSeed` ranges use a general helper (`packRanges`/`unpackRanges`, network/ranges.ts): runs of "one more than the last", any order, so `ids` and `indices` stay aligned. The client unpacks in `serverMessages.ts`; `GameState.handleAsteroidSeed` is unchanged.
- A8: the forced `sendPeople(conn, true)` at the end of `Quests.onLogin` was removed. `send(conn)` just before it already sends `people` (the connection has not been seen, so nothing is de-duplicated away).
- A9: `Session.itemsKey` (Pilots). A10: `Party.sent` (a WeakMap by connection, cleared when a member leaves or the party disbands). The client only uses a member's x, y when that ship is not in view (nav marker fallback, map), so 1 km steps are enough. A11: `Operations.shown` is now a `WeakMap<conn, JSON>`.
- `support.test.ts` used to assert `intercept` was not compact. It now asserts it is.
- Golden change on purpose: `frameHash.golden.json` (frame bytes and counts change: `items` and `party` copies are gone). The `world` hash did not change.

### Measured (probe, 20 s, 3 ticks latency, shooter A, raw B/s; before -> after)

| scenario | A raw | ignite | detonation |
|---|---|---|---|
| idle | 293 -> 293 | | |
| P_pip | 835 -> 835 | | |
| P_hammerhead | 2,905 -> 2,905 | | |
| P_spark (Gale) | 5,368 -> 3,567 | 1,152 -> 288 | 1,353 -> 416 |
| P_heavy | 478 -> 467 | | 16 -> 6 |
| boss | 5,237 -> 5,061 | | 125 -> 45 |
| debris, npcfight, P_beam | unchanged | | |

The Gale fight drops by a third. Deflated (what actually crosses the wire) goes 1,758 -> 1,667 B/s: deflate already squeezed the repeated keys, so the real saving is smaller than the raw figure. The probe does not count `pong`, `bossTelegraph`, `intercept` or `asteroidSeed`; the round-trip tests in protocol.test.ts and ranges.test.ts cover them. The before/after JSON is in the session scratchpad (`net/before-hits/`, `net/after-A1/`).

## Part B as built (2026-11-04, no wire or golden change)

The rules now live in `common/src/ships/hitRules.ts`. The server calls them; its numbers did not change.

- **Safety net first.** `server/src/game/hitRules.golden.test.ts` was pinned on the old code before anything moved. It runs 420 direct hits (`hurt`, `damagePartBy`, `splashAt` with every weapon's HitInfo, shields, stage cover, a ruin piece, bane, marks, boss taken scales, an immune ship) and 40 volleys of live shells (cannon, railgun, flak, missile, magma, arc, cinder_bloom, prism, emp, phase, autocannon, mortar, torpedo) through Weapons and the collision step. It pins dealt, the glancing share, shield, shieldHitTick, last hitter, shield breaks, every part's HP, and every `ignite`/`detonation` Weapons sent. It passes unchanged after the move, as do `parity`, `frameHash` and `shipBridgeApi`.
- **Moved:** `GLANCING` and `STAGE_COVER` (bridge/core.ts re-exports them), `hpWire` (SnapshotBuilder imports it), `bursts` (Weapons.ts re-exports it), `cover` -> `coverPart(ctx, ship, part, at?, memo?)` (bridge `cover` is now one line).
- **New:** `partHit` (the body of `hurt`), `shellAmount`, `shellVs`, `pierceKeepOf`/`PIERCE_KEEP`, `shellGone`, `struckStands`, `igniteRule`, `hitEndFx`, `deriveShellHit`.
- **Differences from section 2:**
  - `ctx` is `{ catalog, tuning, geometry(ship) }`, not a geometry array. The ShipBridge is one as it stands. Geometry is only asked for when the cover needs it, as before.
  - `mods` are lazy: `stageCover()`, `baneFaction()` and `taken()` are functions, called only where the old code called the host. So the boss hooks run exactly as often as before and a plain hit costs no lookups. A client view leaves them out (defaults: `STAGE_COVER`, no bane, taken 1).
  - `partHit` reports `broke` and `hurt` calls `shieldBroken` after the hit, not in the middle. Its only listener (Flash) refills the shield, and nothing in between reads the shield, so the result is the same. `share` is what `b.lastThrough` holds (through × min(1, taken)).
  - `hurt` reuses one mods object and one result object, so a hit allocates nothing new.
  - `shellAmount` rounds to f32 at each step, as `Projectile.damage` stores it. `Weapons.spawn` now uses it; storing it gives the same f32.
  - `Weapons.vsOf` uses `shellVs` for shells with extras. A plain cannon shell keeps no extras and still gets just `{ hit }`.
  - `deriveShellHit` uses the passes *before* the hit for `gone` (spent when `passes >= pierce`), matching `onShipHit`. It leaves the view's shield alone, and sets the struck part's HP to the wire value. `hpAfter` is -1 when no part took the hit.
- **Tests:** `common/src/ships/hitRules.test.ts` covers the small rules, `partHit` (plain hit, shield soak and break, splash, bane, taken, ruin floor), `coverPart` on Scrap Mother (stage cover, the boss's own share, the memo), and `deriveShellHit` against `partHit` for cannon, railgun, magma and flak with 0 and 1 passes.

## Part C as built (2026-11-04, protocol 27)

Built as designed, behind the switch: on for clients that announce it on the dev server, off everywhere else. A legacy
client gets the same messages at the same moments (the Outbox's `skipCaps`). Differences from sections 3-5:

- **Files.** New: `common/src/network/hits.ts` (`CAPS`, `ShellHitRecord`, `packHits`/`unpackHits`, `hpChecksum`),
  `server/src/net/hits/HitLedger.ts`, `client/src/ships/hits/ConfirmedHits.ts`. `gunShell` (what a gun's shell is, from
  the firing ship as both sides have it) went into hitRules.ts.
- **Seams.** No new host calls: bridge `notifyProjectileHit` gained an optional `hit` argument (target, part, dealt,
  glancing, soak, rebuild count), and Weapons sends the ignite, pierce flash and end detonation of a ship hit through an
  optional `WeaponsHost.hitFx`. GameServer wires those to the ledger and calls `hits.end(proj)` where a shell is spent.
  `lastHurtSoak()` (bridge/damage.ts) reads the shield's share of the last hit.
- **The switch.** `join.caps`; the server keeps `capsOffered` (what it allows: `netCaps`), `capsNext` (join, or the
  admin's `/hits on|off [name]`), and `caps` (in effect). `caps` changes only in `HitLedger.endSnapshot`, so no hit is
  told both ways. `authResult.caps` (not `welcome`, which goes before the join) tells the client. The client's switch:
  `?hits=1` or `?hits=0` (remembered in localStorage), else on in dev builds. No settings checkbox yet. `/hits` with
  no on/off shows the ledger's counters.
- **No ledger work without a capable client.** `shellHit` keeps nothing and broadcasts as before unless some client had
  HITS when the snapshot window began.
- **Damage.** `flushDamage` sends the sums to legacy clients and holds them (`heldDamage`) for capable ones, which get
  theirs in `write`: a sum the records cover entirely isn't sent (the client sums the records); a sum with something
  else in it too (a blast) goes as ever, and the records with that sum get `D = 0` so the number isn't shown twice.
- **The plan runs in the snapshot loop**, after the syncs and before the removed list: it needs the shells the client
  has (its rows, now or before, and this snapshot's fire events) and must leave the spent ones out of `removed`. The
  derivation runs there too, on `Object.create(liveShip)` with `hp` = `shipHpSent` and no shield, so `shipHpSent` is
  updated in place.
- **The old way, per client.** A hit goes the old way (to that client alone, after its snapshot) when: the target
  rebuilt since the hit or isn't synced or in view; the shell has no gun or the client never had it; the shooter isn't
  synced; it's out of range; the gun is gone; the end the client would draw isn't what the server sent (a dry round,
  out of ammunition, has no effects); a fire's length differs.
- **The record's point of impact** is worked out on the client: the shell's line from the tick before the hit to the
  tick after, cast against the struck part at the replica's pose for the hit's tick; if that misses, the point of the
  line nearest the part's middle. `deriveShellHit` runs with no `at` on both sides (a boss's cover then picks by the
  struck part's middle; the shipHps fixes any difference).
- **The shell's end.** `GameState.removeShell` follows the snapshot rule: removed now, or with the next snapshot if the
  one just applied made it.
- **hpCheck**: one ship a second from those worked out since their last check; `hpResync` takes up to 32 ids, limited to
  10 a second.

Tests: `server/src/net/hits/confirmedHits.test.ts` (parity, nine fights, both clients compared after every snapshot),
`common/src/network/hits.test.ts` (packing, a 1,000-batch fuzz through the binary codec, the checksum), round trips in
protocol.test.ts. Golden changes on purpose: `frameHash.golden.json` (the frames carry the gun on projectile rows; the
world hash changes only because `Projectile.gun` is a new component field, and matches the old one with it left out),
`serverMessages.json` (`hits`, `hpCheck`), `clientMessages.json` (`hpResync`). `parity.golden.json` and
`shipBridgeApi.json` did not change.

Measured (docs/audits/confirmed-hits-impact-2026-11-04.md): the shooter's bytes fall 23% with Pips, 19% in the
Hammerhead fight and 33% in the Gale fight (deflated: 25%, 16%, 21%). The client's own sums needed the server's number
on 12 of 1,832 records. The main loss left is hits on ships that rebuilt before the snapshot (24% in the Hammerhead
fight), which go the old way; that is the next step, not another hidden input.

## Review fixes (2026-11-04)

- **A shell removed just before its records.** A pierce shell could pass one ship (a record) and then end the old way
  or expire in the same snapshot. Its id went in the snapshot's removed list, the client dropped the shell, and the
  record that followed could not be worked out: no hit, no damage number, the HP off until a resync. The client now
  keeps the shells a snapshot removed until the hits message after it (`ConfirmedHits.forget`). Test: "railgun through
  a stack".
- **Pass counts forgotten the same way on both sides.** The server forgot every removed shell; a client only forgets
  what its removed list names. The server now forgets per client, from that client's list (`HitLedger.dropShells`),
  and the client forgets after the hits message, as the server does after planning. A new connection starts the
  client's counts afresh (`ConfirmedHits.reset`, on connect).
- **A respawned or reused target.** A hit now keeps the target's state; if the ship at that id is a new one by the
  snapshot, the hit goes the old way.
- **Small ones.** Hits in another system are skipped per client (they were counted as "view" and cost a derive each).
  No hpCheck for debris the client is working out. The snapshot's hits are dropped even if the snapshot throws. The old
  `fireCannon` shell sets `Projectile.gun` to -1 (a reused id kept the last shell's gun).
