/**
 * DebugUI - On-screen debug controls for shader tuning
 * 
 * Press F3 to toggle visibility
 */

// Global debug config that renderers can read from
export const debugConfig = {
  parallaxScale: 0.0,
};

export class DebugUI {
  private container: HTMLElement;
  private panel: HTMLElement;
  private visible = false;
  
  // Callbacks for real-time updates
  public onParallaxChange: ((value: number) => void) | null = null;
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    // Create debug panel
    this.panel = document.createElement('div');
    this.panel.id = 'debug-panel';
    this.setupStyles();
    this.render();
    
    // Append to body directly to avoid ui-overlay's pointer-events: none
    document.body.appendChild(this.panel);
    
    // Toggle with F3
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }
  
  private setupStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #debug-panel {
        position: fixed;
        top: 10px;
        right: 10px;
        width: 280px;
        background: rgba(0, 0, 20, 0.9);
        border: 1px solid #446;
        border-radius: 6px;
        color: #fff;
        font-family: 'Segoe UI', Consolas, monospace;
        font-size: 12px;
        z-index: 99999;
        box-shadow: 0 0 20px rgba(0, 100, 200, 0.3);
        display: none;
        pointer-events: auto;
      }
      
      #debug-panel * {
        pointer-events: auto;
      }
      
      #debug-panel.visible {
        display: block;
      }
      
      .debug-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: rgba(0, 50, 100, 0.5);
        border-bottom: 1px solid #446;
        border-radius: 6px 6px 0 0;
      }
      
      .debug-header span {
        font-weight: bold;
        color: #6af;
      }
      
      .debug-close {
        background: none;
        border: none;
        color: #888;
        font-size: 16px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      
      .debug-close:hover {
        color: #f66;
      }
      
      .debug-content {
        padding: 12px;
      }
      
      .debug-section {
        margin-bottom: 12px;
      }
      
      .debug-section:last-child {
        margin-bottom: 0;
      }
      
      .debug-section-title {
        font-size: 10px;
        color: #6af;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
      }
      
      .debug-slider-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      
      .debug-slider-row label {
        min-width: 70px;
        color: #aaa;
      }
      
      .debug-slider-row input[type="range"] {
        flex: 1;
        height: 4px;
        -webkit-appearance: none;
        background: #224;
        border-radius: 2px;
        outline: none;
      }
      
      .debug-slider-row input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        background: #6af;
        border-radius: 50%;
        cursor: pointer;
      }
      
      .debug-slider-row input[type="range"]::-webkit-slider-thumb:hover {
        background: #8cf;
      }
      
      .debug-slider-row .debug-value {
        min-width: 60px;
        text-align: right;
        color: #6f6;
        font-family: Consolas, monospace;
      }
      
      .debug-hint {
        font-size: 10px;
        color: #666;
        margin-top: 8px;
        text-align: center;
      }
    `;
    document.head.appendChild(style);
  }
  
  private render(): void {
    this.panel.innerHTML = `
      <div class="debug-header">
        <span>🔧 Debug (F3)</span>
        <button class="debug-close">×</button>
      </div>
      <div class="debug-content">
        <div class="debug-section">
          <div class="debug-section-title">Glow Shader</div>
          <div class="debug-slider-row">
            <label>Parallax</label>
            <input type="range" id="debug-parallax" min="-0.001" max="0.001" step="0.00001" value="${debugConfig.parallaxScale}">
            <span class="debug-value" id="debug-parallax-value">${debugConfig.parallaxScale.toFixed(5)}</span>
          </div>
        </div>
        <div class="debug-hint">Positive = glow moves with camera, Negative = against</div>
      </div>
    `;
    
    this.setupEventListeners();
  }
  
  private setupEventListeners(): void {
    // Close button
    const closeBtn = this.panel.querySelector('.debug-close');
    closeBtn?.addEventListener('click', () => this.hide());
    
    // Parallax slider
    const parallaxSlider = this.panel.querySelector('#debug-parallax') as HTMLInputElement;
    const parallaxValue = this.panel.querySelector('#debug-parallax-value') as HTMLElement;
    
    parallaxSlider?.addEventListener('input', () => {
      const value = parseFloat(parallaxSlider.value);
      debugConfig.parallaxScale = value;
      parallaxValue.textContent = value.toFixed(5);
      this.onParallaxChange?.(value);
    });
  }
  
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }
  
  show(): void {
    this.visible = true;
    this.panel.classList.add('visible');
  }
  
  hide(): void {
    this.visible = false;
    this.panel.classList.remove('visible');
  }
  
  isVisible(): boolean {
    return this.visible;
  }
}
