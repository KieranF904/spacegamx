# Archived scripts

One-off scripts whose job is done (the data they rewrote is already rewritten). Kept for reference and in case a similar
refit is needed; none are run by npm scripts, tests or deploys. Paths inside were adjusted for this folder, but they have
not been run since the move.

- `add-batteries.ts`, `merge-thrusters.ts`: refit passes over the player ship plans (battery rules, bigger engines).
- `econ/migrate-blueprints.mjs`: moved the legacy parts of the library blueprints to models (docs/parts-redesign.md).
- `econ/retireKits.mjs`: replaced repair kits and insurance bonds with material packs (docs/design/field-fabrication.md).
