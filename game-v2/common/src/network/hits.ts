/**
 * Confirmed hits (docs/design/confirmed-hits.md, part C): the server tells a capable client only "shell s hit part p
 * of ship t", and the client works out the rest (damage, part HP, fire, the hit point, the shell's end) with the
 * shared rules (ships/hitRules.ts). This file is the wire side: the per-player switch, the record and its packing,
 * and the HP checksum the server checks a client's copy against.
 */

/**
 * What a client can do beyond the base protocol, announced in `join.caps` (a bit mask). The server accepts only the
 * bits it allows (GameServer netCaps). Later islands take the next bits.
 *
 *   HITS       confirmed hits: told "shell s hit part p of ship t", works out the rest (part C)
 *   SELF_HITS  client-detected hits (part D, needs HITS): finds its shells' hits itself on its tick-faithful layer and
 *              reports a 1-byte hash of them on its inputs; the server tells only what it couldn't find or got wrong
 *   PACKED     bit-packed frames (network/packed): reads PACKED_FRAME messages as well as the base format
 *   COALESCE   (with PACKED) frames with nothing urgent wait a few ticks (netCaps.hold) and go several to a WebSocket message
 *   OWN_SHOTS  its own straight shells come as fire events, not projectile rows, built from its own confirmed ship: it is
 *              sent its own ship's keyframes and control rows as everyone else is, so they're exact whatever its prediction
 *              did; rows (told, not found) for a window its ship is keyframed in (server ownShots.ts)
 *   ROUGH      (with SELF_HITS) adaptive validation (part E): its hit chain is checked as closely as its record calls for,
 *              at the level the server's netCaps.lvl says (CONFIRM)
 *   OWN_SIM    (with OWN_SHOTS) its own ship on its tick-aligned layer is its own: stepped from its own inputs at the
 *              ticks the server ran them, with the causes of anything else that moved it (a snapshot's own rows: pulls,
 *              contacts, rebuilds) worked out alike on both sides (network/ownTick.ts, part G). It is sent no control
 *              rows or keyframes of its own ship unless its inputs don't say what it flew with, and checks its own
 *              state with a hash on its inputs (OwnCheck)
 *   INPUTS     compact inputs (network/inputCompact.ts, protocol 35): it sends only what changed since its last input,
 *              aim as a step, by the send rules of client app/inputCompactSend.ts. The server reads both layouts anyway
 *   BODIES     (with OWN_SIM) bosses flown by their bodies on its tick-aligned layer (common bodies/, protocol 36,
 *              docs/design/decision-inputs.md): their brains' decisions come in a snapshot's `decisions` rows, and it
 *              is sent no control rows of them and keyframes only where their bodies don't say what moved them; it
 *              checks them with a hash on its inputs (BodyCheck)
 *   BLOCKS     (with PACKED) snapshots in encode-once blocks (network/packed/blocks.ts, protocol 37): other entities'
 *              status rows, keyframes, control rows and fire events are bit-packed once per snapshot for every client,
 *              named by per-system wire ids and coded from per-entity chains; the client decodes the same messages
 *   FOCUS      (protocol 38) the focus grid (network/cells.ts, docs/design/awareness-model.md section 0): it holds the
 *              ships homed in the cells within 19 km of its ship instead of a 40 km circle, the ring out to 35 km as
 *              map-dot ghosts; a dropped cell is kept 10 s and, back, fast-forwarded from a log when its hash agrees
 *   CAUSES     (with OWN_SIM, protocol 39) other ships' causes (network/causes.ts): what moved a ship it holds besides
 *              its controls (a contact, a rebuild's recentring, a pilot's pull) comes as that cause at its tick, worked
 *              out on its tick layer by the shared functions, instead of a keyframe of the ship
 *   WAYPOINTS  (with OWN_SIM, protocol 40) homing shells on its tick layer (guidance/, docs/design/awareness-model.md
 *              6.3): one in range comes once as a SYNC and flies by the shared waypoint law, planned here from its
 *              target's replica when it holds the target, else from the server's waypoint records; no rows of it after
 *   PILOTS     (with BODIES and CAUSES, protocol 41) the enemy AI's ships flown by their pilot's body on its tick layer (bodies/
 *              aiPilot.ts, docs/design/decision-inputs.md 6.5): the server's commander sends its orders, targets and
 *              strafe sides as decisions; no control rows of them
 *   CROWD      (protocol 41) crowd fallbacks (network/crowd.ts): it takes its system's crowd level (crowd message: a
 *              smaller focus radius and ghost fade, a wider snapshot window, a slower tick clock from a stated tick)
 *   STRUCTS    (with CAUSES, protocol 42) every structure a ship it holds flew: one shipSync a rebuild tick, each stamped
 *              with its tick (`at`), kept by tick (client ShipStore.derivedAt), so a window with two rebuilds of a ship,
 *              or a contact with one rebuilt since, is worked out on its tick layer, not keyframed (server bridge/structLog.ts)
 *   CARGO      (with CAUSES or OWN_SIM, protocol 42: no wire change) a ship's hold mass changing (a pickup, a sale, a tow taken on) comes
 *              as a CARGO cause at the tick it is first flown with (network/ownTick.ts), not a keyframe of the ship
 *   DEBRIS     (protocol 44) debris it worked out from a split it runs from then on (debrisSplit `l`): its parts crumble on
 *              ticks fixed at its spawn and each crumble's rebuild is worked out here (ships/debrisLife.ts), so nothing of
 *              the piece comes after its spawn (no syncs, HP, crumble effects or keyframes for its recentring) but its
 *              removal, until something else touches it (a shot, a tow: a shipSync, and it's told from then)
 *   LAUNCHES   (with WAYPOINTS: no wire change) a volley of mobs laid at once (a Rivet Sower's mines) comes as one guide
 *              LAUNCH row, its pattern and ids, each mob's run made from it in place of a SYNC a mob (guidance/launch.ts)
 *   NOSE       (no wire change) mouse-steer with its movement keys pushing along the ship (W the nose), for the view that
 *              follows the heading (client input/viewMode.ts): said by both strafe bits with helm off (ships/flight.ts
 *              noseFrame), a pair no input sent before. Without it such a client's keys push along the world, as ever
 */
