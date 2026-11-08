/**
 * @contract client.ship.renderer
 * owns:       drawing modular ships and debris each frame: views per ship, hull slots, fades, labels, health bars, lights
 * needs:      ShipSource (ShipStore), GameState entities, Renderer, ships/render/{GunDrawer,HullDrawer,muzzle,bankGlow,gunLooks,hullCaches}
 * invariants: a hull is built once per design, parts attached, colouring and kind, and shared by every ship like it — client/src/ships/rigidHull.test.ts
 *             damage and the hit flash are data the hull shader reads: taking hits builds nothing — none pinned
 * extend:     a new per-ship visual is a field on BodyView (render/viewTypes.ts) drawn in update(), or a new module under ships/render/
 */

/**
 * Draws modular ships and debris in flight: structure from a ShipSource (the
 * client's ShipStore), poses from the interpolated GameState entities.
 *
 * A hull is built once per design, set of parts still attached, colouring and
 * kind (shared by every ship like it: HULLS), at full health; damage and the
 * hit flash are data the hull shader reads (ShipBatch), so taking hits builds
 * nothing.
 */

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Lighting } from '../rendering/lighting/Lighting';
import { ShipBatch } from '../rendering/lighting/ShipBatch';
import { beam } from '../rendering/fxTextures';
import { EntityType, ShipState, STATUS_SLOWED, currentStage } from '@space-game/common';
import type { ShipSource } from './ShipStore';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { ThrusterFx, ThrustCommand } from './ThrusterFx';
import { PartFx } from './PartFx';
import type { ClientFeatures } from './features/host';
import type { ShipDrawCtx } from './features/types';
import { cameraView } from '../rendering/cameraView';
import factionsData from '../../../data/factions.json';
import type { BodyView } from './render/viewTypes';
import {
  FADE, OFFSCREEN_MARGIN, GUN_MIN_PX, STATUS_SLOT, HEADLIGHT, LAMPS_BELOW, BIG_HULL, BUILD_EVERY,
  LABEL_STYLE, TRAFFIC_LABEL_STYLE, HOSTILE_LABEL_STYLE, CALM_LABEL_STYLE, ELITE_LABEL_STYLE, BOSS_LABEL_STYLE,
} from './render/constants';
import { flushGuns, clearBarrels, clearTurrets } from './render/gunLooks';
import { HULLS, ASKED, DESIGN_NO, isRigid, hullKey } from './render/hullCaches';
import { GunDrawer } from './render/GunDrawer';
import { HullDrawer } from './render/HullDrawer';
import { drawBankGlow } from './render/bankGlow';
import { kickGun, spinAtGun, barrelTipOf } from './render/muzzle';

/** Hostile factions' colours by index (snapshot data[3]) */
export const FACTION_COLORS = Object.values((factionsData as { factions: Record<string, { color: string }> }).factions).map((f) => parseInt(f.color.slice(1), 16));

export class ShipRenderer {
  private views = new Map<number, BodyView>();
  private layer: Container;
  private engines: ThrusterFx;
  private partFx = new PartFx();
  private lastFrame = 0;
  private flamesLayer = new Container();
  /** Under the hulls (fixed barrels), the hulls in a few draws, then over them (flashes, turrets) */
  private underLayer = new Container();
  private hulls: ShipBatch;
  private overLayer = new Container();
  /** Ships gone from the world, fading out where they were last seen */
  private leaving: BodyView[] = [];
  /** Hull building and fitting (render/HullDrawer.ts), and turret and barrel drawing (render/GunDrawer.ts) */
  private readonly hullDraw: HullDrawer;
  private readonly gunDraw: GunDrawer;
  private readonly bankHost = { charge: () => this.state.charge, geometry: (s: ShipState) => this.bridge.geometry(s) };

  constructor(
    private bridge: ShipSource,
    private renderer: Renderer,
    private state: GameState,
    /** The pilot's thrust command for a ship we fly (null: infer it from the ship's motion) */
    private thrustCommand: (id: number) => ThrustCommand | null,
    /** Ships not to draw (docked: inside their station) */
    private hidden: (id: number) => boolean = () => false,
    /** Part features' ship drawing (features/host.ts) */
    private features?: ClientFeatures,
  ) {
    this.layer = new Container();
    renderer.getShipLayer().addChild(this.layer);
    this.engines = new ThrusterFx(this.layer, bridge);
    // Every ship's flames in one layer under the hulls: one additive batch, not a blend switch per ship
    this.layer.addChild(this.flamesLayer);
    this.lighting = renderer.lighting;
    this.hulls = new ShipBatch(this.lighting, bridge.tuning.cellSize);
    this.layer.addChild(this.underLayer, this.hulls.container, this.overLayer);
    this.hullDraw = new HullDrawer({ bridge, lighting: this.lighting, hulls: this.hulls, underLayer: this.underLayer, destroyed: () => this.destroyed });
    this.gunDraw = new GunDrawer({ catalog: bridge.catalog, renderer, lvl: this.lvl, playerId: () => this.state.playerId, geometry: (s) => bridge.geometry(s) });
    this.lighting.addSource(this.lights);
  }

