# Protocol changelog

One line per PROTOCOL_VERSION, oldest first, appended by `npm run wire:bump "reason"` (game-v2/). Do not edit by hand
except to fix a typo. A bump makes old clients reload (see PROTOCOL_VERSION in protocol.ts).

- 14 (2026-10-31): local circuits (the pilot's row carries the core's store and each store group's charge: energy.ts packCharge), the Stabiliser Anchor's brace flag and dictionary entry, and the hold's cargo mass
- 15 (2026-10-31): the Burst Strafer's dodge (input flags2 0x40/0x80, CTL.dodge bits, keyframes' dodge and charge after a station slot that's -1 undocked, the pilot's row's dodge, charge and tow after the charge groups) and the Tow Beam (the `tow` message, other pilots' status data[8]); both models in the dictionary
