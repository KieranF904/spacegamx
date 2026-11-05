---
date: "2026-11-03"
category: "graphics"
topic: "gas-band-hash"
files:
- "graphics/gas-band-hash-before.png"
- "graphics/gas-band-hash-after.png"
- "graphics/gas-band-hash.png"
numbers: "band flicker on a static gas giant: 23 events in 16,800 frames with the old hash, 1 in 14,400 with the new"
---
Gas giants' band tints (and the ovals) now come from a sin-free hash, because the old sin hash was fed about 27,000 and now and then a frame drew whole bands in the other tint. Jovan, Cinderjack, Boreas Major and Opaline, before (top) and after (bottom): each planet's band pattern is different now, with the same palette and a mix of pale zones and dark belts.
