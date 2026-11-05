# Space Game — Vision & End Goal

*What we're building, why, and where it's headed.*

---

## The One-Liner

A persistent, multiplayer 2D space game: fly your ship through a living galaxy of star
systems, mine asteroids, fight, trade at stations, take quests — and explore a universe
that is entirely **data-driven**, so the world itself is content we can design, edit, and
expand without touching engine code.

---

## The End Goal

The destination is a **hosted, persistent galaxy** that players log into and keep playing
across sessions, built on three pillars:

### 1. A real game loop that is fun on its own

The core loop, inherited and refined from v1:

```
fly → mine asteroids → dock at a station → sell ore / buy gear
  → upgrade weapons, booster, cockpit → take quests from NPCs
  → fight enemies → jump through a portal → repeat in a new system
```

- **Flight** that feels good: acceleration, friction, boost with fuel, warp boost.
- **Combat**: left/right hardpoint lasers, charge shots, mines, enemy AI, HP/regen.
- **Progression**: XP/levels, item rarities (mk1/mk2/mk3 → common → legendary),
  equipment slots (weapons, booster, cockpit), a 10-slot inventory + 50-slot bank.
- **Economy & quests**: stations to trade at, NPCs with dialogue, quest chains.
- **Persistence**: accounts, inventory, quests, and progress survive logout —
  the galaxy remembers you.

### 2. A universe that is data, not code

Every star system is defined by data (`data/systems.json`), not hardcoded:

- **Central bodies** — suns (or other detail elements) with full shader parameters:
  fBM brownian motion, plasma turbulence, limb darkening, custom color palettes,
  glow. Sol is a hand-tuned "detail star"; other systems can be ice dwarfs,
  red giants, exotic cores.
- **Sectors** — systems are grouped into named sectors (`core`, and more to come),
  which is how the galaxy grows: new sectors, new identities, new difficulty tiers.
- **Portals** — the graph edges connecting systems into an explorable network.
- **Belts, stations, NPCs, enemies, hazards** — all declared per system.

The **sandbox editor** (`dev-tools/`) is the content pipeline: design a star with the
element library, tweak shader params live, save as `.sgsys` / `.sguniverse`, and
eventually export straight into `systems.json`. The person designing the universe
should never need to read the renderer.

The client renders whatever the server tells it (`systemInfo` message) — visuals,
map, and world layout all flow from the same data. **One source of truth.**

### 3. Architecture that scales from laptop to VPS

- **Server-authoritative simulation** at 60Hz with client prediction and
  interpolation — cheat-resistant and smooth.
- **Shared code** (`common/`): one ECS, one physics/orbit math, one protocol used by
  both client and server. No drift between what the client predicts and the server
  confirms.
- **Local-first development**: everything runs on one machine with zero external
  services. Accounts use a pluggable `UserStore` — JSON files today, PostgreSQL
  tomorrow via the identical interface (`server/schema.sql` is already written).
- **Deploy-ready**: the same codebase runs on Fly.io / a VPS when it's time to go
  public. Flipping `USER_STORE_BACKEND=postgres` + `DATABASE_URL` is the whole
  migration.

---

## Where We Are Now

✅ **Working today:**
- Full gameplay loop skeleton: flight, mining, lasers, enemies, docking, trading,
  inventory/bank, quests, XP/levels
- 4 systems in the `core` sector, portal-connected, all data-driven
- GPU-rendered universe: procedural starfield, fBM detail stars, glow, corona
  rays, nebulae
- In-game system map (M key) rendered from the same data the server sends
- Account system (JSON store, PostgreSQL-ready), admin dashboard
- Server browser / lobby, sandbox editor with element library

🔜 **Next:**
- **Sector expansion** — grow from 1 sector / 4 systems to multiple unique sectors
  (each with its own visual identity, difficulty curve, and story flavor)
- **Editor → game pipeline** — export sandbox universes directly into `systems.json`
- **PostgreSQL launch** — host on a VPS, migrate accounts, open the galaxy up

---

## The Feel We're Chasing

- **Alive**: stars churn with plasma, belts drift on real orbits, the starfield has
  parallax depth. The galaxy should feel like a place, not a backdrop.
- **Handcrafted at scale**: procedural techniques (noise, shaders) in service of
  *authored* worlds — every system is designed, the tools just make designing fast.
- **Honest engineering**: shared simulation, data over code, local-first with a
  clean path to production. No magic, no lock-in.

---

## Non-Goals

- No 3D — the 2D top-down view is the game's identity.
- No pay-to-win or account-linking services; accounts are ours, on our infra.
- No procedural-only galaxy — sectors and systems are designed, not generated.

---

*See `DEVELOPMENT.md` for how to run it, `MIGRATION_CATALOG.md` for the v1 feature
reference, and `data/systems.json` for the current universe.*
