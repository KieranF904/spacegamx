---
title: Building a ship
order: 3
group: Ships
summary: The hangar, structure and modules, materials, build points, mounting rules, and what a design costs.
checked: 2026-11-04
sources: client/src/ships/HangarUI.ts, common/src/ships/blueprint.ts, grid.ts, mounting.ts, grades.ts, rating.ts, partStats.ts, rebuild.ts, data/ships/materials.json, pieces.json, models.json, tuning.json, data/unlocks.json, data/recipes.json, common/src/econ/salvage.ts, market.ts
---
## The hangar

Dock at a station (**H** inside the docking ring) and open the **Ships** tab. Each slot there is one ship. You start with **5 hangar slots** (a sixth at level 30, a seventh at level 50) and **10 design slots** for saved plans.

In the hangar you place parts on a grid:

| Key | Does |
|---|---|
| **R** | Rotate the selected part |
| **F** | Flip it |
| **T** | Cycle its facing: auto, then N, E, S, W (for guns, engines and mining tools) |
| Arrow keys | Move the view |
| **Esc** or **H** | Close the hangar |

Parts are shown as soon as you place them, even ones you do not have yet. A part you cannot afford is a **ghost** until it is built. **Save** puts what you have into the slot and turns the rest into ghosts to build.

## Structure and modules

Every ship is **structure** plus **modules**.

| | Structure | Modules |
|---|---|---|
| What | Hull, armour, cargo holds | Core, generators, batteries, engines, guns, shields, mining tools, scanners, jump coils |
| Made by | Placed in the hangar and paid in refined plate on the spot | Fabricated at a station, kept as items until a ship takes them |
| Material | Any material you have unlocked | Each model has its own fixed material |

A ship has **exactly one core**, and every part must touch the rest by a full edge, in a chain back to the core. A ship can have at most **255 parts**.

| Structure part | HP | Mass | Notes |
|---|---|---|---|
| Hull | ×1 | ×1 | Holds the ship together |
| Armour | ×2.5 | ×2.5 | One grade harder to get through. Slows the ship |
| Cargo Hold | ×0.8 | ×1 | Adds 25 hold space per cell |
| Core | ×2 | ×1 | Holds 30 units of cargo, a 240-unit energy store and the first coil of the jump drive |

A part's HP is `toughness × cells × its multiplier`. A single alloy hull cell has 75 HP, an alloy armour cell 187.5.

## Pieces

Every part is one of these shapes. The number is how many cells it covers.

| Piece | Cells | Piece | Cells |
|---|---|---|---|
| Square | 1 | Dome | 4 |
| Panel | 2 | Wide Fillet | 3 |
| Wedge | 1 | Wedge Nose | 4 |
| Slope | 2 | Block | 4 |
| Nose Cap | 2 | Long Block | 9 |
| Round | 1 | Fillet | 1 |

Round, wedge, slope and fillet pieces are partial cells, so a round piece counts as about 0.79 of a cell for mass and cost. Most modules come in only one or two pieces.

## Materials

Structure takes any material you have unlocked. A better material is tougher and raises the output of parts built in it, but also costs more build points. Nothing opens a material early.

| Material | Opens | Grade | HP per cell | Density | Notes |
|---|---|---|---|---|---|
| Alloy | start | I | 75 | 1.0 | Takes full damage from everything |
| Composite | level 3 | I | 50 | 0.7 | Light. Takes 1.2× kinetic, 0.8× energy |
| Steel | level 5 | II | 94 | 1.4 | Takes 0.85× kinetic and 0.9× explosive, but 1.2× energy |
| Titanium | level 12 | III | 112 | 1.0 | Takes 0.85× thermal and 0.9× cryo |
| Cobalt | level 22 | IV | 131 | 1.2 | Takes 0.85× kinetic, 1.15× energy |
| Neutronium | level 32 | V | 150 | 1.35 | Takes 0.75× kinetic, 1.3× cryo |

Some special materials open later and trade strength for a trait:

| Material | Opens | Trait |
|---|---|---|
| Insulated Polymer | level 10 | Takes 0.45× energy and 0.7× cryo, but 1.4× thermal. Light, HP 52 |
| Leestone | level 12 and a job | Heavy, repairs cost more, tolerates radiation |
| Dense Ferrite | level 30 | Very dense (2.2), takes 0.7× kinetic. Its mass counts double towards tolerating gravity wells |
| Conductive Steel | level 35 | Takes 0.8× kinetic but 1.6× energy |
| Ceramic Laminate | level 45 | Takes 0.45× thermal but 1.35× kinetic and 1.3× explosive |
| Leaded Iridium | level 45 | Heavy, tolerates radiation |
| Sealed Composite | level 45 | Takes 0.6× cryo, tolerates corrosion |

