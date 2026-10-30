# Server robustness audit

October 2026. The scope was every way the live server could crash, hang, lose or corrupt player data, or be abused, without changing gameplay. It covers the game server (`server/`), the lobby (`server-browser/`) and the stores under both.

Each fix has a test:
- `server/src/game/robustness.test.ts`: crash isolation, fuzzing, rate limits and the long-run leak test.
- `server/src/net/socketTransport.test.ts`: real sockets against an in-process server.
- `server/src/game/fileStores.test.ts`: the world memory, contributor files and durable writes.
- `server/src/profile/profileStore.test.ts`: profile data safety.
- `server-browser/src/accounts/hardening.test.ts`: the lobby.

## Fixed

### Crash isolation (game server)

| Risk | Before | Now |
|---|---|---|
| A system throws mid-tick (one bad entity, brain, quest…) | The exception escaped `gameLoop` before it scheduled the next run. With no process handler, the **whole server crashed**; even with one, the loop would have stopped for good. | Each system in `tick()` runs under `guard(name, fn)`, and so does each client's share of the per-client loops. A throw is logged once in full, then once every 10 s with a count (`faultCounts()`), and the rest of the tick runs. `gameLoop` catches anything left over and always schedules the next run. |
| A bad input in the queue | A throw in `drainInputQueue` left the queue uncleared, so the same input replayed and threw on every tick. | Each input is guarded on its own, and the queue always empties. |
| Async handlers (`join`, `authLogin`, `authRegister`, `loginPilot`, `pilots.detach`) | Called without a catch. A rejection, for example a profile that throws in `migrateProfile` or a listener on `login`, was an unhandled rejection. On Node 15+ that **kills the process**. | Each has `.catch(→ fault)`. |
| A throw while a connection closes | `clients.delete` and the save never ran, so the connection object stayed in every loop. The throw also escaped ws's `close` event, **crashing the process**. | Each step of `close()` is guarded on its own. `clients`, `outbox` and `lazy` are always cleared, and the transport catches anything left. |
| `ws` `error` events | There was no listener. A malformed frame or an oversized message made ws emit `error`, which threw and **crashed the server**. | There are listeners on each socket, on the WebSocketServer, and for `clientError` on the HTTP server. |
| Process-level failures | There was no `unhandledRejection` or `uncaughtException` handler. | `unhandledRejection` is logged loudly and the server keeps running; these come from isolated async work such as saves, lobby calls and timers. `uncaughtException` is logged and runs the normal shutdown save with exit code 1, so systemd (`Restart=always`, 3 s) starts it fresh. |
| Shutdown (SIGTERM) | `saveAll` ran in sequence, so one failing store stopped the later ones. There was no deadline, so a hung store meant systemd SIGKILLed it after 90 s, losing the saves still waiting. | The server stops taking connections first. Every store saves independently (`allSettled`), and the profile/user stores are always closed so their writes in flight finish. The whole save is capped at 20 s (`SHUTDOWN_SAVE_MS`), well inside systemd's 90 s `TimeoutStopSec`. |
| A rankings save fails | The data was marked clean and never retried. | It stays dirty and is retried at the next save. |

### Data safety

| Risk | Before | Now |
|---|---|---|
| A profile file that couldn't be **read** (EACCES, EMFILE, EISDIR) | Treated as corrupt: **the good file was renamed aside and the pilot started from nothing.** | Only a file that fails to parse counts as broken. Any other read error goes up to `Pilots.login`, which already refuses to save a profile it couldn't load ("progress this session will not be saved"). |
| A profile that parses but makes `migrateProfile` throw | The guest profile stayed in the session with `loading=false`, so **autosave could write it over the real save**. | The session is locked (`loading=true`, the same as a failed read): the save on disk is never touched, and the pilot is told. |
| Saves that fail (disk full, I/O error) | `JsonProfileStore.save` swallowed the error, so Pilots believed the save had worked. | The error reaches the caller, which marks the profile dirty and saves again later. The write queue carries on past it. |
| Writes that aren't atomic or durable | Profiles, rankings, `memory.json` and contributor files went through temp + rename with no fsync. Several files also used one fixed `.tmp` name, so overlapping writes could rename a half-written temp file into place. | `profile/durableWrite.ts` writes to a unique temp file, fsyncs it, renames it, and fsyncs the folder (skipped on Windows). A failed write deletes its temp file and leaves the old file untouched. All four of those stores use it. |
| A broken profile | It was moved aside and the pilot started fresh. | **Daily rotating backups**: the first save of an account each day copies the save it replaces to `data/profiles/backups/<id>/<day>.json`, keeping the last 7 (`BACKUP_DAYS`). A broken file is moved aside and the newest backup that parses is loaded instead. Deleting an account deletes its backups too. This is documented in DEVELOPMENT.md. Cost: one file copy per account per day. |
| A broken `_rankings.json` | It was ignored, and the next save **overwrote it**. | It is moved aside (`.broken-<time>`) first. |
| `memory.json` that exists but can't be read | A fresh world started and **saved over it** at the next save. | The world isn't saved this run, and the error is logged. A file that fails to parse is still moved aside, as before. |
| Postgres profile saves | Overlapping saves of one account ran on different pool connections in any order, so an **older save could land last**. | Saves are serialised per account, and `close()` waits for them. |
| Lobby `users.json` corrupt or empty | It loaded as "no accounts", and the next save (the admin seed) **wiped every account**. | The lobby refuses to start and names `users.json.bak`, which a good startup writes. Writes are durable and coalesced, and `deleteUser` waits for the disk. `deleted-accounts.json` is written durably and a damaged copy is kept aside. |

