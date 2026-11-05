---
date: "2026-11-04"
category: "graphics"
topic: "projectile-surface-impacts"
files:
- "graphics/projectile-surface-impacts-before.png"
- "graphics/projectile-surface-impacts-after.png"
- "graphics/projectile-surface-impacts.png"
numbers: "Shells drawn inside or through a hull before their impact, 12 live scenarios (Gale's Sparks and Chainsaws, the Hammerhead's Rattler stream; point-blank, 300, 1,000; caps 15 and 0): 20-120 a scenario before, 0 after. Shells with any drawn part past their impact point: 2-21 a scenario (up to 557 units) before, 0 after."
---
Weapons range, live dev client, against the Tallyman hull: each row is four frames about 0.1 s apart (top: the Gale at about 300, Sparks and Chainsaws; middle: the Hammerhead's stream at point-blank; bottom: the Gale at point-blank). Before, a shell flew on until the server's hit for it came, so tracers ran into and through the hull (up to 160 units inside) and then snapped back, and a hit on a shell already past left its tail beyond the impact. Now every drawn shell, yours or another ship's, stops at the first surface it touches as drawn (the hull's real part shapes at the pose it's drawn at, or a raised shield's bubble), in that frame, with its impact there; its tracer collapses into that point. The server's hit only confirms the damage: it never moves the impact, draws a second one, or brings an ended shell back (a late hit, the adopt path, a later row). Piercing shells mark each hull they pass; shells pass their own shooter and ships the server lets them through. Beams already stopped at hulls and now stop at a raised shield too.
