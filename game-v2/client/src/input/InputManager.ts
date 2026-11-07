/**
 * Input Manager - Keyboard and mouse input handling
 *
 * Rebinding: the game listens for each action's default key code. A key the
 * player bound to an action is translated to that default code here; an
 * action's default key that was moved elsewhere does nothing. In raw mode
 * (hangar, menu) keys mean themselves.
 */

import type { AimPin } from './aimPin';
import { groupWheel } from '../ships/weaponGroups/keys';

export class InputManager {
  /** Held keys, as the game sees them (translated codes) */
  private keys: Set<string> = new Set();
  /** Physical key → the code it was translated to when pressed (so release matches press) */
  private held = new Map<string, string>();
  private remap = new Map<string, string>();
  private swallow = new Set<string>();
  /** Hangar / menu open: no translation */
  public raw = false;
  /** Rebinding UI: the next key press goes here instead of the game */
  public onCapture: ((code: string) => void) | null = null;
  public invertZoom = false;
  public zoomSpeedScale = 1;
  private mouseButtons: Set<number> = new Set();
  
  /** Where the pointer last was over the canvas */
  public rawX = 0;
  public rawY = 0;
  /** The aim pinned in the world (mouse-steer with the view on the heading, input/aimPin.ts): the cursor is drawn there */
  public pin: AimPin | null = null;
  /** The cursor as the game sees it: the pointer, or the pinned aim's place on the screen */
  get mouseX(): number { return this.pin?.pinned ? this.pin.screen().x : this.rawX; }
  get mouseY(): number { return this.pin?.pinned ? this.pin.screen().y : this.rawY; }
  private canvas: HTMLCanvasElement | null = null;
  
  // Zoom
  public zoom = 1;
  public targetZoom = 1;
  /** Flight zoom range; scrolling out past minZoom hands over to the system map */
  public readonly minZoom = 0.04;
  public readonly maxZoom = 2.0;
  private readonly zoomSpeed = 0.15;
  /** Scrolled out while already as far out as flight goes */
  public onZoomPastMin: (() => void) | null = null;
  private pastMinAt = 0;
  
