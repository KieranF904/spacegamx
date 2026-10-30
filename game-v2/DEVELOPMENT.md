# Local Development Guide

This project runs fully locally — no Supabase, no Fly.io, no external services required.

## Quick Start

```powershell
# 1. Install dependencies (first time only)
cd game-v2
npm run install:all

# 2. Start the server browser (lobby server, port 8787)
npm run dev:browser

# 3. Start the game server (port 3000, admin on 3005)
npm run dev:server

# 4. Start the client dev server (port 5273)
npm run dev:client
```

Then open http://localhost:5273

Making a new boss: follow [docs/boss-design.md](docs/boss-design.md) (stages, look, fight, tuning, tools).

Cold and warmth: in a system with a `cryo` rating, cold builds up on a pilot's ship away from heat (stars, stations,
ships on fire, lava worlds), slower through insulating materials (`materials.json insulation`). The numbers are in
`data/hazards.json` `warmth`; the stages (guns slower, then a numb drive, then a seize) in
`common/src/ships/warmth.ts`; the server meter in `server/src/game/Warmth.ts` and `ShipBridge.warm`, where frost hits
(gemmed guns, the Frostbite Lance, the Brood Mother) take warmth too. The pilot gets it as snapshot `data[13]`
(percent) and sees it as the frost vignette (`client/src/ui/FrostVignette.ts`; a tint only on Low quality).

Watching the VPS live: `npm run monitor` opens a dashboard of the box's CPU, memory, network, disk, each service and the game's tick times. It streams over SSH as a read-only `vpsmon` account (key `~/.ssh/vpsmon_ed25519`; set up by `deploy/vps/monitor/setup.sh`, which only lets that key run the stats script).

## Default Admin Account

The JSON user store auto-seeds an admin account on first run:

- **Username:** `admin`
- **Password:** `admin`

Accounts are stored in `game-v2/data/users.json` (gitignored). Delete the file to reset all accounts.

## The world's memory

A system nobody's in isn't simulated: after `memory.evictAfterSeconds` it's written down and taken out of the world, and brought back (moved on, mended a little) as a pilot arrives, so a boss you killed or a nest you cleared stays so until it's due back, through restarts too. It's kept in `game-v2/data/world/memory.json` (gitignored, never overwritten by a deploy). Delete `data/world/` (with the server stopped) for a fresh world. The knobs are `memory` in `data/rules.json`: `evictAfterSeconds`, `healPerMinute` (a share of each part's max HP mended a minute away), `bossHealPerMinute`, `fastForwardMinutes` (most of the time away ships are flown on for), `saveSeconds`. See `docs/engine-map.md`, "Far ships and the world's memory".

## Services

| Service | Port | Purpose |
|---|---|---|
| Client (Vite) | 5273 | Game client + sandbox |
| Game server | 3000 | WebSocket game server + HTTP auth |
| Admin server | 3005 | Live admin dashboard (password: `admin`) |
| Server browser | 8787 | Lobby/server list registry |
| Website | 5310 | `site/`: updates, community, accounts, Play (see "Website" below) |

## User Account Storage

Accounts use a pluggable `UserStore` interface (`server/src/auth/`):

- **`JsonUserStore`** (default) — local JSON file at `game-v2/data/users.json`. Atomic writes, no native dependencies.
- **`PostgresUserStore`** — production backend, ready to enable when you set up PostgreSQL on your VPS.

Both implement the identical schema (see `server/schema.sql`):

```
users:    (id, username, email, password_hash, salt, is_admin, created_at)
sessions: (token, user_id, expires_at)
```

### Switching to PostgreSQL later

When your VPS PostgreSQL server is ready:

```powershell
# 1. Install the driver
cd game-v2/server
npm install pg @types/pg

# 2. Apply the schema
psql $env:DATABASE_URL -f schema.sql

# 3. Run with the postgres backend
$env:USER_STORE_BACKEND = "postgres"
$env:DATABASE_URL = "postgres://user:pass@your-vps:5432/spacegame"
npm run dev
```

