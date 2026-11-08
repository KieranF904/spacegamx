/**
 * The field machines' HUD: for the ship's fabricator and refiner, a switch, its tier, the job it is on and how far along
 * (from the machine's own predicted clock, never sent), why it is idle, and its two pickers (the fabricator's pack mode,
 * the refiner's recipe). It lives in the side panel's Fab tab (ui/hub/tabs/fabTab.ts), drawn while that tab is on show;
 * it never floats over the other panels. Its element is made on first use, so importing the feature touches no DOM.
 */
import { canRefine, jobFraction } from '@space-game/common';
import type { Bag, ClientMessage, Economy, MachineKind, MachineView, PackMode } from '@space-game/common';
import { fieldClient, machineJob, MACHINE_KINDS, type FieldClocks } from './fieldState';
import { machineName, machineStatus, packModeOf, PACK_MODE_LIST, PACK_MODE_TEXT } from './fieldText';
import type { FieldDeps } from './bridge';

const CSS = `
.fh { padding: 6px 4px 8px; color: #cfe0f5; font: 12px 'Segoe UI', system-ui, sans-serif; }
.fh-none { color: #8ea0bd; line-height: 1.45; }
.fh-row + .fh-row { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(125, 211, 252, 0.14); }
.fh-top { display: flex; align-items: center; gap: 6px; }
.fh-name { flex: 1; min-width: 0; font-weight: 600; letter-spacing: 0.3px; color: #e5ecf7; }
.fh-btn { cursor: pointer; border: 1px solid #2a3a5a; background: #14203a; color: #cfe0f5; border-radius: 5px; padding: 1px 8px; font: inherit; }
.fh-btn:hover { background: #1c2d52; }
.fh-btn.on { background: #14532d; border-color: #22c55e; color: #bbf7d0; }
.fh-btn.x { padding: 0 6px; color: #fca5a5; }
.fh-status { margin-top: 3px; color: #9fb0cc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fh-status.warn { color: #fcd34d; }
.fh-bar { height: 4px; border-radius: 2px; margin-top: 4px; background: rgba(125, 211, 252, 0.14); overflow: hidden; }
.fh-bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #38bdf8, #bae6fd); }
.fh-pick { margin-top: 5px; width: 100%; background: #101a30; color: #cfe0f5; border: 1px solid #2a3a5a; border-radius: 5px; padding: 2px 4px; font: inherit; color-scheme: dark; }
.fh-short { margin-top: 6px; color: #8ea0bd; font-size: 11px; line-height: 1.35; }
`;

interface Row {
  kind: MachineKind;
  root: HTMLDivElement;
  name: HTMLElement;
  toggle: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
  bar: HTMLElement;
  pick: HTMLSelectElement;
  /** What the row last showed (so a frame that changes nothing touches nothing) */
  shown: { name: string; on: boolean | null; status: string; warn: boolean; pct: number; job: number; pick: string; pickKey: string };
}

export class FieldHud {
  private root?: HTMLDivElement;
  private rows: Row[] = [];
  private shortEl?: HTMLElement;
  private shortText = '';
  private noneEl?: HTMLElement;
  /** The tab's body it is drawn in while the tab is on show (null: not on show: nothing is drawn) */
  private host: HTMLElement | null = null;

  constructor(private deps: FieldDeps) {}

