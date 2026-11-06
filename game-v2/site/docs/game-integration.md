# What the website needs from the game

The website has the four feature halves it can build without the game. Each works today and says so plainly where the
game's half is missing. This file is the contract for the game's half: what to send, in what shape, when, and how the
site behaves until then. Nothing here is built on the game side yet.

| # | Feature | Site today | The game provides | Until then |
|---|---|---|---|---|
| 1 | Database (`/database`) | Reads its own snapshot of the game's data | A catalog file or endpoint (optional) | Snapshot, "Data as of" line |
| 2 | Server status (`/status`) | Players and online state | Extra fields in `live.json` | "Not reported by the server yet." per section |
| 3 | Ship gallery (`/ships`) | Stores and draws shared ships, shows the game's plans | `POST /api/v1/ships` from the game server | "No shared ships yet." |
| 4 | "What's new" feed | Public JSON API | The menu fetches it | Works as a plain API |

Rules that hold for all four:

- **No story.** Nothing the game sends is shown if it is lore (history, origins, factions' backstory, codex text,
  mysteries, hints). The site writes its own plain chart text from numbers. The only free-text field the game may send is
  `blurb` (section 1), and it must be plain chart text: what the thing is and does.
- **The site never calls the game.** It reads files the game writes (sections 1 and 2) and answers calls the game
  makes (section 3). Section 4 is called by the game's menu.
- **Every field is checked on arrival.** A missing or malformed field is left out, never guessed. Unknown fields are
  ignored, so the game can add fields before the site reads them.

---

## 1. Catalog (Database)

### What the site does now

`site/catalog/catalog.json` is a snapshot made by `npm run build-catalog` (in `game-v2/site`), which reads
`game-v2/data` and the game's shared ship code (`common/src/ships`) and writes nothing else. It is committed, with the
data folder's last commit and date in `source`. The pages show "Data as of <date>".

The Parts tab is laid out like the game's component guide, with the game's own pictures. `npm run build-part-images`
(run it first) draws every component and item icon with the client's drawing code (`client/src/ui/componentSprites.ts`,
`itemIcons.ts`) in one headless Chrome, into `site/public/img/parts/` and `site/public/img/items/` (WebP), and writes
`site/catalog/guide.json` (each component's tab, level, picture, cost, trade-off and mounting lines; never its
description). `build-catalog` folds that file into the snapshot. Commit all of it.

Run both again whenever parts, items, ships, bosses or stations change in the data. `catalog.test.ts` fails if any of the
game's prose (descriptions, intros, titles, factions, market notes, codex, people, factions, strings) reaches the
snapshot or a rendered page.

### What the game may provide later

Either of these, the first that exists and is valid wins over the snapshot:

- **A file** at `data/catalog/catalog.json` (or the path in `SITE_CATALOG_FILE`) that the game's build or server writes.
  The site re-reads it when it changes.
- Or the site's snapshot, rebuilt by a game-side script that runs the same builder.

The site also serves what it uses at `GET /api/v1/catalog` (public, cached 60 s, `?kind=parts|items|ships|bosses|stations`
for one list), so a game tool can read the same shape.

### Shape

The TypeScript types are in `site/src/catalog/types.ts` and are the contract. In short:

