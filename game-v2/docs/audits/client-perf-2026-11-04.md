# Client frame profile, 2026-11-04

A short pass over the client's frame (update and render) in busy scenes: what it costs, what was cut, and what is
left. The frame is well under budget in every scene measured (about 1.2 ms of frame JS and 0.6 ms of pixi submit in a
heavy fight at 1440x900): earlier passes already took the big costs out (shots drawn by WeaponFx with pooled sprites,
asteroids in batches, culling in renderEntities, the nav markers' entity scan cached, DOM writes skipped when
unchanged). The changes here are small and each has its own commit.

## How it was measured

- Live dev game (Vite on 5273, dev server on 3000), a guest in one headless Chrome tab borrowed from the render daemon,
  1440x900 at DPR 1, god mode.
- The heavy fight is `node scripts/profile/clientProfile.mjs <out> boss` (the Redtooth picket's lair in Sol, four
  packs, holding fire): in-page timings of the frame's parts plus a CPU profile.
- The other scenes used throwaway scripts in the session scratchpad (the same probe: instance methods wrapped from the
  page, nothing in the game changed; Vite's HMR socket blocked in the tab so other agents' edits don't reload it).
- Each change was measured as an in-page A/B in one scene (a temporary switch, removed before the commit): three
  alternating pairs of 4 s each, so the scene is the same for both. Numbers are ms a frame.

## Scenes (before)

| Scene | Entities | Game.update | Renderer.update | shipClient.update | pixi render | Notes |
|---|---|---|---|---|---|---|
| Heavy fight (boss lair, 85 ships, firing) | 695 | 1.22 | 0.44 | 0.37 | 0.59 main pass, 68 draws | network onMessage 0.29 more (netcode, not touched) |
| Sol asteroid belt, firing | ~600 (560 rocks) | 0.82 | 0.24 | 0.17 | 0.18 | AsteroidBatch.update 0.004 |
| At Sol Central | ~600 | 0.78 | 0.24 | 0.16 | 0.29 | |
| By Jovan (gas giant) | ~600 | 0.72 | 0.21 | 0.14 | 0.15 | updatePlanets 0.02 |
| Selene siege night, zoom 0.6, ~50-90 ships | ~130 | 1.10 | 0.42 | | 0.50 | BastionView.update 0.09, of it SiegeMarks 0.066 |

## What changed

| Commit | Change | Before -> after (A/B pairs) |
|---|---|---|
| db74ff9 | Siege night marks skip hostiles whose mark would fall wholly off screen (SiegeMarks takes the view box with the bracket, glyph and reticle's reach as margin; BastionView is given the ships only, `entities.ofType(ShipBody)`) | SiegeMarks.update 0.064/0.048/0.037 -> 0.028/0.013/0.009; BastionView.update 0.088/0.076/0.064 -> 0.055/0.044/0.039; pixi render 0.50/0.44/0.40 -> 0.46/0.34/0.32 |
| 56e4351 | A hostile's four brackets as one stroke of four open subpaths, turned inline (no point arrays, one stroke instruction instead of four) | SiegeMarks.update 0.046/0.013/0.016 -> 0.013/0.006/0.009 (pixi render within noise) |
| 261f4dc | The weapon ring round the cursor redraws its canvas only when a field it draws from changes (always while a reload's pips breathe); its transform is written only when the cursor's rounded place moves | WeaponRing.update 0.013/0.016/0.010 -> 0.002/0.003/0.001, plus the canvas raster and upload it no longer asks for each frame |
| eed1a07 | NavMarkersUI.update with no per-frame arrays or objects: off-screen places in reused slots (same order, same stable sort), the slide's overlap test on scalars against a reused box list, the fixed HUD boxes rebuilt only on resize; the job's station found with `entities.ofType(Station)` | NavMarkersUI.update 0.075/0.071/0.068 -> 0.065/0.065/0.060 (Sol, 14 markers); new and old run on the same frame gave identical markers over 30 frames |
| bdd6c68 | FloatingRewardsUI.draw places each text with `setTransform` (no save/restore per text), turns the glow's shadow off after its one fill, keeps each text's font string and rgba() prefix | FloatingRewardsUI.draw 0.213/0.214/0.186 -> 0.193/0.184/0.190 (~30 texts); frozen ~55 texts, 800 draws each: 0.177 -> 0.144; canvas within 1 per channel of the old draw (the old against itself differs as much), glow included |

Why these: the siege marks were the one per-frame Graphics rebuild that grew with the number of hostiles, most of
which are off screen on a night; the ring was a canvas redrawn every frame whatever it showed. None changes what's on
screen: culled marks are outside the view plus their reach, the merged stroke is the same lines with the same width,
join and alpha (the corners don't overlap), and the ring keeps its last drawing when nothing it draws from changed.

56e4351 checked on screen afterwards: a Selene night at zoom 0.6 with hostiles marked shows each one's four corner
brackets as separate mitred Ls, no lines joining them. For the floating texts, clearing only the last frame's text boxes
was tried first and dropped: no measured win (the time is in drawing the text, not the clear).

Tests: `npx tsc -p client --noEmit` clean; `npx vitest run client/src/ui client/src/app` (65) pass after the HUD changes; `npx vitest run client/src/rendering/surface` (12) and
`client/src/ships/gunHud client/src/ui` (50) pass.

## Hot spots found, not fixed

Each is small (well under 0.1 ms a frame) unless it says otherwise.

- **NavMarkersUI.update**, now ~0.06 ms (eed1a07): what's left is the windows.ts callbacks (events, ops, party build
  new arrays each call), `worldToScreen` returning an object per place, and the distance and transform strings.
- **FloatingRewardsUI.draw**, now ~0.19 ms with 30 texts alive (bdd6c68): three text draws a text (shadow, outline,
  fill) are the cost; a cheaper way (each text pre-drawn to a small canvas) would change how the faded layers blend.
- **DamageFx.draw**, ~0.08 ms a frame in the fight (sprite rotation and particle takes).
- **ShipRenderer.update**, 0.19 ms a frame in the fight: ShipBatch.end and Lighting.levelAt are the larger parts.
- **network onMessage** 0.29 ms and **SelfHits.detect** ~0.14 ms a frame in the fight: netcode, left to that work.
- **Full entity scans in the HUD each frame** where `entities.ofType(...)` would do: FarZoomMarkers (players),
  BossUI, PingUI, TargetUI (spreads every entity into an array), InfoPanel, MiningBeamFx.cast (asteroids only),
  BossFx beams (ships only). Cheap today, they grow with projectiles in a fight.
- **BastionView** small per-frame allocations: `turrets.slice()` in events, the emplacement key string joined every
  frame, the beacons and mends arrays and the state object; SiegeFx draws each front beacon's 12 dashes as 12 strokes
  (one stroke of subpaths would do, as the marks now are).
