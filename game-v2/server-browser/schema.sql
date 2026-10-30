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

-- Seed admin account (username: admin, password: admin)
-- Hash/salt generated with PBKDF2-SHA512 (100k iterations, 64-byte output)
-- Change the password after first login!
INSERT INTO users (username, email, password_hash, salt, is_admin)
VALUES (
    'admin',
    'admin@localhost',
    '112e445afd8e99d4fbdb0349e5e190aa7895ca75c314832b393fc955c209e68f041009eeb0cabcfb239444dcd21a87dea4be38ec19e646eed7e938a15c9c3296',
    '660c99361c324b744a4553a1963a53d76711e37b8f6b0bab64c0fa95264d1323',
    TRUE
)
ON CONFLICT (username) DO NOTHING;