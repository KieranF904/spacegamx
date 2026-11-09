/**
 * The first two minutes: a guided tour for new pilots, one short step at a
 * time, with an arrow on whatever the step is about. Fly, boost, mine a rock,
 * scoop the ore, look in the hold, get to the station (or let the autopilot
 * take you), dock, find the Ships tab, shoot down a training drone, and make
 * a jump. Skippable at any point; it never shows again once done or skipped.
 */

import { EntityType } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';
import { getTutorialState } from './tutorial/tutorialStore';

const DONE_KEY = 'sg.tutorialDone';

/** The key an action is bound to now, as a key cap (read as each step shows, so a rebind mid-tour shows too) */
const k = (id: string) => `<kbd>${boundKeyName(id, settings.data.bindings)}</kbd>`;
/** Boost: either Shift works while it's on a Shift key */
const boostKey = () => ((settings.data.bindings.boost ?? 'ShiftLeft').startsWith('Shift') ? '<kbd>Shift</kbd>' : k('boost'));

export interface TutorialDeps {
  state: GameState;
  isKeyDown(code: string): boolean;
  worldToScreen(x: number, y: number): { x: number; y: number };
  /** Ore in the hold */
  oreInHold(): number;
  inventoryOpen(): boolean;
  stationOpen(): boolean;
  stationTab(): string;
  /** Inside a station's docking ring */
  inDockRing(): boolean;
  autopilotOn(): boolean;
  sound(id: string, v?: number): void;
  /** Ask the server for a training drone in front of you (inner Sol) */
  trainingDrone(): void;
  /** Kills so far this session */
  kills(): number;
  /** Your jump drive's phase */
  jumpPhase(): string;
}

interface Step {
  text(): string;
  /** Key caps to show */
  keys?: string[];
  /** Where the arrow points (world), if anywhere */
  target?(): { x: number; y: number; label: string } | null;
  /** An element on screen to point at instead */
  element?(): HTMLElement | null;
  done(t: Tutorial): boolean;
}

export class Tutorial {
  private card: HTMLDivElement;
  private arrow: HTMLDivElement;
  private step = -1;
  private stepStart = 0;
  private boostTicks = 0;
  /** Distance flown this step (teleports and respawns don't count) */
  private flown = 0;
  private last: { x: number; y: number } | null = null;
  private steps: Step[];
  /** The combat lesson: kills when it started, and when its drone was last asked for */
  private killsAt = 0;
  private droneAt = 0;
  active = false;

