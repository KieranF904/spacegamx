# common/src/ships: which area guide to read
Deterministic shared code (no Date.now/Math.random, no client/server imports); never open rebuild.ts, flight.ts or energy.ts whole, grep and read the numbered section you need.
- ship-parts: types.ts, catalog.ts, rebuild.ts, grades.ts, partStats.ts, mounting.ts, strafer/tow/support.ts, migrate.ts -> docs/areas/ship-parts.md
- energy: wires.ts, circuits.ts, energy.ts, surge.ts -> docs/areas/energy.md
- flight: flight.ts, physics.ts, state.ts, load.ts, replica.ts, jumpFields.ts, hazards.ts, warmth.ts, flightInputs.ts (the controls both sides build) (collide.ts/stages.ts hit tests: weapons, bosses-ai) -> docs/areas/flight.md
