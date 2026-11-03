# Context: common/src/network
Wire protocol, codec, ship replication. Read docs/areas/networking.md first (message/pilot-row/CTL tables, bump workflow).
Also relevant: docs/areas/server-core.md (where messages are handled/sent), docs/areas/flight.md (FlightBody, replicaStep), docs/areas/energy.md (charge in the pilot row), docs/areas/economy-quests.md (econProtocol.ts bodies).
`inputFields.ts` lists the pilot's input fields once (`INPUT_BOOLS`, `INPUT_HELD`, `INPUT_NUMBERS`), used by the server's `applyInputToEntity`/`releaseControls` (net/handlers/flight.ts) and the client's `app/inputSend.ts`; see docs/areas/server-core.md.
`packed/` is the bit-packed frame format (CAPS.PACKED, protocol 29): tables.ts (hashed) and packedCodec.ts; see docs/design/packed-frames.md.
Rule: any wire-table change needs `npm run wire:bump "reason"` (and `npm run wire:sync` for new part/material/piece ids). Do not read protocol.ts whole.
