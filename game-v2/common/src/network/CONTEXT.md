# Context: common/src/network
Wire protocol, codec, ship replication. Read docs/areas/networking.md first (message/pilot-row/CTL tables, bump workflow).
Also relevant: docs/areas/server-core.md (where messages are handled/sent), docs/areas/flight.md (FlightBody, replicaStep), docs/areas/energy.md (charge in the pilot row), docs/areas/economy-quests.md (econProtocol.ts bodies).
Rule: any wire-table change needs `npm run wire:bump "reason"` (and `npm run wire:sync` for new part/material/piece ids). Do not read protocol.ts whole.
