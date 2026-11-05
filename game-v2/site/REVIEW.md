# Reviewing the website locally

Nothing here is deployed. The site and the lobby are already running on this machine (see "If they aren't running").

## URLs

| What | Where |
| --- | --- |
| Website | http://localhost:5310 |
| Play (the game, signed in from the site) | http://localhost:5310/play (needs Vite on 5273, the game server on 3000) |
| Admin panel | http://localhost:5310/admin |
| API tokens | http://localhost:5310/admin/tokens |
| Updates feed / RSS | http://localhost:5310/updates, http://localhost:5310/rss.xml |
| Lobby (accounts) | http://localhost:8787 |

Pages to look at: home (live pilot count), `/updates` and a post (comments), `/suggestions` (votes), the shoutbox
on the home page, `/pilots` (boards and pilot profiles), `/signin`, `/register`, `/account` (change password or
email, sign out everywhere, delete), `/admin/*` (posts, comments, suggestions, shoutbox, tokens, pilots).

## Accounts

The site has no accounts of its own: they are the lobby's, the same ones the game uses.

| Account | Password | Notes |
| --- | --- | --- |
| `admin` | `admin` | Admin (dev only: the lobby seeds it; production needs `ADMIN_PASSWORD`) |
| `brotherk3d`, `Vega`, `Orrin` | (not known here) | Existing dev accounts |

Make a normal player by registering at `/register`. To try deleting an account, register a throwaway one and delete it
from `/account` (it asks for the password and the pilot name); don't delete the real ones. The deleted account's
profile (`data/profiles/<id>.json`) goes with it, but only once a game server running the new code has sent its next
heartbeat (every 10 s): the game server that's running now predates that, so restart it to see the file go.

## Posting an update

**From the admin panel.** Sign in as `admin`, then Admin, Posts, New post. Write Markdown; the preview is the real
render. Save as a draft or publish. Images upload from the form (PNG, JPEG, GIF, WebP; 8 MB).

**From the terminal** (the CLI, over the authed API). In `game-v2/site`:

```bash
# 1. Make a token: Admin, API tokens, New token (shown once; only its hash is kept). Then either
export SITE_TOKEN=sgs_...                 # for this shell, or keep it once for this machine:
npm run post-update -- --save-token sgs_...

# 2. Check it, then post
npm run post-update -- --whoami
npm run post-update -- seed/posts/02-the-scrap-mother.md --dry-run     # checks it, sends nothing
npm run post-update -- my-post.md --publish                            # re-running the same file updates the post
npm run post-update -- --list                                          # every post, drafts too
npm run post-update -- --unpublish my-post                             # also --publish-slug, --delete
```

No token? `SITE_USER=admin SITE_PASSWORD=admin npm run post-update -- ...` signs in for that one run (or `--login` asks).

**From any script** (plain JSON, `Authorization: Bearer sgs_...`):

```bash
curl -H "Authorization: Bearer $SITE_TOKEN" http://localhost:5310/api/v1/me
curl -H "Authorization: Bearer $SITE_TOKEN" http://localhost:5310/api/v1/posts
curl -X POST -H "Authorization: Bearer $SITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"First post.","status":"draft"}' http://localhost:5310/api/v1/posts
```

The routes (`/api/v1/posts`, `/uploads`, `/preview`, `/status`) are listed at the top of `src/app.ts`.

The three example posts in `seed/posts/` are already in the dev data. To start over, stop the site and delete
`game-v2/data/site/`.

## If they aren't running

```bash
cd game-v2/server-browser && npm run dev     # lobby, 8787
cd game-v2/site && npm run dev               # website, 5310 (watches the files)
cd game-v2 && npm run dev:client             # Vite, 5273, for /play
```

## Tests

```bash
cd game-v2 && npx vitest run --pool=forks --no-file-parallelism site server-browser
cd game-v2/site && npm run typecheck
```

The stores also run against a real PostgreSQL when you give them a scratch database (it needs `pg` somewhere above
the code: `npm install --no-save pg` in `site/`, `server-browser/` and `server/`). The tests make their own schema or
accounts, so use a throwaway database:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest \
SITE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest \
  npx vitest run site/src/store server-browser/src/accounts/userStore.test.ts server/src/profile
# first: psql $DATABASE_URL -f server-browser/schema.sql   (schema.sql is safe to re-apply)
```

## Production (not done yet)

`bash deploy/vps/deploy.sh` now also ships the site. Nothing has been run on the VPS. What it does, and the one
thing that is manual:

- **Service**: `spacegame-site` (`deploy/vps/spacegame-site.service`), `127.0.0.1:8791`, runs as `spacegame`,
  can only write `/opt/spacegame/data/site/` (posts, uploads), which a deploy never touches.
- **Secrets**: `remote-install.sh` makes `SITE_SECRET` once in `/etc/spacegame/secrets.env` (root-only, beside the
  lobby's `LOBBY_ADMIN_SECRET`, which the site shares). The site refuses to start in production without
  `SITE_SECRET`, `LOBBY_ADMIN_SECRET` and an https `SITE_ORIGIN`, and says which is missing.
  API tokens for posting updates are made in the admin panel after the first deploy. `.env.example` lists every name.
- **nginx**: the site's routes are a snippet, `deploy/vps/nginx-spacegame-site.conf`, installed as the root snippet
  `/etc/nginx/snippets/spacegame-root.conf` by a `WITH_SITE=1` deploy (and kept by later game-only deploys while the
  site runs; without the site the root snippet is `nginx-spacegame-play.conf`, the game alone). The game's own routes
  are `nginx-spacegame-game.conf`, which includes it. Every deploy tests them with `nginx -t` and puts the old files back
  if it fails (see docs/areas/ops-tools.md).
- **What changes for players**: `https://space.brotherk3d.com/` becomes the website, and the game is at `/play`
  (signed in from the site). The game's socket, `/lobby/`, `/health`, `/assets/` and `/sfx/` stay where they
  were. Old bookmarks to the root show the website, with a Play button.
- **Admin**: the lobby seeds an admin only with `ADMIN_PASSWORD` set; on the VPS the existing admin account is the
  site's admin.
- **PostgreSQL** (optional, off by default): see `docs/areas/web-accounts.md` and `docs/ops/postgres-migration.md`; `pg` must be installed in `site/`, `server-browser/`
  and `server/`.
