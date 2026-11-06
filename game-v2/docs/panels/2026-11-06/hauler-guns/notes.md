# Ceres Hauler: guns one slot further out

Kieran: the hauler's guns had their line of sight needlessly obstructed. Each gun moved one cell outward (mirrored) in
data/ships/blueprints/hauler.json. Firing windows measured as the game derives them (derived.weapons[].window: rays cast
from the turret pivot across its mounting arc, closed where they pass through another live part).

| gun | arc (traverse) | open before | open after | open range after (offset from facing) |
|---|---|---|---|---|
| chainsaw W (uid 58) | 240 deg | 128 deg [-64, 64] | 186 deg | [-92, 94] |
| chainsaw E (uid 61) | 240 deg | 128 deg [-64, 64] | 186 deg | [-94, 92] |
| rattler W (uid 70) | 270 deg | 76 deg [-31, 45] | 180 deg | [-45, 135] |
| rattler E (uid 71) | 270 deg | 76 deg [-45, 31] | 180 deg | [-135, 45] |

What moved:
- Rattlers 70/71: x -3 to -4 and 2 to 3. A power conduit (uid 123 / 124) fills the cell they left, extending the wire from the corner.
- Chainsaws 58/61: x -5 to -6 and 4 to 5. The reactors beside them (59 / 60) moved out one cell to x -5 / 4 so they still touch the gun,
  and a hull block (uid 125 / 126) fills the cell the reactors left.

Power: all four guns still fed, same intake (chainsaw 135, rattler 77); validateBlueprint ok.

What still closes the rattlers: the remaining 45 deg on the rear side is the ion drive at (-5,4) / (4,4) and the hull below the
gun; that is the ship's own body, left as is.

fixtures/hauler.json is an old auto-wired test fixture (no "power": "ports"), not the live design; left untouched.
