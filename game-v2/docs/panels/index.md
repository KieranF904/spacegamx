# Before/after panels

Clean before/after images for dev updates, nothing overlaid: `<topic>-before.png`, `<topic>-after.png`, and `<topic>.png`
side by side (before left, after right, a thin grey gap), same framing and exposure. Files are under `<date>/<category>/`.
The PNGs stay local (gitignored); this index is tracked.

Dates: changes in the 3a57da7 checkpoint are filed under 2026-10-30 (the work was done then); everything committed
after it is 2026-10-31. Live-game shots keep the same window size and HUD framing, but the world behind the HUD
(stars, nearby stations, chat lines) is whatever was there at the time.

## 2026-10-30

| category | topic | what changed | numbers | files |
|---|---|---|---|---|
| graphics | hull-weathering | Big hulls now look used: scratches, rust and grime on the plating instead of clean flat panels (a boss hull, close up). | | graphics/hull-weathering-before.png, -after.png, hull-weathering.png |
| graphics | weapon-mounts-sparrow | Guns are real models now, each sitting on its own mounting base, instead of a red block with a barrel on top (the starter Sparrow T). | | graphics/weapon-mounts-sparrow-before.png, -after.png, weapon-mounts-sparrow.png |
| graphics | weapon-mounts-dreadnought | The same change on a big ship: the Bastion Dreadnought's rows of side guns. | | graphics/weapon-mounts-dreadnought-before.png, -after.png, weapon-mounts-dreadnought.png |
| graphics | weapon-models-cannons | The cannon line-up, old blocks against the new models, each one a different shape you can tell apart. | | graphics/weapon-models-cannons-before.png, -after.png, weapon-models-cannons.png |
| graphics | weapon-models-all-game-zoom | Every gun in the game at normal play zoom, old against new. (The nebula behind differs between the two shots; the ships are lit the same.) | | graphics/weapon-models-all-game-zoom-before.png, -after.png, weapon-models-all-game-zoom.png |
| ui | hangar-parts-panel | The hangar's parts panel is wider and shows the parts you own with counts, whether each gun is a turret or fixed, its facing, and its firing arc while you place it. | | ui/hangar-parts-panel-before.png, -after.png, hangar-parts-panel.png |

New this update (nothing to compare against, so after only):

| category | topic | what it is | files |
|---|---|---|---|
| ui | action-menu | Hold Z and right-click anything (here a station) for what you can do with it: here, dock now or fly there on autopilot. (A dev "God mode" line shows in the chat.) | ui/action-menu-after.png |
| ui | component-guide | The Component Guide: every part, what it does and when it unlocks. | ui/component-guide-after.png |
| graphics | brood-mother | The Brood Mother, a new boss (her look is done; her fight is still being built). Drawn by the native renderer. | graphics/brood-mother-after.png |
| tools | asset-viewer | The asset viewer: any ship, boss, part or material drawn with the game's own renderer, with lighting presets. | tools/asset-viewer-after.png |
| website | website-home | The game's website, first pass: home page, updates, suggestions, pilot profiles, one account for site and game. | website/website-home-after.png |

## 2026-10-31