  private make(): HTMLDivElement {
    if (!document.getElementById('fh-style')) {
      const s = document.createElement('style');
      s.id = 'fh-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.className = 'fh';
    root.dataset.hudAvoid = '1';
    // (The mouse is the panel's, not the guns')
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    for (const kind of MACHINE_KINDS) this.rows.push(this.makeRow(root, kind));
    this.shortEl = document.createElement('div');
    this.shortEl.className = 'fh-short';
    root.appendChild(this.shortEl);
    this.noneEl = document.createElement('div');
    this.noneEl.className = 'fh-none';
    root.appendChild(this.noneEl);
    return (this.root = root);
  }

  private makeRow(parent: HTMLElement, kind: MachineKind): Row {
    const root = document.createElement('div');
    root.className = 'fh-row';
    root.innerHTML = `<div class="fh-top"><span class="fh-name"></span><button class="fh-btn x" title="Call off this job" hidden>&times;</button><button class="fh-btn"></button></div>
      <div class="fh-status"></div><div class="fh-bar"><i></i></div><select class="fh-pick"></select>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const row: Row = {
      kind, root, name: q('.fh-name'), toggle: q<HTMLButtonElement>('.fh-btn:not(.x)'), cancel: q<HTMLButtonElement>('.fh-btn.x'),
      status: q('.fh-status'), bar: q('.fh-bar i'), pick: q<HTMLSelectElement>('.fh-pick'),
      shown: { name: '', on: null, status: '', warn: false, pct: -1, job: -2, pick: '', pickKey: '' },
    };
    row.toggle.addEventListener('click', () => {
      const m = fieldClient.machine(kind);
      this.deps.send({ type: 'machine', kind, on: !(m?.on ?? false) });
    });
    row.cancel.addEventListener('click', () => {
      const j = fieldClient.machine(kind)?.job;
      if (j) this.deps.send({ type: 'fieldCancel', kind, job: j.id });
    });
    row.pick.addEventListener('change', () => this.deps.send(pickMessage(kind, row.pick.value)));
    parent.appendChild(root);
    return row;
  }

  /** The refiner's recipe choices (refineChoices), the chosen one kept in the list even when this refiner can't run it, so the picker never shows a blank */
  private recipeOptions(m: MachineView): { value: string; label: string }[] {
    const out = [{ value: '', label: 'Refine: what the plan needs' }];
    const ids = refineChoices(this.deps.econ, m.tier, this.deps.level());
    for (const id of ids) out.push({ value: id, label: `Refine: ${this.name(id)}` });
    if (m.recipe && !ids.includes(m.recipe)) out.push({ value: m.recipe, label: `Refine: ${this.name(m.recipe)} (can't run)` });
    return out;
  }

  private name = (item: string): string => this.deps.econ.items.name(item);

  /** The Fab tab came on show: draw into its body */
  mountIn(body: HTMLElement): void {
    const root = this.root ?? this.make();
    this.host = body;
    body.appendChild(root);
    this.update();
  }

  /** The Fab tab left the screen */
  unmount(): void {
    this.host = null;
    this.root?.remove();
  }

  /** Once a frame (nothing to do unless the Fab tab is on show) */
  update(clocks: FieldClocks = this.deps.clocks()): void {
    if (!this.host || !this.root) return;
    const st = fieldClient.state;
    const none = !st ? 'No ship to show.' : '';
    if (this.noneEl!.textContent !== none) { this.noneEl!.textContent = none; this.noneEl!.style.display = none ? 'block' : 'none'; }
    if (!st) { for (const row of this.rows) row.root.style.display = 'none'; return; }
    for (const row of this.rows) this.updateRow(row, fieldClient.machine(row.kind), clocks);
    const need = shortLine(st.short, this.name);
    if (need !== this.shortText) {
      this.shortText = need;
      this.shortEl!.textContent = need;
      this.shortEl!.style.display = need ? 'block' : 'none';
    }
  }

  private updateRow(row: Row, m: MachineView | undefined, clocks: FieldClocks): void {
    row.root.style.display = m ? 'block' : 'none';
    if (!m) return;
    const s = row.shown;
    const job = machineJob(m, clocks);
    const name = machineName(m);
    if (name !== s.name) { s.name = name; row.name.textContent = name; }
    if (m.on !== s.on) {
      s.on = m.on;
      row.toggle.textContent = m.on ? 'On' : 'Off';
      row.toggle.classList.toggle('on', m.on);
    }
    const status = machineStatus(m, job, this.name);
    const warn = m.on && !!m.blocked && m.blocked !== 'idle';
    if (status !== s.status || warn !== s.warn) {
      s.status = status; s.warn = warn;
      row.status.textContent = status;
      row.status.classList.toggle('warn', warn);
    }
    const pct = job ? Math.floor(jobFraction(job) * 100) : 0;
    if (pct !== s.pct) { s.pct = pct; row.bar.style.width = `${pct}%`; }
    const jobId = m.job?.id ?? -1;
    if (jobId !== s.job) { s.job = jobId; row.cancel.hidden = jobId < 0; }
    // The picker: the fabricator's pack mode, the refiner's recipe (rebuilt only when what it offers changes)
    const key = m.kind === 'fabricator' ? 'packs' : `${m.tier}:${this.deps.level()}:${m.recipe ?? ''}`;
    if (key !== s.pickKey) {
      s.pickKey = key;
      const opts = m.kind === 'fabricator'
        ? PACK_MODE_LIST.map((v) => ({ value: v, label: PACK_MODE_TEXT[v] }))
        : this.recipeOptions(m);
      row.pick.innerHTML = '';
      for (const o of opts) {
        const el = document.createElement('option');
        el.value = o.value; el.textContent = o.label;
        row.pick.appendChild(el);
      }
      s.pick = '\0';
    }
    const want = m.kind === 'fabricator' ? packModeOf(m) : m.recipe ?? '';
    if (want !== s.pick && document.activeElement !== row.pick) { s.pick = want; row.pick.value = want; }
  }

  dispose(): void {
    this.root?.remove();
    this.root = undefined;
    this.rows = [];
    this.host = null;
  }
}

/** The recipes a refiner of this tier (0: the core) offers a pilot of this level: ones it can run, ones the pilot has opened */
export function refineChoices(econ: Economy, tier: number, level: number): string[] {
  const out: string[] = [];
  for (const [id, r] of econ.recipes.refining) if ((r.level ?? 0) <= level && canRefine(econ, tier, id)) out.push(id);
  return out;
}

/** The message a picker's choice sends */
export function pickMessage(kind: MachineKind, value: string): ClientMessage {
  return kind === 'fabricator'
    ? { type: 'machine', kind, packs: value as PackMode }
    : { type: 'machine', kind, recipe: value === '' ? null : value };
}

/** "Needs: 4 alloy plate, 2 copper wire" (the plan's shortfall), at most four items */
export function shortLine(short: Bag | undefined, name: (item: string) => string): string {
  const ids = Object.keys(short ?? {}).filter((id) => (short![id] ?? 0) > 0);
  if (!ids.length) return '';
  const shown = ids.slice(0, 4).map((id) => `${short![id]} ${name(id).toLowerCase()}`);
  return `Needs: ${shown.join(', ')}${ids.length > 4 ? ` and ${ids.length - 4} more` : ''}`;
}
