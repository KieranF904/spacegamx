---
date: "2026-10-31"
category: "ui"
topic: "hangar-power"
files:
- "ui/hangar-power-before.png"
- "-after.png"
- "hangar-power.png"
numbers: "Battery gives 600/s per cell, Heavy Bank 450, Drive Cell 1,400, Capacitor 2,000 (only into what it touches); core store 720/s to circuit A, 12/s trickle to the rest"
status: "awaiting review"
---
The hangar's power view shows circuits: lettered A, B on the wires and in the POWER panel (A is the main circuit, which holds the core's store), each with what it spares, holds and can give a second. A load test (Fire / Boost / Both) plays 4 s of the ship's power and says which circuits brown out and how fast they refill (B: never). New warnings: stores with no generator, a capacitor touching nothing that draws power, and weak links (cells a single wire runs through; marked ✂ with the Wires tool).
