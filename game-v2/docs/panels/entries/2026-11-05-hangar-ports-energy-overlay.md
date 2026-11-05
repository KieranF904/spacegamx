---
date: "2026-11-05"
category: "hangar-ports"
topic: "energy-overlay"
status: "awaiting review"
files:
- "hangar-ports/starter-before.png"
- "hangar-ports/starter-after.png"
- "hangar-ports/hauler-before.png"
- "hangar-ports/hauler-after.png"
- "hangar-ports/sunspear-before.png"
- "hangar-ports/sunspear-after.png"
- "hangar-ports/port-hover.png"
- "hangar-ports/ghost-links.png"
- "hangar-ports/ghost-turned.png"
- "hangar-ports/lancer-brownout.png"
---
The hangar's energy overlay for ports ships (E toggles it, or the POWER panel's "On grid" button). The "before" shots have the overlay off, which is how the hangar looked until now; the POWER panel's load test rows are new in both. Every port is drawn at its edge: an out port is a filled triangle pointing out, an in port a hollow notch pointing in. Amber is out and blue is in when linked; red is an open in port or a clash, orange a generator's wasted line, grey a store's spare port. Each link is a line as thick as the E/s it carried in the chosen load test, labelled with that E/s. Stores show their fill bar, and consumers left short are outlined with the share they get. The shots, in order:
- The Sparrow T starter, overlay off, then on.
- The Ceres Hauler (95 parts), off, then on.
- The Sunspear (100 parts), off, then on.
- Hovering a Fusion Plant's out port on the Sunspear: its rating, the Heavy Bank it gives to, the link's cap, and its flow in the boosting-and-firing test.
- A Cell Reactor in hand under the starter's unfed Pip: its port would link to the Pip (cyan).
- The same reactor turned about: it would give into a hull, so the line is wasted.
- The dev Ports Lancer on the firing test: the stores run dry at 10 s, and after 3.5 s its Lance gets 0%.
