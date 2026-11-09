/**
 * Quests on the client: the tracker (top right, with the objective guide's
 * next waypoint), the station's contracts board, and the pilot log (L) with
 * your quests (in progress, leads, completed), records (found documents and
 * testimony: econ/codex.ts), skills (K) and standing.
 * Work that's joined the log since you last looked (a finished job's
 * follow-ups) is badged on the tracker and the log until you open it.
 * Conversations with people are DialogueUI's.
 *
 * All of it is a view of what the server sends (quests, people, questBoard,
 * questStep); accepting, abandoning and spending skill points are requests
 * the server checks.
 */

import {
  ClientMessage, QuestView, QuestTarget, RewardView, SKILLS, SKILL_POINT_CAP, skillValue, repRank, REP_RANKS, VendorDef,
  RibbonsFile, ServerRibbonsMessage, ServerRankingsMessage,
  ServerQuestsMessage, ServerQuestBoardMessage, QuestLead, PersonView,
  CODEX_TABS, CODEX_TAB_NAMES, type CodexView, type CodexTab, type ServerCodexMessage,
} from '@space-game/common';
import type { PilotState } from '../econ/clientEcon';
import { GameWindow, costHtml, injectWindowStyles } from './windowKit';
import ribbonsData from '../../../data/achievements.json';
import { settings } from '../settings/Settings';
import { setText, setStyle } from './domWrite';
import { boundKeyName } from '../input/keybindings';
import { esc } from './escape';
import { fetchRankings } from '../network/rankings';

/** The key an action is bound to now (for the hints) */
const keyOf = (id: string) => boundKeyName(id, settings.data.bindings);

export const CHAIN: Record<string, { label: string; color: string }> = {
  main: { label: 'Story', color: '#fbbf24' },
  science: { label: 'Metallurgy', color: '#fb923c' },
  borealis: { label: 'Borealis', color: '#7ff0d0' },
  side: { label: 'Side story', color: '#c4b5fd' },
  guild: { label: "Miners' Guild", color: '#a3e635' },
  shipwright: { label: 'Shipwright', color: '#7dd3fc' },
  traders: { label: 'Contract', color: '#f0abfc' },
  patrol: { label: 'Sol Patrol', color: '#93c5fd' },
  bounty: { label: 'Bounty', color: '#fca5a5' },
  fleet: { label: 'Fleet op', color: '#4ade80' },
};
const chainOf = (c: string) => CHAIN[c] ?? { label: c, color: '#c9d4e5' };

/** Each Records group's colour */
const CODEX_COLOR: Record<CodexTab, string> = { signal: '#fbbf24', peoples: '#c4b5fd', places: '#7ff0d0', records: '#7dd3fc', talk: '#f0abfc' };


export interface QuestDeps {
  pilot: PilotState;
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
}

