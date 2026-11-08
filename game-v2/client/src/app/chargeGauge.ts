/**
 * @contract client.app.chargeGauge
 * owns:       the thin bar over the jump gauge while pulse lasers charge to their next pulse
 * needs:      domWrite setText and setStyle, ShipClient.laserCharge (passed in)
 * invariants: the bar's element is made on first use and only changed when a value changes — none pinned
 * extend:     another charge readout is one more branch in update()
 */

import { setText, setStyle } from '../ui/domWrite';

export class ChargeGauge {
  private heatEl: HTMLDivElement | null = null;
  private heatText: HTMLElement | null = null;
  private heatFill: HTMLElement | null = null;

  /** Charge guns' charge (Longbarrel, Blackout) and pulse lasers' charge to their next pulse: a thin bar over the jump gauge while they charge (no heat: rework 2026-11) */
  update(laser: { charge: number; ready: number; total: number } | null, visible: boolean): void {
    if (!this.heatEl) {
      this.heatEl = document.createElement('div');
      this.heatEl.style.cssText = `position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%); width: 240px; z-index: 860; pointer-events: none;
        font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-align: center; display: none;`;
      this.heatEl.innerHTML = '<div data-k="t"></div><div style="height:4px; border-radius:2px; background:rgba(255,255,255,0.08); margin-top:3px; overflow:hidden"><i data-k="f" style="display:block; height:100%; transition: width .1s"></i></div>';
      document.body.appendChild(this.heatEl);
      this.heatText = this.heatEl.querySelector('[data-k="t"]') as HTMLElement;
      this.heatFill = this.heatEl.querySelector('[data-k="f"]') as HTMLElement;
    }
    // (A charge gun's charge is on the weapon ring round the cursor: ui/WeaponRing.ts)
    const charging = !!laser && laser.charge < 0.999;
    const show = visible && charging;
    setStyle(this.heatEl, 'display', show ? 'block' : 'none');
    if (!show) return;
    if (laser) {
      // Pulse lasers: the charge to their next pulse
      setText(this.heatText, laser.total > 1 ? `LASERS CHARGING · ${laser.ready}/${laser.total} READY` : 'LASER CHARGING');
      setStyle(this.heatText, 'color', '#fecaca');
      setStyle(this.heatFill, 'width', `${Math.round(laser.charge * 100)}%`);
      setStyle(this.heatFill, 'background', 'linear-gradient(90deg,#7f1d1d,#f87171,#ffe4e4)');
    }
  }
}
