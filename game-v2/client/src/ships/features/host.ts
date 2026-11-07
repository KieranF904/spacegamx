/**
 * ClientFeatures: the client features flattened once so the per-frame loops walk plain arrays (empty with no feature).
 * ShipClient owns one; ShipRenderer is handed its draw list.
 */
import type { Container } from 'pixi.js';
import type { ClientFeature, ClientFeatureHost, IndicatorDef, ShipDrawCtx, TickWindow } from './types';
import type { FeatureStatusLine } from '../../ui/shipStatus/source';

export class ClientFeatures {
  private readonly keyed: NonNullable<ClientFeature['onKey']>[] = [];
  private readonly parsers: NonNullable<ClientFeature['parsePilot']>[] = [];
  private readonly drawers: NonNullable<ClientFeature['drawShip']>[] = [];
  private readonly frames: NonNullable<ClientFeature['beginFrame']>[] = [];
  private readonly chips: IndicatorDef[] = [];
  private readonly statuses: NonNullable<ClientFeature['status']>[] = [];
  private readonly windows: NonNullable<ClientFeature['onWindow']>[] = [];
  private readonly controls = new Map<string, () => boolean>();

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
      if (f.status) this.statuses.push(f.status.bind(f));
      if (f.onWindow) this.windows.push(f.onWindow.bind(f));
      for (const [name, fn] of Object.entries(f.controls ?? {})) {
        if (this.controls.has(name)) throw new Error(`client feature ${f.id}: control ${name} has two features`);
        this.controls.set(name, () => fn(host));
      }
    }
  }

  get hasDrawers(): boolean { return this.drawers.length > 0; }
  get hasParsers(): boolean { return this.parsers.length > 0; }

  /** A held input's value this input tick (false: no feature gives it). Resolve once and keep the function */
  controlFor(name: string): () => boolean {
    return this.controls.get(name) ?? (() => false);
  }

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

  /**
   * A snapshot window searched on the tick layer (SelfHits.window): `ids` the ships exact in it (null: not searched),
   * read through the host's exact poses, sides and structures
   */
  onWindow(from: number, to: number, ids: readonly number[] | null): void {
    if (!this.windows.length) return;
    const h = this.host;
    const win: TickWindow = {
      from, to,
      ships: ids && h.side && h.exactAt && h.shipAt ? {
        ids, side: h.side, at: h.exactAt,
        radius: (id, k) => { const s = h.shipAt!(id, k); return s && s.kind === 'ship' ? s.derived.radius : undefined; },
      } : null,
    };
    for (let i = 0; i < this.windows.length; i++) this.windows[i](win, h);
  }

  /** The features' status panel lines now, into `out` (cleared first; ui/shipStatus) */
  statusLines(out: FeatureStatusLine[]): FeatureStatusLine[] {
    out.length = 0;
    for (let i = 0; i < this.statuses.length; i++) { const l = this.statuses[i](this.host); if (l) out.push(l); }
    return out;
  }
}