  /** Is this ship slowed by a Frostbite's beam: you from your pilot row's ticks, other pilots from their status bits (weaponry.ts STATUS_SLOWED) */
  private slowed(eid: number, e: InterpolatedEntity): boolean {
    if (eid === this.state.playerId) return (e.slowUntil ?? 0) > this.state.serverTick;
    return ((e.status?.[STATUS_SLOT] ?? 0) & STATUS_SLOWED) !== 0;
  }

  /** Is this ship EMP'd (Hush): your row carries the ticks left in data[5], everyone else's a flag in data[2] */
  private empd(e: InterpolatedEntity): boolean {
    return ((e.type === EntityType.Player ? e.data?.[5] : e.data?.[2]) ?? 0) > 0;
  }

  /** The one ctx every feature draw gets (fields reset per ship: no allocation per frame) */
  private featureCtx = {} as ShipDrawCtx;
  private geometryOf = (ship: ShipState) => this.bridge.geometry(ship);
  private lights = (L: Lighting) => this.collectLights(L);
  private destroyed = false;

  /**
   * Everything it made let go: every ship's view (hull slots, guns, frames, labels), the hull worker, its batch's
   * GPU geometry and textures, its light source, its layers, and the gun looks no one else is using
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [id, view] of this.views) { this.engines.forget(id); this.renderer.shipRadius.delete(id); this.dispose(view); }
    for (const view of this.leaving) this.dispose(view);
    this.views.clear();
    this.leaving.length = 0;
    this.hullDraw.terminate();
    this.lighting.removeSource(this.lights);
    this.hulls.destroy();
    this.layer.destroy({ children: true });
    this.blown.clear();
    this.heats.clear();
    flushGuns();
  }

  private lighting: Lighting;
  private lvl: [number, number, number] = [1, 1, 1];

  /**
   * Ships' own lights: engines; and where it's dark, headlights (a beam ahead)
   * and a faint light over the hull so a ship can always see itself.
   */
  private collectLights(L: Lighting): void {
    this.engines.collectLights(L);
    for (const [eid, view] of this.views) {
      if (view.lamps <= 0.01) continue;
      const e = this.state.entities.get(eid), ship = this.bridge.bodies.get(eid);
      if (!e || !ship) continue;
      const fx = Math.cos(e.renderAngle), fy = Math.sin(e.renderAngle), r = ship.derived.radius;
      L.cone(e.renderX + fx * r * 0.9, e.renderY + fy * r * 0.9, fx, fy, HEADLIGHT, 1500 + r * 4, 1.5 * view.lamps, 0.4, 45);
      L.point(e.renderX, e.renderY, 0xd6e2ff, r * 2.4 + 60, 0.5 * view.lamps, r);
    }
  }




  /** A shot left a gun at (x, y): the turret it came from recoils and warms up (render/muzzle.ts) */
  kick(owner: number, x: number, y: number, power = 1): void {
    kickGun(this.views, owner, x, y, power);
  }

  /** How far the spin of the gun a shot left (x, y) from has got (0..1) (render/muzzle.ts) */
  spinAt(owner: number, x: number, y: number): number {
    return spinAtGun(this.views, this.state.playerId, owner, x, y);
  }

  /** Where a shot leaving (x, y) along `angle` comes out of its gun as drawn (render/muzzle.ts) */
  barrelTip(owner: number, x: number, y: number, angle: number): { x: number; y: number } | null {
    return barrelTipOf(this.views, this.bridge.tuning.cellSize, owner, x, y, angle);
  }

