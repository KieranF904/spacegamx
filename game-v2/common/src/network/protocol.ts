/**
 * @contract protocol
 * owns:       the protocol version pin, the wire-table summary, and the re-export of every message family
 * needs:      protocol/{clientMessages,serverCore,serverMessage,mapProtocol,worldProtocol,shipProtocol,inputBinary,compact,snapshotCodec,serverFrame}, the per-feature *Protocol.ts files
 * invariants: PROTOCOL_WIRE_HASH matches the hash of wireTables() — common/src/network/protocol.test.ts
 *             message families keep their wire ids and order — serverMessages.json
 * extend:     a new message family is a new *Protocol.ts file, re-exported below and added to the ClientMessage / ServerMessage unions
 */

/**
 * Network Protocol - All client/server message types. The types and codecs live in protocol/ (one file per
 * family: client messages, server core, map, world, ship sync, binary input, compact rows, snapshots, frames);
 * this file keeps the version pin and re-exports everything so import paths stay.
 */
export * from './econProtocol.js';
export * from './socialProtocol.js';
export * from './contributorProtocol.js';
export * from './bossProtocol.js';
export * from './fieldProtocol.js';
// (Weapon groups, the Mine Bay, Docking Clamps: docs/design/groups-mines-docking.md)
export * from './weaponGroupsProtocol.js';
export * from './minesProtocol.js';
export * from './clampProtocol.js';
export * from './tutorialProtocol.js';
export * from './combatProtocol.js';
export * from './updateProtocol.js';
export * from './replication.js';
export * from './binaryCodec.js';
export * from './protocol/clientMessages.js';
export * from './protocol/serverCore.js';
export * from './protocol/serverMessage.js';
export * from './protocol/mapProtocol.js';
export * from './protocol/worldProtocol.js';
export * from './protocol/shipProtocol.js';
export * from './protocol/inputBinary.js';
export * from './protocol/compact.js';
export * from './protocol/snapshotCodec.js';
export * from './protocol/serverFrame.js';
import { DICTIONARY } from './binaryCodec.js';
import { FX_KINDS } from './fxKinds.js';
import { packedTables } from './packed/tables.js';
import { compactInputTables } from './inputCompactTables.js';
import { BINARY_MSG_INPUT_V1, BINARY_MSG_INPUT, BINARY_MSG_INPUT_G } from './protocol/inputBinary.js';
import { COMPACT } from './protocol/compact.js';
import { SNAP_FIELDS } from './protocol/snapshotCodec.js';
import { SERVER_FRAME } from './protocol/serverFrame.js';

/**
 * The wire format's version. The client sends it in `join` and the server
 * echoes its own in `welcome`; on a mismatch the server closes the socket with
 * PROTOCOL_MISMATCH_CLOSE and the client asks the player to reload (a cached
 * old client would otherwise mis-decode every compact row, silently).
 *
 * Bump it whenever COMPACT, SNAP_FIELDS, DICTIONARY (binaryCodec.ts' head and
 * wire-dictionary.json), the binary input layout or the snapshot packing
 * changes; protocol.test.ts hashes those and fails until `npm run wire:bump`
 * has updated PROTOCOL_VERSION and PROTOCOL_WIRE_HASH.
 */
// History: PROTOCOL_CHANGELOG.md. Re-pin with `npm run wire:bump "reason"` (game-v2/), never by hand.
export const PROTOCOL_VERSION = 66;
/** The hash of the wire tables PROTOCOL_VERSION was recorded for (see protocol.test.ts) */
export const PROTOCOL_WIRE_HASH = 'ad3a71d5';
/** WebSocket close code (and reason) for a client on another protocol version */
export const PROTOCOL_MISMATCH_CLOSE = 4002;
export const PROTOCOL_MISMATCH_REASON = 'version';

/** What the encoding is defined by, for protocol.test.ts to hash (a change here needs a PROTOCOL_VERSION bump) */
export function wireTables(): Record<string, unknown> {
  return {
    compact: COMPACT,
    fxKinds: FX_KINDS,
    snapFields: SNAP_FIELDS,
    dictionary: DICTIONARY,
    binaryInput: [BINARY_MSG_INPUT_V1, BINARY_MSG_INPUT, BINARY_MSG_INPUT_G],
    // (Protocol 35: the compact inputs, CAPS.INPUTS)
    compactInput: compactInputTables(),
    serverFrame: SERVER_FRAME,
    // (Protocol 29: the bit-packed frames, CAPS.PACKED)
    packed: packedTables(),
  };
}
