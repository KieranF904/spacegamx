/**
 * System hazards on screen: a full-screen treatment per hazard (haze for low
 * visibility, a heavy vignette for darkness, a pulsing edge for radiation)
 * plus warning chips. Cold has no fixed treatment: the frost comes in as the
 * ship's warmth runs down (FrostVignette). The gravity well itself is real
 * physics; here it only gets a warning, which turns urgent near the horizon.
 */

const HAZARDS: Record<string, { label: string; color: string; layer?: string; anim?: string }> = {
  low_visibility: {
    label: 'LOW VISIBILITY', color: '#b8b0d8',
    layer: 'radial-gradient(ellipse at center, rgba(40,34,60,0) 28%, rgba(46,40,70,0.45) 62%, rgba(30,26,46,0.82) 100%)',
  },
  darkness: {
    label: 'DARKNESS', color: '#8a8fa8',
    layer: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 18%, rgba(0,0,0,0.6) 52%, rgba(0,0,0,0.92) 100%)',
  },
  radiation: {
    label: 'RADIATION', color: '#ffb547',
    layer: 'radial-gradient(ellipse at center, rgba(255,170,40,0) 60%, rgba(255,150,30,0.16) 100%)',
    anim: 'hazardPulse 2.4s ease-in-out infinite',
  },
  cold: { label: 'COLD', color: '#9fd8ff' },
  gravitational_anomalies: { label: 'GRAVITY WELL', color: '#f2a6ff' },
};

export class HazardOverlay {
  private layers: HTMLDivElement;
  private chips: HTMLDivElement;
  private horizonChip: HTMLDivElement;
  private current = '';

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes hazardPulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      @keyframes hazardBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      .hazard-chip { padding: 3px 9px; border-radius: 999px; border: 1px solid currentColor; background: rgba(6,10,20,0.75);
        font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1px; }`;
    document.head.appendChild(style);

    this.layers = document.createElement('div');
    this.layers.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 5;';
    this.chips = document.createElement('div');
    this.chips.style.cssText = 'position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: none; z-index: 950;';
    this.horizonChip = document.createElement('div');
    this.horizonChip.className = 'hazard-chip';
    this.horizonChip.style.cssText = 'color: #ff5a5a; animation: hazardBlink 0.6s linear infinite; display: none;';
    this.horizonChip.textContent = 'EVENT HORIZON PROXIMITY';
    document.body.append(this.layers, this.chips);
  }

  /** Show the hazards for the system the player is in. */
  setHazards(hazards: string[]): void {
    const key = hazards.join(',');
    if (key === this.current) return;
    this.current = key;
    this.layers.innerHTML = '';
    this.chips.innerHTML = '';
    for (const h of hazards) {
      const def = HAZARDS[h];
      if (!def) continue;
      if (def.layer) {
        const layer = document.createElement('div');
        layer.style.cssText = `position: absolute; inset: 0; background: ${def.layer}; ${def.anim ? `animation: ${def.anim};` : ''}`;
        this.layers.appendChild(layer);
      }
      const chip = document.createElement('div');
      chip.className = 'hazard-chip';
      chip.style.color = def.color;
      chip.textContent = `⚠ ${def.label}`;
      this.chips.appendChild(chip);
    }
    this.chips.appendChild(this.horizonChip);
  }

  /** Settings: the full-screen tints can be turned off (the warning chips stay) */
  setEffectsVisible(on: boolean): void {
    this.layers.style.display = on ? 'block' : 'none';
  }

  /** Warn when the ship is being pulled in: `danger` 0 (safe) .. 1 (at the horizon). */
  setHorizonDanger(danger: number): void {
    this.horizonChip.style.display = danger > 0.35 ? 'block' : 'none';
  }
}