  /** Headlights come on (fading in) where the ambient and the sun leave it dark; their beam shows faintly */
  private updateLamps(view: BodyView, ship: ShipState, e: { renderX: number; renderY: number; renderAngle: number }, dt: number): void {
    const env = this.lighting.envAt(e.renderX, e.renderY);
    const want = ship.kind === 'ship' && this.lighting.enabled && env < LAMPS_BELOW ? 1 : 0;
    view.lamps += (want - view.lamps) * Math.min(1, dt * 2.5);
    if (view.lamps < 0.02) { if (view.beam) view.beam.visible = false; return; }
    if (!view.beam) {
      view.beam = new Sprite(beam());
      view.beam.anchor.set(0, 0.5);
      view.beam.tint = HEADLIGHT;
      this.flamesLayer.addChild(view.beam);
    }
    const r = ship.derived.radius, len = 1500 + r * 4;
    const fx = Math.cos(e.renderAngle), fy = Math.sin(e.renderAngle);
    view.beam.visible = true;
    view.beam.position.set(e.renderX + fx * r * 0.9, e.renderY + fy * r * 0.9);
    view.beam.rotation = e.renderAngle;
    view.beam.scale.set(len / 256, (len * Math.tan(0.4) * 2) / 128);
    view.beam.alpha = 0.1 * view.lamps * Math.max(0.3, 1 - env / LAMPS_BELOW);
  }

  /** Build a ship's hull and turrets afresh next frame, not from the cache (leaving a station: whatever was changed there shows) */
  refresh(id: number): void {
    const ship = this.bridge.bodies.get(id);
    // (its design may have been changed in place: a new number, so its fixed guns' looks and the worker's copy are made
    // afresh, and an answer still on its way from the worker is dropped)
    if (ship) { HULLS.delete(ship.blueprint); ASKED.delete(ship.blueprint); DESIGN_NO.delete(ship.blueprint); }
    const view = this.views.get(id);
    if (view) { view.ship = null; view.turretShip = null; view.hullKey = ''; }
  }

  /**
   * A ship took damage: its hull flashes (harder for bigger hits; a big hull
   * far less: one shot doesn't light up a whole boss, and a stream of them
   * would leave it flickering white)
   */
  hit(id: number, amount: number): void {
    const view = this.views.get(id);
    if (!view) return;
    const r = view.ship?.derived.radius ?? 0, big = Math.min(1, Math.pow(160 / Math.max(160, r), 1.4));
    view.flashLevel = Math.max(view.flashLevel, Math.min(0.75, 0.3 + amount / 80) * big);
  }

  /** Engine flames and exhaust (for the bloom) */
  glowLayers(): Container[] {
    return [this.flamesLayer, this.engines.exhaustLayer];
  }

  /**
   * How much of a ghost this ship is drawn as (0 none, 1 all: its hull goes, the ghost layer's marker stands in): the focus
   * grid draws ships from 18 km out as ghosts (CAPS.FOCUS: ShipClient sets it, common network/cells.ts ghostWeight)
   */
  ghostOf: (eid: number) => number = () => 0;

