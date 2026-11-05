/**
 * A moon siege's bastion ground: the crater it stands in, a stepped platform
 * under it (each moon's its own shape), ramparts where the moon has them, the
 * keep round the bastion (a dais and its towers), and the turret pads round
 * it, each ringed with lamps. The bastion and its turrets themselves are ships
 * (wards) drawn as ships; under each turret an emplacement in its kind's
 * colour with a pip a mark.
 *
 * Over that, from the siege's state (siegeFeed, written by the siege panel):
 * the approach lanes, reach rings, pad lamps and hull arcs by each turret's
 * hull, scorched pads (SiegeGround, redrawn when the state changes); the
 * beacon's sweep, the core's glow by the bastion's hull, front beacons, mends,
 * shocks, smoke and sparks (SiegeFx, each frame); and over the ships, the
 * hostiles' night marks by role (SiegeMarks, `top`). A turret shot down goes
 * up in a big explosion (`boom`) and leaves its pad scorched.
 *
 * Lighting is worked out per vertex, so the big flat parts are cut into rings
 * and segments: headlights and the pads' lamps light the ground where they
 * fall, not just at its far corners.
 */

import { Container, Graphics } from 'pixi.js';
import type { ServerSiegeStateMessage } from '@space-game/common';
import rules from '../../../../../data/rules.json';
import { LitGeometry } from '../../lighting/LitGeometry';
import { Lighting, LitMesh } from '../../lighting/Lighting';
import { drawGround } from './SiegeGround';
import { SiegeFx } from './SiegeFx';
import { SiegeMarks, type MarkEntity, type ViewBox } from './SiegeMarks';
import { siegeFeed } from './siegeFeed';
import { PAD_EMPTY, TURRET_DEFAULT, TURRET_LOOKS, beaconPhase, coreGlow, dayLanes, frontLanes, padLamp, type Approach } from './siegeLook';

const DEG = Math.PI / 180;
/** How long before a front lands its beacon shows (ticks) */
const BEACON_WARN = 20 * 60;
/** How long after a front lands its lane stays painted (ticks) */
const LANE_HOLD = 30 * 60;

type Layout = { x: number; y: number; slots: { x: number; y: number }[]; platform?: { sides: number; radius: number }; walls?: { from: number; to: number; radius: number }[]; profile?: string };
type Turret = NonNullable<NonNullable<ServerSiegeStateMessage['turrets']>[number]>;

/** `view`: the world on screen (marks off it aren't drawn); `entities` need only be the ships */
export interface BastionFrame { night: number; zoom: number; angle: number; entities: Iterable<MarkEntity>; view?: ViewBox }

export class BastionView {
  readonly container = new Container();
  /** Over the ships: the hostiles' night marks */
  readonly top = new Container();
  private lit: LitMesh;
  private emplaced: LitMesh | null = null;
  private emplacedKey = '';
  private pads: { x: number; y: number }[];
  private ground = new Graphics();
  private groundKey = '';
  /** What the ground was last looked at for (BastionView.update) */
  private groundIn: { msg: ServerSiegeStateMessage | null; focus: number; step: number; onLanes: number } = { msg: null, focus: -2, step: -1, onLanes: -1 };
  /** The scorched pads (from the state) */
  private lost = new Set<number>();
  private fx = new SiegeFx();
  private marks = new SiegeMarks();
  private approach: Approach | undefined;
  private laneFrom: number;
  private laneTo: number;
  /** Last frame's siege state (turret lost, bastion hit, fronts landed) */
  private seen: { msg: ServerSiegeStateMessage | null; turrets: (Turret | null)[]; hull: number; tick: number } = { msg: null, turrets: [], hull: -1, tick: 0 };
  private smokeAt = 0;
  private state = { night: 0, hull: 100, breach: false, active: false, core: 0x7dd3fc, beacons: [] as { x: number; y: number; phase: number; boss: boolean }[] };