```jsonc
{
  "version": 1,
  "builtAt": "2026-11-04T02:00:00.000Z",
  "source": { "commit": "dec7d34", "date": "2026-11-03T14:22:23+11:00", "dirty": false },   // or null
  "parts":    [ { "id": "cannon_pip", "name": "Pip", "category": "weapons", "family": "cannon", "rarity": "common",
                  "mark": "Mk I", "grade": 1, "material": "alloy", "size": "Small", "cells": 1, "shapes": ["sq"],
                  "unlock": null, "hp": 60, "mass": 1,
                  "weapon": { "mount": "fixed", "dps": 56, "range": 7200, "damageType": "kinetic", "pen": 1, "interval": 15 },
                  "draw": 8, "ports": [ { "dir": "in", "side": "S", "rate": 12 } ],
                  "craft": { "inputs": { "alloy_plate": 2, "copper_wire": 1 }, "seconds": 0 },
                  "blurb": "optional plain text from the game" } ],
  "items":    [ { "id": "steel_plate", "name": "Steel Plate", "category": "refined", "rarity": "common", "value": 12,
                  "foundIn": [ { "rock": "asteroid_metal", "name": "Chondrite", "share": 60 } ],
                  "madeBy": [ { "kind": "refine", "inputs": { "iron_ore": 4, "nickel_ore": 2 }, "out": 1, "seconds": 4 } ],
                  "usedIn": [ { "kind": "part", "id": "cannon_twinlink", "name": "Twinlink" } ],
                  "soldAt": [ "sol_station_trade" ], "paidMoreAt": [ { "station": "sol_station_lagrange", "mult": 1.15 } ],
                  "droppedBy": [ { "boss": "boss_giant_midden", "chance": 0.8 } ] } ],
  "ships":    [ { "id": "sparrow-t", "name": "Sparrow T", "stats": { "parts": 14, "cells": 13.6, "mass": 13.6, "hp": 1063, "gen": 70,
                  "draw": 34, "thrust": 4.5, "shield": 0, "cargo": 0, "guns": { "fixed": 2, "turret": 0 } },
                  "size": { "w": 6, "h": 4 }, "power": "pool",
                  "plan": [ { "fn": "core", "piece": "rect2", "x": 2, "y": 1, "rot": 0 } ], "soldAt": [] } ],
  "bosses":   [ { "id": "boss_scrap_mother", "name": "Scrap Mother", "system": "sol_scrap_nest", "level": 8, "phases": 4,
                  "xp": 2400, "credits": 2400, "respawnSeconds": 600,
                  "loot": [ { "item": "servo_motor", "chance": 1, "min": 1, "max": 2 } ] } ],
  "stations": [ { "id": "sol_station_mining", "name": "Sol Mining Outpost", "system": "sol", "services": ["repair", "market"],
                  "repairCostPerHp": 0.4, "refuelCostPerUnit": 0.5,
                  "sells": { "items": ["repair_kit"], "plans": ["hauler"], "parts": [ { "part": "utility_mining_laser", "material": "alloy", "label": "Alloy Mining Laser" } ] },
                  "pays": [ { "item": "titanium_ore", "mult": 1.2 } ] } ],
  "systems":  [ { "id": "sol", "name": "Sol System", "danger": 1, "hazards": [], "stations": ["sol_station_central"] } ],
  "ribbons":  [ { "id": "first_blood", "name": "First Blood" } ],   // optional: names for the ribbon ids on pilot pages
  "render":   { "shapes": { "sq": ["1,0 1,1 0,1 0,0", "..."] }, "colors": { "hull": "#24324d", "cannon_pip": "#e05a4a" } }
}
```

Notes for whoever writes it:

- Ids are the game's ids. Names are the in-game names. **No `description`, `intro`, `title` or `faction` fields**: the
  site ignores them and a test fails if they appear in its snapshot.
- `render.shapes[pieceId]` is 8 outlines (rotation 0-3, then the same four flipped), as `"x,y x,y ..."` in cell units
  from the piece's origin cell (the catalog variant's `polygon`). `render.colors` is a colour per function id. The site
  draws every plan with these (nose up); it has no copy of the game's piece data.
- A ship's `plan` is moved so its top-left corner is (0, 0). A ship's `stats` are totals worked out with the game's own
  part stats (the same numbers as the hangar).
- Stations in a pilot's private space are left out. Placeholder bosses are left out.
- Optional `blurb` on any entry (part, item, ship, boss, station) replaces the site's own first sentence. It is the one
  place the game may later supply chart text (the description pass); plain, mechanics only.
- Optional later: a per-ship or per-part picture (`image`, a PNG path from the native renderer). The site would show it
  beside the drawing. Not read yet.

---

## 2. Server status

### What the site does now

`/status` and `GET /api/v1/status` read `data/status/live.json` (the file `SITE_STATUS_FILE` names), which the game
server writes every 2 s. Today it has `{ t, players, ships }`. `t` older than 15 s means the server is down.

### What the game adds

Extra fields in the same file. All optional; each section of the page appears when its field does.

```jsonc
{
  "t": 1762221600000,            // ms since epoch, written every 2 s (already there)
  "players": 3,                  // (already there)
  "ships": 12,                   // (already there)
  "version": "0.9.1",            // string, 40 characters at most: the build or git short hash
  "protocol": 26,                // number: the network protocol version
  "startedAt": 1762200000000,    // ms since epoch: when the server process started
  "tick": { "ms50": 3.1, "ms99": 9.8 },        // median and 99th percentile tick time over the last minute, ms
  "systems": [ { "id": "sol", "players": 2 } ],   // only systems with pilots, or all: either is fine
  "bosses": [ { "id": "boss_scrap_mother", "system": "sol_scrap_nest", "state": "down", "respawnAt": 1762221720000 } ]
}
```

- `bosses[].state` is `up` (alive, nobody fighting), `fighting`, or `down`. `respawnAt` (ms since epoch) is only for
  `down`; the page shows the time left.
- Ids are the game's. The page looks names up in the catalog and falls back to the id.
- Write the file atomically (temp file and rename), as it already does. Nothing in it is private; it is public on
  `/api/v1/status`.

### Until then

Online state, pilots and ships show as today. Each missing section says **"Not reported by the server yet."** When the
server is offline the page says so and shows no sections.

`GET /api/v1/status` returns `{ online, players, ships, ... }` with only the fields the game reported, plus
`updatedAt`. Public, cached 2 s.

