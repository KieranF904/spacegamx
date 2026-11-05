---
date: "2026-11-04"
category: "graphics"
topic: "impact-particles-ride"
files:
- "graphics/impact-particles-ride-before.png"
- "graphics/impact-particles-ride-after.png"
- "graphics/impact-particles-ride.png"
---
Three Bastion hits, 0.3 s apart, on the fastest orbiting rock near the spawn (top, about 320-390 u/s) and on a moving range dummy (bottom), with the camera on the target. Frames are about 0.1, 0.3, 0.5 and 0.7 s after the last hit. Each run picks its own rock and the dummies steer themselves, so before and after are not the same moment. Before, the sparks, sprays and fragments got the target's velocity once, from a single frame of its motion, then flew straight on. A rock placed once a tick read as stopped or doubled, so they streaked off behind it and smeared round its orbit. Now they fly in the target's frame and are carried by the hit point's motion each frame, so they stay with the rock or hull and spray out from where it was hit. Pulse-laser hits, mining chips and dust, and plating hits ride the same way (not pictured).