let styled = false;
function injectQuestStyles(): void {
  if (styled) return;
  styled = true;
  injectWindowStyles();
  const css = document.createElement('style');
  css.textContent = `
.rib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px; }
.rib { display: flex; gap: 10px; padding: 9px 10px; border-radius: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(140,170,220,0.12); opacity: 0.75; }
.rib.done { opacity: 1; border-color: rgba(134, 239, 172, 0.4); background: rgba(34, 197, 94, 0.06); }
.rib.rare.done { border-color: rgba(251, 191, 36, 0.55); background: rgba(251, 191, 36, 0.07); }
.rib .ic { width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center; font-size: 18px; color: #64748b; background: rgba(0,0,0,0.3); border: 1px solid rgba(140,170,220,0.2); }
.rib.done .ic { color: #86efac; border-color: rgba(134,239,172,0.5); box-shadow: 0 0 10px rgba(134,239,172,0.25); }
.rib.rare.done .ic { color: #fde68a; border-color: rgba(251,191,36,0.6); box-shadow: 0 0 12px rgba(251,191,36,0.35); }
.rib .tx { flex: 1; min-width: 0; }
.rib .n { font-weight: 600; color: #e5ecf7; }
.rib .n .st { color: #fbbf24; }
.rib .d { color: #8394ad; font-size: 11px; line-height: 1.4; }
.rib .ok { color: #86efac; font-size: 11px; margin-top: 2px; }
.rank-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.rank-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rank-cols .rh { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: #8394ad; margin-bottom: 4px; text-transform: uppercase; }
.rr { display: flex; gap: 6px; align-items: baseline; font-size: 12px; padding: 1px 0; }
.rr .p { width: 18px; color: #64748b; text-align: right; }
.rr .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d6deeb; }
.rr b { color: #fde68a; font-weight: 600; }
.ry { margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(140,170,220,0.1); color: #7dd3fc; font-size: 11px; }
.qt { position: fixed; right: 16px; top: 232px; width: 268px; z-index: 840; display: none; flex-direction: column; gap: 6px;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #c9d4e5; pointer-events: none; }
.qt-head { display: flex; align-items: center; gap: 8px; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2.5px; color: #8394ad; pointer-events: auto; }
.qt-head span { flex: 1; }
.qt-head button { all: unset; cursor: pointer; color: #8394ad; font-size: 10px; letter-spacing: 1px; padding: 1px 6px; border-radius: 6px; }
.qt-head button:hover { color: #fff; background: rgba(255,255,255,0.06); }
.qt-q { background: rgba(8, 14, 26, 0.74); border: 1px solid rgba(120, 150, 200, 0.18); border-left: 3px solid var(--qc); border-radius: 9px;
  padding: 7px 10px 8px; pointer-events: auto; cursor: pointer; transition: background .15s, transform .2s; }
.qt-q:hover { background: rgba(14, 24, 44, 0.85); }
.qt-q.tracked { background: rgba(14, 24, 44, 0.88); border-color: rgba(160, 190, 240, 0.32); border-left-color: var(--qc); }
.qt-q.bump { animation: qtbump .6s ease-out; }
@keyframes qtbump { 0% { transform: translateX(-6px); box-shadow: 0 0 0 0 var(--qc); } 60% { box-shadow: 0 0 14px -2px var(--qc); } 100% { transform: none; box-shadow: none; } }
.qt-n { display: flex; align-items: baseline; gap: 6px; font-weight: 600; color: #e5ecf7; }
.qt-n .c { font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: var(--qc); text-transform: uppercase; }
.qt-n .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt-s { margin-top: 3px; color: #a9b6c9; line-height: 1.35; }
.qt-s b { color: #e5ecf7; font-weight: 600; }
.qt-ap { margin-left: 6px; padding: 0 6px; border-radius: 4px; border: 1px solid rgba(74, 222, 128, 0.55); background: rgba(20, 60, 40, 0.6);
  color: #bbf7d0; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1px; cursor: pointer; vertical-align: 1px; }
.qt-ap:hover { background: rgba(34, 197, 94, 0.35); }
.qt-bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); margin-top: 5px; overflow: hidden; }
.qt-bar i { display: block; height: 100%; background: var(--qc); transition: width .3s; }
.qt-more { color: #56657c; font-size: 11px; padding-left: 4px; pointer-events: auto; cursor: pointer; }

.qt-g { margin-top: 5px; padding-top: 4px; border-top: 1px dashed rgba(251,191,36,0.25); color: #fde68a; font-size: 11px; }
.ql-h { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; text-transform: uppercase; margin: 6px 2px 0; }
.ql-h:first-child { margin-top: 0; }
.ql-none { color: #56657c; font-size: 11px; padding: 2px 4px; }
.ql-item.lead { border-style: dashed; border-left-style: solid; }
.ql-item.lock { opacity: 0.6; }
.ql-item.fin { opacity: 0.55; }
.ql-item .new, .qt-new { color: #fbbf24; font-size: 10px; font-weight: 700; letter-spacing: 1px; }
.ql-item .new { margin-left: 6px; }
.qt-new { flex: 0 !important; white-space: nowrap; cursor: pointer; pointer-events: auto; }
.ql-outro { color: #a9b6c9; font-style: italic; margin-top: 10px; line-height: 1.5; }
.ql-where { margin-bottom: 10px; padding: 7px 10px; border-radius: 8px; background: rgba(125,211,252,0.06); border: 1px solid rgba(125,211,252,0.18); color: #c9d4e5; line-height: 1.5; }
.qr { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; color: #a9b6c9; font-size: 12px; }
.qr .k { color: #8394ad; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; margin-right: 2px; }
.qr .xp { color: #7dd3fc; font-weight: 600; }
.qr .cr { color: #ffd166; font-weight: 600; }
.qr .pl { color: #fbbf24; font-weight: 600; }
.qr .rc { color: #a5f3a1; }
.qr .li { color: #f0abfc; font-weight: 600; }
.qr .rp { color: #9fb3cc; }

.qb { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.qb-card { background: rgba(4, 8, 16, 0.4); border: 1px solid rgba(140, 170, 220, 0.14); border-top: 2px solid var(--qc); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.qb-card h5 { margin: 0; font: 600 14px 'Segoe UI', sans-serif; color: #fff; display: flex; gap: 8px; align-items: baseline; }
.qb-card h5 .c { font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.5px; color: var(--qc); text-transform: uppercase; }
.qb-card h5 .lv { margin-left: auto; color: #8394ad; font-weight: 400; font-size: 11px; }
.qb-card .who { color: #8394ad; font-size: 11px; margin-top: -4px; }
.qb-card .intro { color: #a9b6c9; line-height: 1.5; font-size: 12px; max-height: 5.4em; overflow: hidden; position: relative; }
.qb-card .intro.open { max-height: none; }
.qb-card ol { margin: 0; padding-left: 18px; color: #c9d4e5; line-height: 1.55; }
.qb-card .row { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.qb-card .row .sp { flex: 1; }
.qb-lock { color: #56657c; font-size: 12px; padding: 4px 2px; }

.ql { display: grid; grid-template-columns: 300px 1fr; gap: 14px; min-height: 360px; }
.ql-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.ql-item { all: unset; cursor: pointer; display: block; padding: 8px 10px; border-radius: 9px; border: 1px solid rgba(140,170,220,0.12); border-left: 3px solid var(--qc); background: rgba(4,8,16,0.35); }
.ql-item:hover { background: rgba(125,211,252,0.06); }
.ql-item.on { background: rgba(125,211,252,0.1); border-color: rgba(125,211,252,0.35); border-left-color: var(--qc); }
.ql-item .n { color: #e5ecf7; font-weight: 600; }
.ql-item .s { color: #8394ad; font-size: 11px; margin-top: 2px; }
.ql-det h3 { margin: 0 0 2px; font: 600 18px 'Segoe UI', sans-serif; color: #fff; }
.ql-det .who { color: #8394ad; margin-bottom: 10px; }
.ql-det .intro { line-height: 1.6; color: #a9b6c9; margin-bottom: 12px; }
.ql-steps { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ql-steps li { display: flex; gap: 8px; align-items: baseline; color: #56657c; }
.ql-steps li.now { color: #e5ecf7; }
.ql-steps li.done { color: #6b8f74; text-decoration: line-through; text-decoration-color: rgba(107,143,116,0.5); }
.ql-steps .m { width: 16px; flex: none; text-align: center; }
.ql-steps .p { margin-left: auto; color: #8394ad; font-variant-numeric: tabular-nums; }

.sk { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.sk-c { background: rgba(4,8,16,0.4); border: 1px solid rgba(140,170,220,0.14); border-radius: 12px; padding: 12px 14px; }
.sk-c h5 { margin: 0 0 4px; font: 600 14px 'Segoe UI', sans-serif; color: #fff; display: flex; align-items: center; }
.sk-c h5 span { margin-left: auto; color: #7dd3fc; font-size: 12px; }
.sk-c .per { color: #8394ad; font-size: 12px; margin-bottom: 8px; }
.sk-pips { display: flex; gap: 3px; align-items: center; }
.sk-pips i { flex: 1 1 0; min-width: 5px; max-width: 16px; height: 6px; border-radius: 2px; background: rgba(255,255,255,0.08); }
.sk-pips i.on { background: linear-gradient(90deg, #2c87ad, #7dd3fc); box-shadow: 0 0 6px rgba(125,211,252,0.5); }
.sk-pips .sgw-btn { margin-left: auto; padding: 3px 10px; }
.cx-src { font-variant: small-caps; letter-spacing: 1px; color: #8394ad; margin-bottom: 12px; }
.cx-body { white-space: pre-line; line-height: 1.65; color: #c9d4e5; max-width: 620px; }
.rep { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
.rep-r .n { display: flex; justify-content: space-between; color: #e5ecf7; font-weight: 600; }
.rep-r .n span { color: #8394ad; font-weight: 400; }
.rep-r .d { color: #8394ad; font-size: 12px; margin: 2px 0 4px; }
`;
  document.head.appendChild(css);
}