export const CAPS = { HITS: 1, SELF_HITS: 2, PACKED: 4, COALESCE: 8, OWN_SHOTS: 16, ROUGH: 32, OWN_SIM: 64, INPUTS: 128, BODIES: 256, BLOCKS: 512, FOCUS: 1024, CAUSES: 2048, WAYPOINTS: 4096, PILOTS: 8192, CROWD: 16384, STRUCTS: 32768, CARGO: 65536, DEBRIS: 131072, LAUNCHES: 262144, NOSE: 524288 } as const;

/** Does this client run the debris it works out from then on (CAPS.DEBRIS)? */
export function debrisFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.DEBRIS) !== 0;
}

/** Does this client take a hold's mass changing as a CARGO cause (CAPS.CARGO)? */
export function cargoFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.CARGO) !== 0;
}

/** Does this client keep every structure a ship flew, by its rebuild tick (CAPS.STRUCTS, with CAUSES)? */
export function structsFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.STRUCTS | CAPS.CAUSES)) === (CAPS.STRUCTS | CAPS.CAUSES);
}

/** Does this client take its system's crowd level (CAPS.CROWD)? */
export function crowdFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.CROWD) !== 0;
}

/** Does this client hold the focus grid's cells rather than the view circle (CAPS.FOCUS)? */
export function focusFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.FOCUS) !== 0;
}

/**
 * Adaptive validation (CAPS.ROUGH; docs/design/confirmed-hits.md part E): how closely the server checks a finding
 * client's hit chain. Its tick-aligned layer is exact by construction, so a client that keeps agreeing is checked
 * roughly; one that disagreed is checked closely, then steps back down after a clean stretch. Damage is the server's
 * whatever the level: a level only decides how soon a client's own view of the hits is put right.
 *
 *   ROUGH   a report at most once a second (when its chain changed); judged when it comes, silence past a deadline
 *           counts as a disagreement; the server keeps only each window's chain sum. One disagreement: NORMAL, with a
 *           coarse correction (the chain, and the struck ships' HP in full)
 *   NORMAL  part D: a report every 6 input ticks when the chain changed, judged every snapshot, a correction with the
 *           hits after two disagreements running
 *   STRICT  after a correction: it finds nothing itself, every hit is told (a record); its interpolation runs two
 *           ticks later so the records are in before the frames that show them, and the server waits as much longer
 */
export const CONFIRM = { ROUGH: 0, NORMAL: 1, STRICT: 2 } as const;

/** What a confirmation level asks of the client and the server */
export interface ConfirmRules {
  /** Input ticks between two reports (at least), and the most a report waits for an input to ride on */
  reportEvery: number;
  /** It finds nothing itself: every hit is told */
  strict: boolean;
  /** Ticks more of interpolation delay (client) and of waiting for its reports (server) */
  delayTicks: number;
  /** Ticks between two hpChecks (the HP backstop) */
  checkTicks: number;
}

/** CONFIRM levels' rules, by level */
export const CONFIRM_RULES: readonly ConfirmRules[] = [
  { reportEvery: 60, strict: false, delayTicks: 0, checkTicks: 180 },
  { reportEvery: 6, strict: false, delayTicks: 0, checkTicks: 60 },
  { reportEvery: 6, strict: true, delayTicks: 2, checkTicks: 30 },
];

/** A level's rules (no level said: NORMAL, part D) */
export function confirmRules(level: number | undefined): ConfirmRules {
  return CONFIRM_RULES[level ?? CONFIRM.NORMAL] ?? CONFIRM_RULES[CONFIRM.NORMAL];
}

