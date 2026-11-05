---
date: "2026-11-06"
category: "netcode"
topic: "prediction modes (Rockery demo)"
status: "after only"
files:
- "2026-11-06/predict-modes/f7-panel-modes.png"
- "2026-11-06/predict-modes/mode-a-200ms.png"
- "2026-11-06/predict-modes/mode-b-200ms.png"
- "2026-11-06/predict-modes/mode-c1-200ms.png"
- "2026-11-06/predict-modes/mode-c2-200ms.png"
- "2026-11-06/predict-modes/mode-c3-200ms.png"
numbers: "200 ms ping: other pilots drawn 343 u from where your shells meet them in A, 232 u in C1, 10-13 u in C2/C3; drones 168 u in A, 4-6 u in C1-C3; B 4-7 u but 490 ms input to screen; C2/C3 re-steps under 0.01 ms a tick"
---
The F7 Sim tools can now switch how other ships are drawn, live, in the dev game: A today's (your ship predicted, everyone else interpolated), B prediction off, C1 drones and AI stepped ahead, C2 every ship on a predicted layer that is checked against each snapshot and re-stepped once on a miss, C3 the same plus re-stepping what a mispredicted ship touched. The Rockery, a guest strafing a Helios drone pack with three bot players flying round it, 200 ms round trip and 10 ms jitter, the Shift+F7 overlay on (cyan the confirmed pose, yellow the predicted one, red lines the gap) and its counters on the left. No before: these are dev modes beside today's.
