# Pre-cache everything from the sign-in page? (31 October 2026)

Kieran asked: *if players compiled and pre-cached as much as possible from the moment they open the sign-in page, how
much would we send them, and how much would it take up in their cache once everything is compiled and built?*

This is an audit only. No game code was changed. The measuring script is `scripts/profile/precacheAudit.mjs`, with three
modes: `download` (sizes of a built client), `generators` (drives a scratch dev page that ran every asset-cache
generator; the page has been deleted) and `shaders` (a first visit and a reload on a fresh Chrome profile against a
`vite preview` of the build, with a GL probe). Machine: Ryzen 7 9800X3D and RTX 5070 Ti, headless Chrome on ANGLE/D3D11,
1440×900. As in `profile-2026-10-31.md`, the CPU numbers are a best case; a typical player laptop is about 2.5 to 4×
slower.

**Short answer.** A normal player could at most download **about 2.4 MB** (gzip as nginx serves it), compared with
**0.85 MB today** before the sign-in screen. Building every generated asset for every input in the game takes about
**43 MB** of IndexedDB (133 MB uncompressed) and **about 6.8 s of CPU** on this machine (about 17 to 27 s on a laptop).
Most of that time runs in workers. All shader programs are already compiled behind the sign-in screen today: 34
programs, about 2.8 s of driver time, and **5.4 MB** in Chrome's GPU program cache. Everything fits easily under the
256 MB budget. Most of it isn't worth building up front: the costly items are rare ones (three bespoke giants' hulls,
every system's stillstones, the item icons).

## (a) Download

Sizes are from a fresh `vite build`. "nginx" is what `deploy/vps/nginx-spacegame.conf` sends: `gzip on` at the default
level 1, for JS, CSS, JSON and HTML only, from 1 KB up; there is no brotli. MP3s go out as they are. gzip-6 and
brotli-11 are listed for comparison: brotli would cut the JS by about a further 25%.

What a first visit actually fetched was recorded with the `shaders` run (Network domain).

