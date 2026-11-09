/**
 * @contract client.ui.tutorial.ui
 * owns:       wiring the lesson into the game: the card, markers and toast from each tutorialState, ghost/drone looks for the
 *             training bodies, panel-open reports (polled here, so no panel's own code changes), retiring the old tour
 * needs:      tutorialStore, tutorialModel, TutorialPanel, TutorialMarkers, the game's entities, a send function, a renderer hook
 * invariants: step text, targets and rules come from the server's state and data/tutorial.json, never hardcoded here — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new panel to report is an entry in `panelsOpen` (Game wiring) and in common TUTORIAL_PANELS
 */

import { EntityType, TUTORIAL_PANELS, objectPos } from '@space-game/common';
import type { ClientMessage, ServerTutorialStateMessage, TutorialPanel } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import { TutorialMarkers } from './TutorialMarkers';
import { TutorialPanel as PanelView } from './TutorialPanel';
import { leaveMessage, onTutorial, onTutorialEdge, reportMessage, resetTutorial, tutorialData } from './tutorialStore';
import { lookFor, newlyDone, packLines, panelModel, risingPanels, type TrainingLook } from './tutorialModel';

export interface TutorialUIDeps {
  state: GameState;
  send(m: ClientMessage): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  setTrainingLook(id: number, look: TrainingLook | null): void;
  /** The key an action is bound to, as text */
  keyOf(action: string): string;
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
    this.panel.reset();
  }

  private onState(s: ServerTutorialStateMessage): void {
    const prev = this.cur;
    this.cur = s;
    if (!s.left) this.d.stopOldTour();
    for (const t of newlyDone(prev, s, tutorialData)) this.panel.toast(t);
    // A new step: whatever panel is already open counts again
    if (!prev || prev.step !== s.step) this.prevPanels = {};
    this.panel.set(panelModel(s, tutorialData, this.d.keyOf), packLines(tutorialData, (id) => this.d.itemName(id)));
    this.looks();
  }

  /** Each frame; `hidden`: behind a full-screen view */
  update(hidden: boolean): void {
    const s = this.cur;
    this.panel.setHidden(hidden);
    this.markers.setHidden(hidden);
    if (!s || s.left) { this.markers.draw(null); return; }
    this.markers.draw(s);
    // Panels: report each one as it opens
    const now: Record<string, boolean> = {};
    const open = this.d.panelsOpen();
    for (const p of TUTORIAL_PANELS) now[p] = !!open[p];
    for (const p of risingPanels(this.prevPanels, now)) this.d.send(reportMessage('panel', { panel: p as TutorialPanel }));
    this.prevPanels = now;
    // Bodies come and go as the yard streams in: match them again now and then
    if (++this.frame % 20 === 0) this.looks();
  }

  /** Give each training body its look (a drone, a ghost, or the plain rock) */
  private looks(): void {
    const s = this.cur;
    if (!s) return;
    for (const o of tutorialData.objects) {
      if (o.kind !== 'rock' && o.kind !== 'drone') continue;
      let id = this.entityOf.get(o.id);
      const known = id !== undefined ? this.d.state.entities.get(id) : undefined;
      if (!known || known.type !== EntityType.Asteroid) {
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
      const look = lookFor(o, s);
      if (this.applied.has(o.id) && this.applied.get(o.id) === look) continue;
      this.applied.set(o.id, look);
      this.d.setTrainingLook(id!, look);
    }
  }
}