### Untrusted input

**Message size.** `maxPayload` was left at ws's default of 100 MiB. A compressed frame could inflate to that.
- It is now 512 KB (`MAX_CLIENT_MESSAGE_BYTES`), checked after inflating. A full 256-part design is about 40 KB.
- An oversized message closes that socket with code 1009.

**Design bombs.** A design with 20,000 parts on one cell ran O(n²) geometry and froze the event loop. This applied to shipEdit, slotSave, designSave and shareDesign.
- `clientBlueprint()` refuses more than 256 parts (uids are unique 0..255) before any work is done.
- It also caps the name at 64 characters and gem strings at 40, and drops a `facing` that isn't a short string.

**Hostile values.**
- **itemJettison:** `n: "x"` gave a NaN count, which corrupted the hold for good. It now falls back to 1, and `addTo`/`removeFrom` (common) ignore NaN.
- **skillUp:** `"__proto__"`, `"toString"` and similar spent a point and saved junk. Only the skill table's own keys count now.
- **Guest `username`:** it was used as-is. An object broke `/invite` for everyone, and a megabyte string was sent to everyone nearby. It must now be a string, has control characters stripped, and is capped at 24 characters.
- **JSON input:** `cursorDist`, `seq` and ping `clientTime` must be finite. `cursorDist` is clamped to 0..65535, the same range as the binary path.
- **marketScan:** the items array is sliced to 80 before it is mapped.
- **Non-objects:** a message that isn't an object with a string `type` is dropped.

**Forged bounties (questAccept).** Bounties and fleet ops are rebuilt from their id, so a client could make up any window or slot and pick the job and its roll. Only ids the board offers now, or offered in the previous window, can be accepted. This closes an exploit; it doesn't change what the board offers.

**Rate limits.** `net/MessageLimits.ts` gives each connection token buckets, held in a WeakMap so they never leak. Admins are exempt.

| Message | Per minute | Burst |
|---|---|---|
| chat | 40 | 8 |
| authLogin, authRegister | 10 | 5 |
| marketScan | 12 | 4 |
| rankings, ribbons | 30 | 6 |
| shipEdit, slotSave, designSave, designDelete | 60 | 10 |
| partyInvite, tradeRequest | 20 | 6 |
| mapView | 60 | 10 |
| itemJettison | 120 | 20 |
| pilotInfo | 120 | 20 |
| shipNeed | 1200 | 200 |

A person clicking never reaches these. Dropped chat gets a "Slow down" reply.

**Sockets.**
- At most 16 sockets per address at once. The address is nginx's `X-Real-IP`, trusted only from loopback.
- A client whose unsent data passes 8 MB (it has stopped reading) is terminated, instead of its snapshots piling up in memory.

**Logging.** Malformed frames and handler throws are logged once every 5–10 s with a count, not once per message. They were full stack traces each, which a hostile client could use to flood the disk.

**HTTP `/auth/*` on the game server.**
- The body was unbounded, so one large POST could exhaust memory. It is now capped at 16 KB.
- An error after the headers were sent made `writeHead` throw inside an async handler, giving an unhandled rejection. That is fixed.

**Fuzz test.** It sends 4,000 random and malformed messages of every type, using raw objects with NaN, Infinity, prototype keys, 5 KB strings and 3,000-element arrays. It asserts:
- the server keeps ticking and nothing throws out of it;
- a bystander still gets snapshots;
- no prototype is polluted;
- the fuzzer's own save stays numeric;
- most message types actually reach their handlers, so the test can't pass by doing nothing.

### Leaks and long runs

