/**
 * @contract client.app.hud-readouts
 * owns:       the top-HUD readouts each frame: boost bar, XP bar and level (with their gain glow), credits, system name
 * needs:      HudHost (state, pilot, ship client, system names), domWrite setText and setStyle
 * invariants: each element is written only when its value changes (domWrite) — client/src/app/appInvariants.test.ts
 * extend:     a new readout is a cached element below and one more write in update()
 */

import { setText, setStyle } from '../ui/domWrite';
import type { PilotState } from '../econ/clientEcon';
import type { ShipClient } from '../ships/ShipClient';
import type { GameState } from '../state/GameState';

/** What the readouts read from the game */
export interface HudHost {
  readonly state: GameState;
  readonly pilot: PilotState;
  readonly shipClient: Pick<ShipClient, 'myShip'>;
  readonly systemNames: Map<string, string>;
}

export class HudReadouts {
  private xpFillEl = document.getElementById('xpFill');
  private xpBarEl = document.getElementById('xpBar');
  /** The XP bar as last shown (to glow when it grows) */
  private xpSeen: { level: number; into: number } | null = null;
  private boostFillEl = document.getElementById('boostFill');
  private levelEl = document.getElementById('level');
  private xpEl = document.getElementById('xp');
  private xpToNextEl = document.getElementById('xpToNext');
  private creditsEl = document.getElementById('credits');
  private systemInfoEl = document.getElementById('systemInfo');

  constructor(private h: HudHost) {}

  /** The credits figure last written to the HUD */
  private creditsShown = -1;

  update(): void {
    // Boost Bar (vertical)
    if (this.boostFillEl) {
      const boostPercent = (this.h.state.boostFuel / this.h.state.maxBoostFuel) * 100;
      setStyle(this.boostFillEl, 'height', `${boostPercent.toFixed(1)}%`);
    }
    
    // XP bar: progress through the current level (from the pilot's profile)
    const prof = this.h.pilot.profile;
    const into = prof ? prof.xp - prof.xpLevel : 0;
    const span = prof ? Math.max(1, prof.xpNext - prof.xpLevel) : 100;
    // (Each only when it changes: see domWrite)
    setStyle(this.xpFillEl, 'width', `${Math.min(100, (into / span) * 100).toFixed(1)}%`);
    setText(this.levelEl, String(prof?.level ?? this.h.state.level));
    const lvl = prof?.level ?? this.h.state.level;
    if (prof && this.xpSeen) {
      if (lvl > this.xpSeen.level) { this.replayClass(this.xpBarEl, 'lvl'); this.replayClass(this.levelEl?.parentElement, 'lvl'); }
      else if (into > this.xpSeen.into) this.replayClass(this.xpBarEl, 'gain');
    }
    if (prof) this.xpSeen = { level: lvl, into };
    setText(this.xpEl, String(into));
    setText(this.xpToNextEl, String(span));
    // (Formatted only when it changes: toLocaleString is slow to run every frame)
    if (this.h.state.credits !== this.creditsShown) { this.creditsShown = this.h.state.credits; setText(this.creditsEl, this.h.state.credits.toLocaleString()); }
    setText(this.systemInfoEl, this.h.systemNames.get(this.h.state.systemId) ?? this.h.state.systemId ?? 'Unknown System');
  }

  /** Restart a one-shot CSS animation (remove the class, reflow, add it back) */
  private replayClass(el: Element | null | undefined, cls: string): void {
    if (!el) return;
    el.classList.remove('gain', 'lvl');
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  }
}
