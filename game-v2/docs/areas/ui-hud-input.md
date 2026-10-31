# UI, HUD & input
The client's player-facing shell: `Game.ts` (the orchestrator: builds every window and HUD piece, routes keys, switches on server messages, sends the per-tick input), the DOM windows and HUD under `client/src/ui/`, input translation and rebinding under `client/src/input/`, saved player settings, and lazy-loaded screens. Hangar editing UI is a separate area (`hangar-ui`); rendering is `render-world`/`render-ships`. Everything here is plain DOM + CSS strings injected at runtime (no framework).

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| `client/src/Game.ts` | 2505 | God-file. See "Game.ts map" below. Read slices only |
| `client/src/lazy.ts` | 40 | `Lazy<T>` (dynamic-import wrapper: `.value`, `.load()`, `.use(fn)`), `prefetchIdle(loads)` |
| `ui/windowKit.ts` | 429 | `GameWindow` (veil + head + tabs + body, `open/close/onClose`, swallows keys except Esc), `showTip/hideTip`, `openMenu/closeMenu`, `itemTipHtml`, `partStatsHtml`, `costHtml`, `ItemGrid`, filters/sort |
| `ui/PilotHud.ts` | 182 | `PilotHud` (bars, level, credits) and `ToastUI` |
| `ui/QuickBar.ts`, `CargoPanelUI.ts` | 271 (cargo) | Quick-bar slots 1-5; the cargo panel on the HUD |
| `ui/CircuitBars.ts`, `DodgeIndicator.ts` (ready/cooldown ring, LOW POWER, ways it can't dodge), `TowIndicator.ts`, `FrostVignette.ts` | 100-255 each | Per-feature HUD chips driven by `ShipDerived`/snapshot extras |
| `ui/StationWindow.ts` | 1444 | Station tabs (lazy chunk). Economy area owns content; god-file |
| `ui/InventoryWindow.ts`, `TradeWindow.ts`, `QuestUI.ts` (835), `SocialUI.ts` (319) | 200-835 | Cargo/storage window (I), player trade, jobs+skills log (L/K) and tracker, party/friends (P) |
| `ui/SystemMapUI.ts` | 1885 | Galaxy/system map (M), autopilot clicks. God-file |
| `ui/GameMenuUI.ts` | 687 | Esc menu: settings tabs (audio, display, ui, gameplay), key rebinding, field guide host |
| `ui/fieldGuide.ts` (+`GuideUI.ts`, `ComponentGuideUI.ts`, `componentGuide.ts`) | 555 | In-game guide tabs (pure `guideHtml`, tested); component guide (C, lazy) |
| `ui/Tutorial.ts` | 255 | 10-step tour; done flag in localStorage; step text built per step from `boundKeyName()` |
| `ui/ContextMenuUI.ts`, `ContextActionUI.ts` | 241 | The Z + right-click action menu (rendering only) |
| `ui/PerfMonitor.ts` | 355 | FPS/frame breakdown overlay |
| `ui/LoginUI.ts`, `loginBody.ts`, `ServerBrowserUI.ts` | 706/164/613 | Sign-in screen, rotating Sol body picker (pure, tested), lobby server list |
| `ui/AdminPanel.ts`, `ContributorPanel.ts`, `AdminGive.ts`, `DebugUI.ts`, `RenderTuningPanel.ts`, `DevShipPanel.ts` | | Admin/contributor/dev tools (by rank, or dev builds) |
| `ui/domWrite.ts` | | `setText/setHtml/...`: DOM writes that skip when unchanged. Use in per-frame code |
| `input/keybindings.ts` | | Declarative `ACTIONS: ActionDef[]` (id, label, category, default `key`, `alt`, `hint`, `rebindable:false`), `RESERVED_KEYS`, `keyName()`, `boundKeyName(actionId, bindings)` |
| `input/InputManager.ts` | 223 | Keyboard/mouse/wheel; translates a bound key to the action's default code; `raw` mode (hangar/menu); `onKeyPressed`, `onMouseButton`, `onCapture`, zoom |
| `input/contextClick.ts` (+test), `ContextActions.ts` | 327 / 703 | Pure menu logic (`targetOptions`, `openSpaceOptions`, `jumpStep`, `placeMenu`) and the stateful executor (`ContextActions`, `ContextHost`) |
| `settings/Settings.ts`, `quality.ts` | | `settings` singleton (localStorage, `subscribe`, `update`, `reset`), `SettingsData`; quality tiers (tested) |
| `docs/ux/` | | `polish-pass-2026-10-31.md` (+ screenshots in `polish-2026-10-31/`): usability findings and proposals |

### Game.ts map (2505 lines; open only the slice you need)
| lines | section |
|---|---|
| 1-312 | imports, `ProtoHooks`, `GameOptions`, field declarations (windows are `Lazy<>` or direct) |
| 313-398 | `constructor` |
| 399-710 | `init()`: window/HUD construction (about 436-665: `new InventoryWindow`, `QuickBar`, `TradeWindow`, `SystemMapUI`, lazy `StationWindow`/`ComponentGuideUI`, ...), callbacks, `input.onKeyPressed = handleKeyPress` (690) |
| 711-806 | login/register/guest/server-select/logout; `prefetchScreens` (727, `prefetchIdle` of the lazy chunks) |
| 807-1074 | `start`, `createMenu` (814), sounds, zone, `applySettings` (995), heat gauge |
| 1075-1214 | `handleKeyPress(code)`: ordered key routing (modal windows first, then global keys) |
| 1215-1293 | objective/guide, autopilot helpers |
| 1294-1477 | `update()` per frame; 1478-1688 `tickInput()` builds and sends the input message; 1689 `sendNeutralInput` |
| 1722-2121 | `handleServerMessage`: one big `switch (msg.type)` (after `shipClient.handleMessage`); 2123-2197 chat |
| 2198-2325 | connect/disconnect/auth result; 2358-2425 admin and contributor panel start/stop; 2426+ `updateUI`, quality, resize |

## Public interface
- `GameWindow` (windowKit): subclass or compose; `open()/close()/isOpen/onClose`; fill `body`, `tabs`, `headExtra`.
- `ACTIONS` + `boundKeyName(id, bindings)`: any key hint text must use this, never a literal letter.
- `settings.data`, `settings.subscribe(fn)` (calls fn immediately), `settings.update(fn)`.
- `Lazy<T>.use(fn)` / `.value` for screens split into their own chunk.
- UI classes take `send: (m) => void` and `sound(id, v?)` callbacks in their constructor; they do not touch `network` or `audio` directly.
- Server messages reach UI only through the `handleServerMessage` switch (one case per `ServerMessage.type`, defined in common `network/protocol.ts`; see `networking`).

## Invariants
- Game logic listens for each action's DEFAULT code; `InputManager` translates rebinds. Never compare against a player's custom key; never hard-code a key letter in text.
- Windows own the keyboard when open: `GameWindow` stops key propagation (except Esc); `handleKeyPress` closes windows on Esc/their key in a fixed order (menu, dialogue, component guide, inventory, trade, social, quest log, station ...). A new window must be added to that chain.
- Fixed keys (not rebindable): Esc, Enter, mouse, wheel (`rebindable:false`, `RESERVED_KEYS`). Map-internal keys (C follows the ship) are not bindings.
- Per-frame DOM updates go through `domWrite` (`setText/setHtml`) to avoid restyle.
- localStorage reads are wrapped in try/catch (private windows); settings and the tutorial flag already are.
- The client build fails if `server/src` code lands in the start-up chunk (`serverOutOfMain` in `client/vite.config.ts`); import server code lazily.
- Keep pure logic (menu options, guide HTML, login body choice, quality) in testable pure modules; DOM classes stay thin.

## How to extend
1. **Add a keybinding**: add an `ActionDef` to `ACTIONS` (`input/keybindings.ts`) with a default `key`; handle `code === '<default>'` in `Game.handleKeyPress` (1075-1214) or read the key in `tickInput` (1478); show it via `boundKeyName`. The rebinding UI iterates `ACTIONS`, so it appears automatically.
2. **Add a window**: extend/compose `GameWindow` in `ui/<Name>.ts`; construct in `Game.init` (436-665) passing `send`/`sound`; if heavy, wrap in `new Lazy(() => import('./ui/<Name>')...)` and add to `prefetchScreens` (727); add its Esc/toggle case to `handleKeyPress`.
3. **Add a HUD chip**: new small class in `ui/` (model: `DodgeIndicator.ts`, `CircuitBars.ts`) with an `update()` using `setText`; construct in `init`, call from `updateUI` (2426) or `update`; if toggleable add a field to `SettingsData` + `defaultSettings()` and a row in GameMenuUI's tab.
4. **Handle a new server message**: add a `case` in `handleServerMessage` (1722-2121) calling a UI method; the type must exist in common protocol (`networking`).
5. **Add a setting**: `SettingsData` + `defaultSettings()` in `settings/Settings.ts` (the loader merges saved data over defaults, so old saves are fine), a row in `GameMenuUI`, apply in `Game.applySettings` (995).
6. **Add a context-menu action**: pure options in `input/contextClick.ts` (`targetOptions`/`openSpaceOptions`, extend `ActionId`), execution in `ContextActions.pick`, tests in `contextClick.test.ts`.
7. **Add a tutorial step / guide page**: the `Step` list in `Tutorial.ts` (use `boundKeyName`); guide tab in `fieldGuide.ts` (`guideHtml`) with its test.

## Tests
- Whole repo (includes client tests): `npx vitest run` from `game-v2/`.
- Client area only: `npx vitest run client/src/ui client/src/input client/src/settings`.
- Client vitest alone (`cd client && npx vitest`) stubs `fs`; run from the root when a test imports server/common code.
- Typecheck: `cd client && npx tsc --noEmit`. Build check (enforces `serverOutOfMain`): `npm run build:client`.
- Visual checks: method in `docs/ux/polish-pass-2026-10-31.md` (Vite 5273 + server 3000, `scripts/boss-shots/shoot.mjs`; one headless browser per agent, see `ops-tools`).

## Gotchas
- Key hints that wrote default letters went stale on rebind (fixed across Tutorial, death screen, QuestUI, SocialUI; see the polish pass). Don't reintroduce.
- Vite node stubs: `fs|path|os|url|zlib` resolve to `client/src/nodeStubs.ts` in the browser, so server code pulled into the sandbox/replays can't do real I/O.
- `handleKeyPress` order matters: a window early in the chain returns and swallows keys meant for later ones (C is ignored on the map; Esc priority).
- `SystemMapUI` (1885) and `StationWindow` (1444) are big; grep for the tab/section name, don't open whole.
- Guests: `handleGuestPlay` (Game.ts 765) makes `Guest_<0-9999>` client-side; the server decides rights (guests are admins on dev servers).
- Proto mode (`?proto`, `ProtoHooks`) skips some windows (`if (!this.proto)`); keep both paths working.

## Related areas
`hangar-ui` (HangarUI, component guide shared), `economy-quests` (Station/Trade/Quest content), `networking` (messages), `energy` (CircuitBars), `render-world` (Renderer, quality), `web-accounts` (LoginUI/ServerBrowserUI talk to the lobby), `flight` (input bundle), `ops-tools` (screenshot tools). Links: `docs/areas/<slug>.md`.

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Escape menu** (`ui/GameMenuUI.ts`): Resume, galaxy map, Pilot & ship (live readout of level, credits, core, mass, speed, turn rate, power, guns, jump drive; a dock button inside a docking ring), Field guide, Settings (Audio, Display, Interface, Gameplay), Controls (every action rebindable; binding a used key swaps the two), Server (ping, jitter, pilots in system, copy address), Leave server and Log out (both confirm). Esc steps back a page, then closes; flight input is off while open, the sim keeps running.
- **Settings** (`client/src/settings/Settings.ts`): one object in localStorage (`spacegame.settings.v1`) merged over defaults; `Game.applySettings` pushes it into audio, renderer (shake scale, planets, minimap, damage numbers, names), ship client (schematic, jump screen effects, default control mode), hazard overlay, nav markers, net stats, chat and zoom. Gameplay adds tap or hold for the jump key.
- **Rebinding** (`input/keybindings.ts`): every action with its default key and always-on alternates (arrows, right Shift). Game code still listens for the default codes; `InputManager.setBindings` translates the bound key into the default, and an action's default key does nothing once moved. `InputManager.raw` (hangar, menu) turns translation off. HUD hints show bound keys (keep them dynamic; do not write default letters).
- **System map (M)** (`ui/SystemMapUI.ts`): full screen, zoom/pan, opens on the system view; galaxy view (systems, sectors, gate links, rift routes, hover cards, a ship pin on your system) and a live system view (planets with moons and rings, wrecks, hover cards); you are a pulsing beacon with heading and velocity, an edge arrow when panned away, C centres on you. Clicking warps through `devTeleport`, honoured by the server only with `devTeleport` on (dev, proto) or for admins. `locked` draws a padlock and "needed" hint for restricted sectors; siege moons are labelled and clickable and threat-coloured.
- **Nav markers (N)** (`ui/NavMarkersUI.ts`): edge-of-screen chevrons on off-screen stations, gates, rifts, planets, wrecks and quest objectives, with distances, kept clear of each other and the HUD panels (measured 4x a second).
- **Audio** (`client/src/audio/`): synthesised, no files required: `sfx.ts` renders 21 effects at startup, each a small Web Audio graph in an `OfflineAudioContext` (shots, impacts, hull hits, explosions, jump phases, warp, dock, credits, level-up, alarms, UI ticks, engine and boost loops). `AudioManager` starts on the first click/key, positions and pans by world position, caps voices per sound, master -> compressor with separate effects and music buses. Generated files (`npm run gen:sfx`, see ops-tools) are loaded first and prepared (lead-in trimmed, loudness matched, loops crossfaded, per-effect `FILE_GAIN`/`FILE_PITCH`/`FILE_REVERB`); anything without a file falls back to its synth recipe. Hooks: each new projectile plays a shot (max four per frame), `projectileHit` an impact, hull hits a thump, debris/core loss explosions, `JumpFx.onPhase`, docking, refits, gates, rifts, credits, level-ups, map and menu, the event-horizon alarm; engine/boost loops follow thrust and speed. **Music** (`MusicEngine.ts`): generative per-system mood (root, scale, progression, tempo, timbre), slow detuned pads over a drone, bells through feedback echo and synthesised reverb, a combat layer fades in when firing or hit, new systems crossfade at the next bar.
- **Admin tools**: admin accounts (lobby) or everyone on proto servers get the panel `ui/AdminPanel.ts` (F2; F3 teleport to cursor; F4 free camera). Tabs: Me (god mode, hidden, free camera, repair, credits, XP, skill points, any item, teleports), Players (go to, bring, watch, repair, god, hide, credits, XP, send, destroy, kick), World (spawn faction/ship, bosses at lairs, destroy/remove hostiles, clear loot, raid or salvage field, announce), Server (tick time, memory, bandwidth by message, prediction, recent errors). Everything is a server command in `server/src/game/AdminTools.ts` (`{ type: 'admin', cmd, args }`, answered by `adminResult`, refused for non-admins, logged as `[admin] name: cmd args`); the same commands work from chat (`/help`: `/tp /goto /bring /god /hide /heal /kill /boot /credits /xp /give /skillpoints /spawn /boss /clear /clearpods /event /announce /who`; players by username prefix or `#id`). God mode is `ShipHost.invulnerable`; hidden pilots are left out of hostile and boss target lists.
- **Other UI facts**: `ui/HazardOverlay.ts` (haze, darkness, radiation, cold, event-horizon alert), `ui/FrostVignette.ts`, `ui/BossUI.ts`, `ui/SiegePanel.ts`, `ui/ObjectiveBanner.ts`, `ui/DialogueUI.ts`, `ui/PeopleUI.ts` (see the world-sim, bosses-ai and economy-quests notes); a "Talk to ..." prompt shows near a person's ship. Respawn: R sends `respawn`; the server accepts once the entity is gone and `welcome` clears the death screen.
