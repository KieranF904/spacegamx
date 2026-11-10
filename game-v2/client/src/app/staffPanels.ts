/**
 * @contract client.app.staff-panels
 * owns:       the admin panel (F2) and contributor notes panel (F6): loaded on demand, made once, torn down on sign-out
 * needs:      StaffHost (send, state, pilot, renderer, input, windows, flyTo, chat), dynamic imports of ui/AdminPanel and ui/ContributorPanel; npm: @space-game/common
 * invariants: only admins fetch the admin chunk, only contributors the notes chunk — none pinned
 * extend:     a new staff-only panel is one more start/stop pair here
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import type { InputManager } from '../input/InputManager';
import type { Renderer } from '../rendering/Renderer';
import type { AutoDest } from '../ships/Autopilot';
import type { GameState } from '../state/GameState';
import type { AdminPanel } from '../ui/AdminPanel';
import type { ContributorPanel } from '../ui/ContributorPanel';
import type { WindowSet } from './windows';

/** What the staff panels read from the game */
export interface StaffHost {
  readonly state: GameState;
  readonly pilot: PilotState;
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly w: Pick<WindowSet, 'systemMapUI'>;
  isAdmin(): boolean;
  send(msg: ClientMessage): void;
  flyTo(dest: AutoDest): void;
  chat(playerName: string, text: string, isSystem?: boolean, color?: string): void;
}

export class StaffPanels {
  constructor(private h: StaffHost) {}

  /** The admin panel (admins only; F2 opens it) */
  adminPanel: AdminPanel | null = null;

  /** Its chunk is on its way (split out of the main chunk: only admins fetch it) */
  private adminLoading = false;

  startAdmin(): void {
    const h = this.h;
    if (this.adminPanel || this.adminLoading) return;
    this.adminLoading = true;
    void import('../ui/AdminPanel').then(({ AdminPanel }) => {
      this.adminLoading = false;
      // (signed out while it loaded)
      if (this.adminPanel || !h.isAdmin()) return;
      this.adminPanel = new AdminPanel({
        send: (m) => h.send(m),
        state: h.state,
        econ: h.pilot.econ,
        cursorWorld: () => h.renderer.screenToWorld(h.input.mouseX, h.input.mouseY),
        screenToWorld: (x, y) => h.renderer.screenToWorld(x, y),
        setCamera: (t) => h.renderer.setCameraTarget(t),
        zoom: () => h.input.zoom,
        isKeyDown: (c) => h.input.isKeyDown(c),
        clientStats: () => {
          const s = h.state;
          return `<b>Prediction</b><span>${s.predErrorPre.toFixed(1)}px before · ${s.predErrorPost.toFixed(1)}px after (avg ${s.predErrorPreAvg.toFixed(1)})</span>
            <b>Snaps</b><span>${s.predSnapCount}</span><b>Pending</b><span>${s.predPendingCount} inputs</span>
            <b>Input delay</b><span>${s.inputDelayTicks} ticks (${(s.inputDelayTicks * 16.67).toFixed(0)} ms)</span>`;
        },
      });
      h.chat('', 'Admin: F2 opens the admin panel, F3 teleports to the cursor, F4 frees the camera. /help lists the chat commands.', true, '#ff8a6a');
    }, (e) => { this.adminLoading = false; console.error('Admin panel failed to load:', e); });
  }

  stopAdmin(): void {
    this.adminPanel?.destroy();
    this.adminPanel = null;
  }

  /** Contributor notes (contributors and admins; F6) */
  contribPanel: ContributorPanel | null = null;
  /** Started and not stopped since (its chunk loads first: only contributors fetch it) */
  private contribWanted = false;

  startContrib(): void {
    const h = this.h;
    if (this.contribPanel) return;
    this.contribWanted = true;
    void import('../ui/ContributorPanel').then(({ ContributorPanel }) => {
      if (this.contribPanel || !this.contribWanted) return;
      this.contribPanel = new ContributorPanel({
        send: (m) => h.send(m),
        state: h.state,
        me: () => h.state.playerName,
        isAdmin: () => h.isAdmin(),
        screenToWorld: (x, y) => h.renderer.screenToWorld(x, y),
        worldToScreen: (x, y) => h.renderer.worldToScreen(x, y),
        zoom: () => h.renderer.getZoom(),
        map: h.w.systemMapUI,
        flyTo: (d) => h.flyTo(d),
        setCamera: (t) => h.renderer.setCameraTarget(t),
        warp: (systemId, x, y) => h.send({ type: 'devTeleport', systemId, x, y }),
      });
    }, (e) => console.error('Contributor panel failed to load:', e));
  }

  stopContrib(): void {
    this.contribWanted = false;
    this.contribPanel?.destroy();
    this.contribPanel = null;
  }

  /** Each frame: the panels that are up */
  update(): void {
    this.adminPanel?.update();
    this.contribPanel?.update();
  }
}
