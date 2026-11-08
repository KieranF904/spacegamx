/**
 * @contract client.ship.render.hullDrawer
 * owns:       asking the hull worker for a design's hull and fitting a built hull to a view: batch slot, fixed barrels, skeleton and frame meshes
 * needs:      HullDrawHost (bridge, lighting, hulls batch, underLayer, destroyed), HullWorker, buildHull, hullCaches
 * invariants: a hull is built once per design, parts attached, colouring and kind, and shared — client/src/ships/rigidHull.test.ts
 *             a design changed in place drops a stale worker answer — none pinned
 * extend:     a new kind of per-view mesh is built in drawHull and freed in disposeFrame
 */

import { Container } from 'pixi.js';
import { LitMesh, type Lighting } from '../../rendering/lighting/Lighting';
import { LitGeometry } from '../../rendering/lighting/LitGeometry';
import type { ShipBatch, ShipGeometry } from '../../rendering/lighting/ShipBatch';
import type { ShipState } from '@space-game/common';
import type { ShipSource } from '../ShipStore';
import { HullWorker } from '../hullWorkerClient';
import { fromWire, type HullJob } from '../hullWire';
import { buildHull, skeletonCovered, type HullBuild } from '../hullBuild';
import { buildSkeleton } from '../skeletonBuild';
import { buildFrame } from '../frameBuild';
import { animOf } from '../gunAnim';
import { HULLS, HULLS_KEPT, BONES, ASKED, BUILD_HERE, BUILT_COM, DESIGN_NO, designNo, isRigid, hullKey } from './hullCaches';
import { gunGraphics, gunLook, clearBarrels } from './gunLooks';
import { GUN_TINT } from './constants';
import type { BodyView } from './viewTypes';

export interface HullDrawHost {
  readonly bridge: ShipSource;
  readonly lighting: Lighting;
  readonly hulls: ShipBatch;
  /** Under the hulls (fixed barrels, frames) */
  readonly underLayer: Container;
  destroyed(): boolean;
}

export class HullDrawer {
  constructor(private readonly h: HullDrawHost) {}

  /** Let go of the worker */
  terminate(): void {
    this.builder.terminate();
  }

  /**
   * A hull asked of the hull worker (once per design, colouring and parts attached): a rigid design's whole, from the
   * moment its body arrives; any other for the parts it has now, about its centre of mass now. Kept as if built here
   * when it comes (unless its design's been changed since: refresh)
   */
  private readonly builder = new HullWorker();

  ask(ship: ShipState, cs: number, tint: number | undefined, key = hullKey(ship, tint)): void {
    const bp = ship.blueprint;
    if (BUILD_HERE.has(bp) || HULLS.get(bp)?.has(key)) return;
    let asked = ASKED.get(bp);
    if (!asked) ASKED.set(bp, (asked = new Set()));
    if (asked.has(key)) return;
    asked.add(key);
    const whole = isRigid(ship), design = designNo(bp);
    const com: [number, number] = [ship.derived.com[0], ship.derived.com[1]];
    const job: Omit<HullJob, 'id'> = whole
      ? { blueprint: bp, cs, tint, design, whole: true, kind: 'ship' }
      : { blueprint: bp, cs, tint, design, kind: ship.kind, alive: [...ship.derived.alive], com };
    this.builder.build(job, (d) => {
      if (this.h.destroyed() || ASKED.get(bp) !== asked) return;
      asked.delete(key);
      if (!d) { BUILD_HERE.add(bp); return; }
      // (changed in place since it was asked: refresh)
      if (DESIGN_NO.get(bp) !== design) return;
      let byKey = HULLS.get(bp);
      if (!byKey) HULLS.set(bp, (byKey = new Map()));
      const build: HullBuild = { hull: { full: fromWire<ShipGeometry>(d.full), far: fromWire<ShipGeometry>(d.far) }, barrels: d.barrels };
      if (!whole) BUILT_COM.set(build, com);
      byKey.set(key, build);
      for (const k of byKey.keys()) { if (byKey.size <= HULLS_KEPT) break; byKey.delete(k); }
      if (whole && !BONES.has(bp)) BONES.set(bp, d.bones.map((b) => ({ sk: b.sk, cover: b.cover, g: fromWire<LitGeometry>(b.g) })));
    });
  }

