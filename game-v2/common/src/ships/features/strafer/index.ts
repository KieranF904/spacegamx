/**
 * The Burst Strafer as a part feature (features/README.md; the part, its dodge and its numbers: strafer.ts). Shared half:
 * what a rebuild derives for it, how it flies (two flight hooks), its input and its wire slots. Its world half is
 * server/src/ships/features/strafer (the pilot row), its key, chip and jets client/src/ships/features/strafer.
 *
 * (No imported value is used at module scope here: flight.ts, rebuild.ts and energy.ts reach this file through the plan.)
 */

import type { FlightCtx, InputDef, PartFeature } from '../types.js';
import { fnOutput } from '../../grades.js';
import { cargoThrust } from '../../load.js';
import { localToWorldDir, worldToLocalDir } from '../../flight.js';
import { DODGE_MIN_SHARE, dodgeLoad, dodgeVec, refuseDodge, stepDodge, strafeForce } from './strafer.js';

/**
 * The dodge control: held to dodge, the way the movement keys ask; one burst a press. Its control bit is CTL.dodge
 * (8192: replica.ts), pinned to it in features.wire.json; the input message's `dodge` flag and the Input component's
 * `dodge` field carry it to the server.
 */
export const DODGE_INPUT: InputDef = {
  name: 'dodge',
  kind: 'held',
  label: 'Dodge (Burst Strafer)',
  defaultKey: 'Space',
  hint: 'One hard burst a press, the way you are steering (WASD, diagonals too; forward, back and Q/E at the helm), with whichever strafers push that way; with nothing held, back the other way from last time. Ready again in under half a second; every burst costs a lot of energy',
  ctlBit: 8192,
};

/**
 * thrustGate: step the dodge counter from the held control and the way the movement keys ask (ship-local; not while
 * the drive spools), and ask the burst's power for this tick. Runs for every ship: one that lost its strafers mid-dodge
 * still winds the counter down (stepDodge with none).
 */
function dodgeStart(c: FlightCtx): void {
  const body = c.body, s = c.d.fx?.strafe;
  const dir = s || body.dodge
    ? stepDodge(body, !!c.input.dodge, c.wantX || c.wantY ? worldToLocalDir([c.wantX, c.wantY], body.angle) : null, s, c.charging)
    : 0;
  c.scratch.dodgeDir = dir;
  if (dir && c.accounted) {
    const l = dodgeLoad(c.d, dir);
    if (l) { c.load[c.feature] = l; c.loads++; }
  }
}

/**
 * impulse: the strafers' push along the dodge's way, on the ship's mass and load; short of power, that much less, and
 * a burst that gets too little on its first tick is refused (strafer.ts refuseDodge).
 */
function dodgePush(c: FlightCtx): void {
  const dir = c.scratch.dodgeDir as number;
  if (!dir) return;
  const body = c.body, d = c.d, share = c.shares?.[c.feature] ?? 1;
  if (body.dodge === 1 && share < DODGE_MIN_SHARE) { refuseDodge(body, d.fx!.strafe!); return; }
  const m = Math.max(d.mass, d.fullMass ?? d.mass);
  const a = m > 0 ? ((strafeForce(d.fx?.strafe, dir) * (d.drive ?? 1)) / m) * cargoThrust(d, c.cargo) * share * (c.k.hazard?.control ?? 1) : 0;
  const [wx, wy] = localToWorldDir(dodgeVec(dir), body.angle);
  body.vx += wx * a;
  body.vy += wy * a;
}

export const feature: PartFeature = {
  id: 'strafer',
  applies: (fn) => !!fn.strafe,
  // (After the Tow Beam: feature numbers follow (order, id), and the Tow Beam keeps number 0)
  order: 30,
  // It draws by the tick, only while a burst runs, and Drive Cell banks touching it feed it as they do engines
  burst: 'engine',
  // Each powered strafer pushes away from its facing edge, whichever way that is
  derive(c) {
    for (const i of c.parts) {
      const sf = c.fns[i].strafe!, mount = c.mounts[i];
      if (!mount || c.satisfaction[i] <= 0) continue;
      const s = c.out.strafe ??= { parts: [], ticks: sf.ticks, cooldown: sf.cooldown };
      const force = sf.kick * c.area[i] * fnOutput(c.fns[i], c.mats[i]) * c.satisfaction[i];
      const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
      s.parts.push({ part: i, push: [r(-mount.dir[0] * force), r(-mount.dir[1] * force)] });
      s.ticks = Math.max(s.ticks, sf.ticks);
      s.cooldown = Math.min(s.cooldown, sf.cooldown);
    }
  },
  flight: [
    { phase: 'thrustGate', order: 0, step: dodgeStart },
    { phase: 'impulse', order: 0, step: dodgePush },
  ],
  flightKey(d) {
    const s = d.fx?.strafe;
    return s ? `${s.ticks},${s.cooldown},${s.parts.map((p) => `${p.push[0]},${p.push[1]}`).join('+')}` : '';
  },
  inputs: [DODGE_INPUT],
  // Pinned to today's positions in features.wire.json: the pilot's own row (first after the charge groups), a
  // keyframe's tail (16, 17: network/replication.ts packKeyframe) and the control bit
  replicate: [
    { name: 'dodge', where: 'pilotExtra', who: 'self', default: 0 },
    { name: 'dodgeDir', where: 'pilotExtra', who: 'self', default: 0 },
    { name: 'dodge', where: 'keyframe', who: 'all', default: 0 },
    { name: 'dodgeDir', where: 'keyframe', who: 'all', default: 0 },
    { name: 'dodge', where: 'ctl', who: 'all', default: 0 },
  ],
};
