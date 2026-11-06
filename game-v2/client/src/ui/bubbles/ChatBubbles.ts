/**
 * Chat bubbles over pilots' ships: what a pilot says in public chat stands over their ship for a few seconds, the same
 * size on screen at any zoom, stacked (the newest at the bottom by the ship, the older ones gliding up), fading in and
 * out. In flight a stack follows its ship as it's drawn (renderX/renderY: the predicted draw tick, any dev draw mode).
 * On the system map it stands over the pilot's dot, for pilots within a little past the focus grid (the focus radius
 * and a cell and a half: BUBBLE_RANGE_PAST_FOCUS): a live one (an entity here) followed every frame, a far one (FarShips, the map feed) placed where
 * it was last sampled (once a second) and eased to the next. The logic is bubbleStack.ts; this draws it with pooled
 * DOM elements (no garbage per frame). Hidden with the chat box (Settings > Chat box, the chat's hide button), so a
 * recording can drop both; screenshots (scripts/boss-shots/shoot.mjs) hide #chatBubbles as they do the chat box.
 */

import { CELL_SIZE, EntityType } from '@space-game/common';
import { settings } from '../../settings/Settings';
import type { GameState } from '../../state/GameState';
import { BubbleBoard, bubbleAlpha, originDue, originLive, originSample, type Bubble } from './bubbleStack';

/** What the bubbles read of the game */
export interface BubbleHost {
  readonly state: GameState;
  /** A world point on the flight screen (CSS px), into `out` */
  toScreen(x: number, y: number, out: { x: number; y: number }): void;
  /** World units to screen px in flight */
  zoom(): number;
  /** A ship's size (world units) */
  shipRadius(id: number): number;
  readonly map: { readonly isOpen: boolean; readonly overlay: HTMLElement; toCanvas(x: number, y: number, out: { x: number; y: number }): boolean };
}

/** Over a ship in flight: this far above its hull (px), and never more than this high over its centre (a huge zoom) */
const SHIP_GAP = 14;
const SHIP_LIFT_MAX = 320;
/** Over a dot on the map: clear of its name label */
const MAP_LIFT = 20;
/**
 * How far past the focus radius a far pilot still gets bubbles (world units): the focus grid takes every cell whose
 * nearest point is within the radius, so its far corners reach a cell diagonal (1.41 cells) past it; a little beyond that.
 * Still inside RING_RANGE, so the ring's map-dot legs have these pilots even with the map shut.
 */
const BUBBLE_RANGE_PAST_FOCUS = CELL_SIZE * 1.5;
/** Off-screen this far (px) and it isn't drawn */
const MARGIN = 160;

const CSS = `
#chatBubbles { position: fixed; inset: 0; pointer-events: none; z-index: 72; overflow: hidden; }
#chatBubbles.on-map { position: absolute; z-index: auto; }
.cbub { position: absolute; left: 0; top: 0; will-change: transform, opacity; display: none;
  max-width: 260px; width: max-content; padding: 6px 10px 7px; border-radius: 5px; box-sizing: border-box;
  border: 1px solid #05080d; color: #e4ebf5; font: 500 13px/1.35 'Segoe UI', system-ui, sans-serif;
  overflow-wrap: anywhere; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
  background: linear-gradient(180deg, rgba(29, 38, 53, 0.9) 0%, rgba(20, 27, 39, 0.88) 50%, rgba(14, 19, 28, 0.9) 100%);
  box-shadow: inset 0 1px 0 rgba(196, 216, 255, 0.2), inset 0 -2px 0 rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(130, 160, 200, 0.24),
    0 6px 16px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(3px); }
.cbub-t { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
/* The pilot's name: a small tab on the top edge of the stack's top bubble */
.cbub-n { position: absolute; left: 8px; top: 0; transform: translateY(-62%); padding: 1px 6px; border-radius: 3px; white-space: nowrap;
  font: 700 10px/1.3 'Rajdhani', 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: #6cc8ff;
  background: #0e131c; box-shadow: 0 0 0 1px rgba(108, 200, 255, 0.35); opacity: 0; transition: opacity 0.2s; }
.cbub.named .cbub-n { opacity: 1; }
.cbub.me .cbub-n { color: #ffbe55; box-shadow: 0 0 0 1px rgba(255, 190, 85, 0.35); }
/* The tail on the bottom bubble, pointing down at the ship */
.cbub::after { content: ''; position: absolute; left: 50%; bottom: -7px; width: 10px; height: 10px; margin-left: -5px;
  background: rgba(14, 19, 28, 0.92); border-right: 1px solid rgba(130, 160, 200, 0.3); border-bottom: 1px solid rgba(130, 160, 200, 0.3);
  transform: rotate(45deg); opacity: 0; transition: opacity 0.2s; }
.cbub.tail::after { opacity: 1; }`;

