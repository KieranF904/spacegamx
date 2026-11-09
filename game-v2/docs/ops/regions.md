# Regions, versions and updates

One game server runs today (the VPS). This is the code and config that let extra regional servers on Fly.io be added at any time, suspended when empty and woken on connect. Nothing here deploys anything; it runs when asked.

## The model

- Every region runs the same game and data, but each **world is independent** (own spawns, boss timers, `data/world/memory.json`).
- **Accounts are central**: VPS Postgres plus the lobby (`server-browser/`): profiles, rankings, friends, inbox.
- Every game server is **defined in the lobby**, because a sleeping server can't heartbeat.
- Updates are **centralised**: the frontend is served from the VPS (versioned); the lobby schedules one restart time that every awake server counts down to; sleeping servers start on the new build.
- With one server and no definitions everything behaves as before.

## Defining servers (lobby)

`<lobby DATA_DIR>/servers.json`, or the JSON in `LOBBY_SERVERS_JSON`:

```json
{ "servers": [
  { "id": "vps", "name": "Main", "region": "eu", "host": "brotherk3d.com", "port": 443, "kind": "always-on", "protocol": 66 },
  { "id": "fly-syd", "name": "Sydney", "region": "au", "host": "spacegame-syd.fly.dev", "port": 443, "kind": "on-demand", "protocol": 66, "build": "abc1234" }
] }
```

- `kind`: `always-on` (VPS) or `on-demand` (Fly). A defined server with no recent heartbeat is listed `asleep` ("joins in a few seconds") or `offline`.
- `protocol` / `build`: what it is expected to run, used while it sleeps. A heartbeat reports the real ones.
- A game server sets `SERVER_ID` to its id so the lobby matches it (an address match works too). Bad entries are skipped with a log line. Code: `server-browser/src/regions/`.

## Versions

- Game servers send `serverId`, `protocol` (common `PROTOCOL_VERSION`) and `build` (`BUILD_ID`, else `GIT_COMMIT`, else the package version) in each heartbeat.
- `GET /list?protocol=N` returns only servers that run N (or that don't say), plus `hidden`, `latest: { protocol, build }` and any `update: { inMs }`.
- The client asks with its own protocol. If `latest.protocol` is above its own, the join screen shows **New version available. Reload** (`client/src/network/versionCheck.ts`). A server on another protocol also hangs up with close code 4002, which the client already turns into the same reload prompt.
- Frontend plan: serve each build from the VPS under the same lobby/CDN origin with `index.html` uncached and hashed assets cached; a reload then fetches the newest build. Fly servers don't serve the frontend. Not built here.

## Update countdown

1. Schedule: `node scripts/lobby-update.mjs schedule 15` (needs `LOBBY_URL`, `LOBBY_ADMIN_SECRET`), or `/update 15` in game as an admin (`/update cancel`, `/update`). Lobby: `POST /admin/update/{schedule,cancel,status}` behind the admin secret; the schedule is kept in `<DATA_DIR>/update.json`.
2. Servers poll: the heartbeat answer carries `update: { inMs }` (time left, so clocks needn't agree). No inbound connections.
3. Each awake server announces in chat and with a HUD banner at once, then at 15, 5 and 1 minute (only the ones still ahead), and re-sends the banner every 30 s for late joiners.
4. From 1 minute before, sign-ins are refused with a message.
5. At the time the server runs its normal shutdown (saves every pilot, lingering ships included) and exits with code 75. The process manager restarts it on the new build (systemd `Restart=always`; Fly restart policy `always`).
6. The lobby forgets the schedule 2 minutes after its time, so a server that wakes late is not restarted. Cancelling removes it from the next heartbeat answer; servers announce the cancellation.

Code: `server/src/update/` (countdown, install), `common/src/network/updateProtocol.ts` (`serverUpdate` banner message), `client/src/ui/updateBanner.ts`.

## Config

Lobby: `LOBBY_SERVERS_JSON` (optional), `LOBBY_ADMIN_SECRET` (existing). Game server: `SERVER_ID`, `BUILD_ID` (or `GIT_COMMIT`), existing `BROWSER_URL`, `LOBBY_ADMIN_SECRET`, `SERVER_NAME`, `SERVER_REGION`, `PUBLIC_HOST`.