- `lastEntityStates` (each player's last snapshot states, a map of strings) was **never deleted when a player left**. The soak test found 151 entries left after 150 connects and disconnects. It is now cleared when the entity is removed (`cleanupSystem`), along with `riftCooldown`.
- `lastShare` (GameServer) and `Party.lastPing` held closed connections. They are now WeakMaps.
- The soak test runs 150 connect / join / chat / map / invite / disconnect cycles. It checks that clients, sessions, outbox, lazy, snapshot states, lingering ships and live player entities all return to their starting sizes.

### Lobby (server-browser)

Done by a sub-audit; details are in `server-browser/src/accounts/hardening.test.ts`.

- **Brute force:**
  - 10 wrong passwords per username per 15 min, from any address, then 429 with a message the client and site already show. A correct password clears the count.
  - Account changes are limited per account the same way.
  - The limiter maps are pruned rather than cleared, so a flood of new addresses can't reset everyone's counts.
- **X-Forwarded-For** is only trusted from loopback.
- **Request bodies** are capped at 64 KB and answered with 413; previously the request hung forever. A body that isn't an object gets 400.
- **The admin secret** is compared in constant time after SHA-256 (no length leak), and is still refused when unset in production.
- **The `/register` heartbeat** is validated. The host was written unescaped into the `/` page, which was an **XSS** hole. The server list is bounded to 200, and `/stats` is pruned and bounded.
- **Process handlers:** `unhandledRejection` is logged. `uncaughtException` flushes and exits 1. Shutdown has one close-once path.
- **Already sound:** 48-byte random tokens; PBKDF2-SHA512 at 100k iterations with `timingSafeEqual`; 7-day sessions checked on use and cleaned hourly; account deletion needs your own token and password.

## Found, not fixed (ranked)

1. **AdminServer (`server/src/AdminServer.ts`) has the fixed password `admin`.** It listens on 127.0.0.1 only, and ufw blocks the port. But the VPS is shared, so any local account or process on it can log in, and its commands include `killAll`, `teleportPlayer` and `configChange`. Suggestion: read the password from `/etc/spacegame/secrets.env`, or don't start it in production. *Needs Kieran.*
2. **Sign-ins relayed through the game server go to the lobby from 127.0.0.1.** These are the WS `authLogin` from older clients and the game server's `/auth/*` endpoints. They don't pass the player's address on, so they all share one lobby rate bucket of 10 per minute per address. Under load, real players could be refused. Fix: forward `X-Forwarded-For` from `LobbyAccounts` (the lobby now trusts it from loopback). That means passing the connection's address through `connect()`.
3. **A guest can take a registered pilot's name.** Guest names aren't checked against accounts or each other, so a guest can pose as a known pilot or an admin in chat. A product decision (prefix guests? reserve names?).
4. **PBKDF2 is synchronous in the lobby** (`pbkdf2Sync`, about 50–100 ms each), so a distributed sign-in flood stalls the lobby's event loop. Switching to async `crypto.pbkdf2` changes the store signatures.
5. **The lobby listens on every interface** (`/register`, `/stats`, `/admin/*` rely on ufw). Adding `Environment=BROWSER_HOST=127.0.0.1` to `deploy/vps/spacegame-browser.service` would close it; the new optional bind is already supported. *Deploy change, needs Kieran.*
6. **A connection gets a full player entity before join/auth.** It is now capped at 16 per address, but there is no global cap. A botnet could still fill the world with idle entities. Consider deferring `createPlayer` until `join`, which touches a lot of code.
7. **Valid-design spam** now has rate limits, but each accepted shipEdit/slotSave still runs `JSON.stringify` on the whole profile (`saveNow`). This is fine at the current limits.
8. **Message handlers that throw on prototype keys** (all caught, and nothing is left half-done): `outpostUpgrade "__proto__"`, siege `buy "turret___proto__"`, `gemCut gem "__proto__"`, `questAbandon "__proto__"` (it toasts and saves). They now log one line every 10 s. Fix with `Object.hasOwn` lookups when those files are next touched.
9. **Loot-pod flood:** each 1-unit jettison is a pod that lasts 5 minutes. It is now 120 a minute per pilot, which is still a lot of entities for a full hold. Coalescing a pilot's jettisons into one pod would fix it.
10. **`mapView {open:true}` / `stateHash` / `shipNeed`** force resends. They are rate-limited now, but `stateHash` is not, because the client sends it constantly. Mismatches are bounded by its 8-held-ahead cap.
11. **Lobby: unknown usernames skip hashing,** which lets timing reveal which usernames exist. Low impact, because registration says "taken" anyway. IPv6 addresses are limited per address rather than per /64.
12. **Lobby lockout trade-off:** anyone can lock a known username out of sign-in for 15 minutes with 10 wrong passwords. The knobs are `FAIL_LIMIT` and `FAIL_WINDOW_MS` in `routes.ts`. *Needs Kieran.*
13. **Banned accounts can't delete themselves** (existing behaviour). This may matter for data-deletion requests. *Needs Kieran.*
14. **The rankings, the world memory and the contributor notes have no rotating backups,** only atomic writes and keep-aside on corruption. They are cheap to add the same way if wanted.
15. **systemd:** `TimeoutStopSec` is the default 90 s, and the shutdown save now caps itself at 20 s. With `Restart=always` and `RestartSec=3`, a crash at startup loops every 3 s without hitting the start limit. That keeps retrying (good), but floods the journal if, say, the data files are unreadable.

## Decisions for Kieran

- **A corrupt `users.json` now stops the lobby** (systemd restart loop) until `users.json.bak` is restored or the file is fixed. The alternative, loading the backup automatically, could reuse account ids that already own game profiles, so a new pilot would inherit someone's save. Confirm this is the behaviour you want.
- The AdminServer password (item 1), the lobby bind address (item 5), the guest-name policy (item 3) and the lockout knobs (item 12).
- Whether the rate-limit numbers above suit the game. They are in one table, `server/src/net/MessageLimits.ts`.
