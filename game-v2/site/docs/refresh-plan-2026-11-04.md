# Website refresh plan (2026-11-04)

Kieran's ask: refine the site, add manuals and guides (practical mechanics), build the website half of some features
the game will plug into later, and draft a post with all the recent panels. Rules for this run: only `game-v2/site`
changes; game code and data are read-only; nothing deployed or published; **no lore anywhere on the site** (no story,
history, origins, faction backstory, codex text, mysteries or hints, not even attributed). Names of places, ships and
factions are fine as plain labels.

Audit basis: the site's code (`src/`, `public/`, `seed/`, `schema.sql`), the dev data (`data/site/site.json`), and one
headless Chrome pass over `/`, `/updates`, a post, `/suggestions`, `/pilots`, a pilot profile, `/signin`, `/register`
and a 404, at 1366 px and 390 px (no horizontal overflow, no console errors, no broken images).

## 1. What's on the site now, and what to refine

What exists: home (hero, latest updates, three feature blocks, shoutbox, top pilots), `/updates` + posts with comments
and image comments, RSS, `/suggestions` with votes, `/pilots` (weekly/all-time boards) and pilot profiles, sign-in,
register, account, `/play`, admin, a posts API and CLI. Pilot cards, boards and the live count already read the game's
files (`src/pilots.ts`: `data/profiles/*.json`, `_rankings.json`, `data/status/live.json`).

### Lore to remove (do in stage 2 or 5)

| Where | What | Fix |
|---|---|---|
| `src/views/pages.ts` home, "03 Fight" block | `<blockquote class="ingame">` quoting the Scrap Mother's intro ("Something huge and patched together stirs...", cited "In the game") | Delete the quote (and the now-unused `.ingame` CSS); keep the plain mechanics lines |
| `src/views/pages.ts` `pilotCard` footer | "N codex records" (counts a lore system) | Drop it from the card; keep ribbons, since, last flown |
| Game data the new features will read | `description` of items (e.g. `ancient_relic`, `leestone_ore`, `leestone`, `leestone_plate`, `smuggler_cache`), systems (`sol`: "Home system of the colony..."), stations ("The colony's capital station..."), bosses (`intro`, `title`, `faction`), `codex.json`, `factions.json`, `people.json`, `strings.json` | Never shown. The site writes its own plain chart text from mechanics (see feature A). A test fails the build if any of those fields reach a page |

Posts checked: "Reworking the graphics" (published) and "Stations, asteroids and the sign-in screen" (draft) describe
looks and costs only; no lore found.

### Refinements

- **Navigation.** Add **Guides** and **Database** to the top nav and footer (order: Updates, Guides, Database, Pilots,
  Suggestions). The mobile menu already collapses; check the longer list fits at 390 px.
- **Home.** The hero image (`public/img/hero-corsair.webp`) still shows wire runs, which were retired on 1 Nov: swap for
  a current native render (`npm run render`, no browser). `public/img/parts.webp` is a tiny unreadable sheet: replace
  with a crop of a few parts, or link it to the Database. "Engines have a rated speed." is a thin line: replace each
  feature block's second line with a link to the matching guide. Add a short "Guides" row (3-4 cards) under Latest.