The JSON data is 1:1 compatible with the schema — copy the `users` array entries into the `users` table to migrate existing accounts.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Game server port |
| `ADMIN_PORT` | 3005 | Admin dashboard port |
| `BROWSER_URL` | `http://localhost:8787` | Server browser URL |
| `LOBBY_ADMIN_SECRET` | dev: a fixed one; production: none | Shared by the lobby and the game servers so the admin tools can manage accounts (admin rank, bans). The same value on both; with none in production those commands are refused. The VPS deploy makes one in `/etc/spacegame/secrets.env` |
| `PUBLIC_HOST` | `localhost` | Host reported to the browser |
| `USER_STORE_BACKEND` | `json` | `json` or `postgres` |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `VITE_BROWSER_URL` | `http://localhost:8787` | Client-side browser URL (Vite) |

## Asset viewer and renders

**Viewer** (dev server only; `client/viewer.html` isn't a build input, so it never ships):
<http://localhost:5273/viewer.html>. No game server needed. It draws with the game's own renderer: hull build,
ShipBatch shader, Lighting, turrets, wires, ThrusterFx flames, sky and bloom. It doesn't run game behaviour.

- **Browse** (searchable, `/` to focus): library, dev and enemy blueprints, bosses and giants (bespoke and rigid
  designs), every part model on a hull stub, every material as a test block, every piece, and sheets of each.
- **Controls**: zoom/pan (wheel, drag), heading (right- or shift-drag), light preset (`sun`, `hangar`, `nebula`,
  `dark`, `flat`) with sun direction, power, height and ambient overrides, background (`starfield`, `dark`,
  `transparent`), sky biome, throttle, boost and exhaust, turret aim, damage (seeded), frame heat, tint, grid, and
  model facing and stub. Export PNG at 1×, 2× or 4×, transparent if you like.
- **Every setting is a URL param**, for example
  `viewer.html?asset=ship:sparrow-t&zoom=2&light=sun&bg=transparent&flames=0.8`.
  The full list is in `client/src/viewer/params.ts`.

Asset ids:

- `ship:<path under data/ships/blueprints>`, e.g. `ship:corsair` or `ship:enemy/pirate_gunship`;
- `boss:<name>` (= `ship:enemy/<name>`);
- `model:<id>[@N|E|S|W]`, `material:<id>`, `piece:<id>`;
- `sheet:models|materials|pieces|ships|enemy|bosses|all-ships|facings:<model>`;
- or several, comma separated (laid out as a sheet).

**Native renderer** (`scripts/native-render/`; **stills go through it**, with no browser):
a warm service that draws an asset to a PNG in tens of milliseconds, with the game's own hull and lit shaders, panel
atlas, lighting and normals, baked exposure, turrets, wires, ThrusterFx flames and exhaust, bloom and the sky. It is two
processes: Node builds the geometry with the game's pure code, and a Python child (moderngl, a headless OpenGL context on
the real GPU) draws it. Needs `pip install moderngl pillow numpy`. Idle, it uses no CPU.

```bash
npm run render -- ship:sparrow-t --zoom 2 --flames 0.8 --out shot.png   # starts the service if it isn't running
npm run render -- boss:scrap_mother --light dark --scale 2 --bg transparent --out mother.png
npm run render -- boss:brood_mother --light nebula --heat 0.8 --out brood.png
npm run render -- sheet:models --w 2400 --h 1600 --light hangar --bg dark --out models.png
npm run render -- sheet:facings:cannon_twinlink --aim 30 --out twinlink.png
npm run render -- --batch ship:corsair,ship:arrow,boss:brood_mother --dir shots/ --light nebula
# Lighting: the default is the neutral "sun" preset. Presets sun, hangar, nebula (blue-violet), dark (headlights), flat (unlit);
# overrides on any of them: --lightDir 40 --lightPower 0.6 --elevation 0.45 --ambient 0.3 (level), plus colours:
# --lightColor '#b8ccff' (the sun's) and --ambientColor '#4d385c' (the ambient tint, kept at the ambient level)
npm run render -- ship:corsair --light sun --lightColor '#ffb27a' --ambientColor '#2a3550' --out dusk.png
npm run render -- --batch @list.txt --dir shots/   # a line: an asset, then its own flags
npm run render -- --list laser       # asset ids;  --status;  --stop
node scripts/native-render/render.mjs --start     # just start it; then browse at http://127.0.0.1:5311/
```

