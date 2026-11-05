---
title: Energy and ports
order: 4
group: Ships
summary: Generators, batteries and banks, what draws power first, and what is changing with ports.
checked: 2026-11-04
sources: data/ships/functions.json, data/ships/models.json, data/ships/tuning.json (energy), common/src/ships/energy.ts, circuits.ts, rebuild.ts, wires.ts, power/ports.ts, docs/areas/energy.md, docs/design/energy-ports-2026-11.md
---
<!-- TODO: out of date since 2026-11-05: every library ship, enemy design and hangar design now runs on the ports core (power/ports.ts; the server sets power: ports on every design), and the pool-and-banks system below is unused by the game. Rewrite this page for ports (generators give out of their front, stores take at the back and give at the front, guns and engines take at their back, the core takes at its sides and gives fore and aft). -->

Every ship runs on energy, measured in **E**. Generators make it per second, batteries hold it, and engines, guns, shields and tools spend it. The **ENERGY** gauge on the right of the screen shows your pool. This page describes how the game runs today; the last section covers what is changing.

## Making power

| Part | Opens | Makes per cell | Notes |
|---|---|---|---|
| Cell Reactor | start | 35 E/s | The starter generator. Explodes when destroyed |
| Isotope Pile | level 9 | 18 E/s | Weak and tough. Never explodes |
| Fusion Plant | level 18 | 48 E/s | Comes as a 4-cell block, so 192 E/s. Big blast |
| Overclock Reactor | level 24 | 62 E/s | Comes as a 2-cell panel, so 124 E/s. Fragile, the biggest blast |

When a generator is destroyed it blows up a moment later (4 to 16 ticks) and damages parts around it, which can set off other generators. A damaged generator makes less power.

## Storing power

| Part | Opens | Holds per cell | Gives per cell | Notes |
|---|---|---|---|---|
| Core | start | 240 in all | 720 E/s in all | Every ship has one, so every ship has a small pool |
| Battery | start | 200 | 600 E/s | Adds to the ship's pool |
| Heavy Bank | level 20 | 300 (1,200 as a 4-cell block) | 150 E/s | Holds the most, gives slowly |
| Capacitor | level 7 | 160 | 2,000 E/s | Forms a gun bank |
| Drive Cell | level 10 | 320 | 1,400 E/s | Forms an engine bank |

The **pool** is the core's store plus every battery on a powered network. **Banks** are separate, described below.

## What draws power

| Part | Draw |
|---|---|
| Pip cannon | 8 E/s while firing |
| Rattler | 12 E/s |
| Mining Laser | 30 E/s while mining (a Cell Reactor runs about one) |
| Ion Drive | 9 E/s |
| Afterburner | 8 E/s, 60.8 E/s when boosting |
| Plasma Drive | 40 E/s |
| Deflector shield | 16 E/s per cell |
| Scanner | 4 E/s |

Every part's draw is on its card in the Component Guide (**C**). Boosting multiplies an engine's draw by `1 + 2.2 × its boost drain`; an Ion Drive's drain is 1, so it draws 28.8 E/s boosting. A Vernier or a Torch has no boost and no boost drain.

### Who is served first

1. **Steady loads** (shields, scanners, jump coils, the constructor) take theirs from generation first, in priority order: shields, then the rest.
2. **Engines** are served next, from their Drive Cell bank first, then from the ship's output.
3. **Guns, beams and mining lasers** then draw from the Capacitor bank they touch first, and share what is left equally.
4. What generation is left over refills the stores, the emptiest first.

The ship's **output** each second is its spare generation, plus what the pool gives while it holds charge. The pool gives at most 720 E/s from the core plus each battery's rate.

When there is not enough, things get slower rather than switching off:

- Engines give less thrust.
- Guns reload more slowly. A gun that is already loaded still fires.
- Beams sputter.

The HUD schematic at the top left shows it: a part short of power pulses red, and a part with nothing left goes dim.

### Example: the Sparrow T

Two Cell Reactors make 70 E/s. Cruising with both Pips firing draws 18 + 16 = 34 E/s, so the rest refills the core's 240 E. Boosting makes each Ion Drive draw 28.8 E/s, so boosting and firing is about 73.6 E/s. That is 3.6 E/s more than the reactors make, and the core's 240 E covers it for about a minute. Add two Batteries and the store grows by 400.

A **boost cell** from your quick bar refills every store on the ship at once.

## Banks

Capacitors that touch each other form a **Capacitor bank**. Drive Cells that touch each other form a **Drive Cell bank**.

| Bank | Feeds | Never feeds |
|---|---|---|
| Capacitors | Guns, beams, mining lasers and Flash Screens it touches | Engines |
| Drive Cells | Engines and Burst Strafers it touches | Guns |

A bank feeds the parts touching it **before** the ship does, as fast as it gives. Nothing else can drain it, so a ship that boosts its pool flat still reloads the guns on a Capacitor bank at full speed. A bank refills from spare generation when one of its cells is on a powered network. A **Pulse Dynamo** (level 18) needs no connection: it puts 10 E/s into each bank it touches.

Put a Drive Cell against an Afterburner, and a Capacitor against a hungry gun. The hangar's power view outlines each bank and marks the parts it feeds. In flight each bank has its own thin bar beside the ENERGY gauge (at most four).

## Connections

There are no wires to draw. A ship with no wires is wired automatically, from its generators to every part that makes, stores or uses power. Power runs through the ship's own cells, so destroying the parts between a generator and what it feeds can cut that part off. A part that touches a generator is always connected to it.

The hangar's **POWER** panel shows your networks, the pool and output, the banks, and a load test.

## What is changing: ports

Power is being reworked so that you route it. In the test version, called ports, every power part has marked in and out edges, power moves only across a shared edge from an out port to an in port, and hull, armour and cargo carry none. Batteries are where lines join and split, and a strong gun needs a line rated high enough to feed it. Some parts add tanks and pipes that change how a gun or engine behaves, and the **Y** key switches Selector parts between two tanks.

Today only a handful of test ships run on ports. The parts data already holds each part's ports, but the game ignores them for every other ship. Everything above is what a normal ship does now, and this page will be updated when the change reaches the hangar.