  constructor(private b: Layout, private lighting: Lighting, opts: { radius?: number; boom?: (x: number, y: number, r: number) => void } = {}) {
    this.boom = opts.boom ?? (() => {});
    const g = new LitGeometry();
    this.pads = b.slots;
    const reach = Math.max(1250, ...b.slots.map((p) => Math.hypot(p.x, p.y) + 260), ...(b.walls ?? []).map((w) => w.radius + 160));
    this.approach = (rules as unknown as { sieges?: { profiles?: Record<string, { approach?: Approach }> } }).sieges?.profiles?.[b.profile ?? 'selene']?.approach;
    this.laneFrom = reach + 120;
    this.laneTo = Math.max(this.laneFrom + 1500, (this.approach?.radius ?? 0.5) * (opts.radius ?? 14000) - 400);
    // The crater: a wide bowl, its rim lit on the far side
    g.bowl(0, 0, reach * 1.5, 0x6d6a66, { rings: 7 }, 36);
    g.disc(0, 0, reach, 0x5d5a57, { bevel: 90, edge: 0x4a4744, rings: 6 }, 36);
    // Platform: two stepped polygons, the moon's own shape
    const sides = b.platform?.sides ?? 8, size = b.platform?.radius ?? 820;
    const poly = (r: number, color: number, edge: number, bevel: number, rings: number) => {
      const pts: number[] = [];
      for (let k = 0; k < sides; k++) { const a = (k / sides) * Math.PI * 2 + Math.PI / sides; pts.push(Math.cos(a) * r, Math.sin(a) * r); }
      g.panel(pts, color, { bevel, edge, rings, split: Math.max(1, Math.round(24 / sides)) });
    };
    poly(size, 0x5c6470, 0x3a4048, 40, 6);
    poly(size * 0.44, 0x6a737f, 0x434b56, 28, 3);
    // Ramparts: low walls of rock in arcs, cut into blocks
    for (const w of b.walls ?? []) {
      const span = (((w.to - w.from) % 360) + 360) % 360 || 360, n = Math.max(2, Math.round(span / 7));
      for (let k = 0; k < n; k++) {
        const a0 = (w.from + (span * k) / n) * DEG, a1 = (w.from + (span * (k + 0.92)) / n) * DEG;
        const r0 = w.radius - 55, r1 = w.radius + 55;
        g.panel([Math.cos(a0) * r0, Math.sin(a0) * r0, Math.cos(a1) * r0, Math.sin(a1) * r0, Math.cos(a1) * r1, Math.sin(a1) * r1, Math.cos(a0) * r1, Math.sin(a0) * r1],
          0x7a7570, { bevel: 30, edge: 0x4f4b47, split: 2 });
      }
    }
    // Spokes out to the pads
    for (const p of b.slots) g.bar(0, 0, p.x, p.y, 70, 0x4d555f, { bevel: 14, split: Math.max(1, Math.round(Math.hypot(p.x, p.y) / 160)) });
    // The keep: a raised dais round the bastion, a tower between each pair of spokes, hazard lamps on the towers
    const spokes = b.slots.map((p) => Math.atan2(p.y, p.x));
    g.disc(0, 0, 250, 0x535b66, { bevel: 34, edge: 0x2f353d, rings: 3 }, sides * 3);
    g.disc(0, 0, 178, 0x3f4650, { bevel: 16, edge: 0x6a737f, rings: 2 }, sides * 3);
    for (let k = 0; k < sides; k++) {
      let a = (k / sides) * Math.PI * 2 + Math.PI / sides;
      // (nudged off any spoke it would stand on)
      for (const s of spokes) { const d = Math.atan2(Math.sin(a - s), Math.cos(a - s)); if (Math.abs(d) < 0.2) a = s + Math.sign(d || 1) * 0.2; }
      const x = Math.cos(a) * 262, y = Math.sin(a) * 262;
      g.disc(x, y, 40, 0x6f7884, { bevel: 14, edge: 0x3c434c }, 8);
      g.disc(x, y, 9, 0xffb547, { glow: 1 }, 6);
    }
    for (const p of b.slots) {
      g.disc(p.x, p.y, 120, 0x6a737f, { bevel: 26, edge: 0x7dd3fc }, 12);
      g.disc(p.x, p.y, 74, 0x3a4250, { bevel: 10 }, 12);
    }
    // Landing lights round the platform's rim
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; g.disc(Math.cos(a) * size * 0.95, Math.sin(a) * size * 0.95, 9, 0xffd890, { glow: 1 }, 6); }
    this.lit = new LitMesh(g.toGeometry());
    this.lit.radius = reach * 1.5;
    this.container.position.set(b.x, b.y);
    this.top.position.set(b.x, b.y);
    this.container.addChild(this.lit.mesh, this.ground, this.fx.under);
    this.top.addChild(this.marks.g);
    lighting.add(this.lit);
    lighting.addSource(this.lights);
  }

  private boom: (x: number, y: number, r: number) => void;

  /** Each frame (Renderer): the siege's state from the panel, its marks, its light */
  update(dt: number, f: BastionFrame): void {
    const msg = siegeFeed.msg?.active ? siegeFeed.msg : null;
    const tick = siegeFeed.tick();
    const turrets = msg?.turrets ?? [];
    const night = f.night;
    this.events(msg, turrets, tick);
    this.emplace(turrets);
    // The ground's marks: redrawn when what they show changes (looked at only when the state, the pad in focus, the
    // darkness's step or the count of fronts still on the lanes changes: no key string a frame)
    const focus = msg ? siegeFeed.padFocus() : -1;
    const atNight = msg?.phase === 'dusk' || msg?.phase === 'night';
    let onLanes = 0;
    if (msg && atNight && msg.incoming) for (const x of msg.incoming) if (x.at > tick - LANE_HOLD) onLanes++;
    const step = Math.round(night * 8), G = this.groundIn;
    if (msg !== G.msg || focus !== G.focus || step !== G.step || onLanes !== G.onLanes) {
      G.msg = msg; G.focus = focus; G.step = step; G.onLanes = onLanes;
      this.lost = new Set(msg?.padsLost ?? []);
      const lanes = !msg ? [] : atNight && msg.incoming?.length ? frontLanes(msg.incoming.filter((x) => x.at > tick - LANE_HOLD), this.b.x, this.b.y) : dayLanes(this.approach);
      const key = `${msg ? 1 : 0}|${turrets.map((t) => (t ? `${t.kind}:${Math.round(t.hull / 4)}:${t.range}` : '-')).join(',')}|${[...this.lost].join(',')}|${lanes.map((l) => l.angle.toFixed(2)).join(',')}|${focus}|${step}`;
      if (key !== this.groundKey) {
        this.groundKey = key;
        if (msg) drawGround(this.ground, { pads: this.pads, turrets, lost: this.lost, lanes, laneFrom: this.laneFrom, laneTo: this.laneTo, focus, night });
        else this.ground.clear();
      }
    }
    const lost = this.lost;
    // Moving light
    const hull = msg?.bastion ?? 100, breach = !!msg?.breach;
    const beacons = atNight ? (msg!.incoming ?? []).map((x) => ({ x: x.x - this.b.x, y: x.y - this.b.y, phase: beaconPhase(x.at, tick, BEACON_WARN), boss: !!x.boss })).filter((x) => x.phase >= 0) : [];
    const mends: { x: number; y: number; k: number; r: number }[] = [];
    turrets.forEach((t, i) => { if (t?.mend) mends.push({ x: this.pads[i].x, y: this.pads[i].y, k: t.mend, r: 160 }); });
    if (msg?.bastionMend) mends.push({ x: 0, y: 0, k: msg.bastionMend, r: 300 });
    const core = coreGlow(hull, breach);
    this.state = { night, hull, breach, active: !!msg, core, beacons };
    this.fx.update(dt, { bx: 0, by: 0, night: msg ? night : 0, hull, breach, core, beacons, mends });
    this.smokes(dt, msg, turrets, lost, hull);
    // Over the ships: hostiles by role (marks are in the bastion's frame)
    // (the marks' Graphics sits at the bastion, which is at the moon's middle but not necessarily the world's: no copy per entity)
    this.marks.update(dt, f.entities, msg, night, f.zoom, f.angle, tick, this.b.x, this.b.y, f.view);
  }

  /** What changed since last frame: a turret shot down, the bastion hit, a front landed */
  private events(msg: ServerSiegeStateMessage | null, turrets: (Turret | null)[], tick: number): void {
    const s = this.seen;
    if (msg && s.msg) {
      turrets.forEach((t, i) => {
        const was = s.turrets[i], p = this.pads[i];
        if (!p) return;
        if (was && !t && msg.padsLost?.includes(i)) {
          // Shot down: a big explosion, a shock ring, a burst of sparks and smoke
          this.boom(this.b.x + p.x, this.b.y + p.y, 220);
          this.fx.shock(p.x, p.y, 80, 700, 0xffb070, 0.9, 26);
          this.fx.shock(p.x, p.y, 40, 380, 0xffffff, 0.45, 14);
          this.fx.sparks(p.x, p.y, 26, 0xffb060, 700);
          for (let k = 0; k < 6; k++) this.fx.smoke(p.x, p.y, 110, 0.75);
        } else if (was && t && t.hull < was.hull) this.fx.sparks(p.x, p.y, 4, 0xffd090, 300);
      });
      const hull = msg.bastion ?? 100;
      if (s.hull >= 0 && hull < s.hull) {
        this.fx.shock(0, 0, 150, 480, 0xff5a4a, 0.5, 14);
        this.fx.sparks((Math.random() - 0.5) * 160, (Math.random() - 0.5) * 160, 8, 0xffc080, 420);
      }
      for (const f of msg.incoming ?? []) {
        if (f.at > s.tick && f.at <= tick) {
          const x = f.x - this.b.x, y = f.y - this.b.y;
          this.fx.shock(x, y, 120, 1400, f.boss ? 0xff2d55 : 0xff5a4a, 1.0, 30);
        }
      }
    }
    s.msg = msg;
    s.turrets = turrets.slice();
    s.hull = msg?.bastion ?? -1;
    s.tick = tick;
  }

  /** Smoke off what's hurt: turrets under half, the bastion under half, scorched pads */
  private smokes(dt: number, msg: ServerSiegeStateMessage | null, turrets: (Turret | null)[], lost: Set<number>, hull: number): void {
    if (!msg) return;
    this.smokeAt -= dt;
    if (this.smokeAt > 0) return;
    this.smokeAt = 0.22;
    turrets.forEach((t, i) => {
      const p = this.pads[i];
      if (t && t.hull < 50) {
        this.fx.smoke(p.x, p.y, 60 + (50 - t.hull), 0.5);
        if (t.hull < 25 && Math.random() < 0.5) this.fx.sparks(p.x, p.y, 2, 0xffa050, 250);
      } else if (!t && lost.has(i) && Math.random() < 0.35) this.fx.smoke(p.x, p.y, 70, 0.4);
    });
    if (hull < 50) {
      const a = Math.random() * Math.PI * 2;
      this.fx.smoke(Math.cos(a) * 90, Math.sin(a) * 90, 90 + (50 - hull) * 1.5, 0.55);
      if (hull < 30 && Math.random() < 0.6) this.fx.sparks(Math.cos(a) * 60, Math.sin(a) * 60, 3, 0xffb060, 320);
    }
  }

  /** The turrets' emplacements (lit, under each): rebuilt when what's built changes */
  private emplace(turrets: (Turret | null)[]): void {
    const key = turrets.map((t) => (t ? `${t.kind}${t.mark}` : '-')).join(',');
    if (key === this.emplacedKey) return;
    this.emplacedKey = key;
    if (this.emplaced) { this.lighting.remove(this.emplaced); this.emplaced.destroy(); this.emplaced = null; }
    if (!turrets.some((t) => t)) return;
    const g = new LitGeometry();
    turrets.forEach((t, i) => {
      if (!t) return;
      const p = this.pads[i], col = TURRET_LOOKS[t.kind ?? ''] ?? TURRET_DEFAULT, out = Math.atan2(p.y, p.x);
      // Three feet braced out to the pad's rim, a raised collar, armour plates in the kind's colour
      for (let k = 0; k < 3; k++) { const a = out + (k * Math.PI * 2) / 3 + Math.PI / 3; g.bar(p.x + Math.cos(a) * 70, p.y + Math.sin(a) * 70, p.x + Math.cos(a) * 112, p.y + Math.sin(a) * 112, 26, 0x4b535e, { bevel: 8 }); }
      g.disc(p.x, p.y, 88, 0x58616d, { bevel: 18, edge: 0x2f353d }, 16);
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2 + 0.06, a1 = ((k + 1) / 8) * Math.PI * 2 - 0.06, r0 = 70, r1 = 86;
        g.panel([p.x + Math.cos(a0) * r0, p.y + Math.sin(a0) * r0, p.x + Math.cos(a1) * r0, p.y + Math.sin(a1) * r0, p.x + Math.cos(a1) * r1, p.y + Math.sin(a1) * r1, p.x + Math.cos(a0) * r1, p.y + Math.sin(a0) * r1],
          k % 2 ? col : 0x6b7480, { bevel: 4 });
      }
      // A pip a mark, on the side facing out
      for (let m = 0; m < t.mark; m++) { const a = out + (m - (t.mark - 1) / 2) * 0.32; g.disc(p.x + Math.cos(a) * 104, p.y + Math.sin(a) * 104, 9, col, { glow: 1 }, 6); }
    });
    this.emplaced = new LitMesh(g.toGeometry());
    this.emplaced.radius = this.lit.radius;
    this.container.addChildAt(this.emplaced.mesh, 1);
    this.lighting.add(this.emplaced);
  }

  /** The pads' and rim's lamps (by each turret's hull), the core, the sweep at night, fronts' beacons, embers on scorched pads */
  private lights = (L: Lighting): void => {
    if (!this.container.visible) return;
    const x0 = this.container.x, y0 = this.container.y, st = this.state, msg = st.active ? siegeFeed.msg : null;
    const lost = msg?.padsLost;
    this.pads.forEach((p, i) => {
      const t = msg?.turrets?.[i];
      if (t) L.point(x0 + p.x, y0 + p.y, padLamp(t.hull), 560, 0.75, 120);
      else if (lost?.includes(i)) L.point(x0 + p.x, y0 + p.y, 0xff6a2a, 300, 0.35 + 0.25 * Math.random(), 60);
      else L.point(x0 + p.x, y0 + p.y, PAD_EMPTY, 520, 0.6, 120);
    });
    L.point(x0, y0, st.active ? st.core : 0xffd890, 1500, 0.6 + 0.25 * st.night, 500);
    if (st.active && st.night > 0.05) {
      const a = this.fx.angle;
      L.cone(x0, y0, Math.cos(a), Math.sin(a), st.breach ? 0xff8a7a : 0xfff1d0, 3800, 0.95 * st.night, 0.2, 180);
    }
    for (const b of st.beacons) L.point(x0 + b.x, y0 + b.y, b.boss ? 0xff2d55 : 0xff4a3a, 1100, 1.2 * b.phase, 300);
  };

  dispose(): void {
    this.lighting.removeSource(this.lights);
    this.lighting.remove(this.lit);
    if (this.emplaced) this.lighting.remove(this.emplaced);
    this.fx.dispose();
    this.top.destroy({ children: true });
    this.container.destroy({ children: true });
  }
}
