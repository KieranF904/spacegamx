/**
 * The loading screen's driver: puts it up for a join (Game calls begin), an arrival in another system or a respawn
 * (noticed here, from the state changing), reads the game into app/readiness.ts's signals each frame, and lifts the
 * screen once the world is in sync (or after the timeout, logging what was missing).
 *
 * While it's up the camera is held on your ship (Renderer.snapCamera), so nothing slides or spins when it lifts.
 * Game calls update() once a frame, after the world is interpolated and before it is drawn.
 */
import { Readiness, type ReadinessProbe, type ReadinessState } from './readiness';
import { LoadingScreen } from '../ui/LoadingScreen';
import { proceduralPending } from '../rendering/procedural';
import { rockAtlas } from '../rendering/rocks/RockMaterials';
import { hullAtlas, hullAtlasReady } from '../ships/hullLook';
import { hullJobsPending } from '../ships/hullWorkerClient';
import type { GameState } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import type { ShipClient } from '../ships/ShipClient';

export type LoadingKind = 'join' | 'travel' | 'respawn';

/** What the flow reads off the game */
export interface LoadingHost {
  readonly state: GameState;
  readonly renderer: Renderer;
  readonly shipClient: ShipClient;
  connected(): boolean;
  loggedIn(): boolean;
  /** A system's name, if known yet */
  systemName(id: string): string | undefined;
}

/** The screen stays at least this long once up for an arrival or respawn (no one-frame flash) */
const MIN_SHOWN_MS = 250;

export class LoadingFlow {
  private screen: LoadingScreen;
  private readiness = new Readiness();
  private kind: LoadingKind | null = null;
  private lastPlayer = 0;
  private lastSystem = '';
  private subtitle = '';

  constructor(parent: HTMLElement, private host: LoadingHost) {
    this.screen = new LoadingScreen(parent);
    // The rock and hull atlases are built in workers: asked for now, on the sign-in screen, they're usually in by the
    // time a server is picked (asked on the first frame of the world, they held the screen up a second or more)
    rockAtlas();
    hullAtlas();
  }

  get active(): boolean {
    return this.kind !== null;
  }

  /** Put the screen up (a join: from choosing a server; already up for one: carries on) */
  begin(kind: LoadingKind, subtitle = ''): void {
    if (this.kind === kind) { if (subtitle) this.subtitle = subtitle; return; }
    this.kind = kind;
    this.subtitle = subtitle;
    // A join may be to another server: its clock isn't ours until its first pong
    if (kind === 'join') this.host.state.clockSynced = false;
    this.readiness.begin(performance.now());
    this.screen.show(kind === 'respawn' ? 'Respawning' : kind === 'travel' ? 'Arriving' : 'Space Game', subtitle);
    this.screen.setStep(kind === 'join' ? 'Connecting' : 'Receiving the world', 0);
  }

  /** Down at once, nothing waited for (the connection dropped: its message shows instead) */
  cancel(): void {
    this.kind = null;
    this.screen.hide(true);
  }

  /** Once a frame */
  update(now = performance.now()): void {
    const s = this.host.state;
    // An arrival somewhere else, or a new ship after dying: the world is rebuilt, so it's covered while that happens
    if (!this.kind && this.host.loggedIn() && s.playerId) {
      if (this.lastPlayer && s.playerId !== this.lastPlayer) this.begin('respawn', this.host.systemName(s.systemId) ?? '');
      else if (this.lastSystem && s.systemId !== this.lastSystem) this.begin('travel', this.host.systemName(s.systemId) ?? '');
    }
    if (s.playerId) this.lastPlayer = s.playerId;
    if (s.systemId && this.host.loggedIn()) this.lastSystem = s.systemId;
    if (!this.kind) return;

    if (this.kind !== 'join' && !this.subtitle) {
      const name = this.host.systemName(s.systemId);
      if (name) { this.subtitle = name; this.screen.show(this.kind === 'respawn' ? 'Respawning' : 'Arriving', name); }
    }
    const r = this.readiness.check(this.probe(), now);
    this.screen.setStep(r.step, r.progress);
    // Held on your ship until the screen is gone
    this.host.renderer.snapCamera();
    if (!r.done || (this.kind !== 'join' && this.readiness.elapsed(now) < MIN_SHOWN_MS)) return;
    this.finish(r, now);
  }

  /** The signals, read off the game */
  probe(): ReadinessProbe {
    const s = this.host.state;
    const me = s.entities.get(s.playerId);
    return {
      joined: this.host.connected() && this.host.loggedIn() && !!s.playerId,
      ship: !!me && !!this.host.shipClient.myShip(),
      clock: s.clockSynced,
      view: s.viewCaughtUp(),
      built: proceduralPending() === 0 && this.host.renderer.buildPending() === 0 && hullJobsPending() === 0 && hullAtlasReady(),
    };
  }

  private finish(r: ReadinessState, now: number): void {
    const ms = Math.round(this.readiness.elapsed(now));
    if (r.timedOut) console.warn(`Loading screen (${this.kind}): lifted after ${ms} ms without ${r.missing.join(', ')}`);
    else console.log(`Loading screen (${this.kind}): in sync after ${ms} ms`);
    this.kind = null;
    this.screen.hide();
  }
}