export class ChatBubbles {
  private root: HTMLDivElement;
  private board: BubbleBoard;
  /** Pooled elements, and what each was last given (written only when it changes) */
  private els: HTMLDivElement[] = [];
  private free: number[] = [];
  private lastX: number[] = [];
  private lastY: number[] = [];
  private lastA: number[] = [];
  private lastG: number[] = [];
  private lastFlags: number[] = [];
  private shownAt: number[] = [];
  private frame = 0;
  private hidden = false;
  private enabled = true;
  private onMap: boolean | null = null;
  private rootShown = false;
  private system = '';
  private last = 0;
  private at = { x: 0, y: 0 };
  private me = { x: 0, y: 0 };

  constructor(private host: BubbleHost) {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.id = 'chatBubbles';
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
    this.board = new BubbleBoard((b) => this.releaseSlot(b));
    settings.subscribe((d) => { this.enabled = d.ui.chat; });
  }

  /** A public chat line from a pilot (the ship it's over: their entity id) */
  say(pilot: number, name: string, text: string): void {
    if (!text.trim()) return;
    const b = this.board.say(pilot, name, text, performance.now() / 1000);
    const slot = this.takeSlot();
    b.slot = slot;
    const el = this.els[slot];
    (el.firstElementChild as HTMLElement).textContent = name;
    (el.lastElementChild as HTMLElement).textContent = b.text;
    el.classList.toggle('me', pilot === this.host.state.playerId);
  }

  /** Hidden for now (signed out, the hangar, the menu): bubbles keep their time */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Once a frame, after the world's drawn (the camera's where it'll be this frame) */
  update(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    const st = this.host.state;
    if (st.systemId !== this.system) {
      // (Another system: a far place from the last one means nothing here)
      this.system = st.systemId;
      for (const s of this.board.stacks.values()) s.origin.known = false;
    }
    this.board.step(now, dt);
    const map = this.host.map;
    const onMap = map.isOpen;
    const off = this.hidden || !this.enabled || this.board.size === 0 || (onMap && !map.toCanvas(0, 0, this.at));
    if (off) { this.showRoot(false); return; }
    if (onMap !== this.onMap) {
      this.onMap = onMap;
      (onMap ? map.overlay : document.body).appendChild(this.root);
      this.root.classList.toggle('on-map', onMap);
    }
    this.showRoot(true);
    const frame = ++this.frame;
    const w = onMap ? map.overlay.clientWidth : innerWidth, h = onMap ? map.overlay.clientHeight : innerHeight;
    const meEnt = st.entities.get(st.playerId);
    const range = st.crowd.focus + BUBBLE_RANGE_PAST_FOCUS;
    const tick = st.getRawServerTick();
    const zoom = this.host.zoom();
    for (const s of this.board.stacks.values()) {
      const o = s.origin;
      const e = st.entities.get(s.pilot);
      if (e && e.type === EntityType.Player) originLive(o, e.renderX, e.renderY, now);
      else if (originDue(o, now)) {
        if (st.farShips.position(s.pilot, st.systemId, tick, this.at)) originSample(o, this.at.x, this.at.y, now);
        else { o.known = false; o.live = false; }
      }
      if (!o.known) continue;
      // (A far pilot past the bubble range: not shown)
      if (!o.live && (!meEnt || Math.hypot(o.x - meEnt.renderX, o.y - meEnt.renderY) > range)) continue;
      let lift: number;
      if (onMap) { map.toCanvas(o.x, o.y, this.at); lift = MAP_LIFT; } else {
        this.host.toScreen(o.x, o.y, this.at);
        lift = o.live ? Math.min(SHIP_LIFT_MAX, this.host.shipRadius(s.pilot) * zoom) + SHIP_GAP : SHIP_GAP;
      }
      const x = this.at.x, y = this.at.y - lift;
      if (x < -MARGIN || x > w + MARGIN || y < -MARGIN || y > h + MARGIN * 3) continue;
      const n = s.bubbles.length;
      for (let i = 0; i < n; i++) {
        const b = s.bubbles[i];
        if (b.slot < 0) continue;
        const el = this.els[b.slot];
        if (this.shownAt[b.slot] === -1) el.style.display = 'block';
        this.shownAt[b.slot] = frame;
        // (Measured once, the first frame it's on the page)
        if (b.height <= 0) this.board.setHeight(b, el.offsetHeight);
        const a = bubbleAlpha(b, now);
        this.place(b, x, y - b.y, a, (i === n - 1 ? 1 : 0) | (i === 0 ? 2 : 0));
      }
    }
    // (Not placed this frame: off-screen, out of range, or nowhere)
    for (let i = 0; i < this.els.length; i++) {
      if (this.shownAt[i] !== frame && this.shownAt[i] !== -1) { this.shownAt[i] = -1; this.els[i].style.display = 'none'; }
    }
  }