  update(): void {
    const cs = this.bridge.tuning.cellSize;
    const seen = new Set<number>();
    this.renderer.hiddenEntityIds = seen;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.engines.beginFrame(dt);
    this.hulls.begin();
    // (Part features' once-a-frame setup: a Tow Beam's tethers are one graphics, cleared here and drawn afresh by each ship's draw)
    this.features?.beginFrame(this.layer);

    for (const [eid, ship] of this.bridge.bodies) {
      const entity = this.state.entities.get(eid);
      if (!entity) continue;
      seen.add(eid);
      let view = this.views.get(eid);
      if (!view) {
        // Back before it had faded out (its entity gone a moment and sent again, an id that came straight back): the
        // fading view is taken up again. A second view beside it would lose its hull when the old one finished fading,
        // the batch slot being the ship's id (hull gone for good, its guns and flames still drawn)
        view = this.takeBack(eid) ?? this.newView(eid);
        this.views.set(eid, view);
      }
      // Docked: inside the station, out of sight
      const away = this.hidden(eid);
      // Off screen, with room for its light to reach in: no hull, engine, lamp or gun work this frame (below). Each part's
      // visibility is set once a frame, as it'll be drawn: a change, even one undone, has Pixi rebuild the scene's draw list
      const shown = !away && (eid === this.state.playerId || this.renderer.inView(entity.renderX, entity.renderY, ship.derived.radius + OFFSCREEN_MARGIN));
      view.container.visible = view.flames.visible = shown;
      // (too small on screen to see a gun: see drawTurrets)
      view.barrels.visible = shown && cs * this.renderer.getZoom() >= GUN_MIN_PX;
      if (view.frame) view.frame.c.visible = !away;
      if (view.label) view.label.visible = shown;
      if (view.bar) view.bar.visible = shown;
      if (away) {
        view.lamps = 0;
        if (view.beam) view.beam.visible = false;
        continue;
      }
      const hostile = entity.type === EntityType.ShipBody && entity.data?.[0] === 3;
      // Hostiles wear their faction's colours; pilots their own paint
      const tint = hostile ? FACTION_COLORS[entity.data?.[3] ?? -1] : ship.blueprint.paint ? parseInt(ship.blueprint.paint.slice(1), 16) : undefined;
      this.renderer.shipRadius.set(eid, ship.derived.radius);
      this.hulls.track(eid, entity.renderX, entity.renderY);
      // A boss's hull is built off the main thread from the moment its body arrives, on screen or not: ready by the time it's seen
      if (isRigid(ship)) this.hullDraw.ask(ship, cs, tint);
      if (!shown) {
        if (view.beam) view.beam.visible = false;
        continue;
      }
      // (fading in only once its hull's there to show: built off the main thread, it may take a frame or two)
      if (view.hullFor === ship) view.fade = Math.min(1, view.fade + dt / FADE);
      view.vis = view.fade * (1 - this.ghostOf(eid));
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.vis;
      // Its structure (which parts are attached) only changes when it's rebuilt; damage is data (below)
      const big = ship.blueprint.parts.length >= BIG_HULL;
      if ((ship !== view.ship || ship.rebuilds !== view.rebuilds) && !(big && ship === view.ship && now - (view.builtAt ?? 0) < BUILD_EVERY)) {
        const changed = ship !== view.ship;
        view.ship = ship;
        view.rebuilds = ship.rebuilds;
        const key = hullKey(ship, tint);
        if (changed || key !== view.hullKey) {
          // Built off the main thread, the hull it had drawing meanwhile (asked again next frame). Built here, now, only
          // for a new design replacing one already in view (the hangar's changes on the pilot's ship), so it never blinks out
          const now2 = changed && view.hullFor !== null && !isRigid(ship);
          if (this.hullDraw.drawHull(view, ship, cs, tint, key, now2)) { view.hullKey = key; view.builtAt = now; } else view.rebuilds = -1;
        }
      }
      this.hulls.setDamage(eid, ship.hp, ship.maxHp, ship.detached, ship.derived.alive);
      this.engines.draw(view.flames, ship, entity, this.thrustCommand(eid), dt, cs, tint, this.slowed(eid, entity) ? 1 : 0, this.empd(entity));
      // Light on the ship (for its guns, which are tinted rather than lit per vertex)
      this.lighting.levelAt(entity.renderX, entity.renderY, this.lvl);
      this.gunDraw.drawTurrets(view, ship, cs, dt * 60);
      drawBankGlow(this.bankHost, view, ship, cs, eid === this.state.playerId);
      this.partFx.draw(view.container, view.guns, ship, this.bridge.geometry(ship), cs, now, eid === this.state.playerId ? this.state.charge : null);
      this.updateLamps(view, ship, entity, dt);
      if (this.features?.hasDrawers) {
        const fc = this.featureCtx;
        fc.eid = eid; fc.ship = ship; fc.entity = entity; fc.container = view.container; fc.cs = cs; fc.now = now; fc.shared = this.layer; fc.geometry = this.geometryOf;
        this.features.drawShip(fc);
      }
      // Quick: most of the flash gone in ~6 frames
      if (view.flashLevel > 0) view.flashLevel = Math.max(0, view.flashLevel * Math.pow(0.7, dt * 60) - 0.01 * dt * 60);
      view.container.x = entity.renderX;
      view.container.y = entity.renderY;
      if (entity.name && entity.type !== EntityType.Player) {
        if (!view.label) {
          const style = hostile ? (entity.data?.[4] === 2 ? BOSS_LABEL_STYLE : entity.data?.[4] === 1 ? ELITE_LABEL_STYLE : HOSTILE_LABEL_STYLE) : entity.data?.[0] === 2 ? TRAFFIC_LABEL_STYLE : LABEL_STYLE;
          // Rastered at 2× so it stays crisp zoomed in
          view.label = new Text({ text: entity.name, style, resolution: 2 });
          view.label.anchor.set(0.5, 0);
          view.labelAlpha = hostile ? 0.95 : 0.75;
          this.layer.addChild(view.label);
        }
        // Calm or provoked: grey until it means you harm
        const calm = hostile && entity.data?.[9] === 1 && entity.data?.[4] !== 2;
        if (hostile && (view.calmLabel ?? false) !== calm) {
          view.calmLabel = calm;
          view.label.style = calm ? CALM_LABEL_STYLE : entity.data?.[4] === 1 ? ELITE_LABEL_STYLE : HOSTILE_LABEL_STYLE;
        }
        // Counter-scaled when zoomed out, so it stays readable
        const k = this.renderer.tagScale;
        view.label.scale.set(k);
        view.label.alpha = view.labelAlpha * view.vis;
        // Below the ship on screen, upright however the camera's rolled (helm)
        const a = cameraView.angle, below = ship.derived.radius + 24, ux = -Math.sin(a), uy = Math.cos(a);
        view.label.x = entity.renderX + ux * below;
        view.label.y = entity.renderY + uy * below;
        view.label.rotation = a;
        if (hostile && entity.data?.[4] !== 2) {
          if (!view.bar) { view.bar = new Graphics(); this.layer.addChild(view.bar); }
          const f = Math.max(0, Math.min(1, (entity.data?.[5] ?? 100) / 100));
          const sh = (entity.data?.[1] ?? 0) / 100;
          const w = 120, x0 = -w / 2;
          view.bar.position.set(view.label.x + ux * 32 * k, view.label.y + uy * 32 * k);
          view.bar.rotation = a;
          view.bar.scale.set(k);
          view.bar.alpha = view.vis;
          const key = `${f}|${sh}`;
          if (key !== view.barKey) {
            view.barKey = key;
            view.bar.clear();
            view.bar.rect(x0 - 1, -1, w + 2, 8).fill({ color: 0x000000, alpha: 0.55 });
            view.bar.rect(x0, 0, w * f, 6).fill({ color: f > 0.5 ? 0xff6b5a : f > 0.25 ? 0xffa94d : 0xff3b3b });
            if (sh > 0) view.bar.rect(x0, -4, w * sh, 3).fill({ color: 0x7dd3fc });
          }
        }
      }
      // Grid forward is -y; the engine's angle 0 is +x
      view.container.rotation = entity.renderAngle + Math.PI / 2;
      view.flames.position.set(entity.renderX, entity.renderY);
      view.flames.rotation = view.container.rotation;
      this.placeHull(view);
    }

    for (const [eid, view] of this.views) {
      if (seen.has(eid)) continue;
      this.engines.forget(eid);
      this.renderer.shipRadius.delete(eid);
      this.views.delete(eid);
      // Fade out where it was last seen (from wherever it had faded in to); hidden ones just go
      if (view.container.visible && view.fade > 0) this.leaving.push(view);
      else this.dispose(view);
    }
    let w = 0;
    for (const view of this.leaving) {
      view.fade -= dt / FADE;
      if (view.fade <= 0) { this.dispose(view); continue; }
      // (a ghost already, dropped from the focus far off: it doesn't come back solid to fade out)
      view.vis = Math.min(view.vis ?? view.fade, view.fade);
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.vis;
      this.placeHull(view);
      if (view.label) view.label.alpha = view.labelAlpha * view.vis;
      if (view.bar) view.bar.alpha = view.vis;
      if (view.beam) view.beam.visible = false;
      this.leaving[w++] = view;
    }
    this.leaving.length = w;
    this.hulls.end(this.renderer.getZoom());
  }

