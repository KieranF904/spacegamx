# Postgres migration (accounts and profiles)

Status, 2026-10-31: **production runs on Postgres.** The switch-over was done at about 14:33 server time. The live
accounts, sessions, profiles and rankings were re-synced from the frozen JSON into the `spacegame` database and verified
(14/14 checks passed), then both services were restarted on it. The pre-switch JSON and a dump are in
`/opt/spacegame/data/backups-pre-pgswitch-20261031-143323` (earlier, pre-copy backups: `backups-pre-pg-20261031-004940`).
The backend is chosen by systemd drop-ins `/etc/systemd/system/spacegame-{browser,server}.service.d/postgres.conf`
(`Environment=USER_STORE_BACKEND=postgres`; the deploy rewrites the unit files but leaves drop-ins alone). A nightly
`pg_dump` runs from the `spacegame-dbdump` timer, installed by the deploy. Local dev still defaults to JSON.
The JSON files are now a frozen snapshot taken at the switch (nothing writes them); the sections below keep the tool,
the re-sync and the rollback steps. Rolling back to JSON loses everything done since the switch.

## What moves, what stays

(The state before the switch; after it the Postgres column is live and the JSON column is the frozen snapshot.)

| Data | JSON (before the switch) | Postgres | Migrated |
|---|---|---|---|
| Accounts | `data/lobby/users.json` `users` | `users` (same columns, **same ids**) | yes: 2 |
| Sessions | `users.json` `sessions` | `sessions` | yes, unexpired only: 6 (players stay signed in) |
| Next account id | `users.json` `nextUserId` (or highest id + 1) | the `users.id` sequence | yes: next id 3 |
| Pilot profiles | `data/profiles/<accountId>.json` | `profiles` (jsonb, keyed by account id) | yes: 2 (accounts 1, 2) |
| Rankings | `data/profiles/_rankings.json` | `game_docs` key `rankings` | yes: 1 |
| Deleted-accounts list | `data/lobby/deleted-accounts.json` | none (the lobby always keeps it as a file) | n/a: doesn't exist on the VPS (no account ever deleted); stays a file after the switch too |
| Profile backups | `data/profiles/backups/`, `data/backups/`, `*.bak*` | none (Postgres needs its own: `pg_dump`) | no |
| World memory | `data/world/memory.json` | none | no, stays JSON |
| Contributor notes | `data/contributor/` | none | no, stays JSON |
| Telemetry, status | `data/telemetry/`, `data/status/` | none | no, stays JSON |
| Website | `data/site/site.json` | `site/schema.sql` (PostgresSiteStore) | no: the site isn't deployed (`data/site` is empty) |
| Old accounts file | `data/users.json` (Oct 21, pre-`lobby/`) | none | no: not read by anything; left alone |

Not copied on purpose: `profiles/1.json.bak-clearance-124155` (a hand-made backup, not a profile), expired sessions,
and orphans (a profile or session of an account that no longer exists; there are none today).

`pg` (8.23.1) is now a dependency of `server/` and `server-browser/` (package.json + lockfiles). Which store is used
is JSON unless `USER_STORE_BACKEND=postgres` (set on the VPS by the drop-ins above). The site wasn't touched (its data isn't on the VPS).

## The tool

`scripts/db/migrateJsonToPostgres.ts` (tests: `migrateJsonToPostgres.test.ts`; VPS runner: `vps-sync.sh`).

- Reads the JSON through the stores' own loaders (`JsonUserStore`, `JsonProfileStore`), from a private temp copy:
  those stores can write when they load (a `.bak`, an admin flag), so the live files are only ever read. It loads with
  `NODE_ENV=production` and no `ADMIN_PASSWORD`, so the loader never seeds an `admin`/`admin` account.
- Applies `server-browser/schema.sql`, **DDL only** (`CREATE ... IF NOT EXISTS`, `ALTER ... IF NOT EXISTS`). The
  file's seed `INSERT` of an `admin` account with the password `admin` is never run (it would be a live admin with a
  known password); the tool prints what it skipped.
- Writes everything (schema, users, sessions, profiles, docs, sequence) in **one transaction**: a failure leaves the
  database as it was. Ids are inserted explicitly; the sequence is set so the next account gets the JSON's
  `nextUserId`, never an id already given out.
- Refuses (exit 2) if any of the four tables has rows, unless `--replace`, which empties exactly those four tables
  (`TRUNCATE sessions, profiles, game_docs, users`, no CASCADE) and copies again: that's the re-sync.
- `--dry-run` runs the whole write and rolls it back; `--verify-only` writes nothing and compares.
- Then verifies by reading back through the Postgres stores (below). Exit 1 if any check fails. Reports never
  contain password hashes, salts, session tokens or emails: they are compared, not shown.

