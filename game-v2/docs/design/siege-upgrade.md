# Moon siege upgrade (2026-11-04)

Kieran: "upgrading the siege minigames. Make them graphically better and more compelling, interactive, more
challenging and whatever else you can think of."

This is the plan: what the loop is now, what's weak, and a prioritized list that can be built tonight in about two
hours of agent time (several lanes at once). Server authority stays: the client draws and asks; Sieges decides.

Code read: `server/src/game/Sieges.ts` (1001 lines, rules + profiles + run loop), `server/src/GameServer.ts`
`createSiegeHost` (turret controller, hostile spawning), `server/src/game/Surfaces.ts` (descend), `client/src/ui/SiegePanel.ts`,
`client/src/rendering/surface/BastionView.ts`, `surfaceLooks.ts`, `Renderer.setNight`, the `siege` / `siegeState` /
`objective` messages in `common/src/network/protocol.ts`, `sieges.test.ts`, `siegeProfiles.test.ts`, `data/rules.json`
`sieges`, `data/systems.json` bastions.

BEFORE panels (live dev game, Selene night 1): `docs/panels/2026-11-04/gameplay/siege-{day,panel,night,lane,combat}-before.png`.
They are reproduced with `node scripts/boss-shots/siege-steps.mjs > steps.json` and
`node scripts/boss-shots/shoot.mjs http://localhost:5273/ <out> @steps.json` (same framings for the AFTER shots).

## 1. The loop now

- **Enter:** X over a siege moon (Selene I, Rimeholt II, Cinderhold III, Gloam IV, Last Light V). A pilot or party gets
  its own copy with the bastion (a pinned ward ship) on a crater platform with 6-9 turret pads.
- **Day:** a side panel. Spend party supplies (start 150) on: patch everything +30% (60), build a cannon / flak / laser /
  missile turret (100-170) on **the first free pad**, upgrade (marks I-III), scrap for half. Free refit. Everyone clicks
  Ready, or claims the haul and leaves. No time limit.
- **Dusk:** 6 s of failing light (`night` 0..1 on the `objective` banner dims ambient and sun).
- **Night:** the night's budget (grows with night², party size, profile difficulty) is spent on the roster, leaning on
  the newest kinds; split into fronts (one more every few nights) plus a trickle stream. Each front shows a WarpIn
  "warning" 4 s before it lands at the profile's approach (ring, lanes, arc, pincer). Every ship is `sendPack`ed at the
  bastion and then fights with its faction's ordinary AI (aggro/range; lobbers get long range). A boss every 4th-5th
  night. One objective at a time out on the moon (hold a supply drop, burn a nest). Turrets shoot the nearest hostile
  in range.
- **Dawn:** when nothing is left. Toast: "+supplies, +credits to your haul". Haul is paid on claim by day
  (+25% per five nights) or half otherwise. Bastion destroyed: everyone to orbit, half haul.

## 2. What's weak

Seen in play and in code:

1. **The night is passive.** The pilot is one more gun. Nothing the pilot does at night is siege-specific: no
   turret orders, no repairs under fire, no abilities, no way to rebuild a lost turret until dawn.