  constructor(private d: TutorialDeps) {
    const css = document.createElement('style');
    css.textContent = `
.tut { position: fixed; left: 50%; bottom: 236px; transform: translateX(-50%); z-index: 2100; display: none; max-width: min(560px, calc(100vw - 32px));
  padding: 12px 16px 10px; border-radius: 12px; background: linear-gradient(180deg, rgba(16, 30, 52, 0.95), rgba(8, 16, 30, 0.95));
  border: 1px solid rgba(251, 191, 36, 0.55); box-shadow: 0 0 30px rgba(251, 191, 36, 0.15), 0 12px 40px rgba(0,0,0,0.5);
  color: #e5ecf7; font: 14px 'Segoe UI', system-ui, sans-serif; line-height: 1.45; animation: tutin .25s ease-out; }
@keyframes tutin { from { opacity: 0; transform: translate(-50%, 8px); } }
.tut .h { display: flex; justify-content: space-between; align-items: center; gap: 10px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2.5px; color: #fbbf24; margin-bottom: 4px; }
.tut .h button { all: unset; cursor: pointer; color: #8394ad; letter-spacing: 1px; font-weight: 600; }
.tut .h button:hover { color: #fff; }
.tut kbd { display: inline-block; min-width: 18px; padding: 1px 6px; margin: 0 2px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.35); border-bottom-width: 3px;
  background: rgba(255,255,255,0.08); font: 700 12px 'Segoe UI', sans-serif; text-align: center; color: #fff; }
.tut .dots { display: flex; gap: 4px; margin-top: 8px; }
.tut .dots i { width: 18px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.12); }
.tut .dots i.on { background: #fbbf24; }
.tut-ar { position: fixed; z-index: 2090; pointer-events: none; display: none; color: #fbbf24; font: 700 12px 'Segoe UI', sans-serif;
  text-shadow: 0 0 6px #000, 0 0 3px #000; text-align: center; transform: translate(-50%, -100%); }
.tut-ar b { display: block; font-size: 30px; line-height: 1; animation: tutbob 0.9s ease-in-out infinite; filter: drop-shadow(0 0 6px rgba(251, 191, 36, 0.8)); }
@keyframes tutbob { 50% { transform: translateY(-8px); } }`;
    document.head.appendChild(css);
    this.card = document.createElement('div');
    this.card.className = 'tut';
    this.arrow = document.createElement('div');
    this.arrow.className = 'tut-ar';
    document.body.append(this.card, this.arrow);

    const me = () => d.state.entities.get(d.state.playerId);
    const nearest = (type: EntityType, label: (e: { name?: string }) => string) => () => {
      const m = me();
      if (!m) return null;
      let best = null as null | { x: number; y: number; label: string }, bd = Infinity;
      for (const e of d.state.entities.values()) {
        if (e.type !== type) continue;
        const dd = Math.hypot(e.renderX - m.renderX, e.renderY - m.renderY);
        if (dd < bd) { bd = dd; best = { x: e.renderX, y: e.renderY, label: label(e) }; }
      }
      return best;
    };
    this.steps = [
      {
        text: () => `Fly with ${k('forward')}${k('left')}${k('backward')}${k('right')}. Your ship turns to face the mouse cursor.`,
        done: () => this.flown > 700,
      },
      {
        text: () => `Hold ${boostKey()} while thrusting to boost. The <b>ENERGY</b> gauge on the right is your ship's stored power: boosting and firing draw on it when the generators can't keep up, and it refills from spare generation. It reads LOW POWER when something gets less than it asks.`,
        done: () => { if (d.isKeyDown('ShiftLeft') || d.isKeyDown('ShiftRight')) this.boostTicks++; return this.boostTicks > 40; },
      },
      {
        text: () => 'Ore comes from asteroids. Aim at one and hold the <b>left mouse button</b>: chunks of ore break off. Then fly through them to scoop them into your hold.',
        target: nearest(EntityType.Asteroid, () => 'Asteroid'),
        done: () => d.oreInHold() > 0,
      },
      {
        text: () => `Got some. Press ${k('inventory')} to look in your hold (and your station storage, when you're docked).`,
        done: () => d.inventoryOpen(),
      },
      {
        text: () => `Now head for the station: follow the arrow. Or open the map with ${k('map')} and click the station, and the autopilot flies you there (${k('autopilot')} does the same for the job you're following). Any flight key takes back control.`,
        target: nearest(EntityType.Station, (e) => e.name ?? 'Station'),
        done: () => d.inDockRing() || d.stationOpen(),
      },
      {
        text: () => `You're in the docking ring. Press ${k('dock')} to dock: the station repairs you, buys your ore, and has jobs on its board.`,
        done: () => d.stationOpen(),
      },
      {
        text: () => 'Open the <b>Ships</b> tab: your hangar slots, the plans you know, and building ships part by part.',
        element: () => [...document.querySelectorAll<HTMLElement>('.sgw-tab')].find((el) => el.textContent === 'Ships' && el.offsetParent !== null) ?? null,
        done: () => d.stationTab() === 'ships',
      },
      {
        text: () => `Target practice. Leave the station, and a stray <b>Helios drone</b> drifts out in front of you: harmless. ${k('targetNext')} targets it; hold the <b>left mouse button</b> to shoot it down. Hits that flash <b style="color:#94a3b8">grey</b> are glancing: that gun is too weak for the armour it hit.`,
        keys: ['Tab'],
        target: () => {
          const m = me();
          if (!m) return null;
          let best = null as null | { x: number; y: number; label: string }, bd = 6000;
          for (const e of d.state.entities.values()) {
            if (e.type !== EntityType.ShipBody || e.data?.[0] !== 3) continue;
            const dd = Math.hypot(e.renderX - m.renderX, e.renderY - m.renderY);
            if (dd < bd) { bd = dd; best = { x: e.renderX, y: e.renderY, label: 'Target' }; }
          }
          return best;
        },
        done: () => {
          if (this.killsAt < 0) this.killsAt = d.kills();
          // Undocked: one drone in front of you (again if it's gone without you)
          if (!d.stationOpen() && performance.now() - this.droneAt > 20000) { this.droneAt = performance.now(); d.trainingDrone(); }
          return d.kills() > this.killsAt;
        },
      },
      {
        text: () => `Your <b>jump drive</b> crosses space in seconds. Point the cursor where you want to go (a marker at the screen edge locks it on), then press ${k('jump')}. The ring is how far it reaches; the reticle turns <b style="color:#f87171">red</b> if you'd land somewhere bad. Then it recharges for a few seconds, so just fly the short hops. A bigger ship needs jump coils to jump as far.`,
        keys: ['J'],
        done: () => d.jumpPhase() === 'burn',
      },
      {
        text: () => `That's the basics. Inner Sol is <b style="color:#5eead4">safe space</b>: hostiles keep out, and a ship lost here keeps its whole hold. Past Jovan it gets rough, and the gates show what's beyond them. ${k('log')} jobs · ${k('map')} map · ${k('party')} party · ${k('quick1')}–${k('quick5')} quick bar · hold ${k('contextMenu')} and right-click anything for what you can do with it. Good flying!`,
        done: () => performance.now() - this.stepStart > 14000,
      },
    ];
  }

