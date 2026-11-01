---
date: "2026-11-01"
category: "hangar"
topic: "wires"
files:
- "hangar/wires-before.png"
- "hangar/wires-after.png"
---
Wiring is retired: power will flow between touching parts. Before: the renderer drew auto-wire runs over Review: Heron even though its blueprint has no wires. After: no wire lines anywhere (in flight, in native stills, on the hangar grid), the hangar's Wires tool is gone and saving costs no wire spools. Native stills: npm run render -- ship:dev/review-heron --zoom 2.
