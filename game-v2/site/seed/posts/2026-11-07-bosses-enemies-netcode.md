---
title: Bosses, new enemies and a much lighter network
tags: [bosses, enemies, graphics, mining, network]
status: draft
slug: bosses-enemies-netcode
date: 2026-11-07
summary: The Scrap Mother reworked, ten new enemy designs, a rebuilt Helios Array, new freighters, faster mining and a new netcode.
cover: ../../../docs/panels/site-posts/2026-11-07-custom-enemies.jpg
---

Here's what I've been working on this week. None of it is live yet; it all goes out in one update. Old is on the left, new on the right.

## Bosses

The Scrap Mother fight has been reworked. It was too long and turned into a bullet hell. Now each stage has a few signature moves with a clear warning before each one, and windows where she opens up to take damage.

![The Scrap Mother fight](../../../docs/panels/site-posts/2026-11-07-scrap-mother-fight.jpg)

![Her next move called out](../../../docs/panels/site-posts/2026-11-07-scrap-mother-haul-tell.jpg)

![The intake opening](../../../docs/panels/site-posts/2026-11-07-scrap-mother-intake.jpg)

![A spiral attack with a window](../../../docs/panels/site-posts/2026-11-07-scrap-mother-spiral-window.jpg)

When a boss opens up, its weak points glow, and they crack as you hit them.

![The Scrap Mother's window, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-boss-exposure-mother-before-after.jpg)

![Weak points cracking](../../../docs/panels/site-posts/2026-11-07-boss-exposure-crack.jpg)

The Pyreclast got the same rework, with limbs you can break.

![The Pyreclast with a window open](../../../docs/panels/site-posts/2026-11-07-boss-exposure-pyreclast.jpg)

And the Heart of the Maw has a new look.

![The Heart of the Maw](../../../docs/panels/site-posts/2026-11-07-maw-heart.jpg)

## Enemies

Ten enemies now have their own designs instead of being built from player parts, and each fights its own way.

![The enemy roster](../../../docs/panels/site-posts/2026-11-07-custom-enemies.jpg)

Enemies also stay put in the world now, and show on the map before you get there.

## Hits and engines

Hits scale with the gun, from a flick of sparks to a proper blast. Original on top, now on the bottom:

![Impacts by gun tier](../../../docs/panels/site-posts/2026-11-07-impacts-by-tier.jpg)

![A heavy hit](../../../docs/panels/site-posts/2026-11-07-big-hit-now.jpg)

![Hits on a pirate gunship](../../../docs/panels/site-posts/2026-11-07-surface-impacts.jpg)

Every engine has its own flame.

![Engine looks](../../../docs/panels/site-posts/2026-11-07-engine-looks.jpg)

## Ships and the world

I was going to wipe everyone's ships for the new power system, but since there are only a handful of players with a handful of custom ships, I've had them remade on the new system instead. They'll be swapped in when the update goes live.

The freighters are redone: armed, shielded, and they shoot back if you attack them.

![The hauler, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-hauler-redo-before-after.jpg)

The Helios Array is rebuilt as a proper megastructure.

![The Helios Array, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-helios-array-before-after.jpg)

Terra Nova and the asteroids got reworked too.

![Terra Nova, old (left) and new (right)](../../../docs/panels/site-posts/2026-11-07-terra-nova-2026-11-before-after.jpg)

![Asteroids](../../../docs/panels/site-posts/2026-11-07-asteroids-glasswater.jpg)

## Mining

Mining is a lot faster: more drops, more ore, and a ring on the rock showing how close the next drop is.

![Mining with the progress ring](../../../docs/panels/site-posts/2026-11-07-mining-progress-ring.jpg)

There's also a new nickel-rich rock, Taenite, about 1 in 20 rocks in the belt.

![The belt without Taenite (left) and with it (right)](../../../docs/panels/site-posts/2026-11-07-taenite-belt-before-after.jpg)

## Joining

The join screen is simpler, with one Join button and a news feed.

![The join screen](../../../docs/panels/site-posts/2026-11-07-join-screen.jpg)

## The network

I've rebuilt the netcode. Your game now runs the same simulation as the server, so the server mostly just sends what other players pressed and what the AI decided, instead of where everything is.

What you download a second, the live version against now:

| What you're doing | Live version | Now | |
|---|---:|---:|---:|
| Sitting idle | 2,664 B/s | 168 B/s | 94% less |
| Cruising | 2,724 B/s | 342 B/s | 87% less |
| Mining | 2,056 B/s | 314 B/s | 85% less |
| In a crowd of 100 | 11,668 B/s | 1,714 B/s | 85% less |
| Fighting the Scrap Mother | 6,036 B/s | 2,456 B/s | 59% less |

None of it adds delay: other players' shots land exactly where and when they fired.
