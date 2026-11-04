/**
 * The compact input's constants (CAPS.INPUTS, protocol 35; the codec is inputCompact.ts). No imports: protocol.ts
 * hashes compactInputTables() into wireTables(), so a change here needs `npm run wire:bump`.
 *
 * A compact input is one byte, 0x80 | the groups that follow (CI), then only those groups:
 *   [EXTRA]  a byte of CI_EXTRA flags: what rides along (hit report, own check, body check, debris acks, a seq that isn't the next)
 *   [TICK]   the target tick as the step from the last input's (1..255; 0 = the full low 16 bits follow). Absent: +1
 *   [KEYS]   CI_KEYS as bits, low first
 *   [MODES]  CI_MODES as bits, low first
 *   [AIM]    AIM_FINE: a signed byte of CI_AIM_FINE steps of the 13-bit aim; AIM_COARSE: of CI_AIM_COARSE steps;
 *            both: the 13-bit aim itself in 2 bytes (little-endian)
 *   [DIST]   the cursor distance's step on CI_DIST's log grid as a signed byte (-128 = the grid index in 2 bytes)
 *   then: a seq (2 bytes, EXTRA SEQ), a hit report (3), an own check (3), a body check (3, CAPS.BODIES), debris acks (protocol.ts ackTail)
 * Everything not sent is as the last input on the socket said (seq: the next one), so a group that didn't change is
 * never sent. Both ends keep that last input the same way (InputDecoder), whichever format it went in.
 */

/** First byte: compact inputs have the top bit set (the base layout's type bytes are 0x01 and 0x03) */
export const CI_FLAG = 0x80;

/** The groups present, in the first byte (AIM_FINE | AIM_COARSE together: an absolute aim) */
export const CI = { EXTRA: 0x01, TICK: 0x02, KEYS: 0x04, MODES: 0x08, AIM_FINE: 0x10, AIM_COARSE: 0x20, DIST: 0x40 } as const;

/** What rides along (the EXTRA byte) */
export const CI_EXTRA = { SEQ: 0x01, HIT_REPORT: 0x02, OWN_CHECK: 0x04, ACKS: 0x08, BODY_CHECK: 0x10 } as const;

/** The on/off keys in the KEYS byte, bit 0 first */
export const CI_KEYS = ['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight', 'jump'] as const;
/** The rest of the keys (the MODES byte), bit 0 first */
export const CI_MODES = ['strafeLeft', 'strafeRight', 'helm', 'dodge'] as const;

/** Aim steps, in units of the 13-bit aim (8,192 a turn): fine 2 (0.088 deg, 11.2 deg a byte), coarse 16 (0.70 deg, 89 deg) */
export const CI_AIM_FINE = 2;
export const CI_AIM_COARSE = 16;

/** The tick byte's escape (the full low 16 bits follow) and the distance byte's (the grid index follows) */
export const CI_TICK_ESCAPE = 0;
export const CI_DIST_ESCAPE = -128;

/**
 * The cursor distance's grid (whole world units, worked out by integer steps so both ends build the same table):
 * from 0 in `step`s, each step then max(step, d >> shift) (1/256 of the distance past 1,024), up to `max`
 */
export const CI_DIST = { step: 4, shift: 8, max: 200000 } as const;

/** What the encoding is defined by (protocol.ts wireTables) */
export function compactInputTables(): Record<string, unknown> {
  return { flag: CI_FLAG, groups: CI, extra: CI_EXTRA, keys: CI_KEYS, modes: CI_MODES, aim: [CI_AIM_FINE, CI_AIM_COARSE], escapes: [CI_TICK_ESCAPE, CI_DIST_ESCAPE], dist: CI_DIST };
}