Local run (from `game-v2/`): `DATABASE_URL=... server/node_modules/.bin/tsx scripts/db/migrateJsonToPostgres.ts --data <data dir> [--dry-run|--replace|--verify-only] [--report out.json]`.

## Verification report (VPS, 2026-10-31 00:50 UTC)

Source `/opt/spacegame/data` (live), target the `spacegame` database as the `spacegame` role.
Report: `/root/pg-migrate/report-20261031-005004.json` (re-checked with `--verify-only` at 00:51: same result).

```
JSON: 2 accounts, 6 live sessions, 2 profiles, docs [rankings], next account id 3, 0 deleted-account ids
postgres before: users 0, sessions 0, profiles 0, game_docs 0
written: users 2, sessions 6, profiles 2, game_docs 1; next account id 3
schema applied (DDL only); not applied: INSERT INTO users   (the seed admin/admin)

verification: 14/14 checks passed
  ok   count users: postgres 2, json 2
  ok   count sessions: postgres 6, json 6
  ok   count profiles: postgres 2, json 2
  ok   count game_docs: postgres 1, json 1
  ok   getUserCount(): 2
  ok   listUsers() ids: 2 listed
  ok   account 1 (brotherk3d): id, username, email, admin, ban, created_at equal; password hash + salt identical
  ok   account 2 (Xire): id, username, email, admin, ban, created_at equal; password hash + salt identical
  ok   sessions resolve via validateSession(): 6/6
  ok   next account id: next id 3 (json nextUserId 3)
  ok   profile 1: v4, 25227 bytes: raw deep-equal; after migrateProfile deep-equal
  ok   profile 2: v2, 31625 bytes: raw deep-equal; after migrateProfile deep-equal
  ok   doc rankings: deep-equal
  ok   deleted accounts absent: 0 on the JSON list, none in postgres
```

What each check does:

- **Accounts**: `PostgresUserStore.getUserById` / `getUserByUsername` for every account, compared field by field with
  the JSON record (id, username, email, admin flag, ban fields, `created_at` as the same instant and the same ISO
  string). Password hash and salt are compared **inside SQL** (`password_hash = $json_hash`), so they never leave the
  database or reach a log, and they are byte-identical: the same passwords sign in. `checkPassword` with a random
  wrong password must fail (the sign-in read path finds the row and checks it). A positive sign-in with a known
  password is covered by the automated test (below), since nobody's live password is known.
- **Sessions**: every migrated token resolves to its account through `validateSession`, i.e. everyone signed in now
  stays signed in after the switch.
- **Ids**: the sequence hands out 3 next (the JSON store's next id): no new account can take an old id, which matters
  because profiles and the deleted-accounts list are keyed by id.
- **Profiles**: `PostgresProfileStore.load(id)` for every account id, deep-equal to `JsonProfileStore.load(id)`; then both
  are run through the game's own `migrateProfile` (starter kit and ship catalog as `GameServer` builds them, from
  the VPS's `data/ships`) and compared again, with the clock and randomness pinned (a control run proves it's
  deterministic).
- **Rankings**: `loadDoc('rankings')` deep-equal.

### Differences found

None in values. One in form: **jsonb doesn't keep the order of keys in an object** (it sorts them). The comparisons
are order-insensitive. After `migrateProfile`, key order still differs inside `reputation`, `stats`, `skills`,
`jobs[]` and ship blueprints. The only code found that depends on that order is the pilot title in
`GameServer.handlePilotInfo`: with **two factions tied** for the highest reputation it names the first one, which
may be a different faction after the switch. Cosmetic; if it matters, store the profile as `json` instead of `jsonb`
or break the tie by name.

Also noted: `users.json` has no `nextUserId` (written before it existed), so the next id is derived as highest id + 1 = 3,
exactly as the lobby does it. (No account has been deleted, so nothing was lost by that.)

## Backups made (VPS)

- `/opt/spacegame/data/backups-pre-pg-20261031-004940/` (root-only, mode 700): copies of `data/lobby/` and
  `data/profiles/` taken before anything was written (`diff -r` against live: identical), and
  `spacegame-db-before.sql`, a `pg_dump` of the spacegame database before (empty: no tables).
- The tool and its reports: `/root/pg-migrate/` (reports mode 600).
- Live files after the run: same sha256 as the backup; services untouched (both active since 06:38 AEDT,
  no `USER_STORE_BACKEND` in their environment, lobby log: `[UserStore] JSON store at /opt/spacegame/data/lobby/users.json`).

## Re-sync (it was used before the switch; after it, a re-sync would overwrite live play with the frozen JSON)

From `game-v2/` on this machine:

