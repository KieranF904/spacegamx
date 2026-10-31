---
date: "2026-10-31"
category: "notes"
topic: "surface-panels"
---
Surface panels: live game shots at 1280×800, with ships, HUD and minimap hidden and the clouds' clock and the time of day fixed, so before and after match exactly. The ground's cost is its GPU time, new against old, from the native harness on an RTX 5070 Ti. At 1080p it's 17–23 µs before and 19–30 µs after; at 4K about 0.08 → 0.11 ms (`docs/rendering/surface-art-pass.md`). In dev, `localStorage['sg.surfaceLook'] = 'classic'` shows the old ground live, for comparison.