  /** Start for a brand-new pilot (once) */
  maybeStart(isNew: boolean): void {
    let done = false;
    try { done = localStorage.getItem(DONE_KEY) === '1'; } catch { /* private window */ }
    // (Not on a server that runs the training yard: it teaches there, and a graduate never gets this as well)
    if (this.active || done || !isNew || getTutorialState()) return;
    this.active = true;
    this.go(0);
  }

  /** End the tour now without marking it done (the training yard's lesson takes over) */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.card.style.display = 'none';
    this.arrow.style.display = 'none';
  }

  /** Replay it (menu). Never on a server that runs the training yard */
  restart(): void {
    if (getTutorialState()) return;
    try { localStorage.removeItem(DONE_KEY); } catch { /* ignore */ }
    this.active = true;
    this.go(0);
  }

  private go(i: number): void {
    this.step = i;
    this.stepStart = performance.now();
    this.boostTicks = 0;
    this.flown = 0;
    this.last = null;
    this.killsAt = -1;
    this.droneAt = 0;
    if (i >= this.steps.length) return this.finish();
    if (i > 0) this.d.sound('scan_ping', 0.4);
    const s = this.steps[i];
    this.card.innerHTML = `<div class="h"><span>FLIGHT SCHOOL · ${i + 1} OF ${this.steps.length}</span><button>Skip tutorial ✕</button></div><div>${s.text()}</div>
      <div class="dots">${this.steps.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>`;
    this.card.querySelector('button')!.onclick = () => this.finish();
    this.card.style.display = 'block';
  }

  private finish(): void {
    this.active = false;
    this.card.style.display = 'none';
    this.arrow.style.display = 'none';
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
  }

  setHidden(hidden: boolean): void {
    if (!this.active) return;
    this.card.style.visibility = hidden ? 'hidden' : 'visible';
    if (hidden) this.arrow.style.display = 'none';
  }

  update(hidden: boolean): void {
    if (!this.active) return;
    this.setHidden(hidden);
    const s = this.steps[this.step];
    if (!s) return;
    const m = this.d.state.entities.get(this.d.state.playerId);
    if (m) {
      const step = this.last ? Math.hypot(m.x - this.last.x, m.y - this.last.y) : 0;
      if (step < 120) this.flown += step;
      this.last = { x: m.x, y: m.y };
    }
    // A step can't be finished in the same moment it starts
    if (performance.now() - this.stepStart > 600 && s.done(this)) { this.go(this.step + 1); return; }
    if (hidden) return;
    // The arrow: over a thing in space (or at the screen edge towards it), or over a button
    const el = s.element?.();
    if (el) {
      const r = el.getBoundingClientRect();
      this.arrow.style.cssText = `display:block; left:${r.left + r.width / 2}px; top:${r.top - 4}px; transform: translate(-50%, -100%)`;
      this.arrow.innerHTML = '<b>▼</b>';
      return;
    }
    const t = s.target?.();
    if (!t || this.d.autopilotOn()) { this.arrow.style.display = 'none'; return; }
    const p = this.d.worldToScreen(t.x, t.y);
    const W = innerWidth, H = innerHeight;
    if (p.x > 40 && p.y > 80 && p.x < W - 40 && p.y < H - 40) {
      this.arrow.style.cssText = `display:block; left:${p.x}px; top:${p.y - 40}px; transform: translate(-50%, -100%)`;
      this.arrow.innerHTML = `${t.label}<b>▼</b>`;
    } else {
      const cx = W / 2, cy = H / 2, dx = p.x - cx, dy = p.y - cy;
      const k = Math.min((cx - 70) / Math.max(1, Math.abs(dx)), (cy - 90) / Math.max(1, Math.abs(dy)));
      const ang = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      this.arrow.style.cssText = `display:block; left:${cx + dx * k}px; top:${cy + dy * k}px; transform: translate(-50%, -50%)`;
      this.arrow.innerHTML = `<b style="transform: rotate(${ang}deg); animation:none">▲</b>${t.label}`;
    }
  }
}
