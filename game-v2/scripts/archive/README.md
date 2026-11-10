# Archived scripts

One-off scripts whose job is done (the data they rewrote is already rewritten). Kept for reference and in case a similar
refit is needed; none are run by npm scripts, tests or deploys. Paths inside were adjusted for this folder, but they have
not been run since the move.

- `merge-thrusters.ts`: a refit pass over the player ship plans (bigger engines). (`add-batteries.ts`, the pool core's battery refit, went with the pool core.)
- (`econ/migrate-blueprints.mjs`, which moved the library blueprints' legacy parts to models, went with the ship migration it called, 2026-11-10.)
- `econ/retireKits.mjs`: replaced repair kits and insurance bonds with material packs (docs/design/field-fabrication.md).