/** The rewards line: XP, credits, items, plans, licences, standing */
export function rewardsHtml(pilot: PilotState, r: RewardView): string {
  const parts: string[] = ['<span class="k">REWARD</span>'];
  if (r.xp) parts.push(`<span class="xp">${r.xp.toLocaleString()} XP</span>`);
  if (r.credits) parts.push(`<span class="cr">${r.credits.toLocaleString()} cr</span>`);
  if (Object.keys(r.items).length) parts.push(costHtml(pilot.econ, r.items));
  for (const p of r.plans) parts.push(`<span class="pl">◆ Ship plan: ${esc(p)}</span>`);
  for (const p of r.recipes) parts.push(`<span class="rc">⚙ ${esc(p)}</span>`);
  for (const p of r.licences) parts.push(`<span class="li">⬡ ${esc(p)}</span>`);
  if (r.skillPoints) parts.push(`<span class="xp">+${r.skillPoints} skill point${r.skillPoints > 1 ? 's' : ''}</span>`);
  for (const [f, n] of Object.entries(r.reputation)) parts.push(`<span class="rp">+${n} ${esc(f)}</span>`);
  return `<div class="qr">${parts.join('')}</div>`;
}

function stepProgress(q: QuestView): { text: string; frac: number; count: string } {
  const s = q.steps[q.stage];
  if (!s) return { text: 'Complete', frac: 1, count: '' };
  const count = s.need > 1 ? `${Math.min(q.progress, s.need).toLocaleString()} / ${s.need.toLocaleString()}` : '';
  return { text: s.text, frac: s.need > 1 ? q.progress / s.need : 0, count };
}

// ---------------------------------------------------------------------------

export class QuestClient {
  active: QuestView[] = [];
  done = 0;
  /** Jobs heard about but not taken, and those finished */
  leads: QuestLead[] = [];
  /** Jobs not yet found, by system */
  hidden?: Record<string, number>;
  finished: { id: string; name: string; chain: string; outro?: string }[] = [];
  /** Everyone, where they are and whether they want you (the server's `people`) */
  people: PersonView[] = [];
  reputation: Record<string, number> = {};
  reputations: Record<string, { name: string; description: string; vendor?: VendorDef }> = {};
  board: ServerQuestBoardMessage | null = null;
  /** The job (or lead) the marker and the guide follow */
  tracked: string | null = null;
  /** The tracker's autopilot button (Game flies to the followed job) */
  onAutopilot: (() => void) | null = null;
  /** Ribbon progress and the rankings (asked for when their tabs open) */
  ribbons: ServerRibbonsMessage | null = null;
  rankings: ServerRankingsMessage | null = null;

  /** Records found (the server's `codex`: never the ones still to find), in the order found, and those not opened yet */
  codex: CodexView[] = [];
  codexFresh = new Set<string>();

  setRibbons(m: ServerRibbonsMessage): void { this.ribbons = m; this.log.refresh(); }
  setRankings(m: ServerRankingsMessage): void { this.rankings = m; this.log.refresh(); }
  /** The boards, from the lobby (every server's pilots ranked together); the last ones stay up if it can't be reached */
  async loadRankings(): Promise<void> {
    const m = await fetchRankings();
    if (m) this.setRankings(m);
    else if (!this.rankings) { this.rankingsDown = true; this.log.refresh(); }
  }
  rankingsDown = false;
  private listeners = new Set<() => void>();
  private tracker: QuestTracker;
  readonly log: QuestLogWindow;

  constructor(readonly d: QuestDeps) {
    injectQuestStyles();
    try { this.tracked = localStorage.getItem('sg.trackedQuest'); } catch { /* private window */ }
    this.tracker = new QuestTracker(this);
    this.log = new QuestLogWindow(this);
    d.pilot.onChange(() => this.log.refresh());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
    this.tracker.render();
    this.log.refresh();
  }

  setQuests(m: ServerQuestsMessage): void {
    const before = new Map(this.active.map((q) => [q.id, `${q.stage}:${q.progress}`]));
    this.active = m.active;
    this.done = m.done;
    this.leads = m.leads ?? [];
    this.hidden = m.hidden;
    this.finished = m.finished ?? [];
    this.reputation = m.reputation;
    this.reputations = m.reputations;
    if (this.tracked && !this.active.some((q) => q.id === this.tracked) && !this.leads.some((l) => l.id === this.tracked)) this.tracked = null;
    const moved = this.active.filter((q) => before.has(q.id) && before.get(q.id) !== `${q.stage}:${q.progress}`).map((q) => q.id);
    // A job just taken (none followed): follow it
    const fresh = this.active.find((q) => !before.has(q.id));
    if (fresh && (!this.tracked || fresh.chain === 'main')) this.tracked = fresh.id;
    this.emit();
    for (const id of moved) this.tracker.bump(id);
  }

  setPeople(people: PersonView[]): void {
    this.people = people;
    this.emit();
  }

  setBoard(m: ServerQuestBoardMessage): void {
    this.board = m;
    this.emit();
  }

  setCodex(m: ServerCodexMessage): void {
    if (m.all) this.codex = m.entries;
    else for (const e of m.entries) if (!this.codex.some((x) => x.id === e.id)) this.codex.push(e);
    this.codexFresh = new Set(m.fresh);
    this.log.refresh();
  }

  /** A record was opened: no longer new */
  readRecord(id: string): void {
    if (this.codexFresh.delete(id)) this.d.send({ type: 'codexRead', id });
  }

  /** Leads that joined the log since it was last looked at */
  freshCount(): number {
    return this.leads.filter((l) => l.fresh).length;
  }

  /** The log is open on the quests: what's new has been seen */
  markSeen(): void {
    if (this.freshCount()) this.d.send({ type: 'questSeen' });
  }

