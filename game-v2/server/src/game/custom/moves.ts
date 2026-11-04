/**
 * Custom enemies' moves on the server, by design (docs/enemies/custom-roster.md): when each may start (the commander's
 * pick) and what each step of it does to the world. Their flight is the common body's (bodies/custom/<id>.ts), the same
 * on every client running it; the numbers are factions.json custom's. Adding a design is its entry here.
 */
import {
  Position, Velocity, Rotation, quantizeCursorAngle, dequantizeCursorAngle, datan2, dcos, dhypot, dsin, hashUnit,
  CENSER_WARN, CENSER_BURN, LURKER_WARN, HOOK_WARN, BELL_WARN, CRAWLER_PULL, CRAWLER_SNAP, SOWER_AHEAD, RAY_PASS,
  CLINKER_WARN, CLINKER_SHELLS, CLINKER_GAP, TORCH_TICKS, customGroups, launchPattern,
} from '@space-game/common';
import { beamFx, burnLine, gun, leadAngle, lineFirst, lineWarn, pullTowards, ringWarn, strikeAt } from './kit.js';
import type { Act, DesignMoves } from './types.js';

const num = (a: Act, move: string, key: string, dflt = 0) => a.live.stats.moves[move]?.[key] ?? dflt;
const due = (a: Act, move: string) => a.now >= a.live.next && a.d <= a.live.stats.reach;
const nose = (a: Act) => Rotation.angle[a.eid];