  /**
   * The hull's slot follows the container (and the barrels and frame with it). A hull built for parts since
   * lost (its new one still being built) is shifted onto the ship's centre of mass as it is now; one built for another
   * ship (a new design on its way) isn't drawn.
   */
  private placeHull(view: BodyView): void {
    const c = view.container, ship = view.ship;
    let x = c.x, y = c.y;
    const com = ship?.derived.com, at = view.hullCom;
    if (com && at && (com[0] !== at[0] || com[1] !== at[1])) {
      const cs = this.bridge.tuning.cellSize, dx = (at[0] - com[0]) * cs, dy = (at[1] - com[1]) * cs;
      const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
      x += dx * cos - dy * sin; y += dx * sin + dy * cos;
    }
    const mine = view.hullFor === ship;
    view.barrels.position.set(x, y);
    view.barrels.rotation = c.rotation;
    // (no hull of its own yet: nothing of it drawn, not its guns nor its flames floating without it)
    if (!mine) {
      view.barrels.visible = view.guns.visible = view.flames.visible = false;
    }
    // (built whole: what shows is what's there)
    if (ship && mine && isRigid(ship)) {
      const alive = ship.derived.alive;
      const blown = this.blown.get(view.id);
      for (const s of view.frame?.shows ?? []) s.m.mesh.visible = alive[s.sk] && (s.cover < 0 || (!alive[s.cover] && !blown?.has(s.cover)));
      for (const b of view.fixed) b.g.visible = alive[b.part];
    }
    if (view.frame) {
      view.frame.c.position.set(x, y);
      view.frame.c.rotation = c.rotation;
      view.frame.c.alpha = view.vis ?? view.fade;
      if (!mine) view.frame.c.visible = false;
      // (its heat eases in: the glow creeping out along the girders)
      const want = this.heats.get(view.id) ?? 0;
      view.heat = (view.heat ?? 0) + (want - (view.heat ?? 0)) * 0.03;
      if (view.frame.hot) view.frame.hot.mesh.alpha = view.heat * (0.75 + 0.25 * Math.sin(performance.now() / 260 + view.id));
    }
    const vis = view.vis ?? view.fade;
    if (mine) this.hulls.place(view.id, x, y, c.rotation, vis, view.flashLevel * vis);
  }

