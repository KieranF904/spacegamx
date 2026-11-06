---
title: Bosses, new enemies and a much lighter network
tags: [bosses, enemies, graphics, mining, network]
status: draft
slug: bosses-enemies-netcode
date: 2026-11-07
summary: The Scrap Mother fight reworked, ten enemies with their own designs, a rebuilt Helios Array, redone freighters, a new belt rock and faster mining, and the netcode rebuilt so the game sends a fraction of what it used to.
cover: ../../../docs/panels/site-posts/2026-11-07-custom-enemies.jpg
---

So the last week has mostly been two things: making the fights worth having, and rebuilding how the game talks to the server so those fights don't cost a fortune in bandwidth. There's a fair bit of graphics work mixed in as well.

None of this is on the live server yet. It all goes out in one big update once the dev version is solid, so this is a look at what's coming.

Where there's an old and new picture, the old one is on the left and the new one on the right.

## Bosses

### The Scrap Mother

The Scrap Mother fight has been rebuilt from the ground up. The old version was long and turned into a bullet hell, which wasn't much fun. Now she has three signature moves a stage, each with a clear warning before it lands, a light threat in between so you're never just waiting around, and windows where she opens up and you can actually do damage.

![The Scrap Mother fight](../../../docs/panels/site-posts/2026-11-07-scrap-mother-fight.jpg)

Every move tells you what's coming. The label up top says which one is next, and the boss itself winds up before it goes: the crane arms swing out for a haul, the intake opens up when she's about to pull you in, and so on. The idea is that if you're watching, you can dodge it.

![Her next move called out before it happens](../../../docs/panels/site-posts/2026-11-07-scrap-mother-haul-tell.jpg)

![The intake opening up](../../../docs/panels/site-posts/2026-11-07-scrap-mother-intake.jpg)

![A spiral attack with a window to hit back](../../../docs/panels/site-posts/2026-11-07-scrap-mother-spiral-window.jpg)

She also has personal attacks now. Each pilot in the fight draws their own from the stage's pool, so it isn't just one big pattern for everyone to stand outside of.

She lives in a proper lair now too: a hollowed out asteroid with chambers, tunnels and a barrier at the arena, with scrap heaps and her little ones roaming the chambers on the way in.

### Windows you can see

When a boss opens up, you can tell. The weak points glow and pulse while the window is open, there's a meter for how long you've got, and the weak points crack as you hit them.

