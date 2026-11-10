/**
 * The system map as the game holds it from init: the same API as SystemMapUI, which loads (a dynamic import, out of the
 * startup chunk) when first opened or in idle time after sign-in. Before then it is closed: the per-frame queries answer
 * the closed map's answers (isOpen false, no aim, no fire, no lock), the settings written to it wait and are applied on
 * arrival, and an open asked for in the meantime opens it when it arrives (so the first M press is never lost).
 */
import { Lazy } from '../lazy';
import type { SystemMapUI } from './SystemMapUI';

/** The fields Game and the windows assign: kept here, written through to the real map once it exists */
const FIELDS = [
  'onWarp', 'onFlyTo', 'autoTarget', 'autoRoute', 'party', 'myRating', 'myShip', 'locked', 'pings', 'onPing', 'wreck', 'jump',
  'jumpAim', 'notesOverlay', 'placeHook', 'onVisibleChange', 'onZoomIntoFlight', 'flightMinScale',
] as const;
type Field = (typeof FIELDS)[number];

export class SystemMap {
  declare onWarp: SystemMapUI['onWarp'];
  declare onFlyTo: SystemMapUI['onFlyTo'];
  declare autoTarget: SystemMapUI['autoTarget'];
  declare autoRoute: SystemMapUI['autoRoute'];
  declare party: SystemMapUI['party'];
  declare myRating: SystemMapUI['myRating'];
  declare myShip: SystemMapUI['myShip'];
  declare locked: SystemMapUI['locked'];
  declare pings: SystemMapUI['pings'];
  declare onPing: SystemMapUI['onPing'];
  declare wreck: SystemMapUI['wreck'];
  declare jump: SystemMapUI['jump'];
  declare jumpAim: SystemMapUI['jumpAim'];
  declare notesOverlay: SystemMapUI['notesOverlay'];
  declare placeHook: SystemMapUI['placeHook'];
  declare onVisibleChange: SystemMapUI['onVisibleChange'];
  declare onZoomIntoFlight: SystemMapUI['onZoomIntoFlight'];
  declare flightMinScale: SystemMapUI['flightMinScale'];

  private readonly held: Partial<Record<Field, unknown>> = {};
  private info: Parameters<SystemMapUI['setSystemInfo']>[0] | null = null;
  private belt: [number, number] | null = null;
  private redrawEvery: number | null = null;
  /** Stands in for the map's overlay layer until it exists (nothing reads it while the map is closed) */
  private readonly stub = typeof document !== 'undefined' ? document.createElement('div') : (null as unknown as HTMLDivElement);

  constructor(private readonly lazy: Lazy<SystemMapUI>) {
    for (const f of FIELDS) {
      Object.defineProperty(this, f, {
        get: () => this.held[f],
        set: (v: unknown) => { this.held[f] = v; if (this.lazy.value) (this.lazy.value as unknown as Record<string, unknown>)[f] = v; },
      });
    }
  }

  /** Starts the load (idle prefetch) */
  load(): Promise<unknown> { return this.lazy.load(); }

  /** Built: hand it everything set and fed while it was away */
  applyPending(map: SystemMapUI): void {
    Object.assign(map, this.held);
    if (this.info) map.setSystemInfo(this.info);
    if (this.belt) map.setBelt(this.belt[0], this.belt[1]);
    if (this.redrawEvery !== null) map.setRedrawEvery(this.redrawEvery);
  }

  get loaded(): boolean { return this.lazy.value !== null; }
  get isOpen(): boolean { return this.lazy.value?.isOpen ?? false; }
  get overlay(): HTMLElement { return this.lazy.value?.overlay ?? this.stub; }
  toCanvas(x: number, y: number, out: { x: number; y: number }): boolean { return this.lazy.value?.toCanvas(x, y, out) ?? false; }
  isVisible(): boolean { return this.isOpen; }
  covers(): boolean { return this.lazy.value?.covers() ?? false; }
  aimWorld(): { x: number; y: number } | null { return this.lazy.value?.aimWorld() ?? null; }
  firing(): boolean { return this.lazy.value?.firing() ?? false; }
  jumpLock(): ReturnType<SystemMapUI['jumpLock']> { return this.lazy.value?.jumpLock() ?? null; }

  setSystemInfo(info: Parameters<SystemMapUI['setSystemInfo']>[0]): void { this.info = info; this.lazy.value?.setSystemInfo(info); }
  setBelt(inner: number, outer: number): void { this.belt = [inner, outer]; this.lazy.value?.setBelt(inner, outer); }
  setRedrawEvery(n: number): void { this.redrawEvery = n; this.lazy.value?.setRedrawEvery(n); }

  /** Opens or closes it; a first open waits for the chunk, then opens */
  toggle(): void { this.lazy.use((m) => m.toggle()); }
  show(): void { this.lazy.use((m) => m.show()); }
  showFromFlight(scale: number): void { this.lazy.use((m) => m.showFromFlight(scale)); }
  hide(): void { this.lazy.value?.hide(); }
  destroy(): void { this.lazy.value?.destroy(); }
}

/** The map as a facade over a lazily-built SystemMapUI (the build gets the page's overlay and the game state) */
export function makeSystemMap(build: () => Promise<SystemMapUI>): SystemMap {
  let facade!: SystemMap;
  const lazy = new Lazy(() => build().then((m) => { facade.applyPending(m); return m; }));
  facade = new SystemMap(lazy);
  return facade;
}
