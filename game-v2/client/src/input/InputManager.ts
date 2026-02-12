/**
 * Input Manager - Keyboard and mouse input handling
 */

export class InputManager {
  private keys: Set<string> = new Set();
  private mouseButtons: Set<number> = new Set();
  
  public mouseX = 0;
  public mouseY = 0;
  private canvas: HTMLCanvasElement | null = null;
  
  // Zoom
  public zoom = 1;
  public targetZoom = 1;
  public readonly minZoom = 0.1;
  public readonly maxZoom = 2.0;
  private readonly zoomSpeed = 0.15;
  
  // Callbacks
  public onZoomChange: ((zoom: number) => void) | null = null;
  public onKeyPressed: ((code: string) => void) | null = null;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    
    // Keyboard events
    window.addEventListener('keydown', (e) => {
      // Don't capture keys when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return; // Let the input field handle it
      }
      
      if (!this.keys.has(e.code)) {
        this.keys.add(e.code);
        this.onKeyPressed?.(e.code);
      }
      
      // Prevent default for game keys
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyI', 'KeyE', 'Escape'].includes(e.code)) {
        e.preventDefault();
      }
    });
    
    window.addEventListener('keyup', (e) => {
      // ALWAYS process keyup for game keys to prevent stuck inputs
      // This fixes the bug where holding W, clicking into chat, then releasing W
      // would leave W stuck because the keyup was ignored when focus was in input
      const gameKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (gameKeys.includes(e.code)) {
        this.keys.delete(e.code);
        return;
      }
      
      // For non-game keys, still skip if typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      this.keys.delete(e.code);
    });
    
    // Mouse events
    canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      e.preventDefault();
    });
    
    canvas.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
    });
    
    canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    
    // Mouse wheel for zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      
      const zoomDelta = e.deltaY > 0 ? -this.zoomSpeed : this.zoomSpeed;
      this.targetZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.targetZoom + zoomDelta));
      this.onZoomChange?.(this.targetZoom);
    }, { passive: false });
    
    // Prevent context menu on right click
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    
    // Handle focus loss (window loses focus)
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
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
      this.mouseButtons.clear();
    }
  }
}
