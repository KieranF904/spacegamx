/**
 * Ship HUD: core HP plus a small schematic of the ship, each part tinted by HP, and the ship status readout
 * (ui/shipStatus: a shield and energy summary under the CORE bar, and a foldable details column beside the schematic,
 * refreshed at STATUS_HZ from the source ShipClient gives it).
 */

import { setText, setStyle, setHtml } from '../ui/domWrite';
import { ShipState, PlacedGeom, bounds } from '@space-game/common';
import type { ShipSource } from './ShipStore';
import { hpColor, numToCss } from './shipColors';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import { StatusPanel } from '../ui/shipStatus/StatusPanel';
import { readStatus, newMemory, emptyStatus, type StatusInput } from '../ui/shipStatus/source';

/** How often the status readout is refreshed (a second) */
const STATUS_HZ = 10;

export class ShipHud {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private label: HTMLDivElement;
  private bar: HTMLDivElement;
  private lastSig = '';

  private mode: HTMLDivElement;
  private status = new StatusPanel();
  private statusMem = newMemory();
  private statusRec = emptyStatus();
  private statusAt = 0;

  constructor(private bridge: ShipSource, private getPlayerId: () => number, private isHelm: () => boolean,
    private statusInput: () => StatusInput | null = () => null) {
    this.root = document.createElement('div');
    // (The ship column; unfolded, the status details sit in their own box beside it: ui/shipStatus/StatusPanel.ts)
    this.root.style.cssText = `
      position: fixed; left: 16px; top: 64px; width: 180px; padding: 8px 10px 10px;
      background: rgba(8, 12, 22, 0.82); border: 1px solid rgba(120, 150, 200, 0.35); border-radius: 8px;
      font: 12px 'Courier New', monospace; color: #cfd8e6; z-index: 900; pointer-events: none;`;
    this.root.dataset.hudAvoid = '1';
    const col = document.createElement('div');
    this.label = document.createElement('div');
    const track = document.createElement('div');
    track.style.cssText = 'height: 6px; background: #1b2333; border-radius: 3px; margin: 4px 0 8px; overflow: hidden;';
    this.bar = document.createElement('div');
    this.bar.style.cssText = 'height: 100%; width: 100%; background: #4ade80; transition: width 0.1s;';
    track.appendChild(this.bar);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 180;
    this.canvas.height = 88;
    this.canvas.style.cssText = 'display: block; position: static; width: 180px; height: 88px;';
    this.ctx = this.canvas.getContext('2d')!;
    this.mode = document.createElement('div');
    this.mode.style.cssText = 'margin-top: 6px; color: #8ea0bd; font-size: 11px;';
    const head = document.createElement('div');
    head.append(this.status.fold, this.label);
    col.append(head, track, this.status.summary, this.canvas, this.mode);
    this.root.append(col, this.status.details);
    document.body.appendChild(this.root);
  }

  /** The setting (on or off) and whether we're in a game at all: shown only when both */
  private wanted = true;
  private inGame = false;

  setVisible(on: boolean): void {
    this.wanted = on;
    this.root.style.display = this.wanted && this.inGame ? 'block' : 'none';
  }

  setInGame(on: boolean): void {
    this.inGame = on;
    this.setVisible(this.wanted);
  }

  update(): void {
const ship = this.bridge.get(this.getPlayerId());
    if (!ship || ship.kind !== 'ship') {
      setStyle(this.root, 'opacity', '0.4');
      return;
    }
    setStyle(this.root, 'opacity', '1');
    const k = (id: string) => boundKeyName(id, settings.data.bindings);
    setHtml(this.mode, this.isHelm()
      ? `<b style="color:#ffb547">HELM</b> ${k('left')}/${k('right')} turn · ${k('strafeLeft')}/${k('strafeRight')} strafe · <kbd>${k('helm')}</kbd>`
      : `<b style="color:#7dd3fc">MOUSE-STEER</b> · <kbd>${k('helm')}</kbd> for helm`);
    const core= ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    const hp = core >= 0 && !ship.detached[core] ? ship.hp[core] : 0;
    const max = core >= 0 ? ship.maxHp[core] : 1;
    const f = hp / max;
    setText(this.label, `CORE ${Math.ceil(hp)} / ${Math.round(max)}`);
    setStyle(this.bar, 'width', `${Math.max(0, f * 100).toFixed(1)}%`);
    setStyle(this.bar, 'background', numToCss(hpColor(f)));

    // The status readout, at STATUS_HZ (what it reads: ui/shipStatus/source.ts)
    const now = performance.now();
    if (now - this.statusAt >= 1000 / STATUS_HZ) {
      this.statusAt = now;
      const inp = this.statusInput();
      if (inp) this.status.update(readStatus(inp, this.statusMem, this.statusRec));
    }

    const sig = ship.hp.map((h, i) => (ship.detached[i] ? 'x' : Math.round((h / ship.maxHp[i]) * 20))).join(',') + ship.rebuilds;
    if (sig !== this.lastSig) {
      this.drawSchematic(ship, this.bridge.geometry(ship));
      this.lastSig = sig;
    }
  }

  private drawSchematic(ship: ShipState, geoms: PlacedGeom[]): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const b = bounds(geoms.flatMap((g) => g.polygon));
    const pad = 6;
    const scale = Math.min((canvas.width - pad * 2) / (b.maxX - b.minX), (canvas.height - pad * 2) / (b.maxY - b.minY));
    const ox = (canvas.width - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
    const oy = (canvas.height - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
    geoms.forEach((g, i) => {
      ctx.beginPath();
      g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(ox + x * scale, oy + y * scale) : ctx.moveTo(ox + x * scale, oy + y * scale)));
      ctx.closePath();
      const gone = ship.detached[i] || ship.hp[i] <= 0;
      if (!gone) {
        ctx.fillStyle = numToCss(hpColor(ship.hp[i] / ship.maxHp[i]));
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = gone ? 'rgba(239, 68, 68, 0.5)' : 'rgba(10, 14, 24, 0.9)';
      ctx.setLineDash(gone ? [2, 2] : []);
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }
}
