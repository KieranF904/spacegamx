/**
 * @contract client.damage.detonations
 * owns:       what each kind of warhead, burst or bolt looks, sounds and shakes like where it goes off (the server's detonation
 *             message names the kind)
 * needs:      DamageCtx (particles, sound, shake, delayed actions), damage/flakBurst (a flak burst's fragments)
 * invariants: a kind with no entry below is drawn as a missile's fireball — none pinned
 *             a hive's blast is a missile's at 0.7 of its radius — none pinned
 * extend:     a new kind of detonation is one function below and one line in KINDS
 */

import type { DamageCtx } from './context';
import { FRAGMENT_FRAMES, fragmentCount, fragmentEnd, fragmentPlan, shipAtPoint, type Fragment } from './flakBurst';

type Detonation = (c: DamageCtx, x: number, y: number, radius: number, from?: [number, number], kind?: string) => void;

/** A jagged bolt of sparks from one point to another */
export function bolt(c: DamageCtx, from: [number, number], x: number, y: number, c0: number, c1: number, size: number): void {
  const steps = 7, dx = x - from[0], dy = y - from[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  // (a long one, in more steps: it stays jagged)
  const n = Math.max(steps, Math.round(len / 160));
  let px = from[0], py = from[1];
  for (let i = 1; i <= n; i++) {
    const t = i / n, j = i < n ? (Math.random() - 0.5) * Math.min(len * 0.18, 260) : 0;
    const qx = from[0] + dx * t + nx * j, qy = from[1] + dy * t + ny * j;
    for (let k = 0; k <= 3; k++) {
      const u = k / 3;
      c.p.push({ kind: 'spark', x: px + (qx - px) * u, y: py + (qy - py) * u, vx: 0, vy: 0, life: 0, max: 10, size, grow: 0, color: k % 2 ? c1 : c0, alpha: 1, drag: 1, rot: 0, vr: 0 });
    }
    px = qx; py = qy;
  }
}

/** `eruption` */
const eruption: Detonation = (c, x, y, radius) => {
  // A boss's mortar shell coming down: a column of fire, a shock ring, slag thrown out
  c.p.glow(x, y, 0, 0, radius * 0.9, 14, 0xffe0b0, 1);
  c.p.glow(x, y, 0, 0, radius * 1.3, 26, 0xff5a12, 0.8);
  c.p.ring(x, y, 0, 0, radius * 0.2, radius * 1.2, 20, 0xff8a3a, 0.9);
  c.p.burstSparks(x, y, 0, 0, 34, 4, 14, 0xffb060);
  c.later(0.08, () => c.p.ring(x, y, 0, 0, radius * 0.1, radius * 0.8, 16, 0xffd08a, 0.7));
  c.sound('explosion_large', { x, y }, 0.75);
  if (c.near(x, y, 1600)) c.state.triggerScreenShake(7, 0.3);
};

/** `mob_burst`, `mob_fizzle` */
const mobBurst: Detonation = (c, x, y, radius, from, kind) => {
  // A drone bursting (on target, or shot down); burnt out, a pop and a puff
  const big = kind === 'mob_burst';
  c.p.glow(x, y, 0, 0, radius * (big ? 0.7 : 0.25), big ? 12 : 8, big ? 0xffe0b0 : 0xffb070, big ? 1 : 0.6);
  if (big) c.p.ring(x, y, 0, 0, radius * 0.15, radius, 14, 0xff7a2a, 0.85);
  c.p.burstSparks(x, y, 0, 0, big ? 18 : 6, big ? 3 : 1.5, big ? 9 : 4, 0xff9a40);
  c.sound(big ? 'explosion_small' : 'hit', { x, y }, big ? 0.6 : 0.3);
};

/** `sludge` */
const sludge: Detonation = (c, x, y, radius) => {
  // Greyseam sludge landing: a green splash and spatter
  c.p.glow(x, y, 0, 0, radius * 0.8, 12, 0xd8ffc0, 0.9);
  c.p.ring(x, y, 0, 0, radius * 0.2, radius * 1.1, 18, 0x7aff6a, 0.8);
  c.p.burstSparks(x, y, 0, 0, 20, 3, 12, 0x9cff6a);
  c.sound('explosion_small', { x, y }, 0.5);
};

/** `scrap` */
const scrap: Detonation = (c, x, y, radius) => {
  // Grinding: a spray of white-hot sparks and scrap, a dull flash
  c.p.glow(x, y, 0, 0, radius * 0.5, 8, 0xfff0c0, 0.6);
  c.p.burstSparks(x, y, 0, 0, 26, 5, 10, 0xffd080);
  c.sound('hit', { x, y }, 0.5);
};

/** `synapse` */
const synapse: Detonation = (c, x, y, radius, from) => {
  // A boss's wires striking a mark: a white-hot bolt down from it, a burst of molten spatter where it lands
  if (from) bolt(c, from, x, y, 0xfff4d0, 0xffa030, 3);
  c.p.glow(x, y, 0, 0, radius * 0.9, 12, 0xffe8b0, 1);
  c.p.ring(x, y, 0, 0, radius * 0.15, radius * 1.1, 16, 0xff8a2a, 0.9);
  c.p.burstSparks(x, y, 0, 0, 22, 3, 10, 0xffb060);
  c.sound('explosion_small', { x, y }, 0.55);
  if (c.near(x, y, 900)) c.state.triggerScreenShake(4, 0.2);
};

/** `arc`, `tesla_arc` */
const arcHit: Detonation = (c, x, y, radius, from, kind) => {
  // A jagged bolt from where it leapt, and a crackle where it lands (Tesla's hops are violet-white, Spark's pale blue)
  const tesla = kind === 'tesla_arc';
  if (from) c.p.zapArc(from, x, y, tesla ? 0xb8a4ff : 0xc7dcff);
  c.p.glow(x, y, 0, 0, 50, 9, tesla ? 0xb8a4ff : 0x9ad8ff, 0.9);
  c.p.burstSparks(x, y, 0, 0, 5, 2.5, 8, tesla ? 0xe4dcff : 0xbfe9ff);
  c.sound('hit', { x, y }, 0.5);
};

/** `cannon`, `autocannon`, `pulse`, `laser` */
const kineticBurst: Detonation = (c, x, y, radius, from) => {
  // A slug that bursts after all (its ammunition gives it a splash): a hot puff, no fireball and no shake. A plain
  // slug's hit sends no detonation at all: WeaponFx draws its impact from projectileHit
  c.p.glow(x, y, 0, 0, Math.max(14, radius * 0.5), 8, 0xffd08a, 0.8);
  c.p.burstSparks(x, y, 0, 0, 10, 2.5, 8, 0xffc46b);
  c.sound('hit', { x, y }, 0.6);
};

/** `singularity` */
const singularity: Detonation = (c, x, y, radius) => {
  // Collapse: rings falling inwards, then a violent flash
  for (let i = 0; i < 4; i++) c.later(i * 0.05, () => c.p.ring(x, y, 0, 0, radius * 1.3, radius * 0.1, 14, 0xc084fc, 0.8));
  c.later(0.25, () => {
    c.p.glow(x, y, 0, 0, radius * 0.9, 12, 0xf5e8ff, 1);
    c.p.ring(x, y, 0, 0, radius * 0.1, radius * 1.3, 24, 0x9b5de5, 0.9);
    c.p.burstSparks(x, y, 0, 0, 40, 5, 14, 0xd8b4fe);
    c.sound('explosion_large', { x, y }, 0.8);
    if (c.near(x, y, 2000)) c.state.triggerScreenShake(10, 0.4);
  });
};

/** `prism`, `prism_shard` */
const prism: Detonation = (c, x, y, radius, from, kind) => {
  const big = kind === 'prism';
  c.p.glow(x, y, 0, 0, big ? 60 : 24, 8, 0xe0fbff, 0.9);
  for (let i = 0; i < (big ? 18 : 6); i++) {
    const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
    c.p.push({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 14 + Math.random() * 12, size: 1.6, grow: 0, color: i % 3 === 0 ? 0xf0abfc : i % 3 === 1 ? 0x67e8f9 : 0xffffff, alpha: 1, drag: 0.92, rot: 0, vr: 0 });
  }
  if (big) c.sound('hit', { x, y }, 0.8);
};

/** `magma` */
const magma: Detonation = (c, x, y, radius) => {
  // A ball of magma bursting: a hot flash, a ring of spatter, and molten gobbets thrown out
  c.p.glow(x, y, 0, 0, 150, 18, 0xffb347, 0.9);
  c.p.ring(x, y, 0, 0, 20, 240, 20, 0xff6a1a, 0.8);
  c.p.burstSparks(x, y, 0, 0, 34, 4, 22, 0xff5a14);
  c.sound('magma_burst', { x, y }, 0.9);
};

/** `cinder_bloom` */
const cinderBloom: Detonation = (c, x, y, radius) => {
  c.p.glow(x, y, 0, 0, 70, 12, 0xffb347, 0.95);
  c.p.burstSparks(x, y, 0, 0, 22, 3.2, 12, 0xff6a1a);
};

/** `phase` */
const phase: Detonation = (c, x, y, radius) => {
  // A violet ripple spreading over the hull it passed through, a second one following
  c.p.ring(x, y, 0, 0, 10, 90, 14, 0xa78bfa, 0.9);
  c.later(0.07, () => c.p.ring(x, y, 0, 0, 6, 130, 22, 0xc4b5fd, 0.6));
  c.p.glow(x, y, 0, 0, 50, 10, 0xede9fe, 0.8);
};

/** `railgun` */
const railgun: Detonation = (c, x, y, radius) => {
  // A slug passing through a hull (a Spear's, at full damage): a shock ring where it went through, a cyan-white flash
  c.p.glow(x, y, 0, 0, 40, 8, 0xdbeafe, 0.9);
  c.p.ring(x, y, 0, 0, 8, 70, 16, 0x9fe8ff, 0.8);
  c.p.burstSparks(x, y, 0, 0, 14, 4, 10, 0xbfe3ff);
};

/** `emp` */
const emp: Detonation = (c, x, y, radius) => {
  // A wide one (the Blackout's) first throws a dark-blue dome out to its blast radius
  if (radius >= 260) {
    c.p.glow(x, y, 0, 0, radius * 0.95, 30, 0x1d3ea8, 0.55, 0.3);
    c.p.ring(x, y, 0, 0, radius * 0.9, radius, 26, 0x3b6cf0, 0.7);
  }
  c.p.glow(x, y, 0, 0, radius * 0.5, 10, 0xd9f6ff, 0.9);
  c.p.ring(x, y, 0, 0, radius * 0.15, radius * 1.1, 22, 0x6ad1ff, 0.8);
  c.p.ring(x, y, 0, 0, radius * 0.1, radius * 0.8, 16, 0xffffff, 0.5);
  for (let i = 0; i < 9; i++) c.p.arc(x, y, 0, 0, Math.random() * Math.PI * 2, radius * (0.6 + Math.random() * 0.5), 14 + Math.random() * 10);
  c.sound('generator_blast', { x, y }, 0.7);
};

/** `flak` */
const flak: Detonation = (c, x, y, radius) => {
  // A burst: a white-orange flash, a ring of fragment streaks flying out to exactly the damage radius (sparking on any ship
  // they end inside), a faint ring left at that radius so the area reads, and a cloud that lingers (the Burst's 1.2 s dark
  // grey; the Cloudmaker's bigger one, brown-grey round a gold core, 2.5 s: a wall that stays)
  const wall = radius >= 220;
  c.p.glow(x, y, 0, 0, radius * 0.3, 5, 0xffffff, 1);
  c.p.glow(x, y, 0, 0, radius * 0.45, 8, wall ? 0xffd070 : 0xffa050, 0.9);
  c.p.burstSparks(x, y, 0, 0, wall ? 8 : 10, 3, 9, 0xffb050);
  c.p.ring(x, y, 0, 0, radius * 0.1, radius, FRAGMENT_FRAMES, 0xffe0a0, 0.55);
  c.p.ring(x, y, 0, 0, radius, radius, 46, wall ? 0xffd070 : 0xffa050, 0.3);
  const fragments = fragmentPlan(fragmentCount(c.p.keepShare), radius, Math.random, FRAGMENTS);
  const secs = FRAGMENT_FRAMES / 60;
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i], vx = Math.cos(f.angle) * f.speed, vy = Math.sin(f.angle) * f.speed;
    c.p.fragment(x, y, vx, vy, FRAGMENT_FRAMES, 2.4, i % 3 === 0 ? 0xffffff : 0xffd890);
    fragmentEnd(x, y, f, END);
    const ex = END.x, ey = END.y, id = shipAtPoint(c.source, c.state, x, y, radius, ex, ey);
    if (id >= 0) {
      const e = c.state.entities.get(id);
      const evx = e?.vx ?? 0, evy = e?.vy ?? 0;
      c.later(secs, () => {
        c.p.burstSparks(ex, ey, evx, evy, 4, 1, 4, 0xffd890);
        c.p.glow(ex, ey, evx, evy, 9, 7, 0xffe0b0, 0.9);
      });
    }
  }
  if (wall) c.p.glow(x, y, 0, 0, radius * 0.5, 60, 0xd9a040, 0.35, radius * 0.002);
  const stay = wall ? 150 : 72;
  for (let i = 0; i < 6; i++) c.p.dustPuff(x, y, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, radius * (0.2 + Math.random() * 0.15), stay * (0.85 + Math.random() * 0.3), wall ? 0x5a4a3c : 0x3a3836, 0.55, radius * 0.004);
  c.sound('explosion_small', { x, y }, 0.55);
};
const FRAGMENTS: Fragment[] = [];
const END = { x: 0, y: 0 };