```bash
scripts/db/vps-sync.sh --verify-only   # how far the copy has drifted (fails once anyone has played since)
scripts/db/vps-sync.sh --dry-run       # what a re-sync would write (rolled back)
scripts/db/vps-sync.sh --replace       # re-sync: empty users/sessions/profiles/game_docs, copy again, verify
```

It bundles the tool, uploads it to `/root/pg-migrate` (with its own `pg`), and runs it there with `DATABASE_URL` read
from `/etc/spacegame/secrets.env` inside the remote shell (never printed, never leaves the VPS). It reads the live
JSON only and touches no service, unit or secret. A re-sync while the game runs is fine for testing, but it's a
snapshot: for the real switch, re-sync with the services stopped (below).

## Switch-over (done 2026-10-31 ~14:33; kept for rollback or a redo)

Prerequisites:

1. Deploy a build that has `pg` in `server/` and `server-browser/` (this branch's package.json + lockfiles; the deploy's
   `npm ci` installs it). Without it the services fail at start with `Cannot find package 'pg'`.
2. `DATABASE_URL` is already in `/etc/spacegame/secrets.env`, which both units load. Nothing to add there.
3. Back up first: `pg_dump` the spacegame database and copy `data/lobby` + `data/profiles` aside, as above.

Steps (as root on the VPS):

```bash
# 1. Freeze the JSON: stop the game server first (it saves every pilot on shutdown), then the lobby
systemctl stop spacegame-server
systemctl stop spacegame-browser

# 2. Re-sync from the final JSON and verify (from this machine: scripts/db/vps-sync.sh --replace).
#    Don't go on unless it says "N/N checks passed".

# 3. Select Postgres for both, with drop-ins (the deploy rewrites the unit files, but leaves drop-ins alone)
for u in spacegame-browser spacegame-server; do
  mkdir -p /etc/systemd/system/$u.service.d
  printf '[Service]\nEnvironment=USER_STORE_BACKEND=postgres\n' > /etc/systemd/system/$u.service.d/postgres.conf
done
systemctl daemon-reload

# 4. Start the lobby first (the game server registers with it), then the game server
systemctl start spacegame-browser
systemctl start spacegame-server
```

Verify:

- `journalctl -u spacegame-browser -n 20` shows `[UserStore] PostgreSQL pool created` (not `JSON store at ...`).
- `systemctl is-active spacegame-browser spacegame-server`; no `pg`/connection errors in either journal.
- Sign in on the site/game with an existing account: it keeps its id, its pilot loads with its progress, the rankings
  show. A session from before the switch should still be signed in.
- After a minute of play, the profile row moves: `psql "$DATABASE_URL" -c "select user_id, updated_at from profiles"`
  (run inside `( set -a; . /etc/spacegame/secrets.env; set +a; ... )`), while `data/profiles/*.json` stays unchanged.
- A new registration gets id 3 or above.

Roll back to JSON:

```bash
systemctl stop spacegame-server spacegame-browser
rm /etc/systemd/system/spacegame-{browser,server}.service.d/postgres.conf && systemctl daemon-reload
systemctl start spacegame-browser && systemctl start spacegame-server
```

The JSON files were frozen at step 1, so a rollback loses whatever was played, registered or changed while on
Postgres (there is no Postgres -> JSON export yet: write one before switching if a rollback after real play must
keep progress). The Postgres data stays where it is for a later retry.

After the switch:

- **Backups**: the JSON store's daily per-profile copies (`data/profiles/backups/`) stop; the nightly `pg_dump` timer
  `spacegame-dbdump` (installed by the deploy) replaces them.
- **The website's pilot pages** read `data/profiles/*.json` and `_rankings.json` directly (`site/src/pilots.ts`), so they
  would go stale. `PilotSource` (`site/src/pilots.ts`) reads files only: give it a Postgres reader before the site is meant to show live pilot data from production.
- The deleted-accounts list stays a file (`data/lobby/deleted-accounts.json`); on Postgres, deleting an account also
  removes its sessions and profile by `ON DELETE CASCADE`.
- Still on JSON: world memory, contributor notes, telemetry, status (no Postgres version exists).

## Tests

- `scripts/db/migrateJsonToPostgres.test.ts` (in the root vitest run): the schema seed is never applied (CRLF too),
  order-insensitive comparison, the source files are left byte-identical and no admin is seeded, expired sessions
  and orphan profiles are left out.
- With `MIGRATE_TEST_DATABASE_URL` naming a scratch database (it empties the four tables there): the full copy on a
  made-up data folder (an admin, a pilot with a save and a ban history, a deleted account with an orphan profile),
  all checks pass, **a real sign-in with the known password works through `PostgresUserStore.login`**, a new
  account gets the next id (not the deleted one's), a second run is refused, a dry run changes nothing, `--replace`
  re-syncs. Run against a throwaway local cluster (Postgres 18, port 55433), as was the first full migration of a
  copy of the live data.
