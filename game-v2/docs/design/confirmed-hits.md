# Confirmed hits (design, 2026-11-04)

Status: **built** (A: protocol 26; B: no wire change; C: protocol 27, on for the dev server only; D, client-detected hits: protocol 28, on for the dev server only; F3, zero disagreements by construction, and E, rough adaptive validation (CAPS.ROUGH): no protocol change, dev server only; G, the own ship stepped by its client (CAPS.OWN_SIM): protocol 34, dev server only). What differs from the design is in the "as built" sections at the end; the measured result is docs/audits/confirmed-hits-impact-2026-11-04.md.

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

---

## Part D: client-detected hits (2026-11-04, protocol 28)

Part C still sends a record (5-8 B) for every hit. Part D has the client find the hits itself and send up one byte
that says what it found; the server sends nothing for hits it agrees with. It sits on its own caps bit,
`CAPS.SELF_HITS` (2), on top of `HITS`: a client with only `HITS` gets part C exactly as before, and a legacy client
gets the old messages.

### D1. Is the client's view tick-exact? (feasibility)

| input | exact on the client? | why / what is done |
|---|---|---|
| a shell fired by another ship (fire event) | **yes** | `rebuildVolley` from the firing ship's replica pose with the shared deterministic maths. Compared during this work in the parity fight: the rebuilt spawn and velocity equal the server's `Projectile.spawnX`/`Velocity` bit for bit |
| the client's own shells (projectile rows) | **no** | rows carry spawn to 0.1 and velocity to 0.01, so the line is off by ~0.1-0.3 units after a second of flight. This causes every correction left (D7) |
| a shell's line each tick | yes, given its origin | the server moves shells `Position += Velocity` in f32; the client does the same (`Math.fround` each step). The line tested at tick k runs from its place at the end of tick k to one step on, as `collisionSystem` does |
| the first tick a shell is tested | yes | pilots' shells are spawned before `projectileSystem` (spawnTick - 1 in rows and fire events), pilotless ships' in `ships.tick` after the collision step: both are first tested at spawnTick + 1 |
| a target's pose at tick k | yes, with one rule | the replica's state at the end of a tick (`ShipReplicaSet.at`) is bit-exact. A pilot moves before the collision step (pose at k); everything else moves in `ships.tick` after it (pose at k - 1). Values go through `Math.fround`, as the server reads `Position`/`Rotation` |
| a target whose path changed in the window | **no** | a keyframe in this snapshot means the replica's history before the keyframe's tick was a guess (a knock, a boss's drive). Left to the server (told) |
| a target whose shape changed in the window | **no** | a rebuild (part lost) or first sight: a `shipSync` since the client's last snapshot. Told |
| who may hurt whom | yes, except PvP zones | `sidesHurt` (common hitRules.ts) is `GameServer.canDamage` bar the zones; the server now calls it too. Pilot against pilot: told |
| the cast | yes | `shipSegmentHit` (bounding circle, then `castShipAt` against standing parts) is the bridge's `segmentHit`, moved to common; the bridge calls it |
| rock, mobs, walls, point defence, expiry | no | the client doesn't simulate them. A shell they end is in the snapshot's removed list: the client sits that shell out for the window, and the server tells its hits in that window |
| own ship, debris | not attempted | own ship: its pose at the server's tick is the prediction's; debris: held and acked separately. Told |
| shields, boss cover, marks, power | no | as part C: the record's extras. A hit whose record would carry an extra is told |

So the client can simulate exactly: straight shells (fire events exact, own rows close) against replicated ships that
weren't keyframed or synced in the window. Everything else the server tells, as part C records.

### D2. The tick-faithful layer (client `ships/hits/SelfHits.ts`)

- **Shells**: every straight shell from a gun the client is told of (rows with `gun`, fire events rebuilt), unless it
  lobs, arms late or is a great orb (`size x 5 >= 20`). Kept apart from the drawn entities; dropped on removal, on a
  spent hit, or when a projectileHit for it comes the old way (the client no longer knows what it passed through).
- **Per snapshot** (`detect(tick)`, after the snapshot is applied): for each tick since the last snapshot, each shell
  (by id) is moved and cast against each candidate ship; the first part struck (smallest t) is a hit. Pierce:
  exclusions and `shellGone`, as the server's `onShipHit`.
- **Candidates**: replicated ships in the store, not its own, not debris, not synced or keyframed in this frame,
  `sidesHurt(shooter, target) === 1`.
- **Applying**: the hits found are worked out at once (`ConfirmedHits.own`: HP into the store before the frame's
  `shipHps` and `hpCheck`), and their messages wait for the frame's end. The frame's `hits` (told records) are merged:
  one for a hit it found overrides it (number, shield, fire, end); the rest are worked out as in part C. A shell told
  the old way drops its found hits (`oldWay`, HP taken back). At the frame's end (`NetworkManager.onFrameEnd`,
  `LocalTransport` too) everything goes to the usual handlers.

### D3. The chain and the report

- Each hit (found or told) adds `hitHash(shell, target, struck part)` (a 32-bit mix) to the chain, a sum mod 2^32. The
  tick is left out and the sum doesn't depend on order, so a hit seen a tick to the other side of a snapshot puts the
  chains back in step one snapshot later.