  // Callbacks
  public onZoomChange: ((zoom: number) => void) | null = null;
  public onKeyPressed: ((code: string) => void) | null = null;
  /**
   * The window lost focus or the tab was hidden (keys are cleared first). The
   * game sends a neutral input straight away: a hidden tab's ticker stops, so
   * the next regular input could be minutes off.
   */
  public onFocusLost: (() => void) | null = null;
  /** A mouse button went down on the canvas, or came up anywhere after one did (screen px; `t`: when it happened, not when handled) */
  public onMouseButton: ((button: number, down: boolean, x: number, y: number, t: number) => void) | null = null;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      // Don't capture keys when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return; // Let the input field handle it
      }
      
      if (this.onCapture) {
        e.preventDefault();
        const cb = this.onCapture;
        this.onCapture = null;
        cb(e.code);
        return;
      }

      const code = this.translate(e.code);
      if (code !== null && !this.held.has(e.code)) {
        this.held.set(e.code, code);
        if (!this.keys.has(code)) {
          this.keys.add(code);
          this.onKeyPressed?.(code);
        }
      }
      
      // Prevent default for game keys
      // Tab: stops browser focus-cycling through input boxes (Tab toggles stats panel)
      // KeyM: system map toggle
      if (this.remap.has(e.code) || ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyI', 'KeyE', 'KeyQ', 'KeyX', 'Escape', 'Tab', 'KeyM'].includes(e.code)) {
        e.preventDefault();
      }
    });
    
    // ALWAYS process keyup, even in input fields, to prevent stuck inputs
    // (holding W, clicking into chat, then releasing W used to leave W stuck)
    window.addEventListener('keyup', (e) => {
      const code = this.held.get(e.code);
      if (code === undefined) return;
      this.held.delete(e.code);
      if (![...this.held.values()].includes(code)) this.keys.delete(code);
    });
    
    // Mouse events
    canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      e.preventDefault();
      // (Pinned: the click is where the cursor is drawn)
      const pinned = !!this.pin?.pinned;
      this.onMouseButton?.(e.button, true, pinned ? this.mouseX : e.clientX, pinned ? this.mouseY : e.clientY, e.timeStamp);
    });
    
    // (On the window: a button let go over the map or a panel still lets go)
    window.addEventListener('mouseup', (e) => {
      const was = this.mouseButtons.delete(e.button);
      const pinned = !!this.pin?.pinned;
      if (was) this.onMouseButton?.(e.button, false, pinned ? this.mouseX : e.clientX, pinned ? this.mouseY : e.clientY, e.timeStamp);
    });
    
    canvas.addEventListener('mousemove', (e) => {
      // (Pinned: the aim moves by the mouse's movement, the pointer captured or not)
      if (this.pin?.pinned) this.pin.move(e.movementX || 0, e.movementY || 0);
      this.rawX = e.clientX;
      this.rawY = e.clientY;
    });
    
    // Mouse wheel for zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // (With the setting on, the wheel changes the weapon group and does not zoom: ships/weaponGroups/keys.ts)
      if (groupWheel(e.deltaY)) return;
      
      // Each notch scales the view by the same factor, so zooming feels the same near and far
      const step = this.zoomSpeed * this.zoomSpeedScale;
      const out = (e.deltaY > 0) !== this.invertZoom;
      if (out && this.targetZoom <= this.minZoom * 1.001) {
        // Already all the way out: keep going and the map takes over (one notch is enough, but not a stray one mid-scroll)
        const now = performance.now();
        if (now - this.pastMinAt > 120) this.onZoomPastMin?.();
        this.pastMinAt = now;
        return;
      }
      this.pastMinAt = performance.now();
      this.targetZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.targetZoom * (out ? 1 / (1 + step) : 1 + step)));
      this.onZoomChange?.(this.targetZoom);
    }, { passive: false });
    
    // Prevent context menu on right click
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    
    // Handle focus loss (window loses focus)
    const lost = () => {
      this.keys.clear();
      this.held.clear();
      this.mouseButtons.clear();
      this.onFocusLost?.();
    };
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') lost();
    });
    
    // Clear movement keys when focusing on ANY input element
    // This prevents movement from continuing when player clicks into chat/etc
    document.addEventListener('focusin', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        this.clearMovementKeys();
      }
    });
  }
  
  /** Clear only movement keys (WASD, arrows, shift) but keep other state */
  clearMovementKeys(): void {
    const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space'];
    for (const key of movementKeys) {
      this.keys.delete(key);
    }
    for (const [phys, code] of [...this.held]) if (movementKeys.includes(code)) this.held.delete(phys);
  }

  /**
   * Install key bindings: `bindings` maps each action's default code to the
   * key the player chose for it.
   */
  setBindings(bindings: { defaultCode: string; code: string }[]): void {
    this.remap.clear();
    this.swallow.clear();
    for (const b of bindings) {
      if (b.code === b.defaultCode) continue;
      this.remap.set(b.code, b.defaultCode);
      this.swallow.add(b.defaultCode);
    }
    this.keys.clear();
    this.held.clear();
  }

  /** What the game should see for a physical key (null: nothing, its action moved to another key). */
  private translate(code: string): string | null {
    if (this.raw) return code;
    const to = this.remap.get(code);
    if (to !== undefined) return to;
    return this.swallow.has(code) ? null : code;
  }

  update(delta: number): void {
    // Smooth zoom interpolation
    const lerpFactor = 1 - Math.pow(0.001, delta);
    this.zoom += (this.targetZoom - this.zoom) * lerpFactor;
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.mouseButtons.has(button);
  }

  isAnyKeyDown(...codes: string[]): boolean {
    return codes.some(code => this.keys.has(code));
  }
  
  resetZoom(): void {
    this.targetZoom = 1;
  }
  
  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.keys.clear();
      this.held.clear();
      this.mouseButtons.clear();
    }
  }
}