---

## 3. Pilot ship gallery

### What the site does now

- `/ships`: ships pilots shared, then the game's plans (from the catalog), drawn from above.
- `/ships/:id`: one shared ship with its totals; a "Shared ships" panel on each pilot's profile.
- `/admin/ships`: an admin can hide, show or delete any shared ship.
- Stored in `site_ships` (the JSON store, or PostgreSQL: `site/schema.sql`). One ship per name per pilot (case
  does not matter; sharing the same name again replaces it), **10 per pilot**. A deleted account's ships go with it.

### What the game does

The **game server** (not the browser) posts a ship when a pilot chooses to share it. It authenticates with a key it
shares with the site, so the totals come from the server's own numbers and cannot be forged by a client.

```
POST /api/v1/ships
Authorization: Bearer <SITE_GAME_KEY>
Content-Type: application/json

{
  "userId": 42,                  // the pilot's lobby account id
  "userName": "Orrin",           // 2-20 characters: letters, digits, _ and -
  "name": "Stubborn",            // the ship's name, 40 characters at most
  "plan": [ { "fn": "core", "piece": "rect2", "x": 0, "y": 0, "rot": 0, "flip": false } ],   // the blueprint's parts
  "stats": { "parts": 14, "cells": 14, "mass": 13.6, "hp": 800, "gen": 70, "draw": 34, "thrust": 4.5, "shield": 0, "cargo": 0,
             "guns": { "fixed": 2, "turret": 0 } },
  "power": "pool"                // or "ports"
}
```

Answers: `201 { id, url, created: true }` (new), `200 { id, url, created: false }` (same name: replaced),
`400 { error }` (what was wrong), `401` (bad key), `409` (the pilot has 10 ships: withdraw one first), `429` (more than 20
shares an hour for one pilot), `503` when the site has no key set.

```
DELETE /api/v1/ships/:id?userId=42       Authorization: Bearer <SITE_GAME_KEY>
```
Withdraws that pilot's ship: `200 { deleted: true }`, `403` if it is another pilot's, `404` if it is gone.

Public reads, no key: `GET /api/v1/ships[?owner=Orrin]` (list, no plans) and `GET /api/v1/ships/:id` (with the plan).

Rules for the data:

- `plan` is the blueprint's parts as the game stores them: `fn` and `piece` are ids (lowercase letters, digits, `_`),
  `x` and `y` whole numbers from -500 to 500, `rot` 0 to 3, `flip` true or omitted. At most 400 parts. The site rejects
  a `piece` it has no outline for (a catalog without it), so the catalog's `render.shapes` and the game's pieces must
  match. Wires, gems, weapon mods and anything else on a part are ignored.
- `stats` are the totals the hangar shows; every number is 0 or more, and `guns` has whole `fixed` and `turret`.
- Only a pilot's choice: the game should not post ships on its own.
- The key (`SITE_GAME_KEY`) is 32 or more random characters, set in the site's environment and in the game server's.
  It can share and withdraw ships and do nothing else (it is not an admin and cannot post updates). Without it the
  site's share call answers 401 or 503 and the gallery shows the game's plans only.

### Until then

The gallery shows "No shared ships yet." above the game's plans, and a profile shows "No shared ships yet."

---

## 4. "What's new" feed

### What the site does now

`GET /api/v1/changelog[?since=<iso>][&tag=<tag>][&limit=<1-50>]`: public, cached 60 s, CORS open.

```jsonc
{ "updatedAt": "2026-11-01T10:00:00.000Z",
  "items": [ { "slug": "suns-and-planets", "title": "Reworking the graphics", "summary": "...", "publishedAt": "2026-11-01T10:00:00.000Z",
               "url": "https://space.example/updates/suns-and-planets", "cover": "https://space.example/uploads/x.png", "tags": ["graphics"] } ] }
```

Published posts only, newest first (never drafts). `since` returns only posts published after it, which is how the menu
counts unread ones. `tag` narrows to one tag, for example `game`, if some posts are for the menu and others only for
the site (tag a post `game` in the editor).

### What the game does

After sign-in, the menu fetches `/api/v1/changelog?since=<the last time this pilot looked>`, shows the titles with an
unread mark, and links each to `url`. It keeps the "last looked" time itself (local storage or the profile). The site
keeps no per-pilot read state.

### Until then

A plain public API; nothing is needed from the game for it to work.

---

## Order the game can build these in

1. **Changelog** in the menu (small, no site change).
2. **Status fields** in `live.json` (a few lines where the file is written).
3. **Shared ships** (a Share button in the hangar, the server call, the key in both environments).
4. **Catalog file** last, or never: the snapshot is enough while the data changes rarely. Rebuild it by hand
   (`npm run build-part-images`, `npm run build-catalog`, then commit) when parts, items or ships change.
