/**
 * @contract client.rendering.gun-range-chamber
 * owns:       how the gun range's chamber looks (systems.json `gunRange`, common gunRange/layout.ts): the station's dark
 *             beyond, the floor as a grid of panels with the firing lane and its distance marks, the rectangular wall all
 *             round (its face, ribs and lamps), the exit door in it with its EXIT sign and the zone X works in, the targets'
 *             rings and names, light pools from the ceiling, and the lamps as lights on the ships
 * needs:      pixi.js, common gunRange layout (chamberBox, chamberWalls, rangeDoor), lighting/Lighting, fxTextures (softDot)
 * invariants: the wall is drawn on the same pieces the shared terrain collides with (chamberWalls), and the door zone with the
 *             server's reach — client/src/rendering/terrainData.test.ts
 * extend:     a new thing in the chamber is a draw step in the constructor (static: drawn once, never redrawn)
 *
 * Everything is drawn once, when you arrive (Graphics never cleared: no rebuild a frame); a frame only checks the exit
 * sign's key name. Look only: the walls are solid in the shared terrain (terrainData.ts), whatever is drawn here.
 */

import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { chamberBox, chamberWalls, rangeDoor, type GunRangeDef } from '@space-game/common';
import type { Lighting } from '../lighting/Lighting';
import { softDot } from '../fxTextures';

/** A floor panel's side (world units), and how many to a heavy seam */
const PANEL = 200, MAJOR = 5;
const COL = {
  void: 0x06080c, floor: 0x1b2431, floorAlt: 0x1f2938, seam: 0x10151d, major: 0x0b0f15,
  wall: 0x2a3341, face: 0x46536a, edge: 0xa3b4cc, rib: 0x1d2430, lamp: 0xfff1d6,
  lane: 0xfacc15, target: 0xf87171, door: 0x4ade80, leaf: 0x3b475b, recess: 0x0b0f16,
};

const hash = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

const SIGN = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 120, fontWeight: '800', fill: COL.door, letterSpacing: 14 });
const SIGN_SMALL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 50, fontWeight: '600', fill: 0xd1fae5, letterSpacing: 3 });
const MARK = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 54, fontWeight: '700', fill: COL.lane, letterSpacing: 4 });
const TARGET = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 84, fontWeight: '800', fill: COL.target, letterSpacing: 16 });

export class ChamberView {
  readonly container = new Container();
  private readonly hint: Text;
  private key = '';
  private readonly light: (L: Lighting) => void;
  /** The floor's words (distance marks, the targets' names), drawn over the floor */
  private readonly labels: Text[] = [];

