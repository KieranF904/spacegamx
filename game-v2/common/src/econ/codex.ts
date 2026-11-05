/**
 * Records (data/codex.json): lore handed out as found documents and
 * testimony, kept in the pilot log's Records tab.
 *
 * Each entry says who wrote or said it (`source`) and reads as their account,
 * not the game's. A pilot finds one when its `unlock` condition holds (the
 * same conditions people's lines use), when someone hands it over in
 * conversation ({ codex } line), when a job pays it (`rewards.codex`), or
 * when an item that carries it (items.json `codex`) comes into their hold or
 * storage. The server decides all of it (server/src/game/Codex.ts); the client
 * is only ever sent the entries already found.
 */

import type { Cond } from './dialogue.js';

/** The Records tab's groups, in the order they're shown */
export const CODEX_TABS = ['signal', 'peoples', 'places', 'records', 'talk'] as const;
export type CodexTab = typeof CODEX_TABS[number];

export const CODEX_TAB_NAMES: Record<CodexTab, string> = {
  signal: 'The Heartbeat',
  peoples: 'Peoples',
  places: 'Places',
  records: 'Logs & records',
  talk: 'What people say',
};

export interface CodexEntry {
  id: string;
  tab: CodexTab;
  title: string;
  /** Who wrote or said it ("Sabine Kerr's notebooks", "Merchant Joe") */
  source: string;
  /** A few sentences (line breaks kept) */
  body: string;
  /** Found as soon as this holds (checked twice a second for entries not yet found) */
  unlock?: Cond;
}

export interface CodexFile {
  entries: CodexEntry[];
}

/** An entry as the client is sent it (found ones only) */
export type CodexView = Omit<CodexEntry, 'unlock'>;
