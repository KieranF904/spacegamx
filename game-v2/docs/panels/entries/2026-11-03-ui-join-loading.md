---
date: "2026-11-03"
category: "ui"
topic: "join-loading"
files:
- "ui/join-loading-before.png"
- "ui/join-loading-after.png"
- "ui/join-loading.png"
numbers: "frames about 0.5, 1.2, 2.2 and 3.8 s after picking the local server (headless, busy machine). Before: the first pong came 2.0 s in, with the client's tick estimate about 29,700 ticks out until then; the camera started 604 units off the ship and slid on over about 1.2 s. After: pong at about 0.1 s, camera on the ship from the first frame, screen lifted after 0.8 to 2.6 s (mostly waiting on the rock relief atlas and lodestone maps from the worker)"
---
Joining now shows a loading screen ("Connecting", "Receiving the world", "Syncing with the server", "Catching up", "Building the sector") until the world is in sync, then fades out. Before, the camera slid onto the ship from off to one side, rocks drew at the wrong place in their orbits for two seconds and then jumped, and a "+300 credits" popped up for what you already had.
