/**
 * @contract network.replication
 * owns:       the entry point for ship motion on the wire: re-exports the row codecs, the replica set's hosts and the
 *             client's ShipReplicaSet from network/replication/, so import paths stay
 * needs:      network/replication/{wire,hooks,ShipReplicaSet}
 * invariants: a client rebuilds every other ship exactly from keyframes, control changes and causes against the
 *             server's state — server/src/net/replication.test.ts
 *             bit-packed and base frames decode to the same snapshot — common/src/network/packed/packedCodec.test.ts
 * extend:     a new keyframe field goes in replication/wire.ts (packKeyframe / unpackKeyframe, npm run wire:bump); a new
 *             thing a replica is moved by is a source or cause in replication/hooks.ts passed to ShipReplicaSet
 */

/**
 * Ship motion on the wire (see ships/replica.ts), in network/replication/:
 *   wire.ts            keyframe and control-row packing (the row formats are described there)
 *   hooks.ts           what the replica set asks of its hosts (own timeline, bodies, causes, rewinds, side steps, debris)
 *   ShipReplicaSet.ts  every other ship's timeline on the client, stepped on demand and rewound when news comes late
 *   debris.ts          the debris world inside it, stepped all together
 *   pose.ts            where a ship is drawn between ticks, corrections bent in or eased out
 *   rep.ts             what it keeps per ship, and the helpers its parts share
 */

export * from './replication/wire.js';
export * from './replication/hooks.js';
export { ShipReplicaSet } from './replication/ShipReplicaSet.js';