- When a snapshot changed the chain, its low byte goes up as `input.hitReport` (protocol 28: flags2 0x20, then 3
  bytes: the byte, and 16 bits holding the snapshot tick's low 14 and a 2-bit correction count). It rides an input that
  goes anyway (at most one per 6 input ticks), or goes on its own after 6 input ticks. No hits, no report.

### D4. The server (`net/hits/HitLedger.ts`, `net/hits/SelfHitJournal.ts`)

- `plan` for a finding client: each hit is **findable** or **told** (`unfindable`: own ship, debris, synced since its
  last snapshot, keyframed this snapshot, shell removed this snapshot, orb, not straight, pilot against pilot, shell
  with an earlier old-way hit). All are worked out on the client's HP copy as in part C, findable ones first in
  tick-then-shell order (the order the client applies them). A findable hit whose record needs an extra (D, S, I, or the
  client's own glancing or spent differs) is told. Records go only for told hits.
- Every hit it should have goes into its journal (`close`): one window per snapshot, with the chain after each.
- `report`: a report agreeing with the chain as of its tick settles everything up to it.
- `judge` (each snapshot): once the client must have heard a window and answered (its ping + 12 ticks), its chain as of
  then is its last report (silence: no change). Agree: settled. Disagree twice running (one snapshot apart): a
  correction.
- **Correction** (`hitFix {s, t, c, e, h}`, a COMPACT row): every hit after the last agreement up to t (records, each
  with its number), the server's chain at t and the new correction count. The client works out the hits it missed (HP
  and all), takes back the ones it had that the server didn't (each kept hit remembers its HP change), sets its chain
  to `c` plus its own hits since t, and reports at once in the new count. Reports in the old count are ignored, and
  judging waits for the new one. The ships go on the hpCheck rota; `hpCheck`/`hpResync` stay the backstop.
- The switch: `netCaps` (a plain server message) tells the client the caps in effect from the snapshot just sent, so
  both sides start (or stop) at the same window. Dev server: `NET_CAPS` defaults to `HITS | SELF_HITS`; client: on with
  confirmed hits unless `?selfhits=0` (remembered). The admin's `/hits off` stops both (D needs C).

### D5. Seams

New: `client/src/ships/hits/SelfHits.ts`, `server/src/net/hits/SelfHitJournal.ts` (and its test),
`server/src/net/hits/fakeHitsClient.testkit.ts` (the fake client the tests and the probe share; `*.testkit.ts` is left
out of the server build), `server/src/net/hits/selfHits.test.ts`. Changed: `hits.ts` (`CAPS.SELF_HITS`, `hitHash`,
`chainAdd`, `HitReport`, `unwrapTick14`), `protocol.ts` (`hitReport` on the binary input, the `hitFix` row,
`netCaps`), `hitRules.ts` (`sidesHurt`, `nearShipSegment`, `castShipAt`, `shipSegmentHit`), bridge `weapons.ts`
(`nearSegment` and `castShip` call common's), `GameServer.canDamage` (calls `sidesHurt`), `SnapshotBuilder` (the sync
tick in `shipSynced.at`, keyframed ids to `plan`), `flight.ts` (the report), `ConfirmedHits.ts` (own, told, oldWay,
flushPending, corrected), `ShipClient.ts` (afterSnapshot, frameEnd, onHitFix, onNetCaps, takeHitReport),
`inputSend.ts`, `serverMessages.ts`, `NetworkManager`/`Transport`/`LocalTransport` (`onFrameEnd`).

### D6. Tests

- `server/src/net/hits/selfHits.test.ts`: a real server, a finding shooter, a legacy observer and a finding observer
  (fire events). Pips on a dying freighter, railgun through two freighters, magma, a shielded freighter, a target
  coasting across the line of fire: after every snapshot each client's part HP is the server's; at the end the same
  damage, fires, impacts, detonations and removed shells as the legacy client; no corrections; no hpCheck mismatches.
- Forced mismatch: the shooter throws away a third of the hits it finds. Every one is corrected (26 of 26), the missed
  hits are drawn (as many impacts as the legacy client), the finding observer is untouched, and all HP is right by the
  end.
- `SelfHitJournal.test.ts`: agreement, silence, a missing hit (corrected at the second judging), a hit seen a snapshot
  early or late (not corrected), an unexpected hit, stale reports after a correction.
- Round trips: the input with a report (with and without debris acks), `hitFix` and `netCaps` (protocol.test.ts);
  `hitHash`, `chainAdd`, `unwrapTick14` (hits.test.ts); `sidesHurt` against the old `canDamage` rule for every pair
  of sides (hitRules.test.ts).

### D7. Measured (probe, 20 s, 3 ticks each way, shooter A, decoded payload B/s)

The same probe for all three runs (session scratchpad `net/self/netAuditSelf.ts`, `runself.sh`): A finds its hits
with caps 3, takes records with 1, nothing with 0; B is a legacy observer (unchanged in every run).

| scenario | no confirmed hits | part C (caps 1) | **part D (caps 3)** | D vs C | deflated C -> D | reports up |
|---|---|---|---|---|---|---|
| 2 Pips, parked freighter | 1,041 | 838 | **769** | -69 (-8%) | 729 -> 690 | 5.6/s, 17 B/s |
| Hammerhead | 3,146 | 2,484 | **2,314** | -170 (-7%) | 1,625 -> 1,525 | 9.4/s, 28 B/s |
| Gale | 4,313 | 2,998 | **2,768** | -230 (-8%) | 1,598 -> 1,609 | 10/s, 30 B/s |
| Scrap Mother | 4,108 | 3,954 | **3,949** | -5 (0%) | 2,867 -> 2,863 | 4.5/s, 13 B/s |

Records (`hits`) went 69 -> 0, 196 -> 24 (+2 hitFix), 238 -> 3 (+4 hitFix) and 68 -> 62 B/s. Frames/s did not
change, so the ~66 B of headers a frame is the same. Deflate already squeezed the records, so the deflated gain is
smaller (the Gale's is within noise). A report costs 3 B riding an input; one that must go alone costs a frame (~80 B
with headers): in a fight inputs go most ticks, but a pilot holding still would pay that.

**Mismatch rate** (journal disagreements and corrections per 100 hits the client was owed):

| scenario | owed | found by the client | told | disagreements /100 | corrections /100 |
|---|---|---|---|---|---|
| Pips | 159 | 159 | 0 | 0.63 | 0 |
| Hammerhead | 592 | 538 | 54 (synced, keyframed) | 0.34 | 0.17 (1 hit, wrong part) |
| Gale | 676 | 669 | 7 | 0.59 | 0.30 (2 hits, wrong part) |
| Scrap Mother | 150 | 16 | 134 (keyframed most snapshots) | 0 | 0 |

0 hpCheck mismatches in all four. With the shooter's own shells given their exact origin (a probe-only cheat), the
Hammerhead and Gale runs had **0 disagreements**: every correction left comes from own shell rows' rounding.
Client cost: 0.03-0.06 ms a tick more on the fake client; server `stepMs` within noise.

### D8. What's left

1. **Own shells exact.** Either quantise a gun shell's spawn and velocity to the row's grid at spawn (one common
   function used by `Weapons.spawn`, `rebuildVolley` and the pilot's predicted shot: rows and fire events both exact,
   at the price of a golden shift), or match the pilot's own predicted shots (exact) to rows that round from them.
   Either removes the corrections measured above.
2. **Bosses.** Their drive and dash impulses aren't replicated, so a boss is keyframed most snapshots and its hits are
   told. Replicating boss motion is what makes D pay there.
3. **Rebuilt and synced ships** (the largest told group, and part C's old-way group): let the client find hits on the
   shape it had before the sync, as part C's audit suggested.
4. **Own ship as a target**: needs the prediction's history at the server's ticks (exact when the prediction was
   right).
5. Reports with no input to ride on cost a frame: a pilot sitting still while being shot could batch them longer.

### D9. Review fixes (2026-11-04)

A review of parts D, packed frames and the deterministic maths (commits a05b5b8, 6acc352, 4cb9e56) found and fixed:

1. **Hits lost when finding is switched off.** The server switches caps at a snapshot's end, so `netCaps` comes in
   the same frame as that snapshot's records, after them. The client (ShipClient.frameEnd, and the test kit) only
   handed out the frame's waiting hits while SelfHits was on, so the switching frame's hits (found and told) were never
   drawn, their spent shells never removed, and they sat in ConfirmedHits' pending list until the next switch on.
   The frame's end now hands them out whenever any wait (`ConfirmedHits.hasPending`).
2. **Shells flying when finding is switched on.** What they passed through before isn't on the client's layer (no
   pierce exclusions, no spent mark), so it found false hits on them, put right only by a correction. Both sides now
   treat them alike: the server marks every shell then flying in the client's system as told (HitLedger endSnapshot,
   the `oldWay` set), and the client drops its layer's shells (SelfHits.setOn). A told shell spent by its record
   leaves that set (HitLedger.write), as a removed one already did.
3. **Ids used again.** The server reuses entity ids. A shell spent by a record never comes in a removed list, so its
   entry stayed on the layer (dead) until the 256-shell prune, and a new shell given its id was refused
   (`addShell` returned on any entry). Now `SelfHits.spent` takes spent shells (and dropped ones) off the layer when
   their records are handed out, and an entry with another spawn tick is replaced.

Tests: selfHits.test.ts, a finder switched to part C and back mid-fight (the first switch lands on a frame with hits
waiting: 2 impacts were lost before), and the layer's id handling.

---

## Follow-ups (2026-11-04)

### F1. Where a told hit is drawn (no wire change)

With caps >= 1 the client's impact points for hits it was told (records) drifted from the server's: up to 36 units in
the probe's fights, 27-28 hits a run more than 20 off with Scrap Mother, 6-7 in the pirates fight, 2 with the
Hammerhead. Three causes in `ConfirmedHits.hitPoint`, all about when and where it cast:

| cause | before | now |
|---|---|---|
| the target's pose | the replica's state at the end of the hit's tick, for every ship | as the server's collision step saw it: a pilot's at the hit's tick (it moves before the step), anyone else's at the tick before (they move in `ships.tick`, after it), in f32: the rule SelfHits uses (host `pilot(id)`) |
| the client's own ship | no replica, so the fake had no pose (the line's middle) and the game used the ship's current predicted pose, a latency ahead | its predicted pose at that tick: `GameState.selfPoseAt` (a 180-tick history noted on each predicted step, each replayed step after a correction, and at a correcting snapshot's own row). Where the server had it while the prediction held |
| the line | two steps wide, centred on the hit's tick | the server's: from where the shell is at the end of that tick (moved in f32 as the server moves it) to one step on; a line a hair off (an own shell's rounded row grazing the part) is cast again 2 units thick before falling back to the point nearest the part's middle |

Measured (probe, caps 1 / 3 / 15, hits more than 20 units off, before -> after): Scrap Mother 28 / 27 / 27 -> 1 / 1 / 1
(a hit on the boss in the snapshot that keyframed it: its path before the keyframe is the client's guess), pirates
7 / 6 / 6 -> 0, Hammerhead 2 / 2 / 2 -> 0, Pips and Gale 0 -> 0. What is left over 20 is debris (2-3 corrections a run
whose records' hit ticks are clamped at 7 ticks back, and hits the client found a tick early: the weak case the
phase 2-3 audit names).

The fake client (fakeHitsClient.testkit.ts) gained what the game's client already does: its own ship's pose per tick
(the server's, as a prediction that held: noted as each frame goes and after each step) and every replica stepped to
each snapshot's tick (the game's client steps them as it draws; a replica nobody asked for in 600 ticks stops short,
which gave the probe a 1,426-unit "drift" from a stale shell origin at caps 1). Test: `server/src/net/hits/hitPoints.test.ts`
(a seeded pirates fight; 155 hits on the client's ship, 41 on pirates; fails on the old hitPoint).

(F1 note, later the same day: Kieran put visual consistency first. Every drawn shell now stops at the first surface it
touches as drawn on the client (docs/areas/weapons.md, "Where a shell stops"), and the server's hits only confirm, so
the derived point above draws an impact only for a shell the client isn't drawing.)

### F2. Own shells exact: fire events for the pilot's own guns (CAPS.OWN_SHOTS = 16, no protocol change)

The shooter's own shell rows cost 435-437 B/s in the Hammerhead and Gale fights and were the source of nearly every
hash disagreement left: rows round the spawn to 0.1 and the velocity to 0.01. With exact spawns (a probe-only cheat)
the disagreements were 0.

**What the client needs to build its own shells exactly**, and where each comes from:

| input | source | exact? |
|---|---|---|
| that a gun fired, on which tick, and the shells' ids | the fire event (as for every other ship) | yes: nothing to predict, so energy-limited fire, a clip, a dry gun and ammunition are the server's word |
| the aim (turret or gimbal) | the fire event's `aimQ` | yes |
| the ammunition and an augmented shot | the fire event's part packing | yes |
| spread | `shellSeed(owner, gun uid, i)`, shared (launch.ts) | yes |
| launch maths (muzzle, direction, speed, size) | `rebuildVolley`, deterministic (detTrig) | yes |
| the ship's pose and velocity on the fire tick | its own prediction: `GameState.selfPoseAt(tick)` (noted on every predicted step and every replayed one after a correction) | while the prediction held on that tick |

`lastProcessedInput` isn't needed: the history is kept by tick, and a tick the prediction got wrong is one the server
corrects. So the server sends the pilot's own straight volleys as fire events (server `net/snapshot/ownShots.ts`,
SnapshotBuilder's fire loop) unless the snapshot's own row is a correction (`selfRowState.fix`: forced, an input
applied late, a new keyframe version, first sight, or a change to what its flight depends on), when that window's
shells go as rows, as before. The client builds them in `ShipClient.preSnapshot` from `selfPoseAt` (rows for the rest,
as ever). It is a caps bit of its own, not SELF_HITS: it helps any client (bytes and exact own lines), a client that
doesn't build its own shells from fire events must not get them, and it can be switched on its own (`?ownshots=0|1`;
on in dev builds; the dev server allows it, `NET_CAPS` 31 elsewhere).

**Still rows** (by rule, and why):
- a window whose own row corrects the prediction (above): the client's pose for those ticks was its guess;
- shells that don't fly a straight line from the muzzle: homing, guided, lobbed, arming late (their rows carry where
  they are, and their hits are told anyway);
- clients without the bit.

**Not exact, and not caught** (measured): a pose the prediction got wrong without the server knowing on that window
(a hash mismatch found later: the 1-a-second state hash). In the probe (whose fake client takes the server's own pose
as its prediction), 2 of 109 own shells in the boss fight and 7 of 821 in the debris fight were built off: a knock (a
boss's blow, a collision with debris) in the tick it fired, which the window's own row didn't flag as a correction.
SelfHits' hash and hitFix put those right, as before.

Tests: `server/src/net/snapshot/ownShots.test.ts` (no own rows in a steady fight, every own shell bit for bit the
server's, every found hit agreed, the same hits as a legacy observer; a stretch of forced corrections sends that
stretch's shells as rows; without the bit, rows).

Measured (probe, shooter, caps 15 -> 31): own shell rows 434 -> 0 B/s with 198 B/s of fire events instead
(Hammerhead), 437 -> 0 with 155 (Gale), 76 -> 0 with 38 (Pips); payload 951 -> 713, 1,093 -> 808, 322 -> 285;
hash disagreements 2 -> 0, 4 -> 0, 1 -> 0; corrections 1 -> 0, 2 -> 0. Details: docs/audits/netcode-phase2-3-impact-2026-11-04.md,
"Follow-up".

### F3. Zero disagreements by construction (no protocol change)

Kieran (2026-11-04): "There shouldn't be disagreements, if the tick aligned simulation is accurate, if something gets
knocked, it's expected and replicated on both." And: "the visual shots should be predicted, but the simulation/damage
etc should be from the tick accurate ship". So a client keeps two layers that never feed each other:

| layer | what it is | where it comes from |
|---|---|---|
| **drawn** (cosmetic) | its own shells launched at once from its predicted ship, each stopped by the first surface it touches as drawn; told hits' impact points on its own ship | its prediction (`GameState.selfPoseAt`, WeaponFx) |
| **tick-aligned** | every shell's line, every hit, damage, part HP, fire, the hit chain and its hash | the server's ticks: fire events built from replicas (its own ship's too), told records |

The one link is the existing adopt/claim step: the server's (or the tick layer's) shell or hit takes over the drawn
shell already flying, keeping the drawn line (WeaponFx.claim/adopt never move a drawn shell). dee6fd1 mixed them: its
own fire events were built from `selfPoseAt`, so its own shells on the tick layer were exact only while its prediction
held. Every disagreement left had a cause on the tick layer, each now removed rather than corrected:

| cause | seen as | fix |
|---|---|---|
| a window searched before the frame's told records were read | debris: a shell the server said struck debris (or a keyframed ship, or the client's own) flew on, on the client's layer, into the hauler behind; a hit the server never had, then the client's HP off the server's copy and hits on parts the server had lost (28-32 disagreements, 16 corrections and 3 hpCheck mismatches a run) | `SelfHits.open` at the snapshot, `detect(told)` once: at its hits message with its records, or before anything after the snapshot that reads the HP (shipHps, shipHp, hpCheck, hitFix, netCaps, the frame's end). A told record for tick k is that shell's hit on k (the server's collision step takes one ship a tick, the nearest): its exclusion, its pass, its end (commit 3812fb1) |
| the layer in f32, the server in f64 | a line a thousandth of a unit off: now and then the neighbouring part (D1's "f32" was wrong: Position, Velocity and Rotation are f64) | doubles, as the server (SelfHits, ConfirmedHits.hitPoint) (3812fb1) |
| own shells from the prediction | exact only while the prediction held; a knock in the fire tick (boss blows, debris) put them off unflagged; with a prediction 5 units off, every own shell was off (Pips 106, Hammerhead 190, Gale 197, debris 182 disagreements) | the client is sent its **own ship's replication** (Replication.forClient `own`: the very keyframes and control rows everyone else gets of it; switched off, it starts again from a keyframe), and builds its own volleys from that replica at the fire tick, as every other ship's. A window its ship is keyframed in (a knock: the shadow left its path) goes as rows, as for any ship |
| shells as projectile rows were on the layer | rows round spawn to 0.1 and velocity to 0.01: the caps-15 own-row disagreements (Hammerhead 2, Gale 2), and any row a keyframed window sends | a shell sent as a row is told on both sides: the server puts it in the client's told set (`HitLedger.rowShell`), the client sits it out (`SelfHits.row`); only fire events' shells, rebuilt bit for bit, are on the layer |

"Confirmed own state" is therefore exactly the server's shadow of the pilot (the same `Replication` shadow that makes
every other pilot's replica exact: stepped with the controls the real ship used, keyframed when a knock, a blast, an
EMP or a rebuild moves it off), not "shadow plus acknowledged inputs" re-derived on the client: the replicated controls
carry what the engines got (`ctlPower`), which only the server's charge knows, so the client couldn't derive them from
its inputs without its prediction.

Measured (probe, shooter, 20 s, 3 ticks each way; caps 31; "prediction off" = the fake's prediction moved by up to 5
units and 0.05 rad, `predictionError`, cosmetic layer only):

| scenario | disagreements before / after | prediction off: after (before) | corrections before / after | payload B/s before / after |
|---|---|---|---|---|
| Idle | 0 / 0 | 0 (0) | 0 / 0 | 152 / 152 |
| 2 Pips | 0 / 0 | 0 (106) | 0 / 0 | 285 / 285 |
| Hammerhead | 0 / 0 | 0 (190) | 0 / 0 | 713 / 716 |
| Gale | 0 / 0 | 0 (197) | 0 / 0 | 808 / 808 |
| Pirates fight | 0 / 0 | 0 (2) | 0 / 0 | 560 / 680 |
| Scrap Mother | 0 / 0 | 0 (4) | 0 / 0 | 1,936 / 2,118 |
| Debris | **32 / 0** | 0 (182) | 16 / 0 (hpCheck mismatches 3 / 0) | 2,011 / 1,962 |
| Beam | 0 / 0 | 0 (0) | 0 / 0 | 307 / 307 |
| Cruising | 0 / 0 | 0 (0) | 0 / 0 | 161 / 161 |

- Every own shell built from a fire event is the server's bit for bit, with and without the prediction error (pips
  160/160, Hammerhead 822/822, Gale 694/694, debris 813 of 820 checked, the rest spent inside the tick they were fired).
