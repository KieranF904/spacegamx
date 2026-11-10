/**
 * @contract client.ship.dock
 * owns:       docking at a station: the dock request/answer, the berth, undocking, the dock and planet and repair hints
 * needs:      DockHost (state, tuning, store, send, showMessage, sound, hangarOpen, openHangar, refreshShip, stationOpen, onDocked); npm: @space-game/common
 * invariants: berthed means no inputs go (the server holds controls neutral) — client/src/app/inputSend.test.ts
 *             undock puts the ship back where it came in — client/src/ships/dock/DockControl.test.ts
 * extend:     a new hint line is one more branch in updateHints
 */

import { EntityType, stationInteractRadius, type ClientMessage, type ServerMessage, type ShipTuning } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import { setHtml, setStyle } from '../../ui/domWrite';
import { boundKeyName } from '../../input/keybindings';
import { settings } from '../../settings/Settings';
import type { ShipStore } from '../ShipStore';

export interface DockHost {
  readonly state: GameState;
  readonly tuning: ShipTuning;
  readonly store: ShipStore;
  /** Is the station screen open */
  stationOpen?(): boolean;
  /** Docked at a station: open the station screen (without this, docking opens the hangar) */
  onDocked?(station: string): void;
  send(msg: ClientMessage): void;
  showMessage(text: string, color?: string): void;
  sound?(id: string, at?: { x: number; y: number }, volume?: number, pitch?: number): (() => void) | null;
  hangarOpen(): boolean;
  openHangar(): void;
  /** Its hull drawn afresh */
  refreshShip(id: number): void;
}

export class DockControl {
  dockHint: HTMLDivElement;
  planetHint: string | null = null;
  planetVerb = 'Descend to';
  /** The planet below you that you could land on (null: none); `verb`: what X does there ("Enter" a pocket's way in) */
  setPlanetHint(name: string | null, verb = 'Descend to'): void {
    this.planetHint = name;
    this.planetVerb = verb;
  }
  repairHint: HTMLDivElement;
  /** A dock request is waiting for the server's answer */
  dockPending = false;
  docked = false;
  /** The station we're berthed in, and where we came in (relative to it) */
  berth: { station: number; ox: number; oy: number } | null = null;
  constructor(private readonly h: DockHost) {
    this.dockHint = document.createElement('div');
    this.dockHint.style.cssText = `position: fixed; left: 50%; bottom: 152px; transform: translateX(-50%); display: none;
      padding: 7px 16px; border-radius: 999px; background: rgba(8, 16, 30, 0.85); border: 1px solid rgba(125, 211, 252, 0.6);
      color: #cfe9ff; font: 14px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; pointer-events: none; z-index: 900;`;
    this.dockHint.dataset.tut = 'dock-hint';
    document.body.appendChild(this.dockHint);
    this.repairHint = document.createElement('div');
    this.repairHint.style.cssText = this.dockHint.style.cssText;
    this.repairHint.style.bottom = '196px';
    this.repairHint.style.borderColor = 'rgba(143, 246, 255, 0.55)';
    this.repairHint.style.color = '#9ffcff';
    this.repairHint.style.display = 'none';
    document.body.appendChild(this.repairHint);
  }

  /** Leave the berth (station screen closed) */
  undock(): void {
    if (!this.docked) return;
    this.h.send({ type: 'undock' });
    this.docked = false;
    // Out where we came in
    const st = this.berth && this.h.state.entities.get(this.berth.station), me = this.h.state.entities.get(this.h.state.playerId);
    if (st && me && this.berth) { me.x = st.x + this.berth.ox; me.y = st.y + this.berth.oy; me.vx = 0; me.vy = 0; }
    this.berth = null;
    // (Its hull drawn afresh, whatever was done to it in the hangar)
    this.h.refreshShip(this.h.state.playerId);
    this.h.sound?.('undock');
  }

  /**
   * Out of the berth by the server's hand, not ours (the gun range took the ship: client ui/gunRange): nothing sent and
   * the ship left where the server put it
   */
  leftBerth(): void {
    this.docked = false;
    this.dockPending = false;
    this.berth = null;
  }

