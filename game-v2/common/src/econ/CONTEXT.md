# Context: common/src/econ
Items, recipes, stacks, prices, quests, profile and its migrations (pure, shared by server and client). Read docs/areas/economy-quests.md first.
Also relevant: docs/areas/ship-parts.md (generated part items/recipes), docs/areas/networking.md (econProtocol.ts), docs/areas/server-core.md (profile stores), docs/lore-canon.md (rules for quest/dialogue text).
Rule: no Date.now or I/O here; profile changes go through migrateProfile; data ids are checked by server/src/data/validateGameData.ts.
