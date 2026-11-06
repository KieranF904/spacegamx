---
date: "2026-11-06"
category: "netcode"
topic: "C3 prediction as the game's default"
files:
- "2026-11-06/c3-default/c3-default-before.png"
- "2026-11-06/c3-default/c3-default-after.png"
numbers: "200 ms (an inflated 0.5-0.9 s measured ping this run): other pilots drawn 284 u from where your shells meet them before, 27 u after (80 % within half a radius); drones 226 u before, 16 u after; your strikes 198 u off before, 1.4 u after; 100 ms: pilots 9 u, drones 7 u (96-97 %); PT 0.2 ms a tick in the browser"
---
Other ships are now predicted to your own tick in every build (C3: each one stepped ahead on its last input or its AI's decisions, checked against every snapshot, re-stepped once when wrong, and what it touched re-stepped with it), and collisions between predicted ships use the server's own contact pass instead of circles. Before: the old drawing (everyone else interpolated, mode A). After: the default C3. The Rockery, a guest strafing a Helios drone pack with three bot players round it, 200 ms round trip and 10 ms jitter, the Shift+F7 overlay on (cyan the confirmed pose, yellow the predicted one, red lines the gap) and its counters on the left.
