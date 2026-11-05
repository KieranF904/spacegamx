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
