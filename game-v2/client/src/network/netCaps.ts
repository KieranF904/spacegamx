/**
 * What this client offers the server in its join (common network/hits.ts CAPS): confirmed and client-detected hits
 * (ships/hits/ConfirmedHits.ts clientCaps), and bit-packed frames with coalescing (common network/packed): on by default
 * (common DEFAULT_CAPS, dev and production builds alike); `?packed=0|1` and `?coalesce=0|1` switch them (remembered), as do `?ownshots=0|1` (its own shells as fire
 * events), `?rough=0|1` (adaptive validation, with client-detected hits), `?ownsim=0|1` (its own ship stepped by itself), `?compact=0|1` (compact inputs: common
 * network/inputCompact.ts) and `?bodies=0|1` (bosses flown by their bodies from their brains' decisions, with ownsim:
 * docs/design/decision-inputs.md) and `?blocks=0|1` (snapshots in encode-once blocks, with packed: common
 * network/packed/blocks.ts) and `?focus=0|1` (the focus grid: the ships in the cells within 19 km held, the ring as ghosts,
 * dropped cells kept a while: common network/cells.ts) and `?causes=0|1` (other ships' causes on its tick layer, with
 * ownsim: common network/causes.ts) and `?waypoints=0|1` (homing shells flown on its tick layer by the waypoint law, with
 * ownsim: common guidance/) and `?pilots=0|1` (the enemy AI's ships flown by their pilot's body from the commander's
 * orders, with bodies: common bodies/aiPilot.ts) and `?crowd=0|1` (its system's crowd fallbacks: common network/crowd.ts)
 * and `?nose=0|1` (mouse-steer's keys along the ship when the view follows the heading: client input/viewMode.ts).
 * The server takes what it allows (netCaps).
 */
import { CAPS, DEFAULT_CAPS, TICK_MS, confirmRules } from '@space-game/common';
import { clientCaps } from '../ships/hits/ConfirmedHits';

/** A switch from the address (remembered) or from storage; null: not set */
function flag(q: string, key: string): boolean | null {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get(q);
    if (v === '0' || v === '1') { globalThis.localStorage?.setItem(key, v); return v === '1'; }
    const m = globalThis.localStorage?.getItem(key);
    if (m === '0' || m === '1') return m === '1';
  } catch { /* no storage: the default */ }
  return null;
}

/** On unless switched off: the shared default (common DEFAULT_CAPS, the same in dev and production builds) */
const on = (bit: number): boolean => (DEFAULT_CAPS & bit) !== 0;