- **The viewer page**: <http://127.0.0.1:5311/> while the service runs. It lists every asset (search with `/`), and shows
  the rendered PNG with controls for zoom, heading, light preset, direction, power, ambient and colours, background
  (`dark`, `transparent`, `starfield`), sky, flames, boost, exhaust, bloom, heat, turret aim, damage, tint, facing and
  stub, plus Save PNG. The page draws nothing (it only shows images the service renders), so it costs no GPU or CPU in
  the browser. Settings live in the link.
- **Flags** are the viewer's URL params (the same as `viewer.html`). Booleans are `--bloom` and `--no-bloom`. `--w`/`--h`
  set the canvas size in CSS px (default 1280×800), `--scale` sets PNG pixels per CSS px, `--compress 0..9` the PNG
  level (the page uses 0), and `--samples` the MSAA (default 8). `--grid` and `--ui` are browser-only.
- **HTTP API**, on 127.0.0.1:5311 only (`NATIVE_RENDER_PORT`): `GET /render?asset=…&<params>` returns the PNG (timings in
  `X-Render-*` headers), `GET /assets?q=`, `GET /health`, `GET /` the page, `POST /quit`. It quits itself after 60 idle
  minutes (`NATIVE_RENDER_IDLE_MIN`).
- **Speed**: about 1.3 s from nothing to the first PNG, then 15 to 30 ms a render (a boss's first render builds its hull,
  about 0.4 s; it's cached after). About 60 renders a second flat out.
- **What it approximates**: no barrel crack overlays (they only show on damaged guns), a still's flicker phase and
  exhaust particles are a seeded steady state, and the bloom's blur is tuned to match the browser's. Against the browser's
  stills the mean error is about 1 to 5 levels of 255 (the rest being particle randomness and the sheets' label spacing).
- **Source of truth**: the shaders, the light presets and the hull attribute table are read from the game's TypeScript each
  time the service starts (`ShipBatch.ts`, `litShader.ts`, `skyShaders.ts`, `ViewerScene.ts`), so they can't drift. The
  Node side is bundled to `client/node_modules/.native-render/` and rebuilt when a source it used is newer
  (`render.mjs --rebuild` forces it). If you change effect drawing (ThrusterFx, fxTextures) the native port is in
  `scripts/native-render/fx.ts` and `gl_worker.py`.

**The browser path** (heavy; only for checking the native renderer against the real client, or for a shot of the viewer
page itself): `npm run render -- --browser ship:sparrow-t …` goes through the render daemon, one long-lived headless Chrome
kept on the viewer (`npm run render-daemon`; its API is on 127.0.0.1:5281, `RENDER_PORT`; it uses the Vite server on 5273 when
up, or its own frozen one on 5299; Chrome runs at Idle priority on the real GPU, and the daemon quits after idle minutes
(`RENDER_IDLE_MIN`)). `npm run render -- --browser --ui ship:corsair --out viewer.png` shoots the viewer page itself.
`scripts/boss-shots/shoot.mjs` (live game shots) uses the same daemon. Don't use either for plain stills.

## Website (site/)

The game's website: home page with live pilot count, update feed (Markdown posts, comments, RSS), suggestions board
(votes, statuses, admin replies), a live shoutbox, accounts (sign in, register, pilot card, change password or
email, sign out everywhere, delete), public pilot profiles and leaderboards, an admin panel, and an authed API and
CLI for posting updates. Server-rendered Node + TypeScript, no front-end framework.

```bash
cd game-v2/site
npm install          # first time
npm run dev          # http://localhost:5310 (needs the lobby on 8787; Play needs Vite on 5273)
npm run typecheck
```

Tests run with the rest: `npx vitest run --pool=forks --no-file-parallelism` (site/src/*.test.ts).

- **Accounts are the lobby's.** The site signs in through the lobby (`/auth/login`, `/auth/register`) and keeps the
  lobby's session token in an HttpOnly cookie. Account management uses lobby endpoints:
  `/auth/account`, `/auth/change-password`, `/auth/change-email`, `/auth/logout-all`, `/auth/delete-account`
  (server-browser/src/accounts/routes.ts). An admin is whoever the lobby says is one (`isAdmin`).
- **Its own data** (posts, comments, suggestions, votes, shouts, API tokens) is in `data/site/site.json` in dev, and
  uploaded images in `data/site/uploads/`. Delete the folder to reset. Production: `site/schema.sql` and
  `SITE_STORE_BACKEND=postgres DATABASE_URL=...` (`npm install pg` in site/ first). Keep `data/site` out of deploys
  (like `data/lobby`).
- **Pilot data, read-only**: `data/profiles/<userId>.json` (pilot card), `data/profiles/_rankings.json` (boards) and
  `data/status/live.json` (pilots online), behind `PilotSource` (src/pilots.ts).
- **Settings**: environment variables, listed at the top of `site/src/config.ts` and in `site/.env.example` (`SITE_PORT`,
  `SITE_ORIGIN`, `SITE_SECRET`, `LOBBY_URL`, `LOBBY_ADMIN_SECRET`, `GAME_MODE`, ...). In production
  (`NODE_ENV=production`) `SITE_SECRET` (32+ characters), `LOBBY_ADMIN_SECRET` and an https `SITE_ORIGIN` are required:
  the site stops at start with a message naming what's missing.
- **Deleting an account** (at the lobby, from the site's account page or anywhere else) deletes the pilot's profile too.
  The lobby keeps the ids of accounts deleted in the last 30 days (`data/lobby/deleted-accounts.json`) and answers every
  game server's 10-second heartbeat (`POST /register`) with them; the server disconnects anyone on the account,
  deletes `data/profiles/<id>.json` (or the Postgres row) and takes the pilot off the rankings
  (`GameServer.forgetAccounts`). Account ids are never reused (the JSON store keeps `nextUserId`).
- **Production** (`deploy/vps`): `spacegame-site.service` runs the site on 127.0.0.1:8791 as `spacegame`, writing only
  `data/site/` (never touched by a deploy). `remote-install.sh` makes `SITE_SECRET` once in
  `/etc/spacegame/secrets.env` and installs the site's nginx routes as the snippet
  `/etc/nginx/snippets/spacegame-site.conf` (refreshed every deploy), which the certbot-edited site file includes in
  place of its old `location /`: the website is at the root and the game at `/play`. See `site/REVIEW.md`.
- **PostgreSQL**: the stores (`site/src/store`, the lobby's `PostgresUserStore`, the game server's `PostgresProfileStore`)
  run their tests against a scratch database when `SITE_TEST_DATABASE_URL` / `DATABASE_URL` is set (`site/REVIEW.md`, Tests).

### Play: opening the game signed in

`/play` serves the game's own `index.html` from the site's origin, with one script first in `<head>` that puts the
visitor's lobby session in `localStorage.authToken`. That's where the client keeps its session already: on load it
asks the lobby whether the token is still good and skips its sign-in screen (Game.ts `resumeSession`). So signing in
on the site signs you into the game, with no client change and no token in any URL.

- `GAME_MODE=proxy` (dev default): `/play` is Vite's page, and the paths the game loads (`/src`, `/@vite`,
  `/node_modules`, `/sfx`, HMR socket) are passed through to Vite on 5273. http://localhost:5310/play is the live dev game.
- `GAME_MODE=static` (production default): `/play` is `client/dist/index.html` read from disk; nginx serves
  `/assets/` and `/sfx/` from `client/dist` as now.
- `GAME_MODE=link`: `/play` redirects to `GAME_URL` (no handoff; the player signs in there).

The site and the game share one session: signing out on either ends it on both.

### Posting updates from the terminal

Make a token in the admin panel (Admin, API tokens; only its hash is kept, it's shown once), then:

```bash
cd game-v2/site
export SITE_TOKEN=sgs_...                       # or save it once: npm run post-update -- --save-token sgs_...
npm run post-update -- path/to/post.md          # front matter decides draft or published
npm run post-update -- post.md --publish        # publish now (or --draft)
npm run post-update -- post.md --dry-run        # check it, send nothing
npm run post-update -- --list                   # every post, drafts too
npm run post-update -- --publish-slug my-post   # also --unpublish <slug>, --delete <slug>, --whoami
SITE_URL=https://space.brotherk3d.com npm run post-update -- post.md   # another site (or --site <url>)
```

Without a token it signs in as an admin for that run (`SITE_USER` and `SITE_PASSWORD`, or `--login` to be asked)
and signs out after. A saved token lives in `~/.config/spacegame/site-token`, never in the repo.

A post is Markdown with front matter:

```markdown
---
title: Wires, mounts and the helm camera
tags: [ships, parts]
status: published            # or draft (the default); also draft: true / publish: true
slug: wires-and-mounts       # optional: the file name otherwise (a leading "01-" is dropped)
summary: One line for lists  # optional: the first paragraph otherwise
cover: ./images/hero.webp    # optional: the first image otherwise
---
The post. ![A caption](./images/shot.webp)
```

- Local images (and `cover`) are uploaded (PNG, JPEG, GIF, WebP; 8 MB each) and their links rewritten. The same image
  always uploads to the same URL.
- Re-running a file updates its post (matched by slug), so fix a typo and run it again.
- Renders for posts: `npm run render -- ship:corsair --bg starfield --flames 0.8 --out shot.png` (native, see above).
- Example posts: `site/seed/posts/` (with images in `site/seed/images/`).

The same API is plain JSON for any script (`Authorization: Bearer sgs_...`):
`GET /api/v1/posts`, `POST /api/v1/posts` (create, or update by slug), `PATCH|DELETE /api/v1/posts/:slug`,
`POST /api/v1/uploads` (image as the body), `POST /api/v1/preview`, `GET /api/v1/me`. See the top of `site/src/app.ts`.

### Security

- All user text is escaped (templates escape by default, `site/src/html.ts`); Markdown is sanitised to an allowlist
  every time, admin posts too, and raw HTML in it shows as text (`site/src/markdown.ts`).
- Cookies are HttpOnly, SameSite=Lax, Secure in production. Every form and script POST carries a CSRF token (an
  HMAC of a per-browser cookie), and POSTs from other origins are refused.
- Rate limits on sign-in, registration, account changes, comments, suggestions, votes, shouts, uploads and bad API
  tokens; the lobby also limits password checks per address.
- A strict Content-Security-Policy (no inline script) on every page but `/play`; uploads are checked by their bytes
  (no SVG) and served with their own `default-src 'none'`.
- No secrets in the repo: `SITE_SECRET` and `LOBBY_ADMIN_SECRET` come from the environment; API tokens are stored
  as sha256 hashes.

## Notes

- The old Supabase code lives only in `Reference/ball` (the v1 project) and is kept for reference only.
- The old SQLite `UserDB` has been removed. Existing accounts (just the seeded admin) are recreated automatically by the JSON store.
- `users.json` is gitignored — never commit account data.