| category | topic | what changed | numbers | files |
|---|---|---|---|---|
| graphics | frost-vignette | When your ship gets cold, the screen now frosts over with hoarfrost creeping in from the edges, instead of cartoon snowflakes (fully chilled). | | graphics/frost-vignette-before.png, -after.png, frost-vignette.png |
| graphics | frost-vignette-corner | The same frost, close up on a corner. | | graphics/frost-vignette-corner-before.png, -after.png, frost-vignette-corner.png |
| graphics | frost-vignette-light | The frost when you're only a little chilled. | | graphics/frost-vignette-light-before.png, -after.png, frost-vignette-light.png |
| ui | empty-cargo-720p | An empty hold is now one line with a hint ("shoot asteroids, then fly through the ore") instead of a tall empty box that covered the pilot readout at 720p. | | ui/empty-cargo-720p-before.png, -after.png, empty-cargo-720p.png |
| ui | hud-1080p | The HUD at 1080p: the tutorial card moved up and the empty cargo box shrank. | | ui/hud-1080p-before.png, -after.png, hud-1080p.png |
| ui | tutorial-card-dock-prompt | The tutorial card no longer hides the "H Dock at…" prompt it's telling you to press. | | ui/tutorial-card-dock-prompt-before.png, -after.png, tutorial-card-dock-prompt.png |
| ui | pilot-statistics-720p | Pilot Statistics fits a 720p screen (its title and close button used to run off the top), and the tutorial card no longer draws over it. | | ui/pilot-statistics-720p-before.png, -after.png, pilot-statistics-720p.png |
| ui | game-menu-720p | Game menu items no longer wrap onto two lines ("Component guide"). | | ui/game-menu-720p-before.png, -after.png, game-menu-720p.png |
| ui | notes-button | The contributor NOTES button sits beside the panels instead of on top of the chat's first line. | | ui/notes-button-before.png, -after.png, notes-button.png |
| graphics | sol-sun-r5 | Sol: the current sun against the round-5 plasma prototype at half resolution (whole sun, same framing). A prototype, not in the game yet. | | graphics/sol-sun-r5-before.png, graphics/sol-sun-r5-after.png, graphics/sol-sun-r5.png |
| graphics | borealis-sun-r5 | Borealis: the current sun against the round-5 plasma prototype at half resolution. A prototype, not in the game yet. | | graphics/borealis-sun-r5-before.png, graphics/borealis-sun-r5-after.png, graphics/borealis-sun-r5.png |
| graphics | nebula-prime-sun-r5 | Nebula Prime: the current sun against the round-5 plasma prototype at half resolution. A prototype, not in the game yet. | | graphics/nebula-prime-sun-r5-before.png, graphics/nebula-prime-sun-r5-after.png, graphics/nebula-prime-sun-r5.png |
| graphics | cinder-reach-sun-r5 | Cinder Reach (the red giant): the current sun against the round-5 plasma prototype at half resolution. A prototype, not in the game yet. | | graphics/cinder-reach-sun-r5-before.png, graphics/cinder-reach-sun-r5-after.png, graphics/cinder-reach-sun-r5.png |
| graphics | prototype-sun-sol-limb | Prototype, not in the game yet: Sol's edge seen from close by, current against the round-5 plasma (half resolution). | sun cost 0.191 → 0.039 ms a frame (4.9×) | graphics/prototype-sun-sol-limb-before.png, -after.png, prototype-sun-sol-limb.png |
| graphics | prototype-sun-sol-close | Prototype, not in the game yet: flying right over Sol's surface, current against the round-5 plasma. | sun cost 0.307 → 0.057 ms a frame (5.4×) | graphics/prototype-sun-sol-close-before.png, -after.png, prototype-sun-sol-close.png |
| graphics | prototype-sun-nebula-prime-rainbow | Prototype, not in the game yet: Nebula Prime's sun with the optional multicolour ("rainbow") look, where the colours come from the plasma itself. | sun cost 0.461 → 0.084 ms a frame (5.5×) | graphics/prototype-sun-nebula-prime-rainbow-before.png, -after.png, prototype-sun-nebula-prime-rainbow.png |
| graphics | surface-terra-nova-countryside | Awaiting review, not deployed: Terra Nova from the air near the coast. Farmland in fields with hedgerows and roads, a river, woods, beaches and surf, in place of flat green. | ground cost ×1.4 (see note) | graphics/surface-terra-nova-countryside-before.png, -after.png, surface-terra-nova-countryside.png |
| graphics | surface-terra-nova-close | Awaiting review, not deployed: Terra Nova low down. Meadows, a wood whose trees each cast a shadow, and a river, in place of camouflage blotches. | ground cost ×1.5 | graphics/surface-terra-nova-close-before.png, -after.png, surface-terra-nova-close.png |
| graphics | surface-terra-nova-wide | Awaiting review, not deployed: Terra Nova from high up. Forests in patches, meadows, rivers, rocky hills with a crag texture, and haze with height. | ground cost ×1.3 | graphics/surface-terra-nova-wide-before.png, -after.png, surface-terra-nova-wide.png |
| graphics | surface-glacia-wide | Awaiting review, not deployed: Glacia. Pack ice broken into floes on the sea, blue glacier ice, dark rock showing through the snow, and blue shade. | ground cost ×1.13 | graphics/surface-glacia-wide-before.png, -after.png, surface-glacia-wide.png |
| graphics | surface-rimeholt-bastion | Awaiting review, not deployed: Rimeholt (Glacia's moon). Rougher than Glacia: more rock, less sea. | ground cost ×1.13 | graphics/surface-rimeholt-bastion-before.png, -after.png, surface-rimeholt-bastion.png |
| graphics | surface-selene-close | Awaiting review, not deployed: Selene. An airless grey moon with craters at four sizes (lit rims, shadowed bowls) and dark low plains, in place of brown blotches. | ground cost ×1.55 | graphics/surface-selene-close-before.png, -after.png, surface-selene-close.png |
| graphics | surface-gloam-bastion | Awaiting review, not deployed: Gloam. A dark violet moon, fractured, with a few craters. | ground cost ×1.3 | graphics/surface-gloam-bastion-before.png, -after.png, surface-gloam-bastion.png |
| graphics | surface-ashfall-wide | Awaiting review, not deployed: Ashfall. Ash and basalt plains split by cracks, some glowing and the rest cooled, with lava vents, in place of a dark smudge. | ground cost ×1.2 | graphics/surface-ashfall-wide-before.png, -after.png, surface-ashfall-wide.png |
| graphics | surface-cinderhold-bastion | Awaiting review, not deployed: Cinderhold. Mostly crusted over, with dim red seams, and smoke-coloured clouds. | ground cost ×1.3 | graphics/surface-cinderhold-bastion-before.png, -after.png, surface-cinderhold-bastion.png |
| graphics | surface-last-light-bastion | Awaiting review, not deployed: Last Light. Lava under a cracked crust, bright and yellow-hot in its channels, in place of flat orange. | ground cost ×1.5 | graphics/surface-last-light-bastion-before.png, -after.png, surface-last-light-bastion.png |
| graphics | surface-deep-foundry | Awaiting review, not deployed: the Deep Foundry arena. The lava held under a heavy crust of drifting plates, in place of flat orange. | ground cost ×1.6 | graphics/surface-deep-foundry-before.png, -after.png, surface-deep-foundry.png |
| graphics | prototype-planets-gas-giant-edge | Prototype, not in the game yet: Jovan's sunlit edge up close. The old haze stopped dead in a hard band; now the clouds thin into a glowing haze that fades out into space. | planet cost 0.185 → 0.071 ms a frame (2.6×) | graphics/prototype-planets-gas-giant-edge-before.png, -after.png, prototype-planets-gas-giant-edge.png |
| graphics | prototype-planets-gas-giant-terminator | Prototype, not in the game yet: Jovan's edge where day turns to night. No dark band and hard line; a dim, reddened twilight haze instead. | | graphics/prototype-planets-gas-giant-terminator-before.png, -after.png, prototype-planets-gas-giant-terminator.png |
| graphics | prototype-planets-gas-giants | Prototype, not in the game yet: every gas giant and the Ashfall brown dwarf. Soft hazy edges, bands that flow at their own speeds, a great storm on each giant, rings you can see through with a soft planet shadow. | gas giants about 3× cheaper close up | graphics/prototype-planets-gas-giants-before.png, -after.png, prototype-planets-gas-giants.png |
| graphics | prototype-planets-solid-worlds | Prototype, not in the game yet: rocky, desert, ice, lava, ocean and toxic worlds. Craters, canyons and ridges lit by the star, cracked ice, glowing lava rivers, oceans with sun glint and clouds that cast shadows. | 1.2–2.5× cheaper close up | graphics/prototype-planets-solid-worlds-before.png, -after.png, prototype-planets-solid-worlds.png |
| graphics | prototype-planets-atmosphere-edge | Prototype, not in the game yet: the edges of Terra Nova, Verdance and Nereid. The thin dark ring between planet and glow is gone. | | graphics/prototype-planets-atmosphere-edge-before.png, -after.png, prototype-planets-atmosphere-edge.png |
| graphics | prototype-planets-rings | Prototype, not in the game yet: Nereid's and Prism's rings. Real ringlets and gaps without the old shimmer, see-through where thin, and a soft-edged shadow. | | graphics/prototype-planets-rings-before.png, -after.png, prototype-planets-rings.png |

Sun costs are from `docs/rendering/sun-sky-prototypes.md` (round 5, 1080p, native harness).
Planet costs are from `docs/rendering/planet-prototypes.md` (1080p, native harness; the browser figures there agree).

Surface panels: live game shots at 1280×800, with ships, HUD and minimap hidden and the clouds' clock and the time of
day fixed, so before and after match exactly. The ground's cost is its GPU time, new against old, from the native
harness on an RTX 5070 Ti. At 1080p it's 17–23 µs before and 19–30 µs after; at 4K about 0.08 → 0.11 ms (`docs/rendering/surface-art-pass.md`).
In dev, `localStorage['sg.surfaceLook'] = 'classic'` shows the old ground live, for comparison.
| graphics | game-sol-sun-limb | In the game now (next deploy): Sol's edge from close by, the old sun against the new plasma star (drawn at half resolution, with Sol's finer detail), and the sky's stars now drawn as sprites. Live dev client, same spot and zoom. | sun 0.19 → 0.048 ms a frame at 1080p (native harness); sky 0.22 → 0.023 ms | graphics/game-sol-sun-limb-before.png, -after.png, game-sol-sun-limb.png |
| graphics | game-sol-sun-close | In the game now: right at Sol's edge, zoomed in. | | graphics/game-sol-sun-close-before.png, -after.png, game-sol-sun-close.png |
| graphics | game-sol-sun-far | In the game now: Sol from the widest flight zoom. | | graphics/game-sol-sun-far-before.png, -after.png, game-sol-sun-far.png |
| graphics | game-borealis-sun-limb | In the game now: Borealis' blue star at its edge. | sun 0.49 → 0.036 ms a frame at 1080p | graphics/game-borealis-sun-limb-before.png, -after.png, game-borealis-sun-limb.png |
| graphics | game-nebula-prime-sun-limb | In the game now: Nebula Prime's pink star at its edge. | sun 0.39 → 0.042 ms a frame at 1080p | graphics/game-nebula-prime-sun-limb-before.png, -after.png, game-nebula-prime-sun-limb.png |
| graphics | game-cinder-reach-sun-limb | In the game now: Cinder Reach's red giant at its edge. | sun 0.20 → 0.043 ms a frame at 1080p | graphics/game-cinder-reach-sun-limb-before.png, -after.png, game-cinder-reach-sun-limb.png |
| graphics | login-sun | The sign-in screen's sun, now the game's own Sol (the same plasma star). Another change (in progress) shows a random Sol body there instead. | | graphics/login-sun-before.png, -after.png, login-sun.png |
| graphics | planets-ingame-jovan | The new planet look is in the game: Jovan as you fly by it, with its great red spot, flowing bands, see-through rings and a soft glowing edge (live game; the planet has moved along its orbit between the two shots). | planets about the same cost far out, up to 3× cheaper close up | graphics/planets-ingame-jovan-before.png, -after.png, planets-ingame-jovan.png |
| graphics | planets-ingame-jovan-edge | Jovan's edge up close in the game: the hard band of haze is gone; the clouds thin into haze that fades into space. | | graphics/planets-ingame-jovan-edge-before.png, -after.png, planets-ingame-jovan-edge.png |
| graphics | planets-ingame-ice-close | Nereid's ice up close in the game (High quality): ridged cracks in the ice, sharp at any zoom, instead of blurry blue loops. | | graphics/planets-ingame-ice-close-before.png, -after.png, planets-ingame-ice-close.png |
| graphics | planets-ingame-ice-closest | The same at the closest zoom. | | graphics/planets-ingame-ice-closest-before.png, -after.png, planets-ingame-ice-closest.png |
| graphics | planets-ingame-lava | Kindle, a lava world: a network of glowing rivers between dark crust plates. | | graphics/planets-ingame-lava-before.png, -after.png, planets-ingame-lava.png |
| graphics | planets-ingame-lava-close | Kindle up close: glowing rivers with cooling cracks in the crust between them. | | graphics/planets-ingame-lava-close-before.png, -after.png, planets-ingame-lava-close.png |
| graphics | planets-ingame-brown-dwarf | Ashfall's brown dwarf, now drawn like the planets: turbulent bands, glowing heat and its old scar. | | graphics/planets-ingame-brown-dwarf-before.png, -after.png, planets-ingame-brown-dwarf.png |
| graphics | planets-ingame-terra-nova | Terra Nova: continents, coasts, ice caps and drifting clouds, lit from the star with a soft twilight edge. | | graphics/planets-ingame-terra-nova-before.png, -after.png, planets-ingame-terra-nova.png |
| graphics | planets-ingame-vesta-close | Vesta up close: craters and ridges catch the light, and the edge is soft, with a faint glow. | | graphics/planets-ingame-vesta-close-before.png, -after.png, planets-ingame-vesta-close.png |
| graphics | planet-cracks-ice-close | Ice cracks up close, Medium quality (left) against High (right). Medium reads cracks from a small texture, so close up they break into blotchy, pixelated dashes. High works each crack out exactly, so it stays sharp at any zoom. | High costs ~0.2 ms more a frame (1080p) only while an icy or lava world fills the screen | graphics/planet-cracks-ice-close-before.png, -after.png, planet-cracks-ice-close.png |
| graphics | planet-cracks-ice-zoom1 | The same on Thule at normal zoom: Medium left, High right. | | graphics/planet-cracks-ice-zoom1-before.png, -after.png, planet-cracks-ice-zoom1.png |
| graphics | planet-cracks-ice-whole | Thule from further out, Medium left, High right: about the same number of cracks, just cleaner. | | graphics/planet-cracks-ice-whole-before.png, -after.png, planet-cracks-ice-whole.png |
| graphics | planet-cracks-lava-close | Lava rivers up close: Medium (left) against High (right). Sharp, smooth glow instead of blocky crack lines. | | graphics/planet-cracks-lava-close-before.png, -after.png, planet-cracks-lava-close.png |
| graphics | planet-edges-selene | A moon's edge (Selene, at the sign-in screen's size): left, a hard cut-out disc; right, a soft edge with a thin rim of sunlight and a faint dust glow. | | graphics/planet-edges-selene-before.png, -after.png, planet-edges-selene.png |
| graphics | planet-edges-selene-zoom1 | The same at normal game zoom. | | graphics/planet-edges-selene-zoom1-before.png, -after.png, planet-edges-selene-zoom1.png |
| graphics | planet-edges-vesta | A rocky world's edge (Vesta), at the sign-in screen's size: hard cut-out (left) against soft (right). | | graphics/planet-edges-vesta-before.png, -after.png, planet-edges-vesta.png |
| graphics | planet-edges-vesta-zoom1 | The same at normal game zoom. | | graphics/planet-edges-vesta-zoom1-before.png, -after.png, planet-edges-vesta-zoom1.png |
| graphics | planet-edges-jovan | A gas giant's edge (Jovan) for comparison: already soft from its haze, unchanged. | | graphics/planet-edges-jovan-before.png, -after.png, planet-edges-jovan.png |
| graphics | planet-edges-jovan-zoom1 | The same at normal game zoom. | | graphics/planet-edges-jovan-zoom1-before.png, -after.png, planet-edges-jovan-zoom1.png |
| ui | login-random-body | The sign-in screen now shows a different Sol body each visit (here Jovan with its rings) in the sun's old place. Behind it is Sol's real sky, and the new sun sits in a corner as the light source. The sun itself still comes up about one visit in six. | sign-in screen ready in about the same time: 245–273 ms on a first visit (was 267), 179–197 ms on a reload (was 224) | ui/login-random-body-before.png, -after.png, login-random-body.png |

