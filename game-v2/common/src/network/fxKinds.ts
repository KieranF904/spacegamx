/**
 * The detonation kinds the server sends, by number (the wire form of `detonation.kind`).
 *
 * APPEND ONLY: an index is the wire format, and the list is hashed into the wire tables (protocol.ts wireTables), so
 * adding a kind needs `npm run wire:bump`. A kind that is not listed still works: it goes as its string.
 * fxKinds.test.ts holds the weapon kinds to being listed.
 */
export const FX_KINDS: readonly string[] = [
  // the weapon kinds (WEAPON_KIND_TYPE order)
  'cannon', 'missile', 'railgun', 'flak', 'emp', 'hive', 'cinder_bloom', 'prism', 'prism_shard', 'phase', 'singularity',
  'pulse', 'autocannon', 'arc', 'torpedo', 'mortar', 'charge', 'magma', 'heart_spark', 'heart_seeker', 'rivet', 'scrap_chunk',
  'seam_seeker',
  // chain lightning, mobs, bosses
  'tesla_arc', 'mob_burst', 'mob_fizzle', 'eruption', 'synapse', 'scrap', 'sludge',
];

const INDEX = new Map(FX_KINDS.map((k, i) => [k, i]));

/** A kind's number, or its string when it is not listed */
export function fxKindCode(kind: string): number | string {
  return INDEX.get(kind) ?? kind;
}

/** The kind a wire value stands for */
export function fxKindName(code: number | string): string {
  return typeof code === 'number' ? FX_KINDS[code] ?? String(code) : code;
}