![The Scrap Mother's window, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-boss-exposure-mother-before-after.jpg)

![The weak points cracking under fire](../../../docs/panels/site-posts/2026-11-07-boss-exposure-crack.jpg)

The Pyreclast got the same treatment, along with its own rework: limbs you can break, stages, its own windows and personal attacks, and a side chamber full of heat vents.

![The Pyreclast with a window open](../../../docs/panels/site-posts/2026-11-07-boss-exposure-pyreclast.jpg)

### Heart of the Maw

The Heart of the Maw got a redesign. It looks grown now rather than built, with veins of light running through the stone to a glowing core.

![The Heart of the Maw](../../../docs/panels/site-posts/2026-11-07-maw-heart.jpg)

## Enemies

Every enemy used to be built from the same player parts as everyone else, which made them all look a bit samey. Now there are ten enemies with their own designs, drawn properly instead of out of blocks. They each have their own way of fighting too: the Slag Ray makes runs at you, the Clinker lobs its shells, the Hookboat grapples, and the Helios Drone hangs back and plinks at you from range.

![The enemy roster](../../../docs/panels/site-posts/2026-11-07-custom-enemies.jpg)

Enemies also live in the world now. They're placed in advance and stay where they are, so an area that has pirates in it always has pirates in it. You can see them on the map as ghosts before you get there, and when you clear an area they come back one at a time instead of all at once.

## Hits and engines

Hits scale with the gun now. A light gun gives a quick flick of sparks, and a heavy one a proper blast that throws fragments off the hull. This is every tier side by side, the original on the top row and now on the bottom:

![Impacts by gun tier, original (top) and now (bottom)](../../../docs/panels/site-posts/2026-11-07-impacts-by-tier.jpg)

![A heavy hit now](../../../docs/panels/site-posts/2026-11-07-big-hit-now.jpg)

![Hits on a pirate gunship](../../../docs/panels/site-posts/2026-11-07-surface-impacts.jpg)

Every engine model has its own flame now as well, so you can tell what someone's flying from across the screen.

![Engine looks](../../../docs/panels/site-posts/2026-11-07-engine-looks.jpg)

## Ships

The freighters got redone. Before, they were mostly empty boxes. Now they're properly armed and shielded, their boost actually does something, and they jump further. They also shoot back now: if you attack one, its guns lock on to you while it keeps flying its route.

![The hauler, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-hauler-redo-before-after.jpg)

## The world

The Helios Array, the big solar ring round the sun, has been rebuilt as an actual megastructure: rows of solar panels on trusses, hubs and spokes, lit from the sun side.

![The Helios Array, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-helios-array-before-after.jpg)

Terra Nova got reworked too, with climates, mountain ranges, shallows and smaller polar caps.

![Terra Nova, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-terra-nova-2026-11-before-after.jpg)

And the asteroids got a pass: each rock has its own tone, craters and hollows, and ore glints on the rich ones, without costing any more to draw.

![Asteroids](../../../docs/panels/site-posts/2026-11-07-asteroids-glasswater.jpg)

## Mining

Mining was way too slow, so it's been reworked. Chunks come off the rock as you work it, drops come about three times as often as before, and you get about twice the ore a second. There's a ring on the rock you're working so you can see how close the next drop is.

![Mining a rock with the progress ring](../../../docs/panels/site-posts/2026-11-07-mining-progress-ring.jpg)

There's a new rock in the belt as well. Taenite is small, dense and pale brass, and it's rich in nickel. It's about 1 in 20 rocks, so it's worth going out of your way for.

![The belt before Taenite (left) and with it (right)](../../../docs/panels/site-posts/2026-11-07-taenite-belt-before-after.jpg)

## Joining

The join screen is simpler now. There's one Join button for the main server, a short description with some pictures, and a news feed so you can see what's changed.

![The join screen](../../../docs/panels/site-posts/2026-11-07-join-screen.jpg)

## The network

This is the big one, even if you can't see it. I've rebuilt how the game keeps everyone in sync.

Before, the server worked everything out and sent you the results: where every ship was, every shot, every hit. Now the game runs the same simulation on your machine as on the server, step for step, so it can work most of that out itself. The server mostly sends what it can't know: what other players pressed, what the AI decided, and the occasional correction.

That covers your own ship, other players' ships and their gunfire, AI enemies, bosses and their moves, debris, homing shells and grapples. On top of that:

- Everything is bit-packed: the numbers are squeezed down to the bits they need.
- Inputs only go when they change something. If you're turning flat out, moving the mouse around doesn't change how your ship turns, so the game doesn't send it.
- Nearby ships get full detail, and distant ones fade to ghosts on a much lighter feed.
- When a ship comes back into range, you only get what changed while it was away.
- When a system gets really busy, its time slows down a little instead of everyone lagging.
- Loot and mining rolls are done with a secret only the server has, so a modified game can't predict them.

This is what you download a second, the version on the live server against now:

| What you're doing | Live version | Now | Change |
|---|---:|---:|---:|
| Sitting idle | 2,664 B/s | about 200 B/s | 92% less |
| Cruising | 2,724 B/s | about 550 B/s | 80% less |
| Mining | 2,056 B/s | about 515 B/s | 75% less |
| In a crowd of 100 | 11,668 B/s | about 1,900 B/s | 84% less |

And the last round, which was all about fights:

| Fight | Before | After |
|---|---:|---:|
| 20 pilots in one fight | 3,729 B/s | 2,552 B/s |
| 50 pilots in one fight | 13,297 B/s | 10,636 B/s |
| Boss fight with 20 pilots | 4,162 B/s | 3,549 B/s |

The best part is that none of this adds any delay. Other players' shots come out exactly where and when they really fired.

## What's next

Mostly play testing all of the above and fixing what turns up, then getting it all onto the live server in one go. Your existing ships will be swapped for their new versions in the update, and you keep your progress.
