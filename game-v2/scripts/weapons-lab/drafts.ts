// Drafts: lab/weapons/<id>.json, one per new weapon or modified copy, each with its prompt history. Kept apart from
// data/: the game never reads this folder; a draft joins the game only when Kieran asks Claude to review and add it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { draftDir } from './paths';

/** One prompt and what came of it */
export interface HistoryItem { at: string; request: string; provider: string; ok: boolean; problems?: string[]; error?: string }
export interface Draft {
  id: string;
  /** The weapon it was copied from, if any */
  base?: string;
  /** The weapon row: a models.json model (data/ships/models.json shape) */
  model: Record<string, any>;
  history: HistoryItem[];
  updated: string;
}

export const ID_RULE = /^[a-z][a-z0-9_]{1,47}$/;

const file = (id: string, lab?: string) => join(draftDir(lab), `${id}.json`);

export function listDrafts(lab?: string): Draft[] {
  const dir = draftDir(lab);
  if (!existsSync(dir)) return [];
  const out: Draft[] = [];
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.json')) { try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8'))); } catch { /* a hand-broken file: skipped, not fatal */ } }
  return out;
}

export function getDraft(id: string, lab?: string): Draft | null {
  if (!ID_RULE.test(id) || !existsSync(file(id, lab))) return null;
  try { return JSON.parse(readFileSync(file(id, lab), 'utf-8')); } catch { return null; }
}

/** Write (atomically); the draft's id must pass ID_RULE and match its model's id */
export function saveDraft(d: Draft, lab?: string): Draft {
  if (!ID_RULE.test(d.id)) throw new Error(`draft id "${d.id}" must be lower-case letters, digits and _ (2-48 characters, starting with a letter)`);
  if (d.model?.id !== d.id) throw new Error(`the model's id ("${d.model?.id}") must be the draft's id ("${d.id}")`);
  const dir = draftDir(lab);
  mkdirSync(dir, { recursive: true });
  const out = { ...d, updated: new Date().toISOString() };
  const tmp = `${file(d.id, lab)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 1));
  renameSync(tmp, file(d.id, lab));
  return out;
}
