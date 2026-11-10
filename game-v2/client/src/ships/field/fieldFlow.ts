/**
 * @contract client.ships.field-flow
 * owns:       the world build view's power flow overlay: its on/off state (remembered), the design's flow worked out once per
 *             edit, the drawing in the world, and the toggle button and legend in the build panel
 * needs:      build/powerFlow (data), build/powerFlowView (drawing), build/powerFlowPref (the remembered choice), common createShipState
 *             / portsLoadTestCached (the whole design as built); WorkingDesign from plan.ts; npm: pixi.js (type only)
 * invariants: it shows the working design as it would run once every planned part is built (labelled "as designed") — none pinned
 * extend:     FieldOverlay calls mount() once, toggle() on the key, draw() each frame; nothing else
 */
import type { Graphics } from 'pixi.js';
import { createShipState, portsLoadTestCached, type PlacedGeom } from '@space-game/common';
import { powerFlow, type PowerFlow } from '../build/powerFlow';
import { loadPowerFlow, savePowerFlow } from '../build/powerFlowPref';
import { ALL_LAYERS, drawFlow, flowLegendHtml, pixiSink } from '../build/powerFlowView';
import type { FieldDeps } from './bridge';
import type { WorkingDesign } from './plan';

export class FieldFlow {
  on = loadPowerFlow();
  private btn?: HTMLButtonElement;
  private legend?: HTMLDivElement;
  private forW: WorkingDesign | null = null;
  private val: PowerFlow | null = null;
  private legendFor = '';

  constructor(private deps: Pick<FieldDeps, 'catalog' | 'tuning'>) {}

  /** The toggle button and the legend, at the top of `parent` (the panel's footer) */
  mount(parent: HTMLElement): void {
    const row = document.createElement('div');
    row.innerHTML = '<button class="fo-btn" data-a="flow" title="Power flow: moving dots from the generators to what they feed, a tick where ports meet, a cross where they do not (U)" style="width:100%">Power flow (U)</button>';
    this.btn = row.querySelector('button')!;
    this.btn.addEventListener('click', () => this.toggle());
    this.legend = document.createElement('div');
    this.legend.style.cssText = 'font-size:11px; line-height:1.4; color:#8ea0bd; background:rgba(7,11,20,0.86); border:1px solid #2a3a5a; border-radius:4px; padding:5px 7px';
    parent.prepend(row, this.legend);
    this.sync();
  }

  toggle(): boolean {
    this.on = !this.on;
    savePowerFlow(this.on);
    this.sync();
    return this.on;
  }

  private sync(): void {
    if (this.btn) { this.btn.style.borderColor = this.on ? '#5fd4c4' : '#2a3a5a'; this.btn.style.background = this.on ? '#24406b' : ''; }
    if (this.legend) this.legend.hidden = !this.on;
  }

  /** The flow of the working design as built whole (cached until the design changes) */
  private flowOf(w: WorkingDesign): PowerFlow | null {
    if (this.forW === w) return this.val;
    this.forW = w;
    this.val = null;
    try {
      const d = createShipState(this.deps.catalog, this.deps.tuning, 0, w.bp, 0).derived;
      this.val = powerFlow(d, portsLoadTestCached(d, 'both'));
    } catch { /* a design the core can't build whole shows no flow */ }
    return this.val;
  }

  /** Draw the flow into the world (`at`: a grid point to the world; `cs`: world units a cell) */
  draw(g: Graphics, at: (gx: number, gy: number) => [number, number], cs: number, w: WorkingDesign, geoms: readonly PlacedGeom[]): void {
    if (!this.on) return;
    const f = this.flowOf(w);
    if (this.legend) {
      const asDesigned = w.standing.some((s) => !s), key = `${asDesigned}|${f ? 1 : 0}`;
      if (key !== this.legendFor) { this.legendFor = key; this.legend.innerHTML = f ? flowLegendHtml('U', asDesigned) : 'POWER FLOW (U)<div>This design has no ports routing to show.</div>'; }
    }
    if (f) drawFlow(pixiSink(g, at, cs), f, geoms, ALL_LAYERS, performance.now() / 1000);
  }
}