### Performance (numbers only, nothing visual to show)

| category | topic | what changed | numbers |
|---|---|---|---|
| performance | first-load | The sign-in screen is drawn by the game's own renderer and shaders compile in the background, so the game is ready almost at once on a first visit. | first visit to the guest button ~5.2 s → ~0.35 s |
| performance | reload | Generated art (rocks, hulls, stations, icons, frost) is cached in the browser instead of rebuilt each visit. | reload worker CPU ~2.8 s → ~0.2 s |
| tools | native-renderer | Ship, boss and part pictures render without a browser. | ~1.3 s to the first picture, then 15–30 ms each |

New this update, after only (no matching before):

| category | topic | what it is | files |
|---|---|---|---|
| ui | login-random-body-* | More sign-in screen examples: Terra Nova, Nereid, Ares, Selene (with Terra Nova behind it), Vesta, and the sun. | ui/login-random-body-terra-nova-after.png, -nereid-after.png, -ares-after.png, -terra-nova-moon-after.png, -vesta-after.png, -sun-after.png |

## Skipped, and why

- **System map: far ships and other pilots.** No shot of the map from before the change exists, and the build before it
  (c407ce1, March) is too different from today's to run against the current server cheaply. Today's map is in the
  scratchpad (`smoke/live-1.png`) if an after-only shot is wanted.