  stepDone(text: string): void {
    this.d.sound('scan_ping', 0.35);
    void text;
  }

  track(id: string | null): void {
    this.tracked = id;
    try { if (id) localStorage.setItem('sg.trackedQuest', id); else localStorage.removeItem('sg.trackedQuest'); } catch { /* ignore */ }
    this.emit();
  }

  /** The job the objective marker follows (none while a lead is followed) */
  current(): QuestView | null {
    if (this.trackedLead()) return null;
    return this.active.find((q) => q.id === this.tracked) ?? this.active[0] ?? null;
  }

  /** The lead being followed (to its person), if one is */
  trackedLead(): QuestLead | null {
    return this.leads.find((l) => l.id === this.tracked) ?? null;
  }

  /** Where in the UI the followed job's current step happens */
  currentHint(): string | undefined {
    const q = this.current();
    return q?.steps[q.stage]?.hint;
  }

  objective(): QuestTarget | null {
    return this.trackedLead()?.target ?? this.current()?.target ?? null;
  }

  /** The guide's line (the next waypoint and how far), written every frame */
  setGuide(text: string): void {
    this.tracker.setGuide(text);
  }

  /** People docked at a station */
  peopleAt(stationId: string): PersonView[] {
    return this.people.filter((p) => p.stationId === stationId);
  }

  talk(person: string): void {
    this.d.send({ type: 'talk', person });
  }

  show(): void { this.tracker.show(); }
  /** Off screen: the tracker hides */
  hide(): void { this.tracker.hide(); }

  accept(id: string): void {
    this.d.send({ type: 'questAccept', id });
    this.d.sound('ui_open', 0.6);
  }

  abandon(id: string): void {
    this.d.send({ type: 'questAbandon', id });
  }

  /** The contracts tab of the station window: bounties and fleet ops (people's jobs are theirs to offer) */
  renderBoard(el: HTMLElement): void {
    const b = this.board;
    el.replaceChildren();
    if (!b) { el.innerHTML = '<div class="sgw-empty">Reading the board…</div>'; return; }
    const here = this.active.filter((q) => q.giver === b.station && !q.person);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
    const mins = Math.max(1, Math.round(b.refreshIn / 60000));
    const people = this.peopleAt(b.station);
    wrap.innerHTML = `<div style="color:#8394ad">Contracts posted at ${esc(b.stationName)}. They change in ${mins} min. You hold ${this.active.length} job${this.active.length === 1 ? '' : 's'}.`
      + (people.length ? ` People here have their own work: ${people.map((p) => `<b style="color:${p.color}">${esc(p.name)}${p.mark ? ' !' : ''}</b>`).join(', ')} (Overview, People).` : '') + '</div>';
    const grid = document.createElement('div');
    grid.className = 'qb';
    if (!b.offers.length && !here.length) grid.innerHTML = '<div class="sgw-empty">Nothing posted here for you right now.</div>';
    for (const q of b.offers) grid.appendChild(this.card(q, false));
    for (const q of here) grid.appendChild(this.card(q, true));
    wrap.appendChild(grid);
    if (b.locked.length) {
      const lk = document.createElement('div');
      lk.innerHTML = '<h4 style="margin:0 0 4px; font:700 11px Segoe UI; letter-spacing:2.5px; color:#7dd3fc">COMING UP</h4>'
        + b.locked.map((l) => `<div class="qb-lock"><span style="color:${chainOf(l.chain).color}">●</span> ${esc(l.name)} · needs pilot level ${l.level}</div>`).join('');
      wrap.appendChild(lk);
    }
    el.appendChild(wrap);
  }

