# UI polish pass: 2026-10-31

A usability pass over the live dev client (Vite 5273, game server 3000) as a fresh guest with the tutorial on, at
1280x720 and 1920x1080: HUD, tutorial, every hotkey window (I, M, L, K, C, P, O, Esc menu), the Z + right-click
action menu, and a docked station's tabs. Small, consistent, low-risk fixes only; anything bigger or a matter of taste
is written up as a proposal at the end.

Screenshots: `docs/ux/polish-2026-10-31/` (`before-*`, `after-*`, `proposal-*`). They were shot with
`scripts/boss-shots/shoot.mjs`; the step files are in the session scratchpad. About 11 MB in all, so drop the folder
if you'd rather not commit it.

## Findings and fixes

### 1. Key hints that ignored rebinding (fixed)
Many hints wrote the default key into the text, so they were wrong for anyone who rebinds. They now read the current
binding through `boundKeyName()`, the way `ShipHud`, `PeopleUI` and the map footer already did:

| Where | Was | Now |
|---|---|---|
| Tutorial, all 10 steps (`ui/Tutorial.ts`) | W A S D, Shift, I, M, G, H, Tab, J, L, M, P, 1–5 | bound keys. Each step's text is built when the step shows, so a rebind mid-tour is picked up. Boost shows "Shift" while it's on either Shift key |
| Death screen (`rendering/Renderer.ts`) | "Press R to respawn" | respawn key |
| "Fly into a station's docking ring and press H" (`ships/ShipClient.ts`) | H | dock key |
| Autopilot with nothing followed (`Game.ts`) | "(L)" / "(M)" | log / map keys |
| Party window and party menu (`ui/SocialUI.ts`) | "press P", "Party window (P)", "Respawn at home (R)" | party / respawn keys |
| Station Overview button (`ui/StationWindow.ts`) | "Cargo & storage (I)" | inventory key |
| Empty quick-bar slot tooltip (`ui/QuickBar.ts`) | "from your cargo (I)" | inventory key |
| Quest tracker and pilot log (`ui/QuestUI.ts`) | "QUESTS · L", "▶ G" autopilot buttons and their tooltips, "needs a party of 2+ (P)", the empty log's "press X", the Follow tooltip's "(G)" | bound keys |
| Map gate tooltip (`ui/SystemMapUI.ts`, text only) | "Fly in and press X" | interact key |

The map's own "C follows your ship" was left alone: C is a fixed key inside the map, not a binding.

### 2. The tutorial card covered the dock prompt (fixed)
The card sat at `bottom: 168px`, right on top of the "H Dock at …" pill (152px) and the "Station repair" pill
(196px). So at step 6 ("Press H to dock") the prompt it talks about was hidden behind it. The card now sits at 236px,
clear of both, at 720p and at 1080p.
Before: `before-dock-hint-hidden-720.png`, `before-hud-1080.png`. After: `after-dock-hint-clear-720.png`, `after-hud-1080.png`.

### 3. Tutorial wording (fixed)
- Step 2 said "The blue gauge on the right is your boost fuel", but the gauge is labelled **ENERGY**. It now names
  the ENERGY gauge.