  /** Write a bubble's place, opacity and tail/name flags, only what changed */
  private place(b: Bubble, x: number, y: number, a: number, flags: number): void {
    const i = b.slot, el = this.els[i];
    const rx = Math.round(x * 2) / 2, ry = Math.round(y * 2) / 2;
    // (Fading in, it grows a touch as it rises)
    const grow = a < 1 && b.fades > this.last ? Math.round((0.92 + 0.08 * a) * 200) / 200 : 1;
    if (rx !== this.lastX[i] || ry !== this.lastY[i] || grow !== this.lastG[i]) {
      this.lastX[i] = rx; this.lastY[i] = ry; this.lastG[i] = grow;
      el.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -100%)${grow !== 1 ? ` scale(${grow})` : ''}`;
    }
    const ra = Math.round(a * 50) / 50;
    if (ra !== this.lastA[i]) { this.lastA[i] = ra; el.style.opacity = String(ra); }
    if (flags !== this.lastFlags[i]) {
      this.lastFlags[i] = flags;
      el.classList.toggle('tail', (flags & 1) !== 0);
      el.classList.toggle('named', (flags & 2) !== 0);
    }
  }

  private showRoot(on: boolean): void {
    if (on === this.rootShown) return;
    this.rootShown = on;
    this.root.style.display = on ? 'block' : 'none';
  }

  private takeSlot(): number {
    const free = this.free.pop();
    if (free !== undefined) return free;
    const el = document.createElement('div');
    el.className = 'cbub';
    el.style.transformOrigin = '50% 100%';
    el.innerHTML = '<b class="cbub-n"></b><span class="cbub-t"></span>';
    this.root.appendChild(el);
    this.els.push(el);
    this.lastX.push(NaN); this.lastY.push(NaN); this.lastA.push(NaN); this.lastG.push(NaN); this.lastFlags.push(-1); this.shownAt.push(-1);
    return this.els.length - 1;
  }

  private releaseSlot(b: Bubble): void {
    if (b.slot < 0) return;
    const i = b.slot;
    this.els[i].style.display = 'none';
    this.shownAt[i] = -1;
    this.lastX[i] = this.lastY[i] = this.lastA[i] = this.lastG[i] = NaN;
    this.lastFlags[i] = -1;
    this.free.push(i);
  }
}