- **Post byline.** Posts show the author as "admin": show "Kieran" (a display name on the post, or map the admin
  account's name) or drop the byline.
- **Old draft.** `stations-asteroids-sign-in` (draft, id 19) was merged into the published post and is superseded:
  ask Kieran before deleting it; until then leave it.
- **404.** The not-found page has no heading; give it an `h1` and links to Updates and Guides.
- **Pilot profile.** The breadcrumb sits tight under the header; add top spacing. Show boss kills by boss name
  (`bossKills` is already parsed, not shown) and ribbon names (labels only from `achievements.json`).
- **Pilots boards.** Most boards are empty in dev; the empty state should be one plain line per board ("No entries
  yet.") rather than a full empty block each.
- **Post images on phones.** Wide frame-strip panels (four or eight frames across) are unreadable at 390 px: the viewer
  already zooms, but the inline picture should use a cropped pair (see section 4).
- **Copy pass.** Plain and short throughout; remove "Play now / in the browser" double label on small screens.
- **Check after changes:** every page at 1366 and 390 px, one browser, closed after.

## 2. Guides to write

Guides live in `site/guides/*.md` (front matter: title, order, summary, `checked` date, `sources` list kept for us and
not shown), rendered with the existing Markdown renderer at `/guides` and `/guides/:slug`, with a contents list and
previous/next links. Each guide is checked against the code and data listed, with real numbers, second person,
mechanics only. Where a system is mid-change, the guide says what works today and gets rechecked later.

| # | Guide | Covers | Read for the mechanics |
|---|---|---|---|
| 1 | Getting started | Signing in, the starter ship, first flight, docking, first job, where to mine, what to do when destroyed | `client/src/ui/Tutorial.ts`, `data/rules.json`, `data/ships/blueprints/sparrow-t.json`, `data/unlocks.json`, `common/src/econ/levels.ts`, `docs/areas/ui-hud-input.md` |
| 2 | Controls and flight modes | Every default key, mouse-steer vs helm (V), boost, strafe, zoom, autopilot (G), action menu (Z), pings, rebinding | `client/src/input/keybindings.ts`, `common/src/ships/flight.ts`, `flightInputs.ts`, `data/ships/tuning.json`, `docs/areas/flight.md` |
| 3 | Energy and ports | Generators, stores, banks (Capacitor, Drive Cell), port directions and rates, what runs first in a brownout, Selectors (Y), the HUD schematic | `data/ships/functions.json` (`ports`, `rate`), `common/src/ships/power/`, `energy.ts`, `circuits.ts`, `rebuild.ts`, `docs/areas/energy.md` (Ports core), `docs/design/energy-ports-2026-11.md` section 14, `tuning.json` `energy`. Note: wires retired 1 Nov and ports are new; confirm which power mode the starter and shop ships use before writing |
| 4 | Weapons and how damage works | Weapon families, fixed vs turret mounts and gimbal, range and reload, energy draw, armour grades, shields, sockets/gems, targeting (Tab, T), missile lock | `functions.json` weapons, `common/src/ships/guns.ts`, `damage.ts`, `grades.ts`, `mounting.ts`, `turret.ts`, `shot.ts`, `data/gems.json`, `docs/areas/weapons.md`. `hitRules.ts` is being changed now: describe outcomes, not internals |
| 5 | Building a ship | The hangar grid, pieces and materials, the core, structure vs armour, mass and speed, mounting rules, saving and cost, the Component Guide (C) | `common/src/ships/blueprint.ts`, `grid.ts`, `mounting.ts`, `rating.ts`, `partStats.ts`, `load.ts`, `data/ships/materials.json`, `inventory.json`, `docs/areas/ship-parts.md`, `docs/areas/hangar-ui.md` |
| 6 | Mining and refining | Rock types and materials (the 18 asteroid types), mining tools, what each ore is worth, refining at stations, cargo mass | `data/mining.json`, `common/src/econ/mining.ts`, `rocks.ts`, `data/recipes.json` (`refining`), `data/items.json` (values), cargo-mass panel 2026-10-31 |
| 7 | Trade, jobs and credits | Markets, buy/sell, jobs and the pilot log (L), XP and levels, skills (K), ribbons | `common/src/econ/market.ts`, `economy.ts`, `quests.ts`, `levels.ts`, `ribbons.ts`, `data/quests.json`, `data/stations.json` markets, `data/achievements.json`, `docs/areas/economy-quests.md` |
| 8 | Stations and services | Docking (H), repair cost per HP, refuel, storage, refinery, fabricator, market; which station has which | `data/stations.json` (`services`, `repairCostPerHp`, `refuelCostPerUnit`), `data/station.json`, `client/src/ui/StationWindow.ts` |
| 9 | Travel: jump drive, gates and the map | Jump (J) range and charge, gates (X), the map (M), autopilot, system danger levels, hazards and warmth | `common/src/ships/jumpFields.ts`, `farRoute.ts`, `warmth.ts`, `hazards.ts`, `data/systems.json` (`portals`, `danger`, `hazards`), `data/hazards.json`, `docs/areas/world-sim.md` |
| 10 | Bosses: the basics | Stages, telegraphed attacks, shooting parts off, respawn times, loot, fighting in a party | `data/bosses.json` (`level`, `hp`, `phases`, `respawnSeconds`, `loot` only), `common/src/ships/stages.ts`, `docs/boss-design.md`, `docs/areas/bosses-ai.md` |
| 11 | Parties and chat (short) | Party window (P), invites, pings (B), shared kills, chat (Enter) | `keybindings.ts`, party code under `client/src/ui`, `server/src/...` party handling |

First batch: 1-5 and 8. Second: 6, 7, 9, 10, 11.

## 3. Features with a website half

Already in place and fed by the game: pilot profiles, leaderboards, the live pilot count. The new four:

### A. Database: parts, items, ships and bosses (best value)

- **Site now:** `/database` with tabs Parts, Items, Ships, Bosses, Stations; search and filters (category, rarity,
  tier); a page per entry. A site script (`site/scripts/build-catalog.ts`, run by hand) reads `game-v2/data`
  read-only and writes `site/data/catalog.json` (committed snapshot with the data's commit hash and date). Parts show
  stats from `functions.json` (HP scale, ports and rates, energy, mass, unlock level from `unlocks.json`), items show
  category, value, where sold (stations' markets), what refines into what (`recipes.json`), which rocks drop it
  (`mining.json`). Ships: stock blueprints drawn as an SVG grid in their parts' colours, with part count, mass, guns.
  Bosses: name, system, level, HP, number of stages, respawn time.
- **Text:** the site writes every description from those fields ("Mineral. Sells for 12 cr at Sol Central Station.
  Refines into Steel."). Data `description`, `intro`, `title`, `faction`, codex and people fields are dropped at build,
  with a test that fails if any reach the snapshot.
- **Contract for the game later:** `GET /api/catalog` on the game server (or a `data/catalog/catalog.json` the game's
  build writes), JSON `{ version, builtAt, parts: Part[], items: Item[], ships: Ship[], bosses: Boss[], stations:
  Station[] }` with only mechanics fields, plus optional `render` PNG paths per ship and part from the native renderer.
  A `blurb` field per entry is the one place the game may later supply plain chart text (Kieran's description pass).
- **Until then:** the site's own snapshot; footer line "Data as of <date>". Missing renders show the SVG grid.

### B. Server status

- **Site now:** `/status` and an extended `/api/v1/status`: online/offline, pilots and ships online, and sections for
  version, uptime, tick health, players per system and bosses up or respawning.
- **Contract:** the game extends `data/status/live.json` (written every 2 s) with `{ t, players, ships, version,
  protocol, startedAt, tick: { ms50, ms99 }, systems: [{ id, players }], bosses: [{ id, system, state: 'up' |
  'fighting' | 'down', respawnAt }] }`.
- **Until then:** players and online state only (as today); each missing section shows "Not reported by the server
  yet."

### C. Pilot ship gallery

- **Site now:** `/ships` and a "Ships" panel on pilot profiles: blueprints drawn as SVG (shared renderer with A), name,
  pilot, part count, mass, weapons, generation vs draw. Stock ships from A fill the gallery today.
- **Contract:** the game posts a ship with the pilot's lobby session: `POST /api/v1/ships { name, blueprint, stats:
  { parts, mass, gen, draw, guns }, image?: PNG }` -> `{ id, url }`; `DELETE /api/v1/ships/:id`. Site stores rows
  (`site_ships`, JSON and Postgres stores), one ship per name per pilot, a cap per pilot, admin can hide.
- **Until then:** stock ships only; profile panel says "No shared ships yet."

### D. "What's new" feed for the game menu

- **Site now:** `GET /api/v1/changelog?since=<iso>` (public, cached): `[{ slug, title, summary, publishedAt, url,
  cover }]` from published posts; a `game` tag or `changelog` front-matter flag picks which posts the game shows.
- **Contract:** the game's menu fetches it after sign-in and shows unread titles linking to the site.
- **Until then:** works as a plain public API; nothing on the game side.

Each comes with `site/docs/game-integration.md` stating the shapes above, who writes what, and how the site degrades.
Order: A, D (small), B, C.

## 4. The draft post

Last published post: "Reworking the graphics" (`suns-and-planets`, 1 Nov, last edited 3 Nov 00:57 UTC). It covered
suns, sky, planets, the sign-in screen, the Citadel, asteroids and the three bosses. Not yet in any post:

**Ships and parts (panels 2026-11-01, 2026-10-30)**
- Engines: per-model plumes (`parts/ships-in-flight-before-after`, `parts/engine_*`), then the 3 Nov pass giving every
  engine its own flame (`graphics/engine-looks`).
- Power, shield and plating parts restyled (`parts/power-engines-shields-plating-before-after`).
- Every weapon model restyled (`weapons/all-models-before-after`; 10-30 `weapon-models-*`, `weapon-mounts-*`,
  `hull-weathering` if not shown before).
- Wiring retired: power flows between touching parts (`hangar/wires`).
- HUD: status drawn on the ship schematic (`hud/ship-schematic`, `hud/ship-status`).
- Your shield at rest is a thin rim (`render/shields`, `shields-hit`).
- Optional gallery: the five review ships (`review-ships/*`, after only).

**Weapons and hits (2026-11-03)**
- Impacts scale with damage: `impacts-by-tier`, `impact-explosions`, `impact-fragments`, `impact-rebound`,
  `impact-direction`, `impact-anchored` (hits ride a moving target).
- Bastion impact and muzzle; Lance part, beam and muzzle; Spark bolt, long bolt (reach 660 -> about 3,960) and how
  other pilots see it; Cutter burn (after only); fixed guns toe in to their gimbal.
- Fixes: Fusion Plant ring stray line; gas giant band flicker (23 events in 16,800 frames -> 1 in 14,400).

**Planets and sign-in (2026-11-03)**
- Terra Nova with climate, and the glint retune (GPU ms in the entries: sign-in size 0.074 -> 0.095 Medium).
- Sign-in: bodies orbit (`ui/login-orbit`), sun sets behind the planet (`ui/login-sun-behind`), Terra Nova on it.

**Joining and arriving (2026-11-03)**
- Loading screen on join (first pong 2.0 s -> 0.1 s, no camera slide) and on arrival/respawn (`ui/join-loading`,
  `ui/arrival-loading`).
- Chat (2026-11-02, `chat/before`, `after-*`): no panels entry; look at it before deciding.

**Network savings (small table)**, from commits c79925d, b9e3733, 9152c80 and
`docs/audits/network-message-catalogue-2026-11-03.md`: Gale fight 5,368 -> 3,567 B/s raw; 8 bots around you down
2,147 -> 1,269 B/s wire and 28 -> 17 msg/s; 8-bot fight up 1,989 -> 800 B/s. The netcode phase is still running:
re-read the latest numbers when drafting.

**Images:** each pair as one side-by-side JPEG in `docs/panels/site-posts/` (old left, new right, no text). The
`<topic>.png` composites are before-left / after-right already but the frame strips are 4-8 frames per side: crop to
one or two moments per side so they read on a phone. After-only shots go in alone and the text says so.

**Voice:** Kieran's first person ("So the last few days I've been..."), why each change was made and what it means in
play, no hype, no exclamation marks, no lore. Saved as a draft only, off the public list.
