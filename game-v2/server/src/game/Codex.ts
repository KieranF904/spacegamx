/**
 * Records (data/codex.json, shapes in common/src/econ/codex.ts): lore found
 * as documents and testimony, kept in the pilot log's Records tab.
 *
 * A pilot finds a record five ways:
 *   - its `unlock` condition holds: checked twice a second, only for the
 *     records with one that they haven't found
 *   - someone hands it over in conversation (a { codex } line, People.ts)
 *   - a job pays it (`rewards.codex`, Quests.ts)
 *   - an item carrying it (items.json `codex`) comes into their hold or
 *     storage, however it was got (Pilots.give)
 *   - a derelict's log (systems.json `derelicts[].log`): flying within
 *     reading range of the hulk (host.wreckLogs, checked twice a second;
 *     a scan step's range is inside it, so a scan reads it too), or
 *     landing the salvage kill on it (GameServer)
 * Found records are saved in the profile (`codex.found`), marked new
 * (`codex.fresh`) until opened. The client is only ever sent the ones found:
 * on login all of them, then each as it turns up, with a toast. Each find
 * is written to telemetry once (`codex_<id>`), to see which hints players
 * notice.
 */

import { CodexEntry, CodexFile, CodexView, CondContext, ItemDef, PlayerProfile, ServerMessage, condHolds } from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';
import { texts, type StringsFile, type Texts } from '../data/rules.js';

export interface CodexHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  /** What conditions see of a pilot (People.ctx) */
  ctx(conn: PilotConn, p: PlayerProfile): CondContext;
  /** The records in the logs of derelicts the pilot is close enough to read (systems.json `derelicts[].log`) */
  wreckLogs?(conn: PilotConn): string[];
}

/** Player-facing text (data/strings.json; these are the defaults) */
export const CODEX_STRINGS = {
  'codex.found': 'New record: {title} (L, Records)',
  'codex.foundMany': '{n} new records (L, Records)',
};

/** Ticks between condition checks (twice a second) */
const CHECK_EVERY = 30;

const view = (e: CodexEntry): CodexView => ({ id: e.id, tab: e.tab, title: e.title, source: e.source, body: e.body });

export class Codex {
  private defs = new Map<string, CodexEntry>();
  /** Records found by a condition */
  private conditional: CodexEntry[];
  /** Item id → the record it carries */
  private carried = new Map<string, string>();
  private ticks = 0;
  private t: Texts<keyof typeof CODEX_STRINGS>;

  constructor(private host: CodexHost, private pilots: Pilots, readonly file: CodexFile, items: ItemDef[], strings?: StringsFile) {
    this.t = texts(CODEX_STRINGS, strings);
    for (const e of file.entries) this.defs.set(e.id, e);
    this.conditional = file.entries.filter((e) => e.unlock);
    for (const it of items) if (it.codex && this.defs.has(it.codex)) this.carried.set(it.id, it.codex);
    pilots.onEvent((conn, ev) => {
      if (ev.type === 'login') this.onLogin(conn);
      else if (ev.type === 'items' && this.carried.size) {
        const ids = Object.keys(ev.items).map((id) => this.carried.get(id)).filter((id): id is string => !!id);
        if (ids.length) this.unlock(conn, ids);
      }
    });
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  /** Signed in (or a guest arrived): everything found so far, then anything their progress already earns */
  private onLogin(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    p.codex.found = p.codex.found.filter((id) => this.defs.has(id));
    p.codex.fresh = p.codex.fresh.filter((id) => this.defs.has(id));
    this.send(conn);
    this.check(conn, p);
  }

  tick(): void {
    if (++this.ticks % CHECK_EVERY) return;
    for (const conn of this.pilots.connections()) {
      const p = this.pilots.get(conn);
      if (!p) continue;
      if (this.conditional.length) this.check(conn, p);
      // Wreck logs: read by flying close (wreckLogs already leaves out wrecks with no log)
      const logs = this.host.wreckLogs?.(conn);
      if (logs?.length) {
        const fresh = logs.filter((id) => !p.codex.found.includes(id));
        if (fresh.length) this.unlock(conn, fresh);
      }
    }
  }

  /** Records whose condition now holds */
  private check(conn: PilotConn, p: PlayerProfile): void {
    let ctx: CondContext | null = null;
    const got: string[] = [];
    for (const e of this.conditional) {
      if (p.codex.found.includes(e.id)) continue;
      if (condHolds(e.unlock, (ctx ??= this.host.ctx(conn, p)))) got.push(e.id);
    }
    if (got.length) this.unlock(conn, got);
  }

  /** Found (those not found already): saved, sent, toasted and tracked. Returns how many were new. */
  unlock(conn: PilotConn, ids: string[]): number {
    const p = this.pilots.get(conn);
    if (!p) return 0;
    const fresh = [...new Set(ids)].filter((id) => this.defs.has(id) && !p.codex.found.includes(id));
    if (!fresh.length) return 0;
    p.codex.found.push(...fresh);
    p.codex.fresh.push(...fresh);
    this.pilots.markDirty(conn);
    this.host.send(conn, { type: 'codex', entries: fresh.map((id) => view(this.defs.get(id)!)), fresh: p.codex.fresh });
    this.pilots.toast(conn, fresh.length > 1 ? this.t('codex.foundMany', { n: fresh.length }) : this.t('codex.found', { title: this.defs.get(fresh[0])!.title }), 'info');
    for (const id of fresh) this.pilots.track(conn, `codex_${id}`, {}, true);
    return fresh.length;
  }

  /** A record was opened: no longer new */
  read(conn: PilotConn, msg: { id: string }): void {
    const p = this.pilots.get(conn);
    if (!p || !p.codex.fresh.includes(String(msg.id))) return;
    p.codex.fresh = p.codex.fresh.filter((id) => id !== msg.id);
    this.pilots.markDirty(conn);
    this.host.send(conn, { type: 'codex', entries: [], fresh: p.codex.fresh });
  }

  /** Every record found so far */
  send(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    const entries = p.codex.found.map((id) => this.defs.get(id)).filter((e): e is CodexEntry => !!e).map(view);
    this.host.send(conn, { type: 'codex', entries, fresh: p.codex.fresh, all: true });
  }

  /** Admin (/codex): hand over one record or all of them, or forget them all. What happened, in words. */
  admin(conn: PilotConn, what: string): { ok: boolean; text: string } {
    const p = this.pilots.get(conn);
    if (!p) return { ok: false, text: 'No profile' };
    if (what === 'clear') {
      const n = p.codex.found.length;
      p.codex = { found: [], fresh: [] };
      this.pilots.markDirty(conn);
      this.send(conn);
      return { ok: true, text: `Forgot ${n} record${n === 1 ? '' : 's'}` };
    }
    if (what === 'all') return { ok: true, text: `${this.unlock(conn, [...this.defs.keys()])} new record(s)` };
    if (!this.defs.has(what)) return { ok: false, text: `No record "${what}" (ids in data/codex.json, or all / clear)` };
    return this.unlock(conn, [what]) ? { ok: true, text: `Found "${this.defs.get(what)!.title}"` } : { ok: true, text: 'Already found' };
  }
}
