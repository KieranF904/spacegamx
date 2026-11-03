# common/src/ships: which area guide to read
Deterministic shared code (no Date.now/Math.random, no client/server imports); never open rebuild.ts, flight.ts or energy.ts whole, grep and read the numbered section you need.
- ship-parts: types.ts, catalog.ts, rebuild.ts, grades.ts, partStats.ts, mounting.ts, features/strafer, features/tow (part features: features/README.md), support.ts, migrate.ts -> docs/areas/ship-parts.md
- energy: wires.ts, circuits.ts, energy.ts (the pool and banks every live design runs), power/ports.ts (the ports core: dev designs with power: 'ports'), power/ layout/tick/state/wire (the touch-routed core, P1: nothing runs it yet; API in the area doc's "Power core") -> docs/areas/energy.md
- flight: flight.ts, physics.ts, state.ts, load.ts, replica.ts, jumpFields.ts, hazards.ts, warmth.ts, flightInputs.ts (the controls both sides build) (collide.ts/stages.ts hit tests: weapons, bosses-ai) -> docs/areas/flight.md
- part features (the registry, being migrated to): features/README.md (types.ts, plan.ts, generated registry.ts; npm run features:gen)
- weapons: damage.ts (types, armour), hitRules.ts (what a shell's hit does, the server's and a client's alike), launch.ts, guns.ts, shot.ts -> docs/areas/weapons.md