| Category | Files | Raw KB | nginx (gzip 1) KB | gzip 6 KB | brotli KB | When / who |
|---|---:|---:|---:|---:|---:|---|
| **A. Sign-in screen**: index.html, `main` (1.94 MB raw), the shared Pixi chunk, and Pixi's WebGL renderer and environment chunks | 12 | 2,483 | **849** | 744 | 599 | Today's initial load (measured) |
| B. Workers at join: procedural, hull atlas, hull (+ its Pixi environment chunks) | 5 | 753 | 240 | 210 | 176 | Every player, when the game starts |
| C. Sound effects (`sfx/`: 51 MP3 + index.json) | 52 | 1,265 | 1,263 | 1,229 | 1,219 | Every player, once audio starts (already compressed) |
| D. Screens prefetched after sign-in (Hangar, StationWindow, Component Guide, field guide, and their helpers) | 9 | 236 | 90 | 81 | 71 | Every player (`Game.prefetchScreens`, measured) |
| E. Admin and contributor panels (AdminPanel, ContributorPanel, contributorNotes) | 3 | 90 | 31 | 28 | 25 | Admins and contributors only (guests are admins on dev, so it loaded here) |
| F. Pixi WebGPU and Canvas renderers | 2 | 54 | 18 | 16 | 15 | Never on WebGL (fallbacks) |
| G. Proto mode (`protoMain`) and the replay worker | 2 | 1,379 | 506 | 443 | 369 | Developers only |
| G2. Proto's 63 enemy-blueprint chunks | 63 | 239 | 47 | 36 | 29 | Developers only |
| H. sandbox.html and its chunk | 2 | 153 | 44 | 38 | 32 | Developers only |
| Z. Source maps (`*.map`, deployed with the build) | 96 | 15,733 | 4,971 | 4,174 | 3,397 | Only when DevTools is open |
| (`.vite/manifest.json`, only in this audit's build) | 1 | 27 | 4 | | | |

| Total | Raw | Transferred (nginx) | brotli |
|---|---:|---:|---:|
| **Today, before the sign-in screen** (A) | 2.4 MB | **0.85 MB** | 0.60 MB |
| **Everything a normal player uses** (A + B + C + D) | 4.6 MB | **2.4 MB** | 2.0 MB |
| Everything except source maps (A to H) | 6.5 MB | 3.0 MB | 2.5 MB |
| **Literally everything in dist** | 21.9 MB | **7.9 MB** | 5.8 MB |

Notes:

- Music is synthesized (`audio/MusicEngine.ts`); nothing is downloaded for it. There are no fonts or images: icons
  and pictures are generated. Game data (systems, items, ship designs) is bundled into `main`.
- B, C and D are already fetched during a normal session. "Fetch everything at the sign-in page" would only move
  **1.6 MB** (gzip) earlier. That is small on broadband, but on a slow mobile link it would compete with `main`, so
  fetch it after the sign-in screen is up.
- Only `/assets/` gets `Cache-Control: immutable, 1y`. `sfx/` and `index.html` get heuristic caching and
  revalidation, so pre-fetched sound effects aren't reliably kept between visits.

## (b) Generated assets: what the asset cache would hold

Every kind declared with `assetKind` or `pictureSheet` (10 kinds), run for **every input a player could meet**.

- **Measured:** every generator ran on the main thread of one page, timed with `performance.now()`. Each result was
  packed with the cache's own `pack()`, so "stored" is the cache's own size accounting (deflate-raw for typed arrays of
  16 KB and up, when that saves 10% or more).
- **Frost:** measured by driving the real `FrostVignette` at the high and medium widths and capturing its PNG blobs.
- **Threads:** the "Thread in game" column says where the kind is built in the game.

| Kind | Count (inputs) | Stored | Uncompressed | CPU time (total; largest) | Thread in game |
|---|---:|---:|---:|---:|---|
| `rockAtlas` | 1 | 4.50 MB | 6.00 MB | 1,234 ms | procedural worker |
| `hullAtlas` | 1 | 2.10 MB | 6.00 MB | 557 ms | hull-atlas worker |
| `stationAtlas` | 1 | 1.43 MB | 3.00 MB | 139 ms | procedural worker |
| `skyNoise` | 1 (one tile for every system, not one per system) | 0.25 MB | 0.25 MB | 18 ms | **main** |
| `stillstoneMap` | 23 stillstones in the 20 systems (15 active, 3 scarred, 1 rough, 2 dead, 2 shattered) | 3.18 MB (0.14 each) | 11.5 MB (0.5 each) | 1,198 ms (73) | procedural worker |
| `stationBake` | 18 stations (one per station, not per design: stationId and accent are in the key) | 2.58 MB | 8.67 MB | 634 ms (163, the citadel) | procedural worker |
| `hullGeometry` | **78 designs**: see the next table | 20.1 MB | 90.2 MB | 1,477 ms (371) | hull worker |
| `itemIcons` (pictureSheet) | 737 items | 4.49 MB (data-URL strings, not compressed) | 4.49 MB | 1,122 ms | **main** |
| `partSprites` (Component Guide) | 79 guide rows | 2.79 MB (data-URL strings) | 2.79 MB | 216 ms | **main** |
| `frostTexture` | 2 (high 1024 px, medium 640 px; low draws none), **one per window aspect ratio** | 1.20 MB (PNG: 0.84 + 0.33) | 3.05 MB (as pixels) | about 150 ms (encode 145 + 7) | **main** |
| **Total** | **127 cache entries** (941 inputs, counting each icon and sprite) | **42.6 MB** | **136 MB** | **about 6.75 s** | about 1.5 s main, about 5.2 s workers |

Hull geometry by group (intact, built whole for rigid designs; the key also holds `tint` and `kind`):

| Group | Designs | Stored | Uncompressed | CPU |
|---|---:|---:|---:|---:|
| Library (player ships: Sparrow-T to Bastion Dreadnought) | 13 | 2.08 MB | 7.96 MB | 131 ms |
| Dev (`guest-sparrow-t`, annihilator) | 2 | 0.27 MB | 0.70 MB | 10 ms |
| Bosses (`boss_*`) | 10 | 1.58 MB | 3.80 MB | 46 ms |
| Giants (`giant_*`) | 7 | 1.27 MB | 5.44 MB | 109 ms |
| Siege turrets | 12 | 1.15 MB | 1.59 MB | 14 ms |
| Other enemies, including the bespoke-bodied brood_mother, pyreclast, scrap_mother and pyreclast_heart | 34 | 13.8 MB | 70.7 MB | 1,166 ms |

- **Three designs are 60 MB raw and 9.9 MB stored of the 90 and 20:** `brood_mother` (20.6 MB raw, 371 ms),
  `pyreclast` (20.1 MB) and `scrap_mother` (19.1 MB). Every other design is under 1.5 MB raw.
- **A player's own design:** about 130 KB stored and 320 KB raw (the library median), and 5 to 30 ms each.
- **Multiplicity:** the key holds the tint, so a design seen in N tints is N entries. The counts above are one tint
  each, so the real "every hull ever seen" figure is a small multiple of 20 MB.

What a real first session stores: after one guest join (Sol), Chrome's IndexedDB folder for the origin was **9.5 MB**
(the start-up atlases, the sky noise, Sol's stations and stillstones, and the hulls in view). A reload stored almost
nothing new (+12 KB).

## (c) Shaders

Measured by the `shaders` run: production build, a fresh profile (cold GPU program cache), then a reload on the same
profile (warm). The probe counted `linkProgram` calls and timed every program query.

| | Cold (first visit) | Warm (reload) |
|---|---:|---:|
| Programs linked | **34**, all behind the sign-in screen: sign-in backdrop, sky, world layers, ShipBatch, stations, lit, rocks, particles, nest, planet, bloom/pipes, and **every system's sun style** | 34 |
| Programs compiled after joining | **0** (nothing lazy was left in this session) | 0 |
| First link → last program ready (driver, in parallel via `KHR_parallel_shader_compile`, 2 in flight) | **2.8 s** (0.40 → 3.18 s from navigation) | 1.6 s (mostly pacing, not compiling) |
| Main thread blocked on program queries | **244 ms** in total (was 5.2 s before the warm-up work) | 42 ms |
| Sign-in screen up | 621 ms | 308 ms |
| Chrome's GPU program cache (`Default/GPUCache`) | 0.54 MB empty → **5.94 MB** (+5.4 MB) | +0.04 MB |

- On ANGLE/D3D11, Chrome keeps WebGL program binaries in the profile's `GPUCache`, so the game's compiled shaders
  take **about 5.4 MB** on disk, about 160 KB a program on average. The 34 KB sun shader is the biggest.
  `GrShaderCache` and the Dawn caches didn't grow: those are Chrome's own (Skia, WebGPU).
- The shader part of "compile everything at the sign-in page" **is already done**. What's left is the cold 2.8 s of
  driver work, which already happens before the player can click.

## (d) GPU memory

The probe tracked live WebGL texture storage (`texImage2D` and `texStorage2D`, mips included), buffers
(`bufferData`) and renderbuffers. Canvas back buffers aren't counted, because the browser allocates them; they are the
same whether or not anything is pre-cached.

| | Textures | Buffers | Tracked total |
|---|---:|---:|---:|
| Sign-in screen | 0.0 MB | 0.1 MB | 0.1 MB |
| 15 s after a guest join (Sol), cold run | 24.4 MB (21 textures; biggest 8 MB, the rock atlas with mips) | 4.8 MB | **29.2 MB** (peak) |
| Same, warm run | 17.0 MB | 4.8 MB | 21.8 MB |
| **Everything resident at once** (estimate from (b)): the atlases with mips (about 20 MB), all 23 stillstones (11.5), all 18 station bakes (8.7), every hull design's geometry (90), render targets (about 10) | | | **about 140 MB** |
| The main canvas back buffer (estimate: 1424×749, MSAA 4×, depth and stencil) | | | about 25 to 45 MB more; about 4× that at DPR 2 |

- Pre-caching doesn't make anything resident. The cache holds bytes in IndexedDB, and textures and buffers are
  uploaded only when something is drawn. A typical session stays at about 20 to 30 MB, plus the back buffer.
- The "everything" figure is a ceiling that no real scene reaches: it would need every boss and giant on screen at
  once, in every system.

## (e) Totals

| | Today (before sign-in) | Normal player, everything | Literally everything |
|---|---:|---:|---:|
| Download (transferred, nginx gzip) | **0.85 MB** | **2.4 MB** | 7.9 MB (3.0 MB without source maps) |
| Download (raw) | 2.4 MB | 4.6 MB | 21.9 MB |
| Asset cache (IndexedDB, stored) | 0 (9.5 MB after the first join) | about 43 MB (every input, one tint each) | about 43 MB plus tints, window sizes and stillstone states |
| Asset cache (uncompressed) | | 136 MB | |
| Generation CPU (this machine; laptop ×2.5 to 4) | | **about 6.75 s** (about 1.5 s main, 5.2 s workers); laptop about 17 to 27 s | |
| GPU program cache | 5.4 MB (already built at the sign-in screen today) | 5.4 MB | 5.4 MB |
| Shader compile, cold | 2.8 s of driver time, 0.24 s main thread (already done at the sign-in screen today) | same | same |
| GPU memory | 0.1 MB at sign-in; about 22 to 29 MB in game | about 22 to 29 MB in game (pre-caching adds nothing) | about 140 MB if everything were drawn at once |
| HTTP cache | | about 4.6 MB raw on disk | |
| **Disk in all** | | **about 53 MB** (HTTP cache 4.6 + IndexedDB 43 + GPU cache 5.4) | |

## (f) Browser quotas, and whether 256 MB is enough

- **Chrome and Edge:** an origin may use up to about 60% of the disk. Storage is "best effort": under disk pressure,
  whole origins are evicted, least recently used first, unless `navigator.storage.persist()` was granted (Chrome
  grants it from site engagement or an installed app, without asking). Incognito storage is in memory, with a small
  quota, and dropped at the end.
- **Firefox:** best-effort storage is limited per site (eTLD+1) to 10% of the disk or 10 GiB, whichever is smaller,
  and in all to 50% of the disk; past that, least recently used origins are evicted. `persist()` asks the user. Private
  windows now allow IndexedDB, but it's temporary.
- **Safari 17+:** up to about 60% of the disk per origin in the browser, but Intelligent Tracking Prevention **deletes
  all script-writable storage of a site the user hasn't interacted with in 7 days of Safari use**. Home-screen web apps
  are exempt. A Safari player who returns weekly will often rebuild everything.
- **The 256 MB budget is plenty.** The whole game is about 43 MB, about 17% of it, and the biggest single entry is
  4.7 MB, against the 64 MB per-entry cap. The budget would only matter after many version bumps; those are cleared by
  `trim`, so they don't pile up. The real risk to a pre-cache is **eviction** (Safari's 7 days, disk pressure), not the
  quota. Calling `navigator.storage.persist()` after sign-in would protect it in Chrome; Firefox would prompt.
- `sizeOf` counts strings at 2 bytes a character, so the icon and sprite sheets (data URLs) are counted at about twice
  their real size on disk (V8 serializes Latin-1 strings at 1 byte). Chrome's IndexedDB also compresses values with
  snappy, so disk use is a little below the "stored" figures.

## Recommendation

**Worth doing, in this order, after the sign-in screen is up:**

1. **Shaders: already done.** The warm-up compiles all 34 programs behind the sign-in screen. Keep adding new programs
   to `gameShaders.ts`; that is the biggest win, and it's in place.
2. **Start the start-up atlases at the sign-in page, not at join.** That means the rock, hull and station atlases and
   the sky noise. This is 1.9 s of worker CPU here (about 5 to 8 s on a laptop) and 8.3 MB stored, needed by every
   player within seconds of joining. On a first visit, the player is usually on the sign-in screen for longer than
   that. It only helps the first visit, and after a version bump.
3. **Fetch the join-time chunks and sound effects in idle time on the sign-in page.** These are categories B, C and D:
   1.6 MB transferred, which every player downloads anyway. Before that, give `sfx/` a long `Cache-Control`, or move
   them under `/assets/` with hashed names, so they stay cached.
4. **Build the hull geometry the player will see first**, at idle, in the hull worker: the 13 library designs, the
   guest Sparrow and the player's own designs. That is about 2.3 MB stored and 0.15 s.
5. **Warm the likely-next systems only:** the spawn or last system and its jump neighbours. For each of those, build
   its stillstones (about 50 ms each), its station bakes (10 to 160 ms each) and its enemies' hulls. Do it in worker
   idle time with a low priority, after 2 to 4, and stop the moment the player joins: a join must not queue behind it.

**Not worth doing:**

- **Every hull design.** That is 20 MB stored and 1.5 s, half of it in three bespoke giants (brood_mother, pyreclast,
  scrap_mother) that most sessions never meet, and each tint is a separate entry. Build them when a ship first comes
  near, as today.
- **Item icons and Component Guide sprites up front.** That is 1.3 s on the **main thread** (about 3 to 5 s on a
  laptop) for screens a player opens later, if ever. They're already kept once drawn. If anything, draw them in
  `requestIdleCallback` slices when the hangar or market first opens.
- **Frost textures.** They are only needed in cold systems, the entry depends on the window's aspect ratio (a resize
  makes a new one) and the draw is cheap (about 150 ms).
- **Stillstones and station bakes for all 20 systems.** That is 1.8 s and 5.8 MB for places a player may visit days
  later. On Safari they will probably have been evicted by then.
- **Developer chunks:** proto, replays, sandbox, admin and contributor panels (1.9 MB raw, 0.6 MB transferred), the
  WebGPU and Canvas fallbacks, and source maps (5 MB transferred). A normal player should never fetch them.
- **Anything for GPU memory.** Pre-caching fills disk, not VRAM. Uploading everything ahead of time would multiply GPU
  use by about 5 (to about 140 MB) for nothing.

**Cost and benefit in one line.** Pre-caching "everything" costs 2.4 MB of network, about 50 MB of disk and 7 to 27 s
of CPU. It buys at most about 2 s on a laptop's first join (the atlases) plus the occasional 50 to 370 ms worker build
later. That first-join part is items 2 to 4 above; the rest is better left to build on demand, as it does today.
