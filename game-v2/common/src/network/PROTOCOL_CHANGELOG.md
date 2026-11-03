# Protocol changelog

One line per PROTOCOL_VERSION, oldest first, appended by `npm run wire:bump "reason"` (game-v2/). Do not edit by hand
except to fix a typo. A bump makes old clients reload (see PROTOCOL_VERSION in protocol.ts).

- 14 (2026-10-31): local circuits (the pilot's row carries the core's store and each store group's charge: energy.ts packCharge), the Stabiliser Anchor's brace flag and dictionary entry, and the hold's cargo mass
- 15 (2026-10-31): the Burst Strafer's dodge (input flags2 0x40/0x80, CTL.dodge bits, keyframes' dodge and charge after a station slot that's -1 undocked, the pilot's row's dodge, charge and tow after the charge groups) and the Tow Beam (the `tow` message, other pilots' status data[8]); both models in the dictionary
- 16 (2026-10-31): remove Stabiliser Anchor (input flag 0x20, CTL brace, pilot row data[14] and the keyframe's brace slot gone: cargo is data[14], charge groups from data[15], keyframe tail cargo/station/ox/oy/dodge/dodgeDir); Burst Strafer rework (dodge is one input flag 0x40 and one CTL bit, its way from the movement keys; the pilot row and keyframes carry the dodge counter and its way instead of charge spent); the wire hash now covers CTL, the keyframe tail and CHARGE_GROUPS_AT
- 17 (2026-10-31): one ship pool and banks: the pilot row's charge groups are the pool's then each bank's (1 + banks; energy.ts packCharge), data[10] the pool's; Surge, circuits and the core trickle gone
- 18 (2026-10-31): Firing models: gun-state correction slot at the end of the pilot row; charge start/cancel as shell-less fire events (partAmmo 255/254); heat fields gone from the pilot row (indices 6..) and status row (tow now at 6)
- 19 (2026-10-31): Shot behaviours: projectile row data[9] endTick (ticks to its end, before x/y); replica control bit CTL.slowed (4096); pilot row's weaponry extras (marked, slowed ticks left) after the tow; status row data[7] statuses (marked 1, slowed 2); the Frostbite's beam slows instead of chilling
- 20 (2026-10-31): gun-state slot carries reload progress in eighths
- 21 (2026-11-01): parts: the Conduit and the Diode (energy routing P4), two model ids appended to the wire dictionary
- 22 (2026-11-01): parts: the Gyro and the Heavy Gyro (reaction wheels), two model ids appended to the wire dictionary
- 23 (2026-11-02): ports energy core: a ports ship's pilot row carries its parts' triples (count negative) and the new models
- 24 (2026-11-02): ports: guns' augment buffers on the pilot row (quads), an augmented shot's flag on fire events (part + 65536)
- 25 (2026-11-03): debris clients work out themselves (debrisSplit message; debris acks on the binary input's tail); engines' power and a refused boost in the replicated control bits (CTL.noBoost 16384, power from bit 15)
