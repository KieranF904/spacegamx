-- ============================================================
-- Space Game website (site/) - PostgreSQL schema
-- ============================================================
-- The same rows the dev JSON store keeps in data/site/site.json
-- (src/store/JsonSiteStore.ts). Accounts are the lobby's (the users table in
-- server-browser/schema.sql); rows here point at an account by its id, with
-- the name it had when it wrote. They are deliberately NOT foreign keys, so
-- the site can live in its own database: a deleted account is handled by the
-- site (forgetUser), not by a cascade.
--
-- Apply with:
--   psql $DATABASE_URL -f site/schema.sql
-- Enable with:
--   SITE_STORE_BACKEND=postgres DATABASE_URL=postgres://... npm start   (and npm install pg in site/)
-- ============================================================

CREATE TABLE IF NOT EXISTS site_posts (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,              -- Markdown (sanitised when shown)
    tags         TEXT[] NOT NULL DEFAULT '{}',
    cover        TEXT,
    status       TEXT NOT NULL CHECK (status IN ('draft', 'published')),
    author_id    BIGINT,
    author_name  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_site_posts_status ON site_posts(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_posts_tags   ON site_posts USING GIN (tags);

CREATE TABLE IF NOT EXISTS site_comments (
    id          BIGSERIAL PRIMARY KEY,
    post_id     BIGINT NOT NULL REFERENCES site_posts(id) ON DELETE CASCADE,
    author_id   BIGINT,
    author_name TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    hidden      BOOLEAN NOT NULL DEFAULT FALSE,
    image       TEXT                         -- the post image this is about (its src as rendered), NULL: the post
);
-- (A database from before images were commentable has the table without the column; the site also adds it at startup)
ALTER TABLE site_comments ADD COLUMN IF NOT EXISTS image TEXT;
CREATE INDEX IF NOT EXISTS idx_site_comments_post ON site_comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS site_suggestions (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    author_id   BIGINT,
    author_name TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'in_progress', 'done', 'declined')),
    reply       TEXT,
    reply_by    TEXT,
    replied_at  TIMESTAMPTZ,
    hidden      BOOLEAN NOT NULL DEFAULT FALSE
);

-- One vote per account per suggestion
CREATE TABLE IF NOT EXISTS site_votes (
    suggestion_id BIGINT NOT NULL REFERENCES site_suggestions(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_site_votes_user ON site_votes(user_id);

-- The shoutbox keeps only its latest few hundred lines (trimmed on each new one)
CREATE TABLE IF NOT EXISTS site_shouts (
    id          BIGSERIAL PRIMARY KEY,
    author_id   BIGINT NOT NULL,
    author_name TEXT NOT NULL,
    is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
    text        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin API tokens (the post-update CLI): only a sha256 of each is kept
CREATE TABLE IF NOT EXISTS site_api_tokens (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    hash            TEXT NOT NULL UNIQUE,
    prefix          TEXT NOT NULL,
    created_by      BIGINT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

-- Ships pilots have shared (the gallery at /ships): the plan to draw and the totals the game worked out.
-- One per name per pilot (the unique index); the site also caps how many a pilot can have.
CREATE TABLE IF NOT EXISTS site_ships (
    id          BIGSERIAL PRIMARY KEY,
    owner_id    BIGINT NOT NULL,
    owner_name  TEXT NOT NULL,
    name        TEXT NOT NULL,
    plan        JSONB NOT NULL,
    stats       JSONB NOT NULL,
    power       TEXT NOT NULL DEFAULT 'pool',
    hidden      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_ships_owner_name ON site_ships(owner_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_site_ships_updated ON site_ships(updated_at DESC);
