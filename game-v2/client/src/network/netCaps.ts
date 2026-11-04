/**
 * What this client offers the server in its join (common network/hits.ts CAPS): confirmed and client-detected hits
 * (ships/hits/ConfirmedHits.ts clientCaps), and bit-packed frames with coalescing (common network/packed): both on in
 * dev builds; `?packed=0|1` and `?coalesce=0|1` switch them (remembered), as do `?ownshots=0|1` (its own shells as fire
 * events), `?rough=0|1` (adaptive validation, with client-detected hits), `?ownsim=0|1` (its own ship stepped by itself), `?compact=0|1` (compact inputs: common
 * network/inputCompact.ts) and `?bodies=0|1` (bosses flown by their bodies from their brains' decisions, with ownsim:
 * docs/design/decision-inputs.md) and `?blocks=0|1` (snapshots in encode-once blocks, with packed: common
 * network/packed/blocks.ts) and `?focus=0|1` (the focus grid: the ships in the cells within 19 km held, the ring as ghosts,
 * dropped cells kept a while: common network/cells.ts) and `?causes=0|1` (other ships' causes on its tick layer, with
 * ownsim: common network/causes.ts) and `?waypoints=0|1` (homing shells flown on its tick layer by the waypoint law, with
 * ownsim: common guidance/) and `?pilots=0|1` (the enemy AI's ships flown by their pilot's body from the commander's
 * orders, with bodies: common bodies/aiPilot.ts) and `?crowd=0|1` (its system's crowd fallbacks: common network/crowd.ts).
 * The server takes what it allows (netCaps).
 */
import { CAPS, TICK_MS, confirmRules } from '@space-game/common';
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

export function netCaps(): number {
  const dev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  const packed = flag('packed', 'sg.packed') ?? dev;
  const coalesce = packed && (flag('coalesce', 'sg.coalesce') ?? true);
  // (its own shells as fire events, built from its own ship as replicated to it, not its prediction: ShipClient.preSnapshot)
  const ownShots = flag('ownshots', 'sg.ownshots') ?? dev;
  // (adaptive validation of the hits it finds: checked roughly while it agrees, closely once it hasn't. docs/design/confirmed-hits.md part E)
  const hits = clientCaps();
  const rough = !!(hits & CAPS.SELF_HITS) && (flag('rough', 'sg.rough') ?? dev);
  // (its own ship on the tick-aligned layer stepped from its own inputs, with own shots: docs/design/confirmed-hits.md part G)
  const ownSim = ownShots && (flag('ownsim', 'sg.ownsim') ?? dev);
  // (compact inputs: only what changed, by app/inputCompactSend.ts's rules)
  const compact = flag('compact', 'sg.compact') ?? dev;
  // (bosses flown by their bodies on the tick layer, from their brains' decisions: they read its own ship there)
  const bodies = ownSim && (flag('bodies', 'sg.bodies') ?? dev);
  // (snapshots in encode-once blocks: the same messages, each row bit-packed once on the server for every client)
  const blocks = packed && (flag('blocks', 'sg.blocks') ?? dev);
  // (the focus grid: the ships homed in the cells within 19 km on its tick layer, the ring out to 35 km as ghosts)
  const focus = flag('focus', 'sg.focus') ?? dev;
  // (other ships' causes: what moved a ship it holds besides its controls, worked out on its tick layer, not keyframed)
  const causes = ownSim && (flag('causes', 'sg.causes') ?? dev);
  // (homing shells flown on its tick layer by the waypoint law: planned here when it holds the target, else sent)
  const waypoints = ownSim && (flag('waypoints', 'sg.waypoints') ?? dev);
  // (the enemy AI's ships flown by their pilot's body on the tick layer, from the commander's orders)
  const pilots = bodies && (flag('pilots', 'sg.pilots') ?? dev);
  // (crowd fallbacks: its system's level, a smaller focus, a wider window, a slower clock: common network/crowd.ts)
  const crowd = flag('crowd', 'sg.crowd') ?? dev;
  // (every structure a ship it holds flew, kept by its rebuild's tick: two rebuilds in a window worked out, not keyframed)
  const structs = causes && (flag('structs', 'sg.structs') ?? dev);
  return hits | (compact ? CAPS.INPUTS : 0) | (packed ? CAPS.PACKED : 0) | (coalesce ? CAPS.COALESCE : 0) | (ownShots ? CAPS.OWN_SHOTS : 0) | (rough ? CAPS.ROUGH : 0) | (ownSim ? CAPS.OWN_SIM : 0) | (bodies ? CAPS.BODIES : 0)
    | (blocks ? CAPS.BLOCKS : 0) | (focus ? CAPS.FOCUS : 0) | (causes ? CAPS.CAUSES : 0) | (waypoints ? CAPS.WAYPOINTS : 0) | (pilots ? CAPS.PILOTS : 0) | (crowd ? CAPS.CROWD : 0)
    | (structs ? CAPS.STRUCTS : 0);
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