  /**
   * Its hull drawn (false: still being built by the worker; what it had stays meanwhile). `here`: build it now, on the
   * main thread, if it isn't built already (a rigid design's is always the worker's while it's working)
   */
  drawHull(view: BodyView, ship: ShipState, cs: number, tint: number | undefined, key: string, here = false): boolean {
    let byKey = HULLS.get(ship.blueprint);
    if (!byKey) HULLS.set(ship.blueprint, (byKey = new Map()));
    let build = byKey.get(key);
    const rigid = isRigid(ship), worker = this.builder.ok && !BUILD_HERE.has(ship.blueprint);
    if (!build && worker && (rigid || !here)) { this.ask(ship, cs, tint, key); return false; }
    if (build) { byKey.delete(key); byKey.set(key, build); }
    else {
      byKey.set(key, (build = buildHull(this.h.bridge.catalog, this.h.bridge.geometry(ship), ship, cs, tint, rigid)));
      if (!rigid) BUILT_COM.set(build, [ship.derived.com[0], ship.derived.com[1]]);
      for (const k of byKey.keys()) { if (byKey.size <= HULLS_KEPT) break; byKey.delete(k); }
    }
    // (a rigid design's is drawn where it is; any other about the centre it was built about, shifted onto the ship's: placeHull)
    const com = rigid ? ship.derived.com : BUILT_COM.get(build) ?? ship.derived.com;
    view.hullFor = ship;
    view.hullCom = rigid ? undefined : com;
    // Fixed guns' barrels: each ship its own (they recoil and glow) over the looks every ship like it shares
    clearBarrels(view);
    const debris = ship.kind === 'debris', design = designNo(ship.blueprint);
    const nth = new Map<number, number>();
    for (const b of build.barrels) {
      const k = nth.get(b.part) ?? 0;
      nth.set(b.part, k + 1);
      const look = `b|${design}|${b.part}|${k}|${cs}`;
      const { c: bg, metal, lit } = gunGraphics(gunLook(look, () => ({ shapes: b.parts ?? [{ pts: b.pts, color: 0x8e98a7 }], outline: b.outline ?? [b.pts], k: 1 })));
      bg.position.set(b.x0, b.y0);
      metal.tint = debris ? 0x555555 : GUN_TINT;
      view.barrels.addChild(bg);
      view.fixed.push({ g: bg, metal, lit, part: b.part, look, x0: b.x0, y0: b.y0, nx: b.nx, ny: b.ny, len: b.len, rot: 0, rx: b.nx, ry: b.ny, kick: 0, heat: 0, debris, tm: -1, tl: -1, anim: debris ? undefined : animOf(ship.blueprint.parts[b.part].fn) });
    }
    this.h.hulls.set(view.id, build.hull, ship.derived.radius + cs);
    // Under the hull: its frame, if it has one, and its skeleton (a boss's: what's seen as its carapace comes off);
    // remade with it (its centre moves as parts come off; a broken skeleton goes)
    this.disposeFrame(view);
    const fp = debris ? undefined : ship.blueprint.parts.map((p) => this.h.bridge.catalog.pieces.get(p.piece)?.frame).find((f) => f);
    const bones = ship.blueprint.parts.map((p, i) => ({ sk: this.h.bridge.catalog.pieces.get(p.piece)?.skeleton, i })).filter((a) => a.sk && (rigid || ship.derived.alive[a.i]));
    if (!fp && !bones.length) return true;
    const c = new Container();
    const frame: NonNullable<BodyView['frame']> = { c, art: [] };
    // Its skeleton: lit geometry, as the hull is (skeletonBuild.ts); built whole, in pieces, each bared as what's over it goes
    if (bones.length && rigid) {
      let cut = BONES.get(ship.blueprint);
      if (!cut) {
        const catalog = this.h.bridge.catalog, geoms = this.h.bridge.geometry(ship);
        const over = (i: number) => { const pc = catalog.pieces.get(ship.blueprint.parts[i].piece); return !pc?.skeleton && !pc?.under; };
        cut = bones.flatMap(({ sk, i }) => {
          const g = new LitGeometry();
          buildSkeleton(g, sk!, ship.derived.com, cs);
          return [...skeletonCovered(g, geoms, ship.derived.com, cs, over)].map(([cover, piece]) => ({ sk: i, cover, g: piece }));
        });
        BONES.set(ship.blueprint, cut);
      }
      frame.shows = [];
      for (const { sk, cover, g } of cut) {
        const lm = new LitMesh(g.toGeometry());
        lm.radius = ship.derived.radius + cs;
        c.addChild(lm.mesh);
        this.h.lighting.add(lm);
        frame.art.push(lm);
        frame.shows.push({ m: lm, sk, cover });
      }
    } else if (bones.length) {
      const g = new LitGeometry();
      for (const { sk } of bones) buildSkeleton(g, sk!, com, cs);
      const lm = new LitMesh(g.toGeometry());
      lm.radius = ship.derived.radius + cs;
      c.addChild(lm.mesh);
      this.h.lighting.add(lm);
      frame.art.push(lm);
    }
    if (fp) {
      const { cold, hot } = buildFrame(fp, com, cs);
      const coldMesh = new LitMesh(cold.toGeometry()), hotMesh = new LitMesh(hot.toGeometry());
      coldMesh.radius = hotMesh.radius = ship.derived.radius;
      hotMesh.mesh.blendMode = 'add';
      hotMesh.mesh.alpha = view.heat ?? 0;
      c.addChild(coldMesh.mesh, hotMesh.mesh);
      this.h.lighting.add(coldMesh);
      this.h.lighting.add(hotMesh);
      frame.cold = coldMesh; frame.hot = hotMesh;
    }
    this.h.underLayer.addChildAt(c, 0);
    view.frame = frame;
    return true;
  }

  disposeFrame(view: BodyView): void {
    if (!view.frame) return;
    // (each mesh's geometry its own, made with it: off the GPU with it)
    const gone = (lm: LitMesh) => { this.h.lighting.remove(lm); const g = lm.mesh.geometry; lm.destroy(); g?.destroy(true); };
    for (const lm of view.frame.art) gone(lm);
    if (view.frame.cold) gone(view.frame.cold);
    if (view.frame.hot) gone(view.frame.hot);
    view.frame.c.destroy({ children: true });
    view.frame = undefined;
  }
}