  constructor(private readonly def: GunRangeDef, private readonly lighting: Lighting, private readonly keyName: () => string) {
    const { x0, y0, x1, y1 } = chamberBox(def), t = def.wall, door = rangeDoor(def);
    const g = new Graphics();
    // The station beyond the wall: dark, far enough out that zooming out never finds its edge
    const far = 40000;
    g.rect(x0 - far, y0 - far, x1 - x0 + 2 * far, y1 - y0 + 2 * far).fill(COL.void);
    // The floor: panels, each a shade off its neighbours, seams between them and heavier ones every few
    g.rect(x0, y0, x1 - x0, y1 - y0).fill(COL.floor);
    for (let x = x0, i = 0; x < x1; x += PANEL, i++) {
      for (let y = y0, j = 0; y < y1; y += PANEL, j++) {
        const k = hash(i, j);
        if (k < 0.45) continue;
        g.rect(x + 3, y + 3, Math.min(PANEL, x1 - x) - 6, Math.min(PANEL, y1 - y) - 6).fill({ color: COL.floorAlt, alpha: 0.35 + 0.65 * (k - 0.45) / 0.55 });
      }
    }
    for (let x = x0, i = 0; x <= x1; x += PANEL, i++) g.moveTo(x, y0).lineTo(x, y1).stroke({ width: i % MAJOR ? 6 : 12, color: i % MAJOR ? COL.seam : COL.major });
    for (let y = y0, j = 0; y <= y1; y += PANEL, j++) g.moveTo(x0, y).lineTo(x1, y).stroke({ width: j % MAJOR ? 6 : 12, color: j % MAJOR ? COL.seam : COL.major });

    // The firing lane: from the door to the target, its edges dashed, a mark every 500 m
    const n = [door.nx, door.ny], side = [-door.ny, door.nx];
    const at = (d: number, s: number): [number, number] => [door.x + n[0] * d + side[0] * s, door.y + n[1] * d + side[1] * s];
    const laneLen = Math.max(0, ...def.targets.map((t) => (t.x - door.x) * n[0] + (t.y - door.y) * n[1] - t.ring));
    const lane = 260;
    for (const s of [-lane, lane]) {
      for (let d = 500; d < laneLen - 700; d += 120) {
        const [ax, ay] = at(d, s), [bx, by] = at(Math.min(d + 70, laneLen - 700), s);
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ width: 12, color: COL.lane, alpha: 0.28 });
      }
    }
    for (let d = 1000; d < laneLen - 600; d += 500) {
      const [ax, ay] = at(d, -lane - 60), [bx, by] = at(d, lane + 60);
      g.moveTo(ax, ay).lineTo(bx, by).stroke({ width: d % 1000 ? 8 : 16, color: COL.lane, alpha: d % 1000 ? 0.22 : 0.4 });
      if (d % 1000 === 0) {
        const label = new Text({ text: `${d / 1000} KM`, style: MARK });
        const [lx, ly] = at(d, lane + 150);
        label.anchor.set(0.5);
        label.position.set(lx, ly);
        label.alpha = 0.45;
        this.labels.push(label);
      }
    }

    // Each target's rings and cross on the floor (sized to it), and its name under them
    for (const tgt of def.targets) {
      const r = tgt.ring, k = Math.max(0.35, Math.min(1, r / 700)), w = Math.max(5, 14 * k);
      for (const [m, a] of [[1, 0.35], [1.43, 0.2]] as const) g.circle(tgt.x, tgt.y, r * m).stroke({ width: w, color: COL.target, alpha: a });
      g.moveTo(tgt.x - r * 1.65, tgt.y).lineTo(tgt.x + r * 1.65, tgt.y).stroke({ width: w * 0.6, color: COL.target, alpha: 0.18 });
      g.moveTo(tgt.x, tgt.y - r * 1.65).lineTo(tgt.x, tgt.y + r * 1.65).stroke({ width: w * 0.6, color: COL.target, alpha: 0.18 });
      const label = new Text({ text: tgt.label.toUpperCase(), style: TARGET });
      label.anchor.set(0.5, 0);
      label.scale.set(Math.max(0.5, k * 0.75));
      label.position.set(tgt.x, tgt.y + r * 1.43 + 40);
      label.alpha = 0.55;
      this.labels.push(label);
    }

    // The door's zone: where X takes you out (the server's reach), dashed on the floor
    const reach = def.door.reach, a0 = Math.atan2(n[1], n[0]);
    for (let k = 0; k < 18; k++) {
      const s0 = a0 - Math.PI / 2 + (k / 18) * Math.PI, s1 = s0 + (Math.PI / 18) * 0.6;
      g.moveTo(door.x + Math.cos(s0) * reach, door.y + Math.sin(s0) * reach).lineTo(door.x + Math.cos(s1) * reach, door.y + Math.sin(s1) * reach)
        .stroke({ width: 14, color: COL.door, alpha: 0.45 });
    }
    g.circle(door.x, door.y, reach).fill({ color: COL.door, alpha: 0.05 });

    // The wall all round: the pieces the terrain collides with, its face lit, ribs with lamps along it
    for (const p of chamberWalls(def)) g.poly(p.flat()).fill(COL.wall);
    const face = 46;
    g.rect(x0 - face, y0 - face, x1 - x0 + 2 * face, face).fill(COL.face);
    g.rect(x0 - face, y1, x1 - x0 + 2 * face, face).fill(COL.face);
    g.rect(x0 - face, y0, face, y1 - y0).fill(COL.face);
    g.rect(x1, y0, face, y1 - y0).fill(COL.face);
    g.rect(x0, y0, x1 - x0, y1 - y0).stroke({ width: 8, color: COL.edge, alpha: 0.9 });
    g.rect(x0 - t, y0 - t, x1 - x0 + 2 * t, y1 - y0 + 2 * t).stroke({ width: 16, color: COL.major });
    const lamps: [number, number][] = [];
    const RIB = 600;
    const rib = (x: number, y: number, w: number, h: number, lx: number, ly: number) => { g.rect(x, y, w, h).fill(COL.rib); lamps.push([lx, ly]); };
    for (let x = x0 + RIB / 2; x < x1; x += RIB) {
      rib(x - 40, y0 - t * 0.75, 80, t * 0.75 - face, x, y0 - face - 12);
      rib(x - 40, y1 + face, 80, t * 0.75 - face, x, y1 + face + 12);
    }
    for (let y = y0 + RIB / 2; y < y1; y += RIB) {
      if (Math.abs(y - door.y) < def.door.width && door.nx !== 0) continue;
      rib(x0 - t * 0.75, y - 40, t * 0.75 - face, 80, x0 - face - 12, y);
      rib(x1 + face, y - 40, t * 0.75 - face, 80, x1 + face + 12, y);
    }

    // The door: a recess in the wall, two leaves shut, hazard stripes either side, green lights
    const [e0, e1] = door.ends, depth = t * 0.8;
    const recess = [e0[0], e0[1], e1[0], e1[1], e1[0] - n[0] * depth, e1[1] - n[1] * depth, e0[0] - n[0] * depth, e0[1] - n[1] * depth];
    g.poly(recess).fill(COL.recess);
    const mid = [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2];
    const leaf = (a: number[], b: number[]) => g.poly([a[0], a[1], b[0], b[1], b[0] - n[0] * 70, b[1] - n[1] * 70, a[0] - n[0] * 70, a[1] - n[1] * 70]).fill(COL.leaf);
    leaf(e0, [mid[0] - side[0] * 6, mid[1] - side[1] * 6]);
    leaf([mid[0] + side[0] * 6, mid[1] + side[1] * 6], e1);
    g.moveTo(e0[0], e0[1]).lineTo(e1[0], e1[1]).stroke({ width: 10, color: COL.door, alpha: 0.9 });
    // (hazard stripes on the wall's face beside the door)
    for (const [end, dir] of [[e0, -1], [e1, 1]] as const) {
      for (let k = 0; k < 4; k++) {
        const s0 = k * 45, s1 = s0 + 22;
        const p = (s: number, d: number) => [end[0] + side[0] * dir * s - n[0] * d, end[1] + side[1] * dir * s - n[1] * d];
        const q = [p(s0, 0), p(s1, 0), p(s1 + 22, face), p(s0 + 22, face)].flat();
        g.poly(q).fill(COL.lane);
      }
    }
    lamps.push([e0[0] + n[0] * 20 - side[0] * 40, e0[1] + n[1] * 20 - side[1] * 40], [e1[0] + n[0] * 20 + side[0] * 40, e1[1] + n[1] * 20 + side[1] * 40]);
    this.container.addChild(g);

    // Light: pools on the floor from the ceiling, the wall lamps, the door's green
    const dot = softDot(0.05, 0.6);
    const pools = new Container();
    for (let x = x0 + 750; x < x1; x += 1500) {
      for (let y = y0 + 800; y < y1; y += 1600) {
        const s = new Sprite(dot);
        s.anchor.set(0.5); s.position.set(x, y); s.tint = 0xcfe0ff; s.alpha = 0.09; s.blendMode = 'add';
        s.scale.set((2 * 1100) / 64);
        pools.addChild(s);
      }
    }
    for (let i = 0; i < lamps.length; i++) {
      const [lx, ly] = lamps[i], s = new Sprite(softDot(0.3, 0.2));
      // (the last two are the door's)
      const green = i >= lamps.length - 2;
      s.anchor.set(0.5); s.position.set(lx, ly); s.tint = green ? COL.door : COL.lamp; s.alpha = 0.9; s.blendMode = 'add';
      s.scale.set((2 * 34) / 64);
      pools.addChild(s);
      const halo = new Sprite(dot);
      halo.anchor.set(0.5); halo.position.set(lx, ly); halo.tint = green ? COL.door : COL.lamp; halo.alpha = 0.08; halo.blendMode = 'add';
      halo.scale.set((2 * 260) / 64);
      pools.addChild(halo);
    }
    const doorGlow = new Sprite(dot);
    doorGlow.anchor.set(0.5); doorGlow.position.set(door.x + n[0] * 80, door.y + n[1] * 80); doorGlow.tint = COL.door; doorGlow.alpha = 0.16; doorGlow.blendMode = 'add';
    doorGlow.scale.set((2 * 520) / 64);
    pools.addChild(doorGlow);
    this.container.addChild(pools);

    // The EXIT sign on the floor inside the door, and what to press
    const sign = new Text({ text: 'EXIT', style: SIGN });
    sign.anchor.set(0.5);
    sign.position.set(door.x + n[0] * 230, door.y + n[1] * 230 - 50);
    this.hint = new Text({ text: '', style: SIGN_SMALL });
    this.hint.anchor.set(0.5);
    this.hint.position.set(door.x + n[0] * 230, door.y + n[1] * 230 + 55);
    for (const l of this.labels) this.container.addChild(l);
    this.container.addChild(sign, this.hint);
    this.refreshHint();

    // The ships take the ceiling lamps' light and the door's (Lighting merges near ones; a few, so shots still count)
    const ceiling: [number, number][] = [];
    for (let x = x0 + 1000; x < x1; x += 2000) for (const y of [y0 + (y1 - y0) * 0.3, y0 + (y1 - y0) * 0.7]) ceiling.push([x, y]);
    this.light = (L) => {
      for (const [x, y] of ceiling) L.point(x, y, 0xe8f0ff, 2600, 0.5, 1400);
      L.point(door.x + n[0] * 150, door.y + n[1] * 150, COL.door, 700, 0.6, 200);
    };
    lighting.addSource(this.light);
  }

  /** The sign says the bound key (rebinding is rare: one string compare a frame) */
  private refreshHint(): void {
    const k = this.keyName();
    if (k === this.key) return;
    this.key = k;
    this.hint.text = `PRESS ${k.toUpperCase()} TO LEAVE`;
  }

  update(): void {
    this.refreshHint();
  }

  destroy(): void {
    this.lighting.removeSource(this.light);
    this.container.destroy({ children: true });
  }
}
