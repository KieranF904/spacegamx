-- ============================================================
-- Space Game v2 - User Account Schema (PostgreSQL)
-- ============================================================
-- This schema is the canonical definition for the user account
-- system. The local JSON store (JsonUserStore) mirrors it 1:1,
-- so migrating to PostgreSQL is a straight data copy.
--
-- Apply with:
--   psql $DATABASE_URL -f schema.sql
--
-- Enable in the server with:
--   USER_STORE_BACKEND=postgres DATABASE_URL=postgres://... npm start
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,          -- PBKDF2-SHA512, 100k iterations, 64 bytes, hex
    salt          TEXT NOT NULL,           -- 32 random bytes, hex
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bans (added later: ALTER so an existing database picks them up when this is re-applied)
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until BIGINT;   -- epoch ms; NULL or past: not banned; 253402300799000: for good
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_by    TEXT;     -- the admin's username

-- The owner rank, above admin (added later, the same way; PostgresUserStore.upgrade() also adds it at start).
-- Set only from the server side: the lobby's /admin/set-owner (behind LOBBY_ADMIN_SECRET) or OWNER_USERNAMES.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner     BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,          -- 48 random bytes, hex
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL            -- epoch milliseconds
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_username   ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);

-- Pilot progress: one document per account (PlayerProfile in common/src/econ/profile.ts).
-- The JSON store (JsonProfileStore, data/profiles/<user_id>.json) holds the same document.
CREATE TABLE IF NOT EXISTS profiles (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,           -- profile schema version (migrated on load)
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which game server holds an account right now (one at a time across regions); see server/src/profile/lease.ts.
-- A server renews its pilots' rows every ~30 s; one that stops (crash, suspend) is stale after ~90 s.
CREATE TABLE IF NOT EXISTS profile_leases (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    holder     TEXT NOT NULL,              -- the game server's SERVER_ID
    expires_at TIMESTAMPTZ NOT NULL
);

-- Game-wide documents (the rankings), by name; the game server creates this too if it is missing.
CREATE TABLE IF NOT EXISTS game_docs (
    key        TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No seeded accounts: never ship an account with a known password (make admins through the lobby or by hand).

-- The player inbox (server-browser/src/inbox): one row per recipient, so a message to everyone is a copy per account
-- sharing a `batch`. PostgresMessageStore makes this at start too when it is missing. The JSON store
-- (JsonMessageStore, data/lobby/messages.json) holds the same rows.
CREATE TABLE IF NOT EXISTS messages (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the recipient
    from_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,          -- the sending admin; NULL: the game ("system")
    from_name    TEXT NOT NULL,                                          -- their username at the time, or 'system'
    subject      TEXT NOT NULL,                                          -- plain text (escaped on display)
    body         TEXT NOT NULL,
    important    BOOLEAN NOT NULL DEFAULT FALSE,                         -- the join screen's banner until read
    batch        TEXT NOT NULL,                                          -- one send (a broadcast's copies share it)
    sent_to      TEXT NOT NULL,                                          -- a username, or '*' for everyone
    created_at   BIGINT NOT NULL,                                        -- epoch ms
    read_at      BIGINT,
    archived_at  BIGINT                                                  -- deleted by the player
);
CREATE INDEX IF NOT EXISTS idx_messages_user  ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_batch ON messages(batch);

-- The player activity feed (server-browser/src/activity): what pilots do on each game server, for the website's admin
-- panel only (never chat or private-message contents). Each server keeps its newest 5000 rows (pruned by the store).
-- PostgresActivityStore makes this at start too when it is missing. The JSON store (JsonActivityStore,
-- data/lobby/activity.json) holds the same rows.
CREATE TABLE IF NOT EXISTS activity (
    id      BIGSERIAL PRIMARY KEY,
    at      BIGINT NOT NULL,                 -- epoch ms
    server  TEXT NOT NULL,                   -- the game server's name ("AUS Main"), or 'Lobby'
    type    TEXT NOT NULL,                   -- join, leave, death, boss_kill, ...
    player  TEXT NOT NULL DEFAULT '',
    other   TEXT NOT NULL DEFAULT '',        -- a second pilot it names (trade partner, PvP killer, admin's target)
    detail  TEXT NOT NULL DEFAULT ''         -- one short line, plain text (escaped on display)
);
CREATE INDEX IF NOT EXISTS idx_activity_server ON activity(server, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_player ON activity(lower(player), id DESC);

-- Friends, friend requests and the saved status (server-browser/src/friends): one row per account, the lists as account
-- ids. The game servers read and change them through the lobby's /admin/friends/*, so friends follow the account to
-- every server. PostgresFriendStore makes this at start too when it is missing. The JSON store (JsonFriendStore,
-- data/lobby/friends.json) holds the same records. A deleted account's row goes by cascade; the store takes its id
-- out of everyone else's lists.
CREATE TABLE IF NOT EXISTS friend_lists (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'online',   -- online, away, busy, invisible ("Appear offline")
    friends    BIGINT[] NOT NULL DEFAULT '{}',
    incoming   BIGINT[] NOT NULL DEFAULT '{}',   -- requests to this account
    outgoing   BIGINT[] NOT NULL DEFAULT '{}',   -- requests it sent
    updated_at BIGINT NOT NULL                   -- epoch ms
);
