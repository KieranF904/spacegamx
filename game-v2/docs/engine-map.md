# Engine map (retired: now an index)

This file used to hold 600 lines of engine notes from the modular-ships prototype. They were moved into the area guides
(`docs/areas/`, see the router `DEVELOPMENT.md`); content describing code that no longer exists was dropped (the
original tour of `createPlayer`, `ACCEL_BASE` physics, `Equipment`/`WeaponState`/`Shield` components, the equipment
weapons, the triangle ship; the "changes to existing files" merge checklist).

| Old section | Now in |
|---|---|
| Layout, Q1-Q6, prototype integration, live game integration, collision/server performance, data validation, safeguards | [server-core](areas/server-core.md) |
| Ship decisions, grades/sizes/rating, engines, capital ships | [ship-parts](areas/ship-parts.md) |
| Flight damage, jump drive, stillstone fields, bigger/faster ships, docking, anchor, cargo | [flight](areas/flight.md) |
| Energy and batteries | [energy](areas/energy.md) |
| Weapons, fixed gun aim, part deaths, decay, station repair | [weapons](areas/weapons.md) |
| Bosses, enemies, grades, the Drift | [bosses-ai](areas/bosses-ai.md) |
| Sectors, rifts, planets, derelicts, hazards, far ships and world memory, surfaces, moon sieges | [world-sim](areas/world-sim.md) |
| Economy, hangar jobs, salvage, levels, people, quests, records, profiles | [economy-quests](areas/economy-quests.md) |
| Networking: replication, prediction clock, view range, wire format | [networking](areas/networking.md) |
| Rendering: frame cost, sky, lighting, stations, shaders | [render-world](areas/render-world.md) |
| Thrusters, part hardware, damage effects, viewer | [render-ships](areas/render-ships.md) |
| Menu, settings, rebinding, map, nav markers, audio, admin tools | [ui-hud-input](areas/ui-hud-input.md) |
| Hangar refit flow, proto tools | [hangar-ui](areas/hangar-ui.md) |
| Sound generation, performance pass 2026-10-25 | [ops-tools](areas/ops-tools.md) |
