/**
 * The Esc menu as the game holds it from init: the GameMenuUI API, built (a dynamic import, out of the startup chunk)
 * on first open or in idle time after sign-in. Until then it is closed (isOpen false); an open or a back asked for
 * meanwhile runs when it arrives, so the first press is never lost.
 */
import { Lazy } from '../lazy';
import type { GameMenuUI } from './GameMenuUI';

type Page = Parameters<GameMenuUI['open']>[0];
type GuideTab = Parameters<GameMenuUI['openGuide']>[0];

export class MenuFacade {
  constructor(private readonly lazy: Lazy<GameMenuUI>) {}

  load(): Promise<unknown> { return this.lazy.load(); }
  get loaded(): boolean { return this.lazy.value !== null; }
  get isOpen(): boolean { return this.lazy.value?.isOpen ?? false; }
  open(page?: Page): void { this.lazy.use((m) => m.open(page)); }
  openGuide(tab: GuideTab): void { this.lazy.use((m) => m.openGuide(tab)); }
  close(): void { this.lazy.value?.close(); }
  toggle(): void { this.lazy.use((m) => m.toggle()); }
  back(): void { this.lazy.value?.back(); }
}
