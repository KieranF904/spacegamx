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
- 26 (2026-11-03): COMPACT rows for ignite, detonation (kind codes, fxKinds.ts), intercept, bossTelegraph, pong, boss beam/charge/blow; asteroidSeed ids and indices as ranges
- 27 (2026-11-03): Confirmed hits: COMPACT rows hits and hpCheck, join.caps, authResult.caps, client hpResync, projectile rows carry the gun that fired them (row index 8, data[10])
- 28 (2026-11-03): client-detected hits (CAPS.SELF_HITS): COMPACT hitFix row; input hit report tail (flags2 0x20: chain byte, tick14+epoch2); netCaps message
- 29 (2026-11-03): Bit-packed frames (CAPS.PACKED, network/packed: packedTables in wireTables) and coalescing (CAPS.COALESCE; netCaps.hold); packedResync
- 30 (2026-11-03): dev weapons range readout as rangeHead + compact rangeRow, changes only
- 31 (2026-11-03): replica control bits carry what part features' bursts got (CTL.share, 6 bits from bit 21: flight.ts ctlOfShare) and name the engines' power mask (CTL.power): replicas fly a short dodge or gyro turn as the ship did
- 32 (2026-11-03): Beams in pieces: a lit piece beam's ports closed field is its piece's ticks left; fire-event tell 253 (TELL_BEAM_PIECE) marks a piece spent
- 33 (2026-11-03): Mining lasers on the ports core: a miner's closed field is its pulse's ticks left; fire-event tell 252 (TELL_MINE_PULSE, aim = fulfilment 0..255) marks a pulse started
- 34 (2026-11-04): Own ship stepped by its client (CAPS.OWN_SIM 64): a snapshot's own rows (field n: pulls, contacts, rebuilds as causes) and an input's own check (flags2 0x80, 3 bytes); packed snapshots' field mask is 10 bits
- 35 (2026-11-04): Compact inputs (CAPS.INPUTS 128): first byte 0x80 | the groups that changed since the last input on the socket (tick step, keys, modes, aim as a fine or coarse step or itself, cursor distance on a log grid), seq implied; read through a per-socket InputDecoder
- 36 (2026-11-04): Decision inputs (CAPS.BODIES = 256): a snapshot's decisions rows (d, packed: decisionsIO), a body check on inputs (base layout: the first flags byte's top bit; compact: CI_EXTRA.BODY_CHECK)
- 37 (2026-11-04): Encode-once blocks (CAPS.BLOCKS = 512): PK.BLOCKS snapshots, other entities' status rows, keyframes, control rows and fire events bit-packed once per snapshot for every client, named by per-system wire ids (intros), coded from per-entity chains (network/packed/blocks.ts)
- 38 (2026-11-04): CAPS.FOCUS: the focus grid's cells message (drops, offers, logs) and cellCache reply
- 39 (2026-11-04): Other ships' causes (CAPS.CAUSES = 2048): a snapshot's causes records (field x, packed: causesIO; [ago, kind, id, ...], a contact once for both ships with states only where needed); packed snapshots' field mask is 12 bits
- 40 (2026-11-04): Scheduled waypoints (CAPS.WAYPOINTS = 4096): a snapshot's guides records (field w, packed as the decisions are; [id, dt, op, ...args]: SYNC, WP, NEXT, LOST, MODE, OFF, guidance/records.ts); packed snapshots' field mask is 13 bits
- 41 (2026-11-04): Crowd fallbacks (CAPS.CROWD = 16384): the crowd message (tick, level, focus radius, snapshot window, system tick rate)
- 42 (2026-11-04): CAPS.STRUCTS: shipSync's at (its rebuild's tick), one sync a rebuild tick
- 43 (2026-11-04): shipSync born and aloof: a piece of debris's grace and whether it knocks (DEBRIS_GRACE_TICKS)
- 44 (2026-11-04): debrisSplit l: the pieces are the client's to run from their spawn (CAPS.DEBRIS 131072)
- 45 (2026-11-04): debrisSplit g: what a ship shed whole, derived as the split's first pieces (fling, crumble, aloof)
- 46 (2026-11-04): debrisSplit s: a destroyed ship's pose as its split took it
- 47 (2026-11-04): debrisSplit c, h: a split whose parent the client has rebuilt since says its centre of mass and the pieces' HP
