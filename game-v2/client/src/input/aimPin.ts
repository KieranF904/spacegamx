/**
 * Mouse-steer with the view following the heading (input/viewMode.ts pinnedAim). The nose chases the cursor's world
 * point and the view chases the nose, so a cursor held still on the SCREEN would swing its world point round with the
 * view and the ship would chase its own camera, spinning. So the aim is pinned in the WORLD instead: held as an offset
 * from the screen's centre along the world's axes (in screen pixels, so zooming keeps it where it is on screen, as in
 * north-up), moved only by the mouse's own movement, and the cursor is drawn where that point now is on screen.
 *
 * It plays as a heading-up mouse: move the mouse right and the aim goes right, the ship turns onto it and the view turns
 * with it, bringing the cursor back round above the ship. Turning on and on takes the mouse's movement, not its place,
 * so a click on the game captures the pointer (the browser's pointer lock) and anything that needs the pointer (a
 * window, a menu, the map) lets it go. InputManager hands the cursor's place to everything that reads mouseX/mouseY
 * (cursor-to-world aim, targeting, the weapon ring), so they all see the drawn cursor.
 */
import { cameraView, screenToWorldDir, worldToScreenDir } from '../rendering/cameraView';

/** The cursor stays this far inside the screen's edges (px) */
const EDGE = 4;

export class AimPin {
  private px = 0;
  private py = 0;
  private on = false;
  /** Something else has the pointer (a window up): the aim stays where it is */
  held = false;

  /** `size`: the screen's; `angle`: the view's roll (cameraView.angle, written by the Renderer each frame) */
  constructor(private size: () => { w: number; h: number }, private angle: () => number = () => cameraView.angle) {}

  get pinned(): boolean {
    return this.on;
  }

  /** Pin the aim at this screen point, as the view is now */
  pin(x: number, y: number): void {
    const { w, h } = this.size();
    const d = screenToWorldDir(x - w / 2, y - h / 2, this.angle());
    this.px = d.x; this.py = d.y; this.on = true;
  }

  unpin(): void {
    this.on = false;
  }

  /** The mouse moved (screen px): the aim moves that way on the screen as it is now */
  move(dx: number, dy: number): void {
    if (!this.on || this.held || (!dx && !dy)) return;
    // (From where the cursor is drawn: held at the edge, a push back in moves it at once)
    const s = this.screen();
    this.pin(s.x + dx, s.y + dy);
  }

  /** Where the pinned aim is on the screen now (kept inside it) */
  screen(): { x: number; y: number } {
    const { w, h } = this.size();
    const d = worldToScreenDir(this.px, this.py, this.angle());
    return {
      x: Math.max(EDGE, Math.min(w - EDGE, w / 2 + d.x)),
      y: Math.max(EDGE, Math.min(h - EDGE, h / 2 + d.y)),
    };
  }
}

/** The drawn cursor and the pointer capture, for the pinned aim (browser only) */
export class AimPinView {
  private dot: HTMLDivElement;
  private active = false;
  private free = false;
  private shown = false;

  constructor(private canvas: HTMLCanvasElement, private pinRef: AimPin, private mouse: () => { x: number; y: number; rawX: number; rawY: number }) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;z-index:40;display:none;'
      + 'border:1.5px solid rgba(186,230,253,0.9);border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.6);';
    const c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:#e0f2fe;';
    d.appendChild(c);
    document.body.appendChild(d);
    this.dot = d;
    // (A click on the game while the aim is pinned captures the pointer: turning on and on takes its movement)
    canvas.addEventListener('mousedown', () => {
      if (this.active && this.free && document.pointerLockElement !== canvas) {
        try { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not allowed here */ }
      }
    });
  }

  /**
   * Once a frame. `active`: the aim is pinned (mouse-steer, view on the heading, flying); `free`: nothing else wants
   * the pointer (no window, menu or map up)
   */
  frame(active: boolean, free: boolean): void {
    if (active !== this.active) {
      this.active = active;
      const m = this.mouse();
      if (active) this.pinRef.pin(m.rawX, m.rawY); else this.pinRef.unpin();
    }
    this.free = free;
    this.pinRef.held = !free;
    const shown = active && free;
    if (!shown && document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (shown !== this.shown) {
      this.shown = shown;
      this.canvas.style.cursor = shown ? 'none' : '';
      this.dot.style.display = shown ? 'block' : 'none';
    }
    if (shown) {
      const m = this.mouse();
      this.dot.style.transform = `translate(${m.x}px, ${m.y}px)`;
    }
  }
}
