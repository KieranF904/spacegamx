/**
 * @contract client.render.pan-control
 * owns:       the middle-mouse view drag (the pan offset) and the RECENTER VIEW button
 * needs:      the game canvas, PanHost (zoom, whether the camera is locked to a target)
 * invariants: middle mouse never autoscrolls the page — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     other pan inputs (touch, keys) go in the constructor's listeners
 */

/** What the pan reads from the renderer */
export interface PanHost {
  zoom(): number;
  /** An admin free camera or a watched pilot: no panning */
  locked(): boolean;
}

export class PanControl {
  /** Where the pilot has dragged the view from their ship (middle mouse), in world units along the screen's axes; the camera keeps the ship PAN_MARGIN inside the screen */
  readonly pan = { x: 0, y: 0 };
  private drag: number | null = null;
  private btn: HTMLButtonElement;
  private shown = false;

  /** Middle mouse drags the view about your ship; a button at the top brings it back */
  constructor(canvas: HTMLCanvasElement, private host: PanHost) {
    // (No browser autoscroll on the middle button)
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 || this.host.locked()) return;
      e.preventDefault();
      this.drag = e.pointerId;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.drag !== e.pointerId) return;
      // Grab and drag: the world follows the mouse (clamped to the margin each frame, in updateCamera; along the screen's axes, the view may be turned)
      this.pan.x -= e.movementX / this.host.zoom();
      this.pan.y -= e.movementY / this.host.zoom();
    });
    const end = (e: PointerEvent) => {
      if (this.drag !== e.pointerId) return;
      this.drag = null;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    const b = document.createElement('button');
    b.textContent = '⌖ RECENTER VIEW';
    b.title = 'Bring the view back onto your ship (middle mouse drags it about)';
    b.style.cssText = 'position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:26;display:none;padding:5px 14px;'
      + 'border-radius:999px;border:1px solid rgba(125,211,252,0.45);background:rgba(8,14,28,0.8);color:#bfe6ff;'
      + 'font-family:inherit;font-size:11px;font-weight:600;letter-spacing:0.1em;cursor:pointer;';
    b.addEventListener('click', () => this.recenter());
    document.body.appendChild(b);
    this.btn = b;
  }

  /** The view back onto your ship */
  recenter(): void {
    this.pan.x = 0;
    this.pan.y = 0;
  }

  /** Whether the button shows (the view sits off the ship) */
  showRecenter(off: boolean): void {
    if (off !== this.shown) {
      this.shown = off;
      this.btn.style.display = off ? 'block' : 'none';
    }
  }
}