  /** A ship's view, empty (its hull, guns and flames come as it's drawn) */
  private newView(eid: number): BodyView {
    const view: BodyView = { id: eid, container: new Container(), flames: new Container(), guns: new Container(), turrets: [], ship: null, turretShip: null, turretRebuilds: -1, rebuilds: -1, hullKey: '', flashLevel: 0,
      barrels: new Container(), fixed: [], lamps: 0, fade: 0, labelAlpha: 1, hullFor: null };
    view.container.addChild(view.guns);
    this.flamesLayer.addChild(view.flames);
    this.underLayer.addChild(view.barrels);
    this.overLayer.addChild(view.container);
    return view;
  }

  /** A view of this ship still fading out, taken off the leaving list (it fades back in from where it had got to) */
  private takeBack(eid: number): BodyView | undefined {
    const i = this.leaving.findIndex((v) => v.id === eid);
    return i < 0 ? undefined : this.leaving.splice(i, 1)[0];
  }

  private dispose(view: BodyView): void {
    view.label?.destroy();
    view.bar?.destroy();
    view.flames.destroy({ children: true });
    // (The batch slot is the ship's id: not taken from another view of it that's live now)
    const live = this.views.get(view.id);
    if (!live || live === view) this.hulls.remove(view.id);
    view.beam?.destroy();
    clearBarrels(view);
    view.barrels.destroy();
    clearTurrets(view);
    this.hullDraw.disposeFrame(view);
    view.container.destroy({ children: true });
    view.hullFor = null;
  }







  /** A boss's skeleton pieces blown away (by the part each was under: bossBlow), before the skeleton itself goes */
  private blown = new Map<number, Set<number>>();
  blow(id: number, part: number): void {
    let b = this.blown.get(id);
    if (!b) this.blown.set(id, (b = new Set()));
    b.add(part);
  }

  /**
   * Where a boss's laid-open pieces are drawn now (world): of `byStage` (bosses.json `exposed`), the list for the stage
   * it's fighting, standing pieces only (its window's effect rides them: BossFx)
   */
  exposedAt(id: number, byStage: readonly (readonly string[])[]): { x: number; y: number }[] {
    const ship = this.bridge.bodies.get(id), view = this.views.get(id);
    if (!ship || !view || !byStage.length) return [];
    const st = currentStage(this.bridge.catalog, ship) || byStage.length;
    const names = byStage[Math.max(0, Math.min(byStage.length - 1, st - 1))];
    const geo = this.bridge.geometry(ship), [cx, cy] = ship.derived.com, cs = this.bridge.tuning.cellSize;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation), out: { x: number; y: number }[] = [];
    ship.blueprint.parts.forEach((p, i) => {
      if (!ship.derived.alive[i] || !names.includes(p.piece) || !geo[i]) return;
      const lx = (geo[i].centroid[0] - cx) * cs, ly = (geo[i].centroid[1] - cy) * cs;
      out.push({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos });
    });
    return out;
  }

  /** How hot a ship's frame glows (a boss's later stage): eased towards (kept while its view comes and goes) */
  private heats = new Map<number, number>();
  setHeat(id: number, k: number): void {
    this.heats.set(id, Math.max(0, Math.min(1, k)));
  }




}