A material also sets how much a hit hurts: see [Weapons and damage](/guides/weapons-and-damage).

## Build points

How big a ship you can build is a budget that grows with your level. Every cell costs build points by its grade:

| Grade | I | II | III | IV | V |
|---|---|---|---|---|---|
| Points per cell | 1 | 1.6 | 2.5 | 3.8 | 5.5 |

A big Mk I ship and a small Mk III ship cost about the same. Some parts have their own cost per cell.

| Level | Budget | Level | Budget |
|---|---|---|---|
| 1 | 60 | 24 | 155 |
| 5 | 75 | 28 | 175 |
| 8 | 90 | 34 | 195 |
| 12 | 105 | 40 | 215 |
| 16 | 120 | 46 | 245 |
| 20 | 135 | 54 | 275 |

The budget keeps growing up to 455 at level 90.

## Mounting rules

Guns have rules about where they can sit. The hangar flags a part that breaks them, and it will not save a new design with a broken part.

- A gun fires out of its **facing** edge, which must be free. Nothing may be across it.
- Most guns **bolt on** at the opposite edge, so a gun needs hull or another part behind it. Some can bolt on at any side, and flak and a few round emitters mount from the side.
- Heavy guns need **clear cells ahead** for the barrel: the Hammer needs 1, the Bastion 2, the Longbarrel and Spear 3.
- A **fixed** gun points where the ship points. A **turret** swings within an arc, from 120 degrees (Overpulse) up to 360 (Lobber, Searchlight), and only through gaps in your own hull.

Each part's card in the hangar lists its rules in words.

## Mass, speed and turning

- Mass is the sum of each part's cells × material density × its mass multiplier.
- Acceleration is the thrust of your engines in the direction you ask, divided by mass. Armour and heavy materials slow you; a full hold slows you more.
- Engines point at their **facing**. An engine pushing the wrong way adds little, so put engines on the back and a few smaller ones on the flanks for turning and strafing.
- Turning comes from the core, from engines away from the centre, and from Gyro parts, which turn the ship without pushing it.

Stock designs for comparison (build points are for the design as saved):

| Ship | Parts | Build points | Mass | Guns | Hold |
|---|---|---|---|---|---|
| Sparrow T | 14 | 14 | 14 | 2 | 30 |
| Drum | 15 | 24 | 21 | 2 | 30 |
| Prospector | 17 | 16 | 19 | 2 | 80 |
| Arrow | 21 | 27 | 20 | 2 | 30 |
| Bulwark | 30 | 31 | 42 | 3 | 30 |
| Corsair | 36 | 49 | 46 | 8 | 30 |
| Lancer | 100 | 291 | 279 | 10 | 30 |
| Galleon | 162 | 448 | 409 | 18 | 30 |
| Hammerhead | 211 | 578 | 500 | 18 | 30 |
| Bastion | 210 | 601 | 537 | 22 | 30 |
| Hauler | 85 | 231 | 215 | 0 | 530 |

## Jump drive and hull size

The core has a coil good for a hull of about **40 cells**. Each Jump Coil square covers 12 more, a Heavy Coil 64 more and also shortens the cooldown by a fifth. A hull bigger than its coils need reaches less and recharges slower, down to 30,000 range and a 25 second cooldown for the biggest ships. The hangar shows the ratio.

## What a design costs

- **Structure** is paid in plate when you place it. A Mk I or II cell costs 1 plate of its material, a Mk III or IV cell 2, a Mk V cell 3. Armour costs one more plate per cell, and a cargo hold half a plate more (rounded up per part).
- **Modules** are fabricated. Each model has its own recipe (plate, wire and sometimes components) and its own time, listed in the Component Guide (**C**). The starter parts are made at once: a Pip takes 2 alloy plate and 1 copper wire, a Cell Reactor 1 plate and 2 wire. A Hammer takes 40 seconds, a Bastion or a Fusion Torch 320 seconds. The core is the slowest: 6 times the usual 20 seconds a cell.
- Put a ship **on order** and the hangar refines ore from storage, fabricates the modules and fits everything as it is ready. See [Mining and refining](/guides/mining-and-refining) for plate.
- **Scrapping** a ship or a module gives back 70% of its minerals as ore and every component in full.
- A ship built from a **plan** you know builds as designed.

## The Component Guide

Press **C** for every part: the level it opens at, what still blocks it for you, what making it takes, and its full numbers. The same numbers appear in tooltips in the hangar, and under the ship summary there you can compare your design against the one you fly.