/** One shell's hit on a ship, as a capable client is told it */
export interface ShellHitRecord {
  /** The shell's entity id */
  shell: number;
  /** The snapshot's tick minus the hit's (0-7: older ones say 7) */
  ago: number;
  /** The ship it hit */
  target: number;
  /** The part it struck (as the shot's line met it: before a boss's cover) */
  part: number;
  /** The shell is spent (removed now; not in the snapshot's removed list) */
  gone: boolean;
  /** It barely got through the armour (the damage number shows glancing) */
  glancing: boolean;
  /** D: the damage dealt × 10, when the client's own sum would be wrong (0: show no number, a damage message has it) */
  d10?: number;
  /** S: a shield took some of it (the client leaves the HP alone: the shipHps after it has them) */
  shield?: boolean;
  /** I: the part set burning, when the client's rule would pick another (-1: none) */
  ignite?: number;
}

// Meta bits: ago (0-2), a target follows, gone, glancing, extras follow. Always under 128: one byte
const M_AGO = 7, M_NEW = 8, M_GONE = 16, M_GLANCE = 32, M_EXTRA = 64;
// Extras: D follows, S, I follows (bit 3 is kept for an explicit hit point: curving shells, later)
const X_D = 1, X_S = 2, X_I = 4;

/**
 * Records as one flat list of integers, in the order given: per hit the shell id as the step from the last one,
 * the meta byte, the target (only when it changes), the struck part, then the extras when there are any
 */
export function packHits(recs: readonly ShellHitRecord[]): number[] {
  const h: number[] = [];
  let shell = 0, target = -1;
  for (const r of recs) {
    const x = (r.d10 !== undefined ? X_D : 0) | (r.shield ? X_S : 0) | (r.ignite !== undefined ? X_I : 0);
    const fresh = r.target !== target;
    h.push(r.shell - shell, Math.max(0, Math.min(M_AGO, r.ago | 0)) | (fresh ? M_NEW : 0) | (r.gone ? M_GONE : 0) | (r.glancing ? M_GLANCE : 0) | (x ? M_EXTRA : 0));
    if (fresh) h.push(r.target);
    h.push(r.part);
    if (x) {
      h.push(x);
      if (r.d10 !== undefined) h.push(r.d10);
      if (r.ignite !== undefined) h.push(r.ignite);
    }
    shell = r.shell;
    target = r.target;
  }
  return h;
}

/** packHits undone. A list cut short or malformed gives the records read so far */
export function unpackHits(h: readonly number[]): ShellHitRecord[] {
  const out: ShellHitRecord[] = [];
  let i = 0, shell = 0, target = -1;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  while (i + 1 < h.length) {
    const ds = h[i], m = h[i + 1];
    if (!int(ds) || !int(m) || m < 0) break;
    let j = i + 2;
    if (m & M_NEW) { if (!int(h[j])) break; target = h[j++]; }
    if (target < 0 || !int(h[j])) break;
    const r: ShellHitRecord = { shell: shell + ds, ago: m & M_AGO, target, part: h[j++], gone: !!(m & M_GONE), glancing: !!(m & M_GLANCE) };
    if (m & M_EXTRA) {
      const x = h[j++];
      if (!int(x)) break;
      if (x & X_D) { if (!int(h[j])) break; r.d10 = h[j++]; }
      if (x & X_S) r.shield = true;
      if (x & X_I) { if (!int(h[j])) break; r.ignite = h[j++]; }
    }
    out.push(r);
    shell = r.shell;
    i = j;
  }
  return out;
}

/** A ship's part HP (on the wire's tenth) as one number, for the server to check a client's copy: Σ round(hp × 10) × (i + 1) mod 65536 */
export function hpChecksum(hp: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < hp.length; i++) s = (s + Math.round(hp[i] * 10) * (i + 1)) % 65536;
  return s < 0 ? s + 65536 : s;
}

// ---- Client-detected hits (part D, CAPS.SELF_HITS) ----

/**
 * One hit's share of a client's hit chain: its shell, the ship and the struck part, mixed to 32 bits. The tick is left
 * out on purpose: a hit both sides saw, a tick apart, is the same hit (only its effects' moment differs).
 */
export function hitHash(shell: number, target: number, part: number): number {
  let h = Math.imul(shell ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(target + 0x632be5ab, 0xc2b2ae35), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ Math.imul(part + 0x165667b1, 0x9e3779b1), 0x85ebca6b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The hit chain after one more hit: a sum (mod 2^32), so it doesn't depend on the order hits are seen in. A hit seen
 * in the next snapshot instead of this one puts both sides' chains back in step once both have it.
 */
export function chainAdd(chain: number, h: number): number {
  return (chain + h) >>> 0;
}

/**
 * What a client says of its hits, on its input (protocol 28): the low byte of its chain as of a snapshot's tick, and
 * the number of corrections it has taken (mod 4: a report made before the last one arrived is from the old count, and
 * is not compared). On the wire `tick` is its low 14 bits (protocol.ts encodeInputBinary); the server unwraps it.
 */
export interface HitReport { tick: number; hash: number; epoch: number }

/** A tick from its low 14 bits: the one nearest `near` (a hit report's tick, 4.5 minutes either way) */
export function unwrapTick14(low: number, near: number): number {
  const d = ((low - near) % 16384 + 16384 + 8192) % 16384 - 8192;
  return near + d;
}
