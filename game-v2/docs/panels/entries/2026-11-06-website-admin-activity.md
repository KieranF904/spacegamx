---
date: "2026-11-06"
category: "website"
topic: "admin activity feed"
status: "after only"
files:
- "2026-11-06/admin-activity/activity-feed.png"
- "2026-11-06/admin-activity/activity-pilot.png"
---
A new Activity section in the website's admin panel: a live list (newest first, every 4 s, with Pause) of sign-ins and sign-outs, new accounts and account changes, joins and leaves with session length, public chat lines, admin commands, kicks, refused sign-ins, old clients and server errors, from every game server and the lobby. Filters by source, server, event and pilot, a search, and a per-pilot view (click a name). Gameplay events (deaths, boss fights, sales, trades, crafting, docking, level-ups and so on) are kept in the code but off by default (ACTIVITY_TYPES switches them on). Private messages are never kept. The dev site reads the local lobby and the production lobby; production shows "not available yet" until the new build is deployed. Shots from a scratch lobby, game server and website with a fake WebSocket client, so there's no before; the second shot is the per-pilot view for orion.