  /** The station whose docking ring we're inside, if any. (The server checks again when we dock.) */
  stationInRange(): InterpolatedEntity | null {
    const me = this.h.state.entities.get(this.h.state.playerId);
    if (!me) return null;
    for (const e of this.h.state.entities.values()) {
      if (e.type === EntityType.Station && Math.hypot(e.x - me.x, e.y - me.y) < stationInteractRadius(e.data?.[8] ?? 0, e.data?.[9] ?? 0)) return e;
    }
    return null;
  }

  isDocked(): boolean {
    return this.stationInRange() !== null;
  }

  /** Berthed at a station (the server took the dock: it holds our controls neutral, so no inputs go: app/inputSend.ts) */
  berthed(): boolean {
    return this.docked;
  }

  /** Name of the station whose docking ring we're in (for the menu) */
  dockableStationName(): string | null {
    return this.stationInRange()?.name ?? null;
  }

  /** "Repairing" while your ship is mending near a station: how far along, and parts still to regrow */
  private updateRepairHint(): void {
    const ship = this.h.store.get(this.h.state.playerId);
    const me = this.h.state.entities.get(this.h.state.playerId);
    const range = this.h.tuning.repair?.range ?? 0;
    let text = '';
    if (ship && me && range > 0 && ship.derived.root >= 0 && !this.h.hangarOpen()) {
      let near = false;
      for (const e of this.h.state.entities.values()) {
        if (e.type === EntityType.Station && Math.hypot(e.x - me.x, e.y - me.y) < (e.data?.[8] ?? 200) + range) { near = true; break; }
      }
      if (near) {
        let missing = 0, hp = 0, max = 0;
        for (let i = 0; i < ship.hp.length; i++) {
          max += ship.maxHp[i];
          if (ship.derived.alive[i]) hp += ship.hp[i];
          else missing++;
        }
        if (missing > 0 || hp < max - 1e-6) {
          text = `Station repair: <b>${Math.floor((100 * hp) / max)}%</b>${missing ? ` · ${missing} part${missing > 1 ? 's' : ''} to rebuild` : ''}`;
        }
      }
    }
    setStyle(this.repairHint, 'display', text ? 'block' : 'none');
    if (text) setHtml(this.repairHint, text);
  }

  /** The dockResult message: berthed (and the station screen up), or refused */
  onDockResult(msg: Extract<ServerMessage, { type: 'dockResult' }>): void {
    this.dockPending = false;
    if (msg.ok) {
      this.docked = true;
      // Inside the station: held at its centre (the server puts you back where you came in when you leave)
      const st = this.stationInRange(), me = this.h.state.entities.get(this.h.state.playerId);
      this.berth = this.docked && st && me ? { station: st.id, ox: me.x - st.x, oy: me.y - st.y } : null;
      this.h.sound?.(this.docked ? 'dock' : 'ui_open');
      if (this.h.onDocked && this.docked) this.h.onDocked(msg.station ?? 'Station');
      else this.h.openHangar();
    } else {
      this.h.showMessage(`Can't dock: ${msg.error ?? 'refused'}`, '#f2d24b');
      this.h.sound?.('error');
    }
  }

  /** H pressed: dock if in range (the server checks again), else say how */
  pressDock(): void {
    if (this.dockPending) return;
    else if (this.isDocked()) { this.dockPending = true; this.h.send({ type: 'dock' }); }
    else this.h.showMessage(`Fly into a station's docking ring and press ${boundKeyName('dock', settings.data.bindings)} to dock`, '#f2d24b');
  }

  /** Once per frame: the hint lines */
  update(): void {
    this.updateRepairHint();
    this.updateHints();
  }

  private updateHints(): void {
    const { state } = this.h;
    // "Press H to dock" while inside a station's docking ring (not while docked: the station's screen is up);
    // in orbit close over a planet you can land on, "X to descend"
    const station = !this.h.hangarOpen() && !this.dockPending && !this.h.stationOpen?.() ? this.stationInRange() : null;
    const planet = !station && !this.h.hangarOpen() ? this.planetHint : null;
    setStyle(this.dockHint, 'display', station || planet ? 'block' : 'none');
    if (station) setHtml(this.dockHint, `<kbd>${boundKeyName('dock', settings.data.bindings)}</kbd> Dock at <b>${station.name ?? 'station'}</b>`);
    else if (planet) setHtml(this.dockHint, `<kbd>${boundKeyName('interact', settings.data.bindings)}</kbd> ${this.planetVerb} <b>${planet}</b>`);
  }
}