- **The price is the own ship's replication**: its control rows and keyframes, Pirates +116 B/s of control rows,
  boss +84 control and +97 keyframes (the boss's blows keyframe it, and the own row still corrects the prediction with
  the same news), Hammerhead +3, debris +14 (debris is still 49 B/s down, from the hits no longer corrected). Two ways
  down, not built: the own row could leave its motion out when an own keyframe goes with it (the prediction would take
  the keyframe's lossless state), and the aim (q) of the own control rows could come from the client's own inputs when
  they were applied on their target tick (most of the control bytes are aim changes).
- caps 15 (no OWN_SHOTS): own shells are rows, so now told rather than found: 0 disagreements (Hammerhead 2, Gale 2
  before) for 70-115 B/s more records (Hammerhead 951 -> 1,016, Gale 1,091 -> 1,182). caps 31 is the configuration.

Tests: `ownShots.test.ts` (a forced correction and a prediction 6 units off change nothing: every own shell exact, 0
disagreements; a knocked window's own shells go as rows and are told, 0 disagreements); `selfHits.test.ts` and
`packedFrames.test.ts` finders now take OWN_SHOTS (as rows their own shells are told, not found).

---

## Part E: rough, adaptive validation (CAPS.ROUGH = 32, no protocol change)

Kieran (2026-11-04): "we can get away with a very rough validation for shot hits, people who don't pass get more
confirmation, or slightly more tick delay, or both". With F3 the tick-aligned layer agrees by construction, so a
finding client's hit chain only needs checking closely when it has stopped agreeing.

### E1. What the check is for, and why a cheat gains nothing

The server applies its own damage, always: it alone decides hits, damage, kills and rewards (part C's rule, unchanged).
A client's chain decides only how soon **its own view** (its HP copy, its drawn hits) is put right. A client that
claims agreement it doesn't have, or never reports, changes nothing anyone else sees and nothing the server applies;
at worst it shows itself wrong numbers for a few seconds. So validation is about catching a client whose view has
drifted (a bug, a lost message), cheaply, not about trust.

### E2. Levels (common hits.ts `CONFIRM`, `CONFIRM_RULES`; server net/hits/ConfirmLevel.ts)

| level | report (client) | judging (server) | hits found by the client | delay | hpCheck |
|---|---|---|---|---|---|
| **ROUGH** (0) | at most one a second (60 input ticks), when its chain changed | as part D, but waits the 54 ticks more a report may take (`reportEvery` - 6) | all it can (part D) | 0 | one ship / 3 s |
| **NORMAL** (1) | part D: one per 6 input ticks when it changed | part D: every snapshot, after its ping + 12 ticks | all it can | 0 | one ship / s |
| **STRICT** (2) | as NORMAL | as NORMAL, 2 ticks later | **none**: every hit told as a record (`unfindable` 'strict'; `SelfHits` skips its search) | +2 ticks of interpolation (client, `coalesceDelayMs`) and of waiting (server) | one ship / 0.5 s |

- Every client starts NORMAL. **Down**: a level with no disagreement for `CLEAN_TICKS` (600 ticks, 10 s) steps down
  one (STRICT -> NORMAL -> ROUGH). **Up**: any correction (`hitFix`), at any level, means STRICT; a lone disagreement
  starts the clean stretch again.
- A change takes effect at a snapshot's end on both sides (HitLedger.endSnapshot: `netCaps` with the same caps and
  `lvl`), exactly as a caps switch does, so the server's plan and the client's search use the same level for every
  window. The client searches the snapshot before the `netCaps` at the old level (ShipClient.findHits).
- STRICT's two ticks: every hit is the server's record, and the records come with the snapshot; drawing two ticks
  later means they are in before the frames that show them. The server waits as long again before judging.
- ROUGH still catches a persistent desync within a couple of seconds: the first report after it (at most a second
  later) misses the server's chain with odds 255/256, and two disagreements running (one snapshot apart) make the
  correction. A client that goes silent while the server's chain moves is judged as before (silence = no change: a
  disagreement).
- **Server cost**: three numbers a client (`ConfirmLevel`: level, next, since) on top of part D's journal; the judging
  is part D's per snapshot. ROUGH cuts the reports it handles from 5-10 to at most 1 a second. Without CAPS.ROUGH a
  client stays NORMAL (part D exactly).

### E3. Measured (probe, shooter, caps 31 = part D + F3 against caps 63 = + ROUGH; 3 ticks each way)

Steady (measured after 800 ticks, so the caps-63 client is ROUGH throughout; same seeded fights):

| scenario | reports up /s: NORMAL -> ROUGH | report bytes up B/s | hpCheck B/s down | payload B/s | disagreements | server stepMs |
|---|---|---|---|---|---|---|
| 2 Pips | 4.45 -> 1.0 | 13 -> 3 | 4.8 -> 1.7 | 243 -> 240 | 0 / 0 | 0.199 / 0.202 |
| Hammerhead | 9.2 -> 1.0 | 28 -> 3 | 4.9 -> 1.7 | 552 -> 549 | 0 / 0 | 0.255 / 0.262 |
| Gale | 9.9 -> 1.0 | 30 -> 3 | 4.8 -> 1.7 | 740 -> 737 | 0 / 0 | 0.258 / 0.260 |
| Pirates fight | 1.95 -> 0.65 | 6 -> 2 | 3.0 -> 1.3 | 749 -> 747 | 0 / 0 | 0.250 / 0.262 |
| Scrap Mother | 0.15 -> 0.15 | 0 -> 0 | 0.8 -> 0.8 | 1,870 -> 1,870 | 0 / 0 | 0.322 / 0.320 |
| Debris | 6.1 -> 0.7 | 18 -> 2 | 4.5 -> 1.5 | 1,697 -> 1,694 | 0 / 0 | 0.409 / 0.387 |
| Idle, beam, cruising | 0 | 0 | 0 | unchanged | 0 / 0 | |

Messages down per second are unchanged (hits ride the snapshots' frames either way). The upstream saving is 10-27 B/s
of report bytes when every report rides an input that goes anyway (the probe's case); a report with no input to ride
costs a frame of its own (~70 B with headers), and ROUGH has at most one a second instead of up to 10. From the start
(NORMAL for the first 10 s, then ROUGH) the 20-second averages fall half way: reports 8.75 -> 3.4 /s (Hammerhead),
9.95 -> 3.9 (Gale), 9.25 -> 3.75 (debris).

**A forced desync** (caps 63, 40 s, the client throws away a third of the hits it finds from 5 s to 8 s; ROUGH before):

| scenario | caught (STRICT) at | hits it threw away first | corrections | level over the run (one digit per 0.5 s) |
|---|---|---|---|---|
| 2 Pips | 6.4 s | 4 | 2 | `00000000000002222222222222222222221111111111111111111100000000000000000000000000` |
| Hammerhead | 5.4 s | 1 | 2 | `00000000000222222222222222222222111111111111111111110000000000000000000000000000` |
| Gale | 5.3 s | 4 | 3 | `00000000000222222222222222222222111111111111111111110000000000000000000000000000` |
| Debris | 6.3 s | 5 | 2 | `00000000000002222222222222222222211111111111111111111000000000000000000000000000` |

Caught 0.3-1.4 s after it began, STRICT for 10 s (records for every hit: records, fixes and checks over the 40 s
Hammerhead 58 B/s against 20 without the desync, Gale 55 against 12, Pips 15 against 2, debris 30 against 17), NORMAL
for 10 s, then ROUGH again. The HP backstop found the client's HP wrong 0-2 times while it was off (each answered by a
resync); the test below checks it is the server's at the end. Once STRICT, the client found nothing itself, so its own dropping stopped mattering: what it threw away was
the hits before the level rose. The scrap mother fight has almost no hits a client can find (keyframed boss), so
there was nothing to desync.

### E4. Tests

`server/src/net/hits/ConfirmLevel.test.ts` (the level's rules: up on a correction, down a level per clean stretch, a
disagreement restarts it, a change only at a snapshot's end, NORMAL for good without ROUGH); `selfHits.test.ts`
"adaptive validation" (a real server: a ROUGH shooter's persistent desync goes STRICT within 4 s, steps down to NORMAL
and ROUGH, the client told each change; HP right at the end, the same impacts as the legacy observer, the other finder
untouched).

### E5. Left

- (Fixed.) A correction at ROUGH used to come in two or three: reports a second apart fold the changes between into the
  next, so judging at `now - wait` compared the client's value there with an older report and corrected windows that had
  agreed. The journal now judges a later report that is already in at that report's own tick (SelfHitJournal.judge):
  a model client at ROUGH went from 1 correction in 60 cases to 300 of 300, one wrong hit one correction
  (SelfHitJournal.test.ts).
- Nothing escalates for a client whose reports are just late (a bad connection): two disagreements running correct
  it like any other. Its delay could rise with its ping instead (not built).
- The switch: on in dev builds with client-detected hits (`?rough=0|1`, remembered); the dev server allows it
  (`NET_CAPS` 63 elsewhere).

---

## Part G: the own ship stepped by its client (CAPS.OWN_SIM = 64, protocol 34)

Kieran (2026-11-04): "i don't want to send snapshots just in case, constantly, it's better to have a cheap method to
detect disagreements, then send them as needed", and "why can't a knock's push be deterministic?". F3 made the
client's own shells exact by sending it its own ship's replication: its control rows (an echo of the inputs it sent
itself) and a keyframe whenever the shadow left its path. That cost the pirates fight +122 B/s and the boss +173.

### G1. What the client steps (client ships/own/OwnTick.ts, common network/ownTick.ts)

Its tick-aligned own ship is still a replica in ShipReplicaSet, but stepped from an `OwnTimeline` instead of rows:

- **controls**: its own inputs, each from its target tick (`noteInput`: `controlBits(buildFlightInputs(msg, false))`
  and the quantized aim, exactly what the server applies on that tick). Where the ship flew with controls its inputs
  don't say (the engines short of power, an EMP, the cold, a server's release), the server sends that window's real
  controls as a control row of its own ship (from aim 0), and the client puts them in place of its inputs'.
- **causes**, after each tick's step, in the order the server's step had them (a snapshot's `own` rows,
  `[ago, kind, ...]`), then rounded as every body is: PULL, CONTACT, REBUILD (below).
- **structure**: the one it flew each tick with (a REBUILD row's tick splits the structure it had before the shipSync
  from the new one).
- **its guns** fire before a tick's pulls and contacts, so its own volleys are built from the body before that tick's
  causes (`firePose`).

The drawn ship (the prediction) and the drawn shells are untouched; hits, damage and the hash come from this layer.

### G2. Every cause found, and its fix (probe: what moved the pilot's ship off its replica path, all scenarios)

| cause | seen in | fix | status |
|---|---|---|---|
| its own control changes (aim, keys) | every fight: pirates 1,191 rows/min, boss 876, debris 276, Hammerhead 60 | stepped from its own inputs at their target ticks; nothing sent | **fixed** (deterministic) |
| engines short of power, EMP, cold, slowed, a server override (idle release) | none in the probe's fights | that window's real controls (`ownStats.exc`; test: an EMP) | fixed: the small input it needs |
| a contact with another ship | pirates 3 windows / 20 s, boss 55 | the push is worked out on the client with the server's own maths, moved to common (`ships/contact.ts`: `contactPieces`, `contactPair`; the server's pass calls them). Cause: `[ago, 1, other, flags]`. Made deterministic: a pilotless ship's body is now rounded right after its step (as a pilot's is), so the contact pass sees what every replica has (golden shift: hitRules shells, frame hash) | fixed for ships whose replica is the server's |
| ...with a ship whose replica isn't the pass's (an AI ship's drive impulse, a boss; one keyframed or rebuilt in that window) | boss: 828 of 834 contacts; pirates all 12 | the cause carries the other's pose and velocity as the pass had them (`CONTACT_FLAG.STATE`, delta-coded against its last keyframe), the client still works the push out | **TEMPORARY** (AI decisions: goes when they are inputs) |
| a rebuild (parts lost or regrown: the centre of mass moves) | boss 22 windows | `recentreShift` in common (the server's rebuildNow calls it); cause `[ago, 2]`, the client keeps the structure it had before the shipSync. Rebuilds that change nothing it flies or touches aren't sent. Own volleys fired up to the rebuild go as rows (built from the structure it has now) | fixed; **deferred**: two rebuilds in one window (the structure between isn't on the client): a keyframe, 1 in the boss run |
| a boss's magnet (Scrap Mother) and a collapsing star's pull | boss 33 windows | the push, rounded on the server to 1e-5 (`quantizePull`) and sent: `[ago, 0, dvx, dvy]` (ShipBridge.push) | **TEMPORARY** (boss decisions: goes when they are inputs) |
| an input applied late, or dropped by a flood guard | none in the probe | a keyframe of its own ship (the server can't place it on the client's timeline) | deferred (rare: a network stall) |
| server-only actions: respawn, teleport, docking, a rift's bounce, cargo taken on | the probe's set-up only (the first `unexplained`) | a keyframe, as before | as briefed: they have their own messages |
| asteroid orbits, Math.random in AI | not a cause of own-ship mismatches: ships don't collide with rocks; AI randomness reaches the own ship only through the other's pose in a contact (above) | - | left to the deterministic-maths and decision-input workflows |

### G3. The server (net/Replication.ts `stepOwn`, `ownFor`; ships/bridge/ownCauses.ts)

- The bridge notes what moved a pilot's ship in the tick (a pull, a contact with the other's pre-pair state and both
  structures, a rebuild's centres of mass). Replication's shadow of a pilot whose client has OWN_SIM is exactly its
  client's own layer: the replica step with the controls flown, then those causes worked out by the client's own
  function (`applyOwnCauses`). If that isn't the real ship, something its client can't work out moved it (`hard`): a
  keyframe of its own ship (its own version, counting down). Every other client gets keyframes of it as before.
- `ownFor`: its own keyframe only on that version; the exceptions row; the causes, a contact's state left out when the
  client's replica of the other is the contact pass's (stepped that tick in step, the same numbers, no keyframe or
  rebuild of it since). A contact whose other the client can't have (rebuilt with the structure lost, not had): a
  keyframe.
- The own row correcting the prediction is unchanged.

### G4. The check (net/own/OwnChecks.ts; input `ownCheck`, flags2 0x80, 3 bytes)

- Client: `ownBodyHash` (8 bits: place, velocity, heading, turn, jump drive, hold, dodge, and the controls it flew the
  tick with, the engines' power among them) and `ownHpHash` (4 bits of hpChecksum of its own part HP) as of the last
  snapshot's tick (12 bits). The battery itself isn't on the tick layer: what the engines got reaches the motion only
  through the controls, which are in the hash.
- Cadence by the part E levels, kept by the client from its own record: NORMAL to start, ROUGH after 10 s clean, STRICT
  after a fix (a keyframe of its own ship after the first), back down a level per clean 10 s. ROUGH: at most one a
  second, riding an input that goes anyway, or alone after 10 s if its state changed; NORMAL 15 / 120 ticks; STRICT
  3 / 6.
- Server: the expected hashes per snapshot sent (80 kept); off: a keyframe of its own ship next snapshot (state) or its
  part HP again (HP); checks made before the fix went are not judged again. A lying client only spoils its own view.

### G5. Measured (probe `net/own/netAuditOwn2.ts`, session scratchpad)

The pilot flies by input messages, on time; its hit reports and checks ride them LAT ticks later; own-ship B/s is a
twin packed encoder fed the same frames without its own keyframes, control rows and causes. Caps 63 before, 127 after;
20 s, 3 ticks each way, the same seeded fights.

| scenario | own ship B/s before -> after | own keyframes /min | own control rows /min | causes /min after (pull, contact with state, rebuild) | disagreements | checks off / made |
|---|---|---|---|---|---|---|
| Idle | -1 -> -1 | 0 -> 0 | 0 -> 0 | 0 | 0 | 0 / 2 |
| 2 Pips | -1 -> -1 | 0 -> 0 | 0 -> 0 | 0 | 0 | 0 / 90 |
| Hammerhead | 2 -> -1 | 0 -> 0 | 60 -> 0 | 0 | 0 | 0 / 110 |
| Gale | -1 -> -1 | 0 -> 0 | 0 -> 0 | 0 | 0 | 0 / 110 |
| Pirates fight | **122 -> 2** | 12 -> 0 | 1,191 -> 0 | 12 (0, 12, 0) | 0 | 0 / 144 |
| Scrap Mother | **173 -> 204** | 291 -> 3 | 876 -> 0 | 1,497 (600, 828, 63) | 0 | 0 / 283 |
| Debris | 13 -> -1 | 0 -> 0 | 276 -> 0 | 0 | 0 | 0 / 121 |
| Beam, cruising | 0 -> 0, 2 -> 2 | 0 | 3 -> 0 | 0 | 0 | 0 |

(+-2 B/s is the twin encoder's noise.) The prediction-off run (`PREDERR=5`) gives the same numbers to the byte: the
layer never reads the prediction. The own layer was compared with the server's ship on every tick of every window:
0 ticks off in every scenario bar the boss's 2 (inside the one window keyframed for two rebuilds). Own shells from fire
events: every one checked exact (Pips 160/160, Hammerhead 822/822, Gale 694/694, boss 111 built of 123, 0 off).
The 3 boss keyframes: the probe placing the ship (start, unexplained) and the two-rebuild window.

The boss is dearer than before: its contacts carry the boss's pose (its drive isn't replicated) and its magnet's push
goes every tick it pulls. Both are the temporary AI and boss-attack causes: with boss decisions as inputs the boss's
replica is the pass's, the contact rows go without its state (~2 B instead of ~10) and the pull is worked out too.
Steady (measured after 1,400 ticks, the checks at ROUGH) the boss fight costs 93 B/s for its own ship, pirates 1.

Upstream (the check): 3 B riding an input, about 1 a second steady; input messages a second steady Pips 2.0,
Hammerhead 2.45, Gale 4.75 (before: 2.25, 4.7, 3.95 with hit reports at their part D rate over the first 20 s), beam
0.2, cruising 0. Over the first 20 s (the start's fix puts it STRICT for 10 s) checks run 3-5.6 a second and lone ones
raise Pips to 4.9 messages/s up (394 B/s on the wire against 180).

### G6. Tests

`server/src/net/own/ownSim.test.ts` (a real server, the pilot flying by input messages): no control rows or keyframes
of its own ship, its layer the server's ship at every snapshot, every check agreeing; pulled and touched: causes, worked
out exactly; an EMP: that window's real controls go, still exact; a cause dropped: its check catches it, a keyframe puts
it right. `common/src/network/ownTick.test.ts`: the input's check and the snapshot's own rows through both formats; the
pull grid, the 12-bit tick and the hashes; a contact's push and a rebuild's recentring from the cause equal the
server's pass to the bit.

### G7. Other ships: still keyframed "just in case"? (built 2026-11-04 as CAPS.CAUSES: docs/areas/networking.md, "Other ships' causes"; docs/audits/effects-2026-11-04.md)

Yes. Every other ship's replica gets a keyframe whenever its shadow leaves its path, to every client that has it. The
probe's keyframes of other ships: Pips 122 B/s, Hammerhead 172, Gale 355, pirates 46, boss 385, debris 577 (shadows'
reasons over 20 s: pilotless ships off their path 236-832 times, rebuilds 1-165). The same scheme fits them, the
server's shadow being exact knowledge of where a replica goes wrong:

- **rebuilds** (a part shot off moves the centre of mass): a `[ago, REBUILD]` cause, recentred by each client from the
  shipSync it gets anyway, as for its own ship; ~2 B instead of a ~15-25 B keyframe;
- **contacts** among ships: each pair as a cause, worked out by every client that has both (`contactPair`); ~3 B a pair;
- **AI drive impulses** (bosses, dashes) and pulls: the decision-input workflow; meanwhile the impulse as a cause on a
  grid, ~3 B;
- **debris** knocked by something a client doesn't step: as today;
- detection stays the shadow (free); a per-client hash of the replicas it has (a byte over all of them, on its
  inputs) would catch the rest, answered with that ship's keyframe.

Estimate from the reasons: most of the 122-577 B/s is pilotless ships moved by contacts, impulses and rebuilds, so
other ships' keyframe bytes would fall by about two thirds (Gale ~355 -> ~110, debris ~577 -> ~200, boss ~385 -> ~150
B/s before AI inputs, most of the rest after), for a few bytes a cause and the server stepping causes on each shadow.

### G8. Left

- Two rebuilds of the ship in one window (the structure between): a keyframe. The partDestroyed messages could
  rebuild it on the client.
- Late or dropped inputs: a keyframe. The server could say on which tick it applied a late one.
- A contact chain (the other pushed earlier in the same pass) goes with the other's state as the pass had it (raw,
  off the grid: the codec escapes it).
- The switch: on in dev builds with own shots (`?ownsim=0|1`, remembered); the dev server allows it (`NET_CAPS` 127
  elsewhere).