export const MOVES: Record<string, DesignMoves> = {
  censer: {
    pick: (a) => (due(a, 'lance') && a.has('lance') ? { move: 0, arg: quantizeCursorAngle(leadAngle(a.target, Position.x[a.eid], Position.y[a.eid], 400)) } : null),
    step(a, m, k) {
      const line = dequantizeCursorAngle(m.arg), tip = a.at('lance');
      if (!tip) return;
      const L = num(a, 'lance', 'length', 1800), W = num(a, 'lance', 'width', 46);
      if (k === 0) lineWarn(a, 'lance', tip.x, tip.y, line, L, W, CENSER_WARN);
      if (k === CENSER_WARN) beamFx(a, 'lance', tip, line, L, W, CENSER_BURN);
      if (k >= CENSER_WARN && k < CENSER_WARN + CENSER_BURN) burnLine(a, tip.x, tip.y, line, L, W, num(a, 'lance', 'damage', 7) * a.live.dmg);
    },
  },

  maw_lurker: {
    pick: (a) => (due(a, 'aim') && a.has('rail') ? { move: 0, arg: quantizeCursorAngle(leadAngle(a.target, Position.x[a.eid], Position.y[a.eid], 150)) } : null),
    step(a, m, k) {
      const tip = a.at('rail');
      if (!tip) return;
      // (No eye: its line wanders, and so does its slug: off by the move's seed)
      const wobble = a.has('eye') ? 0 : (hashUnit(m.seed, a.eid, 7) * 2 - 1) * num(a, 'aim', 'spread', 0.12);
      const line = dequantizeCursorAngle(m.arg) + wobble;
      if (k === 0) lineWarn(a, 'rail', tip.x, tip.y, line, 2800, 18, LURKER_WARN);
      if (k === LURKER_WARN) a.host.fire?.(a.eid, 'railgun', tip.x, tip.y, line, num(a, 'aim', 'damage', 2.6) * a.live.dmg);
    },
  },

  hookboat: {
    pick: (a) => (due(a, 'harpoon') && a.has('harpoon') && !a.live.tether && a.d < num(a, 'harpoon', 'length', 1300) ? { move: 0, arg: quantizeCursorAngle(leadAngle(a.target, Position.x[a.eid], Position.y[a.eid], 120)) } : null),
    step(a, m, k) {
      const tip = a.at('harpoon');
      if (!tip) return;
      const line = dequantizeCursorAngle(m.arg), L = num(a, 'harpoon', 'length', 1300);
      if (k === 0) lineWarn(a, 'harpoon', tip.x, tip.y, line, L, 30, HOOK_WARN);
      if (k !== HOOK_WARN) return;
      const hit = lineFirst(a, tip.x, tip.y, line, L, 30);
      beamFx(a, 'harpoon', tip, line, hit ? hit.t * L : L, 14, 10);
      if (!hit) return;
      const sh = a.host.ships.get(hit.who), seg = sh && a.host.ships.segmentHit(hit.who, sh, tip.x, tip.y, tip.x + dcos(line) * L, tip.y + dsin(line) * L, 15);
      if (seg) a.host.ships.damagePartBy(hit.who, seg.part, 14 * num(a, 'harpoon', 'damage', 1.2) * a.live.dmg, a.eid, { type: 'kinetic', pen: 1 });
      a.live.tether = { target: hit.who, until: a.now + num(a, 'harpoon', 'reel', 150) };
    },
    always(a) {
      gun(a, 'outrigger', [0], 54);
      // The reel: what it struck is drawn in (thrust away to beat it), while its harpoon's still on
      const t = a.live.tether;
      if (!t) return;
      if (a.now >= t.until || !a.has('harpoon') || !a.host.ships.has(t.target)) { a.live.tether = undefined; return; }
      const d = dhypot(Position.x[t.target] - Position.x[a.eid], Position.y[t.target] - Position.y[a.eid]);
      if (d > num(a, 'harpoon', 'slack', 320)) pullTowards(a, t.target, Position.x[a.eid], Position.y[a.eid], num(a, 'harpoon', 'length', 1300) * 1.6, num(a, 'harpoon', 'pull', 0.4) * 1.6);
    },
  },

  rime_bell: {
    pick: (a) => (due(a, 'pulse') && a.has('frill') && a.d < num(a, 'pulse', 'radius', 520) * 1.4 ? { move: 0, arg: 0 } : null),
    step(a, _m, k) {
      const R = num(a, 'pulse', 'radius', 520);
      if (k === 0) ringWarn(a, 'emp', R, BELL_WARN);
      if (k === BELL_WARN && a.has('frill')) {
        a.host.ships.empAt(a.num, Position.x[a.eid], Position.y[a.eid], R, num(a, 'pulse', 'emp', 75), a.eid);
        a.host.send?.(a.num, { type: 'detonation', kind: 'emp', x: Math.round(Position.x[a.eid]), y: Math.round(Position.y[a.eid]), radius: R });
      }
    },
    always(a) {
      // Ice splinters at what comes close: one a tendril still on, in a fan
      const fan = (['tendril_l', 'tendril_c', 'tendril_r'] as const).map((g, i) => (a.has(g) ? (i - 1) * 0.22 : null)).filter((o): o is number => o !== null);
      if (fan.length) gunFrom(a, 'tendrils', fan);
    },
  },

  scrap_crawler: {
    pick: (a) => (due(a, 'pull') && a.has('magnet') && a.d < num(a, 'pull', 'radius', 1300) ? { move: 0, arg: 0 } : null),
    step(a, _m, k) {
      const R = num(a, 'pull', 'radius', 1300);
      if (k === 0) ringWarn(a, 'magnet', R, CRAWLER_PULL);
      if (a.has('magnet') && k >= 18) pullTowards(a, a.target, Position.x[a.eid], Position.y[a.eid], R, num(a, 'pull', 'pull', 0.45));
      // The claws snap shut just ahead of it (each one on, half the bite)
      const claws = (a.has('claw_l') ? 0.5 : 0) + (a.has('claw_r') ? 0.5 : 0), ahead = num(a, 'pull', 'snap', 150);
      const x = Position.x[a.eid] + dcos(nose(a)) * ahead, y = Position.y[a.eid] + dsin(nose(a)) * ahead;
      if (k === CRAWLER_SNAP - 24 && claws) ringWarn(a, 'claw', num(a, 'pull', 'snapRadius', 150), 24, { x, y });
      if (k === CRAWLER_SNAP && claws) strikeAt(a, x, y, num(a, 'pull', 'snapRadius', 150), num(a, 'pull', 'damage', 50) * claws * a.live.dmg, 'snap');
    },
  },

  rivet_sower: {
    pick: (a) => {
      if (!due(a, 'lay') || !a.has('drum')) return null;
      // Its line goes across the way its target flies (or across its line to it, when it's still)
      const v = dhypot(Velocity.x[a.target], Velocity.y[a.target]);
      const heading = v > 1 ? datan2(Velocity.y[a.target], Velocity.x[a.target]) : datan2(Position.y[a.target] - Position.y[a.eid], Position.x[a.target] - Position.x[a.eid]);
      return { move: 0, arg: quantizeCursorAngle(heading + Math.PI / 2) };
    },
    step(a, m, k) {
      if (k !== SOWER_AHEAD || !a.has('drum') || !a.host.mobs) return;
      const drum = a.at('drum');
      if (!drum) return;
      // Along the line across your path, or (blind: no sensors) in a ring round itself; one LAUNCH row to its clients
      const ring = !a.has('sensors');
      const p = launchPattern(drum.x, drum.y, m.arg, Math.round(num(a, 'lay', 'mines', 6)), ring, ring ? num(a, 'lay', 'ring', 260) : num(a, 'lay', 'gap', 170));
      a.host.mobs.launch('rivet_mine', a.num, p, a.eid, a.live.dmg);
      a.host.launchFx?.(a.num, drum.x, drum.y);
    },
    lost(a, newly) {
      // A pannier shot off: its mines go off on the spot, hurting the Sower and anything near it
      const p = a.live.stats.pannier as { radius: number; damage: number } | undefined;
      for (const g of ['pannier_l', 'pannier_r']) {
        if (!(newly & groupBit(a, g))) continue;
        const at = a.at(g, true);
        if (at) { a.host.ships.splashAt(a.num, at.x, at.y, p?.radius ?? 220, (p?.damage ?? 60) * a.live.dmg, -1); a.host.send?.(a.num, { type: 'detonation', kind: 'eruption', x: Math.round(at.x), y: Math.round(at.y), radius: p?.radius ?? 220 }); }
      }
    },
  },

  slag_ray: {
    pick: (a) => (due(a, 'pass') && a.d < a.live.stats.reach * 1.6 ? { move: 0, arg: a.rng() < 0.5 ? 0 : 1 } : null),
    step(a, _m, k) {
      // Embers spat ahead in a cone (its horns), slag left in its wake (its tail)
      const horns = a.at('horns');
      if (horns && k % num(a, 'pass', 'cone', 30) === 0) for (const o of [-0.22, 0, 0.22]) a.host.fire?.(a.eid, 'cannon', horns.x, horns.y, nose(a) + o, num(a, 'pass', 'damage', 0.9) * a.live.dmg);
      const tail = a.at('tail');
      if (tail && k % num(a, 'pass', 'wake', 20) === 0 && k < RAY_PASS - 10) {
        const R = num(a, 'pass', 'pool', 140), T = num(a, 'pass', 'poolTicks', 150);
        (a.live.pools ??= []).push({ x: tail.x, y: tail.y, until: a.now + T });
        ringWarn(a, 'pool', R, T, tail);
      }
    },
    always(a) {
      // Its pools burn what sits in them
      const pools = a.live.pools;
      if (!pools?.length) return;
      for (let i = pools.length - 1; i >= 0; i--) if (a.now >= pools[i].until) pools.splice(i, 1);
      if (a.now % 15) return;
      for (const p of pools) a.host.ships.splashAt(a.num, p.x, p.y, num(a, 'pass', 'pool', 140), num(a, 'pass', 'burn', 3) * 15 * a.live.dmg, a.eid);
    },
  },

  clinker: {
    pick: (a) => (due(a, 'volley') && (a.has('chimney_l') || a.has('chimney_r')) ? { move: 0, arg: 0 } : null),
    step(a, m, k) {
      const R = num(a, 'volley', 'radius', 170), S = num(a, 'volley', 'spread', 220);
      if (k === 0) {
        // Where its four shells come down, round its target (the move's seed scatters them), left chimney then right
        a.live.due = [];
        for (let i = 0; i < CLINKER_SHELLS; i++) {
          const t = hashUnit(m.seed, i, 1) * Math.PI * 2, r = hashUnit(m.seed, i, 2) * S;
          const x = Position.x[a.target] + Velocity.x[a.target] * (CLINKER_WARN * 0.5) + dcos(t) * r, y = Position.y[a.target] + Velocity.y[a.target] * (CLINKER_WARN * 0.5) + dsin(t) * r;
          const at = a.now + CLINKER_WARN + i * CLINKER_GAP;
          a.live.due.push({ x, y, at, group: i % 2 ? 'chimney_r' : 'chimney_l' });
        }
      }
      for (const s of a.live.due ?? []) {
        const lob = s.at - CLINKER_WARN;
        // (Lobbed only from a chimney still on: rule 6)
        if (a.now === lob && a.has(s.group)) { const c = a.at(s.group); if (c) a.host.launchFx?.(a.num, c.x, c.y); ringWarn(a, 'impact', R, CLINKER_WARN, s); }
        if (a.now === s.at && a.has(s.group)) strikeAt(a, s.x, s.y, R, num(a, 'volley', 'damage', 60) * a.live.dmg, 'eruption');
      }
    },
  },

  helios_drone: {
    pick: (a) => (due(a, 'torch') && a.has('torch') && a.d < a.live.stats.reach ? { move: 0, arg: 0 } : null),
    step(a, _m, k) {
      const tip = a.at('torch');
      if (!tip || k < 10 || k >= TORCH_TICKS) return;
      const R = num(a, 'torch', 'reach', 230), aim = datan2(Position.y[a.target] - tip.y, Position.x[a.target] - tip.x);
      if (dhypot(Position.x[a.target] - tip.x, Position.y[a.target] - tip.y) > R + 120) return;
      if (k % 15 === 10) beamFx(a, 'weld', tip, aim, R, 10, 15);
      burnLine(a, tip.x, tip.y, aim, R, 14, num(a, 'torch', 'damage', 0.25) * a.live.dmg);
    },
  },
};

/** A gun firing a fan of its kind (the Rime Bell's splinters) */
function gunFrom(a: Act, group: string, fan: number[]): void {
  const g = a.live.stats.guns?.[group];
  if (!g || a.d > g.reach || a.now < (a.live.guns[group] ?? 0)) return;
  a.live.guns[group] = a.now + g.every;
  const x = Position.x[a.eid], y = Position.y[a.eid], aim = leadAngle(a.target, x, y, 40);
  for (const o of fan) a.host.fire?.(a.eid, g.kind, x, y, aim + o, g.damage * a.live.dmg);
}

/** A group's bit (its design's order: common bodies/custom/roster.json) */
function groupBit(a: Act, group: string): number {
  const i = customGroups(a.live.design).indexOf(group);
  return i < 0 ? 0 : 1 << i;
}
