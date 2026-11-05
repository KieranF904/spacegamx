# Agent rules for game-v2

## Orient
- Read `DEVELOPMENT.md` (the router), then only your area's guide in `docs/areas/<slug>.md`. Each folder with a
  `CONTEXT.md` points at its guide. Do not read other areas "just in case".
- Never open the god-files whole: `server/src/GameServer.ts`,
  `client/src/Game.ts`, `client/src/rendering/Renderer.ts`, `client/src/ships/HangarUI.ts`,
  `common/src/network/protocol.ts`, `client/src/sandbox.ts`. Grep the name, or read the line range the guide gives.
- Line numbers in docs drift; grep the banner text or symbol.

## Rules of the code
- `common/` is shared and deterministic (no `Date.now`, no `Math.random`, no client/server imports).
- Part models are generated: edit `scripts/econ/models.mjs`, run `node scripts/econ/models.mjs`; do not hand-edit
  `data/ships/models.json`.
- Protocol: after adding a model/material/piece run `npm run wire:sync`; after any wire change run
  `npm run wire:bump "reason"`. Never edit `wire-dictionary.json` by hand.
- Panels (before/after images): add an entry file in `docs/panels/entries/`, then `npm run panels:index`. Never edit
  `docs/panels/index.md` by hand.
- Lore: every lore claim needs an owner in the game (a person, record or source); narration never states contested
  lore as fact. Check against `docs/lore-canon.md`.
- New boss: `docs/boss-design.md`. Stills: `npm run render` (native, no browser).

## Tests
- Run from the `game-v2/` root config (it includes client tests): `npx vitest run <path>`. Run the tests for your
  area (the guide lists them), not the whole suite, unless asked.

## Processes
- One headless browser per agent at a time, always closed afterwards (by PID). Do not run tests alongside a browser run.
- Kill only what you started, by PID. Never kill the user's Chrome or dev servers you did not start.

## Git and deploys
- Never `git checkout`, `restore`, `stash`, `reset` or `clean`: other agents' uncommitted work may be in the tree.
- Do not commit, push or deploy unless asked. The VPS is shared; do not touch other projects on it.
