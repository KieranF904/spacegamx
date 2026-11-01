/**
 * Ship HUD: core HP and the ship schematic, which is also the status readout (ui/shipStatus/Schematic.ts paints each
 * part by HP, charge, reload, thrust and brownout from the record ui/shipStatus/source.ts reads, at STATUS_HZ).
 */

import { setText, setStyle, setHtml } from '../ui/domWrite';
import type { ShipSource } from './ShipStore';
import { hpColor, numToCss } from './shipColors';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import { Schematic } from '../ui/shipStatus/Schematic';
import { readStatus, newMemory, emptyStatus, type StatusInput } from '../ui/shipStatus/source';

/** How often the schematic and status are refreshed (a second) */
const STATUS_HZ = 10;
/** The schematic's size (css px) */
const SCHEM_W = 160;
const SCHEM_H = 124;

export class ShipHud {
  private root: HTMLDivElement;
  private schem = new Schematic(SCHEM_W, SCHEM_H);
  private label: HTMLDivElement;
  private bar: HTMLDivElement;

  private mode: HTMLDivElement;
  private statusMem = newMemory();
  private statusRec = emptyStatus();
  private statusAt = 0;

  constructor(private bridge: ShipSource, private getPlayerId: () => number, private isHelm: () => boolean,
    private statusInput: () => StatusInput | null = () => null) {
    this.root = document.createElement('div');
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
    this.mode = document.createElement('div');
    this.mode.style.cssText = 'margin-top: 6px; color: #8ea0bd; font-size: 11px;';
    const head = document.createElement('div');
    head.append(this.label);
    col.append(head, track, this.schem.canvas, this.mode);
    this.root.append(col);
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

    // The schematic is the status readout, at STATUS_HZ (what it reads: ui/shipStatus/source.ts)
    const now = performance.now();
    if (now - this.statusAt >= 1000 / STATUS_HZ) {
      this.statusAt = now;
      const inp = this.statusInput();
      if (inp) readStatus(inp, this.statusMem, this.statusRec);
      else this.statusRec.has = false;
      this.schem.draw(ship, this.bridge.geometry(ship), this.statusRec, now);
    }
  }
}