  private card(q: QuestView, mine: boolean): HTMLElement {
    const c = document.createElement('div');
    c.className = 'qb-card';
    const ch = chainOf(q.chain);
    c.style.setProperty('--qc', ch.color);
    c.innerHTML = `<h5><span class="c">${ch.label}</span>${esc(q.name)}<span class="lv">${q.level > 1 ? `lvl ${q.level}` : ''}</span></h5>
      <div class="who">${esc(q.npc ?? q.giverName)}${q.chain === 'fleet' ? ` · <b style="color:#86efac">needs a party of 2+ (${esc(keyOf('party'))})</b>` : ''}</div>
      <div class="intro">${esc(q.intro)}</div>
      <ol>${q.steps.map((s, i) => `<li style="${mine && i < q.stage ? 'color:#6b8f74;text-decoration:line-through' : ''}">${esc(s.text)}</li>`).join('')}</ol>
      ${rewardsHtml(this.d.pilot, q.rewards)}
      <div class="row"><span class="sp"></span></div>`;
    const intro = c.querySelector('.intro') as HTMLElement;
    intro.onclick = () => intro.classList.toggle('open');
    intro.title = 'Click to read it all';
    const row = c.querySelector('.row')!;
    const btn = document.createElement('button');
    if (mine) {
      btn.className = 'sgw-btn off';
      btn.textContent = 'In progress';
    } else {
      btn.className = 'sgw-btn primary';
      btn.textContent = q.chain === 'fleet' ? 'Accept for the party' : 'Accept';
      btn.onclick = () => this.accept(q.id);
    }
    row.appendChild(btn);
    return c;
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

class QuestTracker {
  private root: HTMLDivElement;
  private visible = false;
  private collapsed = false;
  private guideEl: HTMLElement | null = null;

  constructor(private q: QuestClient) {
    this.root = document.createElement('div');
    this.root.className = 'qt';
    this.root.dataset.hudAvoid = '1';
    document.body.appendChild(this.root);
    settings.subscribe(() => this.render());
  }

  show(): void { this.visible = true; this.render(); }
  hide(): void { this.visible = false; this.root.style.display = 'none'; }

  bump(id: string): void {
    const el = this.root.querySelector(`[data-q="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.remove('bump');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('bump');
  }

  setGuide(text: string): void {
    if (!this.guideEl) return;
    setText(this.guideEl, text);
    setStyle(this.guideEl, 'display', text ? 'block' : 'none');
  }

  render(): void {
    if (!this.visible) return;
    const list = this.q.active;
    const lead = this.q.trackedLead();
    this.guideEl = null;
    const fresh = this.q.freshCount();
    const newHtml = fresh ? `<span class="qt-new" data-a="new" title="New work in your log">● ${fresh} NEW</span>` : '';
    this.root.style.display = list.length || lead || fresh ? 'flex' : 'none';
    if (!list.length && !lead && !fresh) return;
    // Hidden: just the header, to bring it back
    if (!settings.data.ui.questTracker) {
      this.root.innerHTML = `<div class="qt-head"><span>QUESTS · ${esc(keyOf('log'))}</span>${newHtml}<button data-a="show" title="Show the quest tracker">SHOW</button></div>`;
      (this.root.querySelector('[data-a="show"]') as HTMLElement).onclick = () => settings.update((d) => { d.ui.questTracker = true; });
      this.root.querySelector<HTMLElement>('[data-a="new"]')?.addEventListener('click', () => this.q.log.open('jobs'));
      return;
    }
    const cur = this.q.current();
    const shown = this.collapsed ? (cur ? [cur] : []) : [cur, ...list.filter((x) => x !== cur)].filter((x): x is QuestView => !!x).slice(0, lead ? 3 : 4);
    const guide = settings.data.ui.questGuide ? '<div class="qt-g" style="display:none"></div>' : '';
    const leadHtml = lead ? (() => {
      const ch = chainOf(lead.chain);
      return `<div class="qt-q tracked" data-lead="${esc(lead.id)}" style="--qc:${ch.color}" title="A lead you're following: right-click for the log">
        <div class="qt-n"><span class="c">Lead</span><span class="t">${esc(lead.name)}</span></div>
        <div class="qt-s">▸ ${lead.state === 'locked' ? `Needs ${esc(lead.needs.join(', '))}` : `Talk to <b>${esc(lead.who)}</b> · ${esc(lead.where)}`}${lead.target ? ` <button class="qt-ap" title="Autopilot there (${esc(keyOf('autopilot'))})">▶ ${esc(keyOf('autopilot'))}</button>` : ''}</div>
        ${guide}</div>`;
    })() : '';
    this.root.innerHTML = `<div class="qt-head"><span>QUESTS · ${esc(keyOf('log'))}</span>${newHtml}<button data-a="fold">${this.collapsed ? 'SHOW ALL' : 'FOLD'}</button><button data-a="hide" title="Hide the tracker (Settings › Interface brings it back too)">HIDE</button></div>`
      + leadHtml
      + shown.map((x) => {
        const ch = chainOf(x.chain);
        const p = stepProgress(x);
        return `<div class="qt-q${x === cur ? ' tracked' : ''}" data-q="${esc(x.id)}" style="--qc:${ch.color}" title="Click to follow this job">
          <div class="qt-n"><span class="c">${ch.label}</span><span class="t">${esc(x.name)}</span></div>
          <div class="qt-s">${x === cur ? '▸ ' : ''}${esc(p.text)}${p.count ? ` <b>${p.count}</b>` : ''}${x === cur && x.target ? ` <button class="qt-ap" title="Autopilot there (${esc(keyOf('autopilot'))})">▶ ${esc(keyOf('autopilot'))}</button>` : ''}</div>
          ${p.frac > 0 || p.count ? `<div class="qt-bar"><i style="width:${Math.min(100, p.frac * 100)}%"></i></div>` : ''}
          ${x === cur ? guide : ''}
        </div>`;
      }).join('')
      + (list.length > shown.length ? `<div class="qt-more">+${list.length - shown.length} more · L for the log</div>` : '');
    this.guideEl = this.root.querySelector('.qt-g');
    (this.root.querySelector('[data-a="fold"]') as HTMLElement).onclick = () => { this.collapsed = !this.collapsed; this.render(); };
    (this.root.querySelector('[data-a="hide"]') as HTMLElement).onclick = () => settings.update((d) => { d.ui.questTracker = false; });
    this.root.querySelector<HTMLElement>('.qt-ap')?.addEventListener('click', (e) => { e.stopPropagation(); this.q.onAutopilot?.(); });
    this.root.querySelectorAll<HTMLElement>('.qt-q[data-q]').forEach((el) => {
      el.onclick = () => { this.q.track(el.dataset.q!); this.q.d.sound('ui_click', 0.4); };
      el.oncontextmenu = (e) => { e.preventDefault(); this.q.log.open('jobs', el.dataset.q); };
    });
    this.root.querySelector<HTMLElement>('.qt-q[data-lead]')?.addEventListener('contextmenu', (e) => { e.preventDefault(); this.q.log.open('jobs', lead!.id); });
    this.root.querySelector<HTMLElement>('.qt-more')?.addEventListener('click', () => this.q.log.open('jobs'));
    this.root.querySelector<HTMLElement>('[data-a="new"]')?.addEventListener('click', () => this.q.log.open('jobs'));
  }
}

// ---------------------------------------------------------------------------
// Pilot log (L): jobs, skills, standing
// ---------------------------------------------------------------------------

type LogTab = 'jobs' | 'records' | 'skills' | 'standing' | 'ribbons' | 'rankings';

const RIBBONS = (ribbonsData as unknown as RibbonsFile).ribbons;

class QuestLogWindow {
  private win = new GameWindow('Pilot log');
  private tab: LogTab = 'jobs';
  private sel: string | null = null;
  /** The record open in the Records tab */
  private recSel: string | null = null;
  /** Asked "really abandon?" about this job (kept across re-renders) */
  private sure: string | null = null;
  private tabEls = new Map<LogTab, HTMLButtonElement>();
  /** Leads that were new when the log opened (still tagged until it closes) */
  private newIds = new Set<string>();

  constructor(private q: QuestClient) {
    this.win.tabs.style.display = 'flex';
    for (const [id, label] of [['jobs', 'Quests'], ['records', 'Records'], ['skills', 'Skills'], ['standing', 'Standing'], ['ribbons', 'Ribbons'], ['rankings', 'Rankings']] as [LogTab, string][]) {
      const b = document.createElement('button');
      b.className = 'sgw-tab';
      b.textContent = label;
      b.onclick = () => { this.tab = id; this.ask(); this.render(); q.d.sound('ui_click', 0.4); };
      this.tabEls.set(id, b);
      this.win.tabs.appendChild(b);
    }
    this.win.onClose = () => this.newIds.clear();
  }

  get isOpen(): boolean { return this.win.isOpen; }

  /** Ribbons come from the game server and rankings from the lobby when their tabs open */
  private ask(): void {
    if (this.tab === 'ribbons') this.q.d.send({ type: 'ribbons' });
    if (this.tab === 'rankings') void this.q.loadRankings();
  }

  open(tab: LogTab = this.tab, select?: string): void {
    this.tab = tab;
    this.ask();
    if (select) this.sel = select;
    this.win.open();
    this.q.d.sound('ui_open', 0.6);
    this.render();
  }

  close(): void {
    if (this.win.isOpen) this.q.d.sound('ui_close', 0.5);
    this.win.close();
  }

  toggle(tab: LogTab): void {
    if (this.win.isOpen && this.tab === tab) this.close();
    else this.open(tab);
  }

  refresh(): void {
    if (this.win.isOpen) this.render();
  }

  private render(): void {
    const prof = this.q.d.pilot.profile;
    for (const [id, el] of this.tabEls) {
      el.classList.toggle('on', id === this.tab);
      if (id === 'skills') el.innerHTML = `Skills${prof?.skillPoints ? `<span class="badge">${prof.skillPoints}</span>` : ''}`;
      if (id === 'jobs') {
        const fresh = this.q.freshCount();
        el.innerHTML = `Quests${fresh ? `<span class="badge" style="background:#a16207" title="New work">${fresh} new</span>` : this.q.active.length ? `<span class="badge">${this.q.active.length}</span>` : ''}`;
      }
      if (id === 'records') {
        const fresh = this.q.codexFresh.size;
        el.innerHTML = `Records${fresh ? `<span class="badge" style="background:#a16207" title="Not read yet">${fresh} new</span>` : ''}`;
      }
    }
    this.win.sub.textContent = prof ? `Level ${prof.level} · ${this.q.done} job${this.q.done === 1 ? '' : 's'} done · ${this.q.leads.length} lead${this.q.leads.length === 1 ? '' : 's'}` : '';
    const b = this.win.body;
    b.replaceChildren();
    if (this.tab === 'jobs') this.renderJobs(b);
    else if (this.tab === 'records') this.renderRecords(b);
    else if (this.tab === 'skills') this.renderSkills(b);
    else if (this.tab === 'ribbons') this.renderRibbons(b);
    else if (this.tab === 'rankings') this.renderRankings(b);
    else this.renderStanding(b);
  }

  private renderRibbons(b: HTMLElement): void {
    const prog = new Map((this.q.ribbons?.progress ?? []).map((p) => [p.id, p]));
    const earned = RIBBONS.filter((r) => prog.get(r.id)?.earned).length;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div style="color:#8394ad; margin-bottom:10px">${earned} of ${RIBBONS.length} ribbons. Each pays out the moment you earn it; rare ones (★) are announced to the whole galaxy.</div>`;
    const grid = document.createElement('div');
    grid.className = 'rib-grid';
    for (const r of RIBBONS) {
      const p = prog.get(r.id);
      const done = !!p?.earned;
      const pct = Math.min(100, ((p?.value ?? 0) / r.at) * 100);
      const reward = [r.reward.credits ? `${r.reward.credits.toLocaleString()} cr` : '', r.reward.xp ? `${r.reward.xp.toLocaleString()} XP` : ''].filter(Boolean).join(' · ');
      const c = document.createElement('div');
      c.className = `rib${done ? ' done' : ''}${r.rare ? ' rare' : ''}`;
      c.innerHTML = `<div class="ic">${r.icon}</div><div class="tx"><div class="n">${esc(r.name)}${r.rare ? ' <span class="st">★</span>' : ''}</div>
        <div class="d">${esc(r.description)}</div>
        ${done ? `<div class="ok">Earned${reward ? ` · ${reward}` : ''}</div>` : `<div class="sgw-bar" style="margin:4px 0 2px"><i style="width:${pct}%"></i></div><div class="d">${Math.floor(p?.value ?? 0).toLocaleString()} / ${r.at.toLocaleString()}${reward ? ` · ${reward}` : ''}</div>`}</div>`;
      grid.appendChild(c);
    }
    wrap.appendChild(grid);
    b.appendChild(wrap);
  }

  private renderRankings(b: HTMLElement): void {
    const m = this.q.rankings;
    if (!m) { b.innerHTML = `<div class="sgw-empty">${this.q.rankingsDown ? "Can't reach the rankings right now." : 'Fetching the rankings…'}</div>`; return; }
    const days = Math.floor(m.weekEndsIn / 86_400_000), hours = Math.floor((m.weekEndsIn % 86_400_000) / 3_600_000);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div style="color:#8394ad; margin-bottom:10px">Registered pilots only. The weekly boards reset in ${days}d ${hours}h.</div>`;
    const grid = document.createElement('div');
    grid.className = 'rank-grid';
    const list = (rows: { name: string; value: number }[]) => rows.length
      ? rows.map((r, i) => `<div class="rr"><span class="p">${i + 1}</span><span class="nm">${esc(r.name)}</span><b>${r.value.toLocaleString()}</b></div>`).join('')
      : '<div class="sgw-empty" style="padding:4px 0">Nobody yet</div>';
    for (const bd of m.boards) {
      const c = document.createElement('div');
      c.className = 'sgw-col';
      const you = bd.you;
      c.innerHTML = `<h4>${esc(bd.label)}</h4>
        <div class="rank-cols"><div><div class="rh">This week</div>${list(bd.weekly)}</div><div><div class="rh">All time</div>${list(bd.allTime)}</div></div>
        ${you ? `<div class="ry">You: ${you.weeklyRank ? `#${you.weeklyRank} this week (${you.weekly.toLocaleString()})` : 'unranked this week'} · ${you.allTimeRank ? `#${you.allTimeRank} all time` : 'unranked all time'}</div>` : '<div class="ry">Register an account to be ranked</div>'}`;
      grid.appendChild(c);
    }
    wrap.appendChild(grid);
    b.appendChild(wrap);
  }

  private renderJobs(b: HTMLElement): void {
    const list = this.q.active, leads = this.q.leads, finished = this.q.finished;
    for (const l of leads) if (l.fresh) this.newIds.add(l.id);
    this.q.markSeen();
    if (!list.length && !leads.length && !finished.length) {
      b.innerHTML = `<div class="sgw-empty">No jobs yet. Talk to people (docked: the station's Overview; out in space: fly close and press ${esc(keyOf('interact'))}), or check a station's Contracts.</div>`;
      return;
    }
    const all = new Set([...list.map((x) => x.id), ...leads.map((x) => x.id), ...finished.map((x) => x.id)]);
    if (!this.sel || !all.has(this.sel)) this.sel = this.q.current()?.id ?? this.q.trackedLead()?.id ?? list[0]?.id ?? leads[0]?.id ?? finished[0]?.id ?? null;
    const wrap = document.createElement('div');
    wrap.className = 'ql';
    const left = document.createElement('div');
    left.className = 'ql-list';
    const head = (t: string, n: number) => {
      const h = document.createElement('div');
      h.className = 'ql-h';
      h.textContent = `${t} · ${n}`;
      left.appendChild(h);
    };
    const item = (id: string, chain: string, name: string, sub: string, cls = '') => {
      const ch = chainOf(chain);
      const it = document.createElement('button');
      it.className = `ql-item${id === this.sel ? ' on' : ''}${cls ? ` ${cls}` : ''}`;
      it.style.setProperty('--qc', ch.color);
      it.innerHTML = `<div class="n">${id === this.q.tracked ? '▸ ' : ''}${esc(name)}${this.newIds.has(id) && cls !== 'fin' && !list.some((x) => x.id === id) ? '<span class="new">NEW</span>' : ''}</div><div class="s">${esc(sub)}</div>`;
      it.onclick = () => { this.sel = id; this.sure = null; this.render(); };
      left.appendChild(it);
    };
    head('In progress', list.length);
    if (!list.length) left.insertAdjacentHTML('beforeend', '<div class="ql-none">None. Pick a lead below.</div>');
    for (const x of list) item(x.id, x.chain, x.name, `${chainOf(x.chain).label} · ${stepProgress(x).text}`);
    head('Leads', leads.length);
    if (!leads.length) left.insertAdjacentHTML('beforeend', '<div class="ql-none">Talk to people to hear about work.</div>');
    for (const l of leads) item(l.id, l.chain, l.name, l.state === 'rumour' ? 'A rumour, so far' : l.state === 'locked' ? `Needs ${l.needs.join(', ')}` : `${l.who} · ${l.where}`, l.state === 'locked' || l.state === 'rumour' ? 'lock' : 'lead');
    const hidden = Object.entries(this.q.hidden ?? {});
    if (hidden.length) left.insertAdjacentHTML('beforeend', `<div class="ql-none" style="line-height:1.6">${hidden.map(([sys, n]) => `${esc(sys)}: ${n} job${n === 1 ? '' : 's'} not yet found`).join('<br>')}</div>`);
    if (finished.length) {
      head('Completed', finished.length);
      for (const f of [...finished].reverse()) item(f.id, f.chain, f.name, `${chainOf(f.chain).label} · done`, 'fin');
    }
    const det = document.createElement('div');
    det.className = 'sgw-col ql-det';
    const x = list.find((y) => y.id === this.sel);
    const l = !x ? leads.find((y) => y.id === this.sel) : undefined;
    const f = !x && !l ? finished.find((y) => y.id === this.sel) : undefined;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; margin-top:16px;';
    row.innerHTML = '<span style="flex:1"></span>';
    const follow = (id: string, can: boolean) => {
      if (!can) return;
      const btn = document.createElement('button');
      btn.className = 'sgw-btn' + (id === this.q.tracked ? ' off' : ' primary');
      btn.textContent = id === this.q.tracked ? 'Following' : 'Follow';
      btn.title = `The marker, the guide and the autopilot (${keyOf('autopilot')}) take you there`;
      btn.onclick = () => this.q.track(id);
      row.appendChild(btn);
    };
    if (x) {
      const ch = chainOf(x.chain);
      det.style.borderTop = `2px solid ${ch.color}`;
      det.innerHTML = `<h3>${esc(x.name)}</h3>
        <div class="who"><span style="color:${ch.color}">${ch.label}</span> · ${esc(x.person ?? x.npc ?? x.giverName)}${x.where || x.giverName ? ` · ${esc(x.where ?? x.giverName)}` : ''}</div>
        <div class="intro">${esc(x.intro)}</div>
        <ul class="ql-steps">${x.steps.map((s, i) => {
          const st = i < x.stage ? 'done' : i === x.stage ? 'now' : '';
          const mark = i < x.stage ? '✓' : i === x.stage ? '▸' : '·';
          const p = i === x.stage && s.need > 1 ? `${Math.min(x.progress, s.need).toLocaleString()} / ${s.need.toLocaleString()}` : '';
          return `<li class="${st}"><span class="m">${mark}</span><span>${esc(s.text)}</span><span class="p">${p}</span></li>`;
        }).join('')}</ul>
        ${rewardsHtml(this.q.d.pilot, x.rewards)}`;
      follow(x.id, true);
      const ab = document.createElement('button');
      ab.className = 'sgw-btn';
      ab.style.color = '#fca5a5';
      ab.textContent = this.sure === x.id ? 'Really abandon?' : 'Abandon';
      ab.title = x.person ? `${x.person} will offer it again` : x.chain === 'fleet' ? 'Led by you: called off for the whole party. Otherwise you leave and the party carries on' : '';
      ab.onclick = () => {
        if (this.sure === x.id) { this.sure = null; this.q.abandon(x.id); return; }
        this.sure = x.id;
        this.render();
      };
      row.appendChild(ab);
    } else if (l) {
      const ch = chainOf(l.chain);
      det.style.borderTop = `2px solid ${ch.color}`;
      if (l.state === 'rumour') {
        det.innerHTML = `<h3>${esc(l.name)}</h3><div class="who"><span style="color:${ch.color}">${ch.label}</span> · a rumour</div><div class="intro">${esc(l.intro)}</div><div class="ql-where">Nobody's offered it yet. Do the right thing in the right place, and it'll find you.</div>`;
        det.appendChild(row);
        wrap.append(left, det);
        b.appendChild(wrap);
        return;
      }
      det.innerHTML = `<h3>${esc(l.name)}</h3>
        <div class="who"><span style="color:${ch.color}">${ch.label}</span> · lead${l.level > 1 ? ` · level ${l.level}` : ''}</div>
        <div class="ql-where">${l.state === 'locked'
          ? `<b style="color:#fbbf24">Not yet:</b> needs ${esc(l.needs.join(', '))}. Then ask <b>${esc(l.who)}</b> (${esc(l.where)}).`
          : `Ask <b>${esc(l.who)}</b> about it: ${esc(l.where)}.`}</div>
        <div class="intro">${esc(l.intro)}</div>
        ${rewardsHtml(this.q.d.pilot, l.rewards)}`;
      follow(l.id, !!l.target);
    } else if (f) {
      const ch = chainOf(f.chain);
      det.style.borderTop = `2px solid ${ch.color}`;
      det.innerHTML = `<h3>${esc(f.name)}</h3><div class="who"><span style="color:${ch.color}">${ch.label}</span> · completed</div>${f.outro ? `<div class="ql-outro">${esc(f.outro)}</div>` : ''}`;
    }
    det.appendChild(row);
    wrap.append(left, det);
    b.appendChild(wrap);
  }

  /** Records found, by group (each group counts only what's found: never how many there are) */
  private renderRecords(b: HTMLElement): void {
    const all = this.q.codex;
    if (!all.length) {
      b.innerHTML = '<div class="sgw-empty">No records yet. Logs, ledgers and what people tell you are kept here as you come across them.</div>';
      return;
    }
    if (!this.recSel || !all.some((e) => e.id === this.recSel)) this.recSel = all.find((e) => this.q.codexFresh.has(e.id))?.id ?? all[0].id;
    const wrap = document.createElement('div');
    wrap.className = 'ql';
    const left = document.createElement('div');
    left.className = 'ql-list';
    for (const tab of CODEX_TABS) {
      const here = all.filter((e) => e.tab === tab);
      const h = document.createElement('div');
      h.className = 'ql-h';
      h.textContent = `${CODEX_TAB_NAMES[tab]} · ${here.length}`;
      left.appendChild(h);
      for (const e of here) {
        const it = document.createElement('button');
        it.className = `ql-item${e.id === this.recSel ? ' on' : ''}`;
        it.style.setProperty('--qc', CODEX_COLOR[e.tab] ?? '#c9d4e5');
        it.innerHTML = `<div class="n">${esc(e.title)}${this.q.codexFresh.has(e.id) ? '<span class="new">NEW</span>' : ''}</div><div class="s">${esc(e.source)}</div>`;
        it.onclick = () => { this.recSel = e.id; this.render(); this.q.d.sound('ui_click', 0.4); };
        left.appendChild(it);
      }
    }
    const e = all.find((x) => x.id === this.recSel)!;
    const det = document.createElement('div');
    det.className = 'sgw-col ql-det';
    det.style.borderTop = `2px solid ${CODEX_COLOR[e.tab] ?? '#c9d4e5'}`;
    det.innerHTML = `<h3>${esc(e.title)}</h3><div class="cx-src">${esc(e.source)}</div><div class="cx-body">${esc(e.body)}</div>`;
    wrap.append(left, det);
    b.appendChild(wrap);
    // Opened: no longer new (its tag goes with the next render)
    this.q.readRecord(e.id);
  }

  private renderSkills(b: HTMLElement): void {
    const prof = this.q.d.pilot.profile;
    const pts = prof?.skillPoints ?? 0;
    const head = document.createElement('div');
    head.style.cssText = 'color:#a9b6c9; margin-bottom:12px;';
    head.innerHTML = pts ? `<b style="color:#7dd3fc">${pts} skill point${pts > 1 ? 's' : ''}</b> to spend. You earn one each level and from some jobs, until you hold ${SKILL_POINT_CAP} in all.` : `You earn a skill point each level, and from some jobs, until you hold ${SKILL_POINT_CAP} in all.`;
    b.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'sk';
    for (const [id, sk] of Object.entries(SKILLS)) {
      const lv = prof?.skills[id] ?? 0;
      const c = document.createElement('div');
      c.className = 'sk-c';
      // Each point is worth a little less than the last: what you have, and what the next one adds
      const pct = (v: number) => `${sk.sign === -1 ? '−' : '+'}${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
      const now = skillValue(id, lv), next = lv < sk.max ? skillValue(id, lv + 1) - now : 0;
      c.innerHTML = `<h5>${sk.name}<span>${lv} / ${sk.max}</span></h5><div class="per">${esc(sk.per)}: <b>${lv ? pct(now) : 'none yet'}</b>${next ? ` · next point ${pct(next)}` : ' · maxed'}</div>
        <div class="sk-pips">${Array.from({ length: sk.max }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div>`;
      const btn = document.createElement('button');
      btn.className = `sgw-btn${pts > 0 && lv < sk.max ? ' primary' : ' off'}`;
      btn.textContent = '+';
      btn.title = `Spend a skill point on ${sk.name}`;
      btn.onclick = () => { this.q.d.send({ type: 'skillUp', skill: id }); this.q.d.sound('craft_done', 0.5); };
      c.querySelector('.sk-pips')!.appendChild(btn);
      grid.appendChild(c);
    }
    b.appendChild(grid);
  }

  private renderStanding(b: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'rep';
    const reps = Object.entries(this.q.reputations);
    if (!reps.length) { b.innerHTML = '<div class="sgw-empty">No one knows your name yet.</div>'; return; }
    for (const [id, r] of reps) {
      const v = this.q.reputation[id] ?? 0;
      const rk = repRank(v);
      const from = REP_RANKS[Math.max(0, rk.rank)]?.at ?? 0;
      const pct = rk.next !== undefined ? ((v - from) / Math.max(1, rk.next - from)) * 100 : 100;
      const el = document.createElement('div');
      el.className = 'rep-r';
      el.innerHTML = `<div class="n">${esc(r.name)}<span>${rk.name} · ${v}${rk.next !== undefined ? ` / ${rk.next} for ${rk.nextName}` : ''}</span></div><div class="d">${esc(r.description)}${r.vendor ? ' Their quartermaster sells more, and cheaper, at every rank.' : ''}</div>
        <div class="sgw-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
      wrap.appendChild(el);
    }
    b.appendChild(wrap);
  }
}
