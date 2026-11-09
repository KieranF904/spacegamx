/**
 * @contract client.ui.tutorial.ui
 * owns:       wiring the lesson into the game: the card, markers and toast from each tutorialState, drone/ghost/hidden looks for the
 *             training drones, panel-open reports (polled here, so no panel's own code changes), retiring the old tour
 * needs:      tutorialStore, tutorialModel, TutorialPanel, TutorialMarkers, glow (the step's highlight), placement (the card's window), the game's entities, a send function, a renderer hook
 * invariants: step text, targets and rules come from the server's state and data/tutorial.json, never hardcoded here — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new panel to report is an entry in `panelsOpen` (Game wiring) and in common TUTORIAL_PANELS
 */

import { EntityType, TUTORIAL_PANELS, objectPos } from '@space-game/common';
import type { ClientMessage, ServerTutorialStateMessage, TutorialPanel } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import { TutorialMarkers } from './TutorialMarkers';
import { TutorialPanel as PanelView } from './TutorialPanel';
import { Glow, domGlowHost } from './glow';
import { domFind, findAnchor } from './placement';
import { leaveMessage, onTutorial, onTutorialEdge, reportMessage, resetTutorial, tutorialData } from './tutorialStore';
import { lookFor, newlyDone, targetGained, packLines, panelModel, risingPanels, type TrainingLook } from './tutorialModel';
import { clearTrainingBodies, setTrainingBody } from '../../state/trainingBodies';

export interface TutorialUIDeps {
  state: GameState;
  send(m: ClientMessage): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  setTrainingLook(id: number, look: TrainingLook | null): void;
  /** The key an action is bound to, as text */
  keyOf(action: string): string;
  /** The pilot is flying in helm mode (nose-relative keys), not mouse-steer */
  helm(): boolean;
  itemName(id: string): string;
  sound(id: string, v?: number): void;
  /** Which of the reportable panels are open right now */
  panelsOpen(): Partial<Record<TutorialPanel, boolean>>;
  /** End the old flight-school tour (it must not run beside this one) */
  stopOldTour(): void;
}

/** A training body is matched to its entity by place: the yard is stationary */
const SAME_PLACE = 6;

export class TutorialUI {
  private panel: PanelView;
  private markers: TutorialMarkers;
  private cur: ServerTutorialStateMessage | null = null;
  private prevPanels: Record<string, boolean> = {};
  private entityOf = new Map<string, number>();
  private applied = new Map<string, TrainingLook | null>();
  private frame = 0;
  private helmShown = false;
  private glow = new Glow(domGlowHost());
  private find = domFind();

  constructor(private d: TutorialUIDeps) {
    this.panel = new PanelView({
      ack: (step) => d.send(reportMessage('ack', { step })),
      leave: () => d.send(leaveMessage()),
      sound: (id, v) => d.sound(id, v),
    });
    this.markers = new TutorialMarkers({
      data: tutorialData,
      worldToScreen: (x, y) => d.worldToScreen(x, y),
      me: () => { const e = d.state.entities.get(d.state.playerId); return e ? { x: e.renderX, y: e.renderY } : null; },
      station: () => this.yardStation(),
      nearestRock: () => this.nearestRock(),
    });
    onTutorial((s) => this.onState(s));
    // (The yard's edge: the card's own leave confirm, Leave / Stay)
    onTutorialEdge(() => this.panel.askLeave());
  }

  /** The connection starts over */
  reset(): void {
    resetTutorial();
    this.cur = null;
    this.prevPanels = {};
    this.entityOf.clear();
    this.applied.clear();
    clearTrainingBodies();
    this.panel.reset();
    this.glow.clear();
  }

  private onState(s: ServerTutorialStateMessage): void {
    const prev = this.cur;
    this.cur = s;
    // (A server that runs the yard teaches there: the old flight-school tour never runs beside it, nor after it)
    this.d.stopOldTour();
    for (const t of newlyDone(prev, s, tutorialData)) this.panel.toast(t);
    if (targetGained(prev, s, tutorialData)) this.d.sound('scan_ping', 0.6);
    // A new step: whatever panel is already open counts again
    if (!prev || prev.step !== s.step) this.prevPanels = {};
    this.showCard();
    this.looks();
    this.glow.set(s.left ? '' : s.step, s.left ? undefined : tutorialData.steps.find((x) => x.id === s.step)?.highlight);
  }