- **Helm mode camera.** The change is in how the camera moves (loose, then tight); a still can't show it.
- **Login / first-load look.** The sign-in screen looks the same; the change is speed (numbers above).
- **Warmth chip text** ("where to warm up"). No shot of the old chip at the same moment; it's a one-line text change.
- **Hangar overview (Structure tab).** The before and after shots were taken holding different parts, so they don't
  compare fairly; the Weapons-tab pair above covers the change.
- **Mounting rules (fixed/turret/side) as a rule.** Shown indirectly by the hangar panel (TURRET/FIXED tags, arcs);
  the rule itself isn't a picture.
- **Quench Slugs item and icon, Brood Mother intro card.** No before state, and no clean shot to hand; the slugs are
  a small icon in the cargo list.
- **Key hints that follow rebinding, tutorial wording.** Text-only changes that only show if you rebind keys.
- **Bloom and damage effects rewrite, particle pools, server work, bullet-hell audit.** Meant to look identical while
  costing less; nothing to see.
- **Sun lab cost graph, pre-cache audit.** Developer tools and documents, not player-facing.
| graphics | surface-terra-nova-fields | Awaiting review, not deployed: Terra Nova farmland. The seam where the field grid jumped sideways is gone, and the fields are irregular parcels with wandering hedges, varied crops and row directions, with meadow and scrub left before coasts and rivers. | ground cost about the same (+0.002 ms native) | graphics/surface-terra-nova-fields-before.png, -after.png, surface-terra-nova-fields.png |
| graphics | surface-terra-nova-fields-close | Awaiting review, not deployed: the same fields, low down. | ground cost about the same | graphics/surface-terra-nova-fields-close-before.png, -after.png, surface-terra-nova-fields-close.png |
| ui | perf-monitor | Awaiting review, not deployed: the performance monitor (Settings > Performance monitor) is one readable panel at the top, left of the minimap and quest list: FPS and frame time with worst and 95th percentile, a frame-time graph with 16.7 and 33 ms lines, ping and jitter graph, entities, quality, network rates. Click the header to fold, drag to move. | | ui/perf-monitor-before.png, -after.png, perf-monitor.png |