2. **Building has no decisions about where.** `buy` puts the turret on the first free pad, even though every profile
   is about direction (Selene's three lanes, Rimeholt's north arc, Last Light's pincer). Pad placement should be
   the main day decision and it isn't one.
3. **Every enemy does the same thing:** fly at the bastion and fight whatever is near. Only lobbers (range) and
   swarmers (groups) differ. Nothing goes for turrets, nothing ignores pilots to dive the bastion, nothing escorts
   or shields. Profiles differ by who comes and from where, not by how they fight.
4. **Hard to read.** No sign of where fronts will land beyond a 4 s WarpIn flash that is usually off screen; no
   edge arrows; no turret range shown; the bastion's hull is a small meter in the objective banner; turret damage
   only shows in the day panel; in the dark, hostiles are just headlights.
5. **No feedback or arc.** Dawn is one toast. No score, no per-pilot kills, no "perfect night", no streak, no summary,
   no best night. Nights 1-4 feel the same. The haul number is the only progress.
6. **Failure is all or nothing.** A lost turret just frees its pad. The bastion's hull dropping changes nothing until
   it reaches zero. There is no warning state or comeback mechanic.
7. **Graphics:** the platform (BastionView) is flat lit geometry, good by day and almost invisible at night apart
   from pad lamps. Night is a uniform dimming: no colour change at dusk, no dawn moment. No approach paths on the
   ground, no beacon, no damage state on the bastion or the pads.
8. **Code shape:** Sieges.ts holds rules, profiles, planning, objectives, shop and messages in one file. New
   objectives or enemy behaviours would mean more branches in it. The turret controller lives in GameServer.

## 3. Shape of the change (modular layout)

Split before adding (one small refactor commit; tests unchanged):

```
server/src/game/sieges/
  Sieges.ts          run loop: phases, enter/leave/claim, messages (what's left of today's file)
  rules.ts           SiegeRules, DEFAULT_SIEGE_RULES, SIEGE_STRINGS (moved as is)
  plan.ts            wavePlan, waveRoster, siegeBoss, night split into fronts
  shop.ts            buy (on a pad), upgrade, scrap, repair, emergency build
  score.ts           per-night tally, streak, summary
  roles/             enemy roles: one file each, registry index.ts   { id, onSpawn(host, eid, run) , step?(...) }
  objectives/        cache.ts, nest.ts (moved), registry index.ts     { id, start, step, end }
  modifiers/         night modifiers, registry                          { id, apply(run), clear(run) }
  abilities/         party abilities, registry                          { id, cost, cooldown, fire(run, conn) }
```

- Profiles name what they use by id (`roster[].role`, `objectives.kinds`, `modifiers`), so a new kind is one file plus
  a data entry. No `if (kind === ...)` in Sieges.ts or GameServer.
- GameServer only grows `SiegeHost` entries: `onDestroyed(eid, by)` forwarded from the existing
  `onShipDestroyed(eid, lastHitBy)`, `retarget(eid, at)`, and the turret controller taking an `orders()` callback.
  The controller moves into `sieges/turretBrain.ts` (built from host primitives), out of GameServer.
- Client: `client/src/ui/siege/` (SiegePanel, NightHud, DawnCard) and `client/src/rendering/surface/siege/`
  (BastionView and its overlays). `serverMessages.ts` only routes.
- Protocol: add optional fields to the existing `siegeState` and `siege` messages (below); one `npm run wire:bump`.

## 4. Prioritized build list (tonight, ~2 h of agent time)

Effort: S under 20 min, M 20-40 min, L 40+ min. Lanes: **srv** (sieges/ folder), **ui** (siege panel, HUD),
**gfx** (surface/siege rendering). P1 items are the build; P2 if time is left; P3 later.

### P1: the build

| # | What | Lane | Effort | Notes |
|---|------|------|--------|-------|
| 0 | Split Sieges.ts into `sieges/` as above, no behaviour change | srv | S | first, so the other srv items land in their own files |
| 1 | **Build on the pad you pick.** `buy` honours `pad` (already in `ClientSiegeMessage`); the panel lists pads with a build menu on empty ones; clicking a pad on the ground by day selects it | srv+ui | S | no protocol change |
| 2 | **Incoming fronts and night HUD.** `siegeState.incoming: [{ x, y, in, boss? }]` (fronts already planned with `at`; positions picked when they're 4 s out, pick them at planning instead). Client: edge-of-screen arrows with a countdown, a ground beacon (red light pillar + growing ring) where a front will land, a big bastion hull bar top-centre at night, hostiles left | srv+ui+gfx | M | positions are chosen at night start so the warning can be 15 s, not 4 |
| 3 | **Wave announcement.** At dusk, a centred title card: "Night 6", the profile name, boss and modifier if any, what's new tonight (`siegeState.tonight: { night, boss?, modifier?, newKinds: string[] }`) | srv+ui | S | newKinds = roster entries whose `from` is tonight |
| 4 | **Score, perfect nights, streak, dawn summary.** Server tallies per night: kills by each pilot and by the turrets (`onDestroyed` attribution), objectives, bastion hull lost, turrets lost. Perfect night = no turret lost and the bastion above 90%: streak +1, dawn supplies +10% per streak step (cap +50%). `siegeState.summary` at dawn; client DawnCard (kills, your kills, MVP turret, hull lost, supplies, streak, next night's boss/modifier). Best night per moon in the pilot's save | srv+ui | M | score = kill value + objectives + hull kept; feeds the haul a little so it matters |
| 5 | **Enemy roles.** `roster[].role`: `sapper` (sent at the nearest turret, not the bastion; switches when it dies), `runner` (aggro 0: ignores pilots and dives the bastion, fast designs only), `artillery` (today's lobber tuning, as a role), `escort` (follows the biggest ship in its front). Data: Selene gets swarmer=runner from night 3, crawler=sapper from night 4; Rimeholt bulwarks escort; Cinderhold zealots run; Last Light lurkers sap | srv | M | uses existing `sendPack`/`tune`; runner and sapper make turret placement and pilot positioning matter |
| 6 | **Turret orders and focus fire.** Per pad target priority: nearest (today) / toughest / fastest / boss first (`siege` action `orders`, `item` = priority). At night, a pilot can mark their current target: turrets in range focus it for 8 s, 20 s party cooldown (action `focus`, `target`) | srv+ui | M | protocol: two actions added to the union and `target?`. The controller reads `orders()` |
| 7 | **Repairs under fire and emergency builds.** At night, hold within 160 of a damaged turret's pad for 3 s: +15% hull for 20 supplies (a ring fills on the pad). Build on an empty pad at night for 1.5× cost if you are within 400 of it | srv+ui+gfx | S | reuses the cache hold logic; gives pilots a reason to go back to the platform |
| 8 | **Graphics pass on the bastion ground.** Approach lanes drawn on the ground per profile (faint worn tracks with chevrons, from `approach`); turret range rings on pads by day and while hovering; pad state (green / amber / red lamps by hull, scorched decal and smoke when its turret is lost); bastion beacon: a slow sweeping light at night and a core glow that drops with hull (sparks and smoke under 50%) | gfx | L | BastionView gets `setState(pads, hull)` from siegeState; range in `turrets[].range` (one field) |
| 9 | **Dusk and dawn.** Dusk tints the light warm then cold blue (ambient colour ramp, not just dimming), per-moon night tint in surfaceLooks (`night` colour); dawn sweeps light back over a second with a short chime and the DawnCard | gfx | S | Renderer already has `setNight`; add tint to the surface look |
| 10 | **Hit and death readability.** Hostiles at night get a red rim marker (screen-space, small) so they read beyond headlights; bastion hits pulse a red vignette edge in the direction of the hit; a turret's death plays a big explosion and leaves the scorched pad | gfx+ui | S-M | hits on the bastion: hull drop in siegeState/banner is enough to trigger the pulse |

**Built 2026-11-04 (gameplay lane):** 0 (the split), 1, 2 (server, NightHud, edge arrows through the nav markers),
3, 4, 5, 6 (orders as a cycling button; focus on key U), 7 (mending the bastion too), and from P2: 13 (last stand) and
15 (party scaling). Balance: fortifications at the moon's own grade, nights about 1.4x bigger, dawn supplies 60+12n.
Hooks left for the graphics stage (8-10): `siegeState.turrets[].range/kind/mend`, `padsLost` (scorched pads),
`bastion` and `breach` (core glow, alarm), `incoming[]` (ground beacons where fronts land), `SiegePanel.padFocus`
(the pad hovered or picked in the panel: its range ring), `SiegePanel.selectPad(i)` (for a click on a pad on the
ground). Not built: 11 modifiers, 12 abilities, 14 boss surges; best night is kept per run, not saved per pilot.

**Built 2026-11-04 (graphics lane):** 8, 9, 10 and the ground beacon left from 2, in `client/src/rendering/surface/siege/`
(BastionView reads `siegeFeed`, written by the panel). Ground: the keep (a dais and towers round the bastion), turret
emplacements in their kind's colour with a pip a mark, day lanes from each profile's `approach` (lanes, arc; ring and
pincer only at night) and night lanes down each front's bearing, reach rings (faint; the pad picked or hovered in the
panel bright), pad lamps and a hull arc green / amber / red, scorched pads with embers and smoke. Light: a sweeping beacon
at night (beam and cone light, red and faster in the last stand), the core's glow by hull, red beacons at front landing
points for their last 20 s (a ring drawing in, turning dashes, a pillar and a red light), shock rings when a front lands,
a turret dies (with a big explosion) or the bastion is hit, smoke and sparks off damaged turrets and a bastion under half.
Dusk passes through a warm tint to each world's night tint (`surfaceLooks` `nightShade`, ground and lighting). Hostiles
at night: brackets and a glyph by role (`siegeLook` ROLE_LOOKS; `tonight.roles[].id` added, JSON-only). UI: the NightHud
(trailing hull, 30% mark, red screen edge on hits, front landed), the dusk title band with role chips, the dawn card
(tiles, streak pips, count-up score), panel rows in their turret's colour. Not done: the dawn chime, turret weapon
muzzle and hit effects (turrets fire their ordinary weapons; WeaponFx is another lane's), a ground click to pick a pad.

### P2: if time is left

| # | What | Lane | Effort | Notes |
|---|------|------|--------|-------|
| 11 | **Night modifiers** (registry, one a night from a profile's `modifiers` list, from night 3, every other night): Blackout (pad lamps out, darker), Whiteout (turret range ×0.75), Frenzy (stream ×2), Plated (hostiles +1 plating). Each pays +20% at dawn and is named on the title card | srv+gfx | M | Rimeholt: whiteout; Gloam: blackout; Cinderhold: frenzy |
| 12 | **Party abilities**, bought by day, fired at night by any pilot (panel buttons, keys 1-3 while the panel is open): Overcharge (turrets ×1.5 fire rate 10 s), Flare (lights a wide area 20 s, hostiles in it marked), Shockwave (bastion pushes back and damages everything within 900, once a night) | srv+ui+gfx | M-L | action `ability`, `item` = id; cooldowns in siegeState |
| 13 | **Breach state.** Bastion under 30%: alarm, red lamps, "Last stand" on the HUD, kills pay double supplies, a free single patch (+20%) that any pilot can trigger by holding at the bastion core for 5 s, once a night | srv+ui+gfx | S | the comeback mechanic |
| 14 | **Boss nights.** Boss name card at dusk, the existing BossUI bar while it's alive, a surge front when it drops under 50% | srv+ui | S | |
| 15 | **Scaling with party size:** one more front per two extra pilots (so the party has to split), the stream share up 5% per extra pilot; budget scaling unchanged | srv | S | test with 1, 2, 4 pilots in siegeProfiles.test |

### P3: later

- Barricades: cheap wards placed on marked spots by day that enemies have to shoot through (needs a pathing answer:
  `sendPack` flies straight).
- Per-moon leaderboards (best night, best streak) on the site's status page.
- Bastion cosmetics unlocked by nights held.
- New objectives: escort a supply crawler in, defend a relay, salvage a downed turret.

## 5. Protocol (one bump)

- `ClientSiegeMessage.action` += `'orders' | 'focus' | 'repairPad' | 'ability'`; `target?: number`.
- `ServerSiegeStateMessage` += `incoming?`, `tonight?`, `summary?`, `score?: { night: number; streak: number; best: number }`,
  `abilities?`, `modifier?`, and on `turrets[]`: `range`, `orders`. All optional; old clients ignore them.
- `npm run wire:bump "sieges: orders, focus, fronts, summary"` once, by the srv lane, committed first.

## 6. Tests

- `sieges.test.ts`: buy on a chosen pad; emergency build cost at night; repair under fire; summary counts kills by
  pilot and by turret; perfect night streak and its pay; breach.
- `siegeProfiles.test.ts`: roles send sappers at turrets and runners at the bastion; modifiers apply and clear;
  party scaling adds fronts.
- New `sieges/roles/roles.test.ts` and `modifiers/modifiers.test.ts` for the registries (every id used in data exists).
- Client: SiegePanel pad menu and NightHud arrows as small DOM tests; `surfaceLooks.test.ts` for the night tint.

## 7. For Kieran to decide

- Should the score feed the haul (proposed: streak bonus on supplies only, so credits stay as balanced today)?
- Should best nights persist per pilot (save field) or per party run only?
- Abilities (P2 #12) cost supplies by day: is that the right currency, or a charge earned per night?