  /** The instruction card for the state and the control mode now */
  private showCard(): void {
    const s = this.cur;
    this.panel.set(s ? panelModel(s, tutorialData, this.d.keyOf, this.d.helm()) : null, packLines(tutorialData, (id) => this.d.itemName(id)));
  }

  /** The yard station (the dock step's mark): the station body nearest the yard's centre, as the client sees it */
  private yardStation(): { x: number; y: number; radius: number } | null {
    const c = tutorialData.yard.center;
    let best: { x: number; y: number; radius: number } | null = null, bd = tutorialData.yard.leash;
    for (const e of this.d.state.entities.values()) {
      if (e.type !== EntityType.Station) continue;
      const d = Math.hypot(e.renderX - c.x, e.renderY - c.y);
      if (d < bd) { bd = d; best = { x: e.renderX, y: e.renderY, radius: e.stationRadius ?? 500 }; }
    }
    return best;
  }

  /** The belt rock nearest the pilot (the mining step's mark): any asteroid the client knows that is not a training drone */
  private nearestRock(): { x: number; y: number; radius: number } | null {
    const me = this.d.state.entities.get(this.d.state.playerId);
    if (!me) return null;
    const drones = new Set(this.entityOf.values());
    let best: { x: number; y: number; radius: number } | null = null, bd = Infinity;
    for (const e of this.d.state.entities.values()) {
      if (e.type !== EntityType.Asteroid || drones.has(e.id)) continue;
      const d = Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY);
      if (d < bd) { bd = d; best = { x: e.renderX, y: e.renderY, radius: e.data?.[0] ?? 60 }; }
    }
    return best;
  }

  /**
   * Each frame; `hidden`: the world is behind a full-screen view (the markers go); `cardHidden`: so is the card (the
   * map, the menu). The card stays up over the hangar, where the part and generator steps are done
   */
  update(hidden: boolean, cardHidden = hidden): void {
    const s = this.cur;
    this.panel.setHidden(cardHidden);
    this.markers.setHidden(hidden);
    if (!s || s.left) { this.markers.draw(null); this.glow.clear(); return; }
    // The card by the window the pilot is in (the station, the hold, the hangar, the map), or at the top; the glowing controls follow the page
    if (this.frame % 15 === 0) this.glow.refresh();
    // (clear of the controls the step points at: the card's own key caps glow too, and are no reason to move)
    const avoid = this.glow.litNow().filter((e) => !this.panel.contains(e) && e.getClientRects().length > 0).map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (!cardHidden) this.panel.place(findAnchor(this.find), avoid);
    this.markers.draw(s);
    // (The control mode can change with a key: the card's keys follow it)
    if (this.d.helm() !== this.helmShown) { this.helmShown = this.d.helm(); this.showCard(); }
    // Panels: report each one as it opens
    const now: Record<string, boolean> = {};
    const open = this.d.panelsOpen();
    for (const p of TUTORIAL_PANELS) now[p] = !!open[p];
    for (const p of risingPanels(this.prevPanels, now)) this.d.send(reportMessage('panel', { panel: p as TutorialPanel }));
    this.prevPanels = now;
    // Bodies come and go as the yard streams in: match them again now and then
    if (++this.frame % 20 === 0) this.looks();
  }

  /** Give each training body its look (a drone, a ghost or nothing) */
  private looks(): void {
    const s = this.cur;
    if (!s) return;
    for (const o of tutorialData.objects) {
      if (o.kind !== 'drone') continue;
      let id = this.entityOf.get(o.id);
      const known = id !== undefined ? this.d.state.entities.get(id) : undefined;
      if (!known || known.type !== EntityType.Asteroid) {
        if (id !== undefined) setTrainingBody(id, null);
        id = undefined;
        this.entityOf.delete(o.id);
        this.applied.delete(o.id);
        const p = objectPos(tutorialData, o);
        for (const e of this.d.state.entities.values()) {
          if (e.type === EntityType.Asteroid && Math.abs(e.renderX - p.x) < SAME_PLACE && Math.abs(e.renderY - p.y) < SAME_PLACE) { id = e.id; break; }
        }
        if (id === undefined) continue;
        this.entityOf.set(o.id, id);
      }
      const look = lookFor(o, s, tutorialData);
      if (this.applied.has(o.id) && this.applied.get(o.id) === look) continue;
      this.applied.set(o.id, look);
      this.d.setTrainingLook(id!, look);
      // (hits and hover read it: an inert drone is passed by this pilot's shots and has no hover card)
      setTrainingBody(id!, look);
    }
  }
}
