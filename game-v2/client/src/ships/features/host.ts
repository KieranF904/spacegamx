/**
 * ClientFeatures: the client features flattened once so the per-frame loops walk plain arrays (empty with no feature).
 * ShipClient owns one; ShipRenderer is handed its draw list.
 */
import type { Container } from 'pixi.js';
import type { ClientFeature, ClientFeatureHost, IndicatorDef, ShipDrawCtx } from './types';

export class ClientFeatures {
  private readonly keyed: NonNullable<ClientFeature['onKey']>[] = [];
  private readonly parsers: NonNullable<ClientFeature['parsePilot']>[] = [];
  private readonly drawers: NonNullable<ClientFeature['drawShip']>[] = [];
  private readonly frames: NonNullable<ClientFeature['beginFrame']>[] = [];
  private readonly chips: IndicatorDef[] = [];

  constructor(features: readonly ClientFeature[], private readonly host: ClientFeatureHost) {
    const seen = new Set<string>();
    for (const f of [...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(f.id)) throw new Error(`client feature ${f.id} is listed twice`);
      seen.add(f.id);
      if (f.onKey) this.keyed.push(f.onKey.bind(f));
      if (f.parsePilot) this.parsers.push(f.parsePilot.bind(f));
      if (f.drawShip) this.drawers.push(f.drawShip.bind(f));
      if (f.beginFrame) this.frames.push(f.beginFrame.bind(f));
      if (f.indicator) this.chips.push(f.indicator);
    }
  }

  get hasDrawers(): boolean { return this.drawers.length > 0; }
  get hasParsers(): boolean { return this.parsers.length > 0; }

  /** A key was pressed: true if a feature used it */
  onKey(code: string): boolean {
    for (let i = 0; i < this.keyed.length; i++) if (this.keyed[i](code, this.host)) return true;
    return false;
  }

  /** Read the pilot row's feature values (`at`: first pilotExtra index) into `fx` */
  parsePilot(data: number[], at: number, fx: { [name: string]: number }): void {
    for (let i = 0; i < this.parsers.length; i++) this.parsers[i](data, at, fx);
  }

  /** Once a frame, before the ships are drawn */
  beginFrame(shared: Container): void {
    for (let i = 0; i < this.frames.length; i++) this.frames[i](shared, this.host);
  }

  drawShip(ctx: ShipDrawCtx): void {
    for (let i = 0; i < this.drawers.length; i++) this.drawers[i](ctx, this.host);
  }

  updateIndicators(): void {
    for (let i = 0; i < this.chips.length; i++) this.chips[i].update(this.host);
  }
}