- The last step now mentions the Z + right-click action menu ("hold Z and right-click anything for what you can do
  with it"). Before this, the only places it appeared were the map footer and the Controls list.
  After: `after-tutorial-last-step.png`.

### 4. Cargo panel: a tall empty box that overlapped the pilot readout (fixed)
With an empty hold, the always-on CARGO panel above the chat still kept its 200px list height. At 1080p that was a
big blank box. At 720p its 44px minimum pushed it up over the "Cargo 0 / 30" line of the pilot readout. Now an
empty hold is one line, with a hint: "Empty: shoot asteroids, then fly through the ore". The panel goes back to its
own height when something arrives. (`ui/CargoPanelUI.ts`)
Before: `before-hud-720.png`, `before-hud-1080.png`. After: `after-hud-720.png`, `after-hud-1080.png`.

### 5. Pilot Statistics (O) at 720p (fixed)
- The panel is centred and taller than 720px, so its title and close button ran off the top. It now has
  `max-height: calc(100vh - 32px)` and scrolls (thin dark scrollbar, like the window kit).
- Esc did nothing to it: it opened the game menu with the panel still up. Esc now closes the panel first.
- The tutorial card (z 2100) drew on top of the panel (z 1500). It now hides while the panel is open; the steps keep
  tracking underneath.
- The close button got a "Close (Esc)" tooltip.
Before: `before-stats-clipped-720.png`. After: `after-stats-fits-720.png`, `after-esc-closes-stats.png`.

### 6. Small consistency fixes (fixed)
- The game menu's "Component guide" wrapped onto two lines in the 300px sidebar. Menu items now don't wrap.
  (`before-menu-720.png` → `after-menu-720.png`)
- The jump-drive banner said "62k range"; the action menu says "reach 62 km" for the same thing. The banner now
  writes distances the same way (km, or m under 1 km). (`ships/JumpFx.ts`)
- The skill "+" buttons (icon only) got a tooltip: "Spend a skill point on Mining" and so on.

## Checked and fine
- Every `GameWindow` closes on Esc and has a "Close (Esc)" ✕. Inventory, the component guide, party and station
  windows also close on their own key.
- The map's footer and its "Way into …" labels already use bound keys. The HUD's "MOUSE-STEER · V for helm" line
  makes the helm toggle discoverable.
- Empty states mostly say what to do: the hold ("Mine asteroids and pick up loot"), the log ("No jobs yet. Talk to
  people…"), Party ("No party yet. Invite a pilot nearby…"), designs ("In the hangar, Designs saves…").
- Quench Slugs' item text says what they're for (Cinder Cult ships take 2.5×), who taught the pattern (Forgemaster
  Hale, who is the owner of the lore line) and where they come from (your station's armoury). No change needed.

## Proposals (not built: bigger, or a matter of taste)

1. **One word for jobs.** The same thing is called "Quests" (the log tab, the HUD tracker, the stats panel's
   "Quests complete"), "jobs" (the keybinding "Pilot log (jobs)", the log subtitle "0 jobs done", the empty state,
   the tutorial) and "Missions" (the stats panel's "Missions complete", next to "Quests complete"). Pick one ("Jobs"
   matches most of the prose) and rename the tab, the tracker header and the stats cards. `before-hud-720.png`
   (tracker), `proposal-map.png`.
2. **The warmth chip doesn't say how to warm up.** "❄ Chilled · warmth 62% · guns slower" names the cost but not
   the fix. Add a tooltip (or a short tail): "Warm up near a star, a station or …", using the same sources the
   server counts. Not done: `FrostVignette.ts` belongs to the startup agent right now.
3. **"Ctrl-click: warp (dev)" shows to every player** on the map's station and gate tooltips (12 places), because
   `Game.ts` always sets `systemMapUI.onWarp` and the server is what refuses non-admins. Set `onWarp` only for admins
   or dev builds; the tooltips already check `this.onWarp` in one place. This is a behaviour change, so it's left out
   here.
4. **Nav marker distances have no unit** ("45k"). The action menu and now the jump banner say "45 km". Making the
   markers match is a text change in `NavMarkersUI`, but it widens every marker, so it's your call.
5. **Fabricator stat line units.** "56 dmg/s · reach 7,200 · draws 8": reach is in metres and draws is power.
   Something like "reach 7.2 km · draws 8 power" would read better. `proposal-fabricator-units.png`.
6. **Toasts sit over open windows.** Server toasts stack at `top: 122px` with z 3500, so with the station window open
   "Word around the station: …" covers the PEOPLE HERE heading for a few seconds. Option: while a window is open,
   stack toasts at the bottom of the screen. `proposal-toast-over-window.png`.
7. **Component guide styling.** It uses its own look (orange, heavy caps, square tabs) instead of the window kit's
   blue headers and underline tabs. Fine as a "manual", but it stands out from every other window.
   `proposal-component-guide-style.png`.
8. **Pilot Statistics panel** is the last window outside the window kit (its own fonts, red ✕, no veil). Moving it
   onto `GameWindow` would give it the shared look, Esc handling and stacking for free.
9. **Server-written keys.** Contract text from the server says "Our autopilot (G) knows the way"
   (`proposal-contracts-server-keys.png`). Quest prose in `data/quests.json` could use a token such as `{key:autopilot}`
   that the client fills in.
10. **Login tabs.** "CREATE ACCOUNT" wraps onto two lines in its tab at 1280 wide, and "Quick Play as Guest" is a
    small left-aligned button under a full-width LAUNCH, which is easy to miss for the most common first-time path.
    Left alone: the login screen is with the startup agent. `proposal-login-tabs.png`.
11. **Chat over the world.** The chat log's italic orange and red system lines are hard to read over bright station
    hulls. The world nav markers along the bottom-left also draw through the chat text. A slightly darker chat
    backing, or keeping markers out of the chat's rectangle, would fix both. (`before-hud-1080.png`; contributor-only
    "✎ NOTES" chip also sits on the chat's first line.)

## Files changed
`client/src/ui/Tutorial.ts`, `ui/CargoPanelUI.ts`, `ui/PlayerStatsUI.ts`, `ui/QuestUI.ts`, `ui/SocialUI.ts`,
`ui/StationWindow.ts`, `ui/QuickBar.ts`, `ui/GameMenuUI.ts`, `ui/SystemMapUI.ts` (one text line),
`ships/ShipClient.ts`, `ships/JumpFx.ts`, `rendering/Renderer.ts` (death text + imports), `Game.ts` (autopilot
message, Esc closes stats, tutorial hidden under stats).

Checks: `npx tsc --noEmit -p client` clean; client vitest 260/260; root suite 1031/1031.