/** A missile's explosion, and any kind with no look of its own: a proper fireball */
const missile: Detonation = (c, x, y, radius) => {
  c.p.glow(x, y, 0, 0, radius * 0.9, 8, 0xffffff, 1);
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * radius * 0.35;
    c.p.glow(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 0.5, Math.sin(a) * 0.5, radius * (0.3 + Math.random() * 0.3), 24 + Math.random() * 20, i % 2 ? 0xff8a2b : 0xffd27a, 0.75, radius * 0.008);
  }
  c.p.ring(x, y, 0, 0, radius * 0.2, radius * 1.4, 18, 0xffe6c0, 0.6);
  c.p.burstSparks(x, y, 0, 0, 30, 3, 10, 0xffc46b);
  for (let i = 0; i < 6; i++) c.p.dustPuff(x, y, (Math.random() - 0.5), (Math.random() - 0.5), radius * 0.35, 90, 0x3a3634, 0.5, radius * 0.006);
  c.sound('explosion_small', { x, y }, 0.85);
  if (c.near(x, y, 1500)) c.state.triggerScreenShake(6, 0.3);
};

/** Each kind of detonation by the name the server sends */
const KINDS = new Map<string, Detonation>([
  ['eruption', eruption],
  ['mob_burst', mobBurst],
  ['mob_fizzle', mobBurst],
  ['sludge', sludge],
  ['scrap', scrap],
  ['synapse', synapse],
  ['arc', arcHit],
  ['tesla_arc', arcHit],
  ['cannon', kineticBurst],
  ['autocannon', kineticBurst],
  ['pulse', kineticBurst],
  ['laser', kineticBurst],
  ['singularity', singularity],
  ['prism', prism],
  ['prism_shard', prism],
  ['magma', magma],
  ['cinder_bloom', cinderBloom],
  ['phase', phase],
  ['railgun', railgun],
  ['emp', emp],
  ['flak', flak],
  ['hive', (c, x, y, radius, from, kind) => missile(c, x, y, radius * 0.7, from, kind)],
]);

/** A warhead went off: flak burst, missile explosion, EMP ring and the rest */
export function detonate(c: DamageCtx, kind: string, x: number, y: number, radius: number, from?: [number, number]): void {
  (KINDS.get(kind) ?? missile)(c, x, y, radius, from, kind);
}
