/**
 * Floating Rewards UI - Shows floating text for rewards, pickups, and events
 * 
 * Features:
 * - XP gains with level-up flash
 * - Credit pickups with coin effect
 * - Item pickups with rarity colors
 * - Achievement notifications
 * - Combo multipliers
 */

interface FloatingText {
  id: number;
  text: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  type: 'xp' | 'credits' | 'item' | 'damage' | 'heal' | 'combo' | 'achievement';
  scale: number;
  targetScale: number;
}

export class FloatingRewardsUI {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texts: FloatingText[] = [];
  private nextId = 0;
  private animationFrame: number = 0;
  private visible = true;
  
  // Camera offset for world-space texts
  private cameraX = 0;
  private cameraY = 0;
  private zoom = 1;
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'floating-rewards-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 95;
    `;
    container.appendChild(this.canvas);
    
    this.ctx = this.canvas.getContext('2d')!;
    
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    
    this.startAnimation();
  }
  
  private handleResize = (): void => {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  };
  
  private startAnimation(): void {
    const animate = () => {
      if (this.visible) {
        this.update();
        this.draw();
      }
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }
  
  /**
   * Update camera position for world-space to screen-space conversion
   */
  setCamera(x: number, y: number, zoom: number): void {
    this.cameraX = x;
    this.cameraY = y;
    this.zoom = zoom;
  }
  
  /**
   * Add XP gain floating text
   */
  addXP(worldX: number, worldY: number, amount: number, isLevelUp = false): void {
    const screenPos = this.worldToScreen(worldX, worldY);
    
    this.texts.push({
      id: this.nextId++,
      text: `+${amount} XP`,
      x: screenPos.x,
      y: screenPos.y,
      vx: (Math.random() - 0.5) * 30,
      vy: -80 - Math.random() * 40,
      life: 1,
      maxLife: isLevelUp ? 2.5 : 1.5,
      color: isLevelUp ? '#ffdd00' : '#88ff88',
      size: isLevelUp ? 28 : 18,
      type: 'xp',
      scale: isLevelUp ? 0.5 : 1,
      targetScale: isLevelUp ? 1.5 : 1,
    });
    
    if (isLevelUp) {
      this.texts.push({
        id: this.nextId++,
        text: 'LEVEL UP!',
        x: screenPos.x,
        y: screenPos.y - 30,
        vx: 0,
        vy: -60,
        life: 1,
        maxLife: 2.5,
        color: '#ffcc00',
        size: 32,
        type: 'achievement',
        scale: 0.5,
        targetScale: 1.2,
      });
    }
  }
  
  /**
   * Add credits gain floating text
   */
  addCredits(worldX: number, worldY: number, amount: number): void {
    const screenPos = this.worldToScreen(worldX, worldY);
    
    this.texts.push({
      id: this.nextId++,
      text: `+${this.formatNumber(amount)} ¢`,
      x: screenPos.x + (Math.random() - 0.5) * 20,
      y: screenPos.y + (Math.random() - 0.5) * 20,
      vx: (Math.random() - 0.5) * 40,
      vy: -60 - Math.random() * 30,
      life: 1,
      maxLife: 1.2,
      color: '#ffcc44',
      size: 16,
      type: 'credits',
      scale: 1,
      targetScale: 1,
    });
  }
  
  /**
   * Add item pickup floating text
   */
  addItem(worldX: number, worldY: number, itemName: string, rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' = 'common'): void {
    const screenPos = this.worldToScreen(worldX, worldY);
    
    const colors: Record<string, string> = {
      common: '#aaaaaa',
      uncommon: '#44ff44',
      rare: '#4488ff',
      epic: '#aa44ff',
      legendary: '#ffaa00',
    };
    
    const sizes: Record<string, number> = {
      common: 14,
      uncommon: 16,
      rare: 18,
      epic: 20,
      legendary: 24,
    };
    
    this.texts.push({
      id: this.nextId++,
      text: itemName,
      x: screenPos.x,
      y: screenPos.y,
      vx: 0,
      vy: -50,
      life: 1,
      maxLife: 2,
      color: colors[rarity],
      size: sizes[rarity],
      type: 'item',
      scale: rarity === 'legendary' ? 0.5 : 1,
      targetScale: rarity === 'legendary' ? 1.2 : 1,
    });
  }
  
  /**
   * Add damage dealt floating text
   */
  addDamage(worldX: number, worldY: number, amount: number, isCritical = false): void {
    const screenPos = this.worldToScreen(worldX, worldY);
    
    this.texts.push({
      id: this.nextId++,
      text: isCritical ? `${Math.round(amount)}!` : Math.round(amount).toString(),
      x: screenPos.x + (Math.random() - 0.5) * 30,
      y: screenPos.y + (Math.random() - 0.5) * 20,
      vx: (Math.random() - 0.5) * 60,
      vy: -40 - Math.random() * 40,
      life: 1,
      maxLife: isCritical ? 1.2 : 0.8,
      color: isCritical ? '#ff4444' : '#ff8866',
      size: isCritical ? 24 : 16,
      type: 'damage',
      scale: isCritical ? 1.5 : 1,
      targetScale: 1,
    });
  }
  
  /**
   * Add heal floating text
   */
  addHeal(worldX: number, worldY: number, amount: number): void {
    const screenPos = this.worldToScreen(worldX, worldY);
    
    this.texts.push({
      id: this.nextId++,
      text: `+${Math.round(amount)}`,
      x: screenPos.x,
      y: screenPos.y,
      vx: (Math.random() - 0.5) * 20,
      vy: -50,
      life: 1,
      maxLife: 1,
      color: '#44ff88',
      size: 18,
      type: 'heal',
      scale: 1,
      targetScale: 1,
    });
  }
  
  /**
   * Add combo multiplier text
   */
  addCombo(screenX: number, screenY: number, multiplier: number): void {
    this.texts.push({
      id: this.nextId++,
      text: `${multiplier}x COMBO!`,
      x: screenX,
      y: screenY,
      vx: 0,
      vy: -30,
      life: 1,
      maxLife: 1.5,
      color: multiplier >= 5 ? '#ff44ff' : multiplier >= 3 ? '#ffaa00' : '#ff8844',
      size: 20 + multiplier * 2,
      type: 'combo',
      scale: 0.5,
      targetScale: 1,
    });
  }
  
  /**
   * Add achievement notification (screen-space)
   */
  addAchievement(text: string): void {
    this.texts.push({
      id: this.nextId++,
      text: `★ ${text}`,
      x: this.canvas.width / 2,
      y: this.canvas.height / 3,
      vx: 0,
      vy: -20,
      life: 1,
      maxLife: 3,
      color: '#ffcc00',
      size: 28,
      type: 'achievement',
      scale: 0.5,
      targetScale: 1,
    });
  }
  
  private worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const screenX = (worldX - this.cameraX) * this.zoom + this.canvas.width / 2;
    const screenY = (worldY - this.cameraY) * this.zoom + this.canvas.height / 2;
    return { x: screenX, y: screenY };
  }
  
  private update(): void {
    const dt = 1 / 60;
    
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const text = this.texts[i];
      
      // Update physics
      text.x += text.vx * dt;
      text.y += text.vy * dt;
      text.vy += 50 * dt; // Gravity (slows upward movement)
      text.vx *= 0.98; // Air resistance
      
      // Update life
      text.life -= dt / text.maxLife;
      
      // Animate scale
      text.scale += (text.targetScale - text.scale) * 0.1;
      
      // Remove dead texts
      if (text.life <= 0) {
        this.texts.splice(i, 1);
      }
    }
  }
  
  private draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    for (const text of this.texts) {
      const alpha = this.easeOutQuad(text.life);
      const scale = text.scale;
      
      ctx.save();
      ctx.translate(text.x, text.y);
      ctx.scale(scale, scale);
      
      // Draw shadow
      ctx.font = `bold ${text.size}px 'Rajdhani', Arial, sans-serif`;
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha * 0.5})`;
      ctx.fillText(text.text, 2, 2);
      
      // Draw outline
      ctx.strokeStyle = `rgba(0, 0, 0, ${alpha * 0.8})`;
      ctx.lineWidth = 3;
      ctx.strokeText(text.text, 0, 0);
      
      // Draw text with glow
      if (text.type === 'achievement' || text.type === 'combo') {
        ctx.shadowColor = text.color;
        ctx.shadowBlur = 15;
      }
      
      ctx.fillStyle = this.hexToRgba(text.color, alpha);
      ctx.fillText(text.text, 0, 0);
      
      ctx.restore();
    }
  }
  
  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  
  private easeOutQuad(t: number): number {
    return t * (2 - t);
  }
  
  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
  
  show(): void {
    this.visible = true;
    this.canvas.style.display = 'block';
  }
  
  hide(): void {
    this.visible = false;
    this.canvas.style.display = 'none';
  }
  
  clear(): void {
    this.texts = [];
  }
  
  destroy(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.remove();
  }
}