export function netCaps(): number {
  const packed = flag('packed', 'sg.packed') ?? on(CAPS.PACKED);
  const coalesce = packed && (flag('coalesce', 'sg.coalesce') ?? on(CAPS.COALESCE));
  // (its own shells as fire events, built from its own ship as replicated to it, not its prediction: ShipClient.preSnapshot)
  const ownShots = flag('ownshots', 'sg.ownshots') ?? on(CAPS.OWN_SHOTS);
  // (adaptive validation of the hits it finds: checked roughly while it agrees, closely once it hasn't. docs/design/confirmed-hits.md part E)
  const hits = clientCaps();
  const rough = !!(hits & CAPS.SELF_HITS) && (flag('rough', 'sg.rough') ?? on(CAPS.ROUGH));
  // (its own ship on the tick-aligned layer stepped from its own inputs, with own shots: docs/design/confirmed-hits.md part G)
  const ownSim = ownShots && (flag('ownsim', 'sg.ownsim') ?? on(CAPS.OWN_SIM));
  // (compact inputs: only what changed, by app/inputCompactSend.ts's rules)
  const compact = flag('compact', 'sg.compact') ?? on(CAPS.INPUTS);
  // (bosses flown by their bodies on the tick layer, from their brains' decisions: they read its own ship there)
  const bodies = ownSim && (flag('bodies', 'sg.bodies') ?? on(CAPS.BODIES));
  // (snapshots in encode-once blocks: the same messages, each row bit-packed once on the server for every client)
  const blocks = packed && (flag('blocks', 'sg.blocks') ?? on(CAPS.BLOCKS));
  // (the focus grid: the ships homed in the cells within 19 km on its tick layer, the ring out to 35 km as ghosts)
  const focus = flag('focus', 'sg.focus') ?? on(CAPS.FOCUS);
  // (other ships' causes: what moved a ship it holds besides its controls, worked out on its tick layer, not keyframed)
  const causes = ownSim && (flag('causes', 'sg.causes') ?? on(CAPS.CAUSES));
  // (homing shells flown on its tick layer by the waypoint law: planned here when it holds the target, else sent)
  const waypoints = ownSim && (flag('waypoints', 'sg.waypoints') ?? on(CAPS.WAYPOINTS));
  // (the enemy AI's ships flown by their pilot's body on the tick layer, from the commander's orders)
  // (with other ships' causes: the server takes it only with them, common bodies/decisions.ts pilotsFor)
  const pilots = bodies && causes && (flag('pilots', 'sg.pilots') ?? on(CAPS.PILOTS));
  // (crowd fallbacks: its system's level, a smaller focus, a wider window, a slower clock: common network/crowd.ts)
  const crowd = flag('crowd', 'sg.crowd') ?? on(CAPS.CROWD);
  // (every structure a ship it holds flew, kept by its rebuild's tick: two rebuilds in a window worked out, not keyframed)
  const structs = causes && (flag('structs', 'sg.structs') ?? on(CAPS.STRUCTS));
  // (a hold's mass changing as a cause at its tick, worked out on its tick layer, not a keyframe of the ship)
  const cargo = ownSim && (flag('cargo', 'sg.cargo') ?? on(CAPS.CARGO));
  // (debris it works out run from then on: its parts crumble on their own ticks here, nothing more sent of it but its removal)
  const debris = flag('debris', 'sg.debris') ?? on(CAPS.DEBRIS);
  // (a volley of mobs laid at once, a Rivet Sower's mines, as one row: each one run from it, no SYNC a mob)
  const launches = waypoints && (flag('launches', 'sg.launches') ?? on(CAPS.LAUNCHES));
  // (mouse-steer's keys pushing along the ship, for the view on the heading: input/viewMode.ts, common flight.ts noseFrame)
  const nose = flag('nose', 'sg.nose') ?? on(CAPS.NOSE);
  return hits | (compact ? CAPS.INPUTS : 0) | (packed ? CAPS.PACKED : 0) | (coalesce ? CAPS.COALESCE : 0) | (ownShots ? CAPS.OWN_SHOTS : 0) | (rough ? CAPS.ROUGH : 0) | (ownSim ? CAPS.OWN_SIM : 0) | (bodies ? CAPS.BODIES : 0)
    | (blocks ? CAPS.BLOCKS : 0) | (focus ? CAPS.FOCUS : 0) | (causes ? CAPS.CAUSES : 0) | (waypoints ? CAPS.WAYPOINTS : 0) | (pilots ? CAPS.PILOTS : 0) | (crowd ? CAPS.CROWD : 0)
    | (structs ? CAPS.STRUCTS : 0) | (cargo ? CAPS.CARGO : 0) | (debris ? CAPS.DEBRIS : 0) | (launches ? CAPS.LAUNCHES : 0) | (nose ? CAPS.NOSE : 0);
}

/**
 * How much later frames may come with these caps in effect (coalescing: the server's netCaps says how many ticks they
 * may wait), and how much later its confirmation level wants them shown (CAPS.ROUGH, netCaps.lvl: STRICT's two ticks,
 * so every hit's record is in before the frames that show it): the interpolation delay grows by as much (ms)
 */
export function coalesceDelayMs(caps: number, hold = 0, lvl?: number): number {
  const coalesce = (caps & (CAPS.PACKED | CAPS.COALESCE)) === (CAPS.PACKED | CAPS.COALESCE) ? Math.max(0, Math.min(30, hold)) : 0;
  const confirm = caps & CAPS.ROUGH ? confirmRules(lvl).delayTicks : 0;
  return (coalesce + confirm) * TICK_MS;
}
