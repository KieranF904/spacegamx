// A ship concept: a short plan the model writes before the first design round (name, size class, silhouette, where
// things go, a character line, maybe a target cell count). It is put in the design prompt and, as one line, in every
// feedback message, so later rounds keep to it. Pure: the request words, the reply reader, the one-line forms and a
// small score term (size class and cell count against the plan, derived from the ship's own data).
import type { Role } from './roles';

export type SizeClass = 'small' | 'medium' | 'large';

export interface Concept {
  name: string;
  sizeClass: SizeClass;
  silhouette: string;
  /** Where the core, generators and stores, guns, engines and armour go (mirror-friendly) */
  layout: string;
  /** One sentence */
  character: string;
  /** Target number of cells, when the model gave one */
  cells?: number;
  /** model: read from a reply; fallback: made from the role's shape because the reply could not be read */
  source: 'model' | 'fallback' | 'given';
}

export const CONCEPT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    size: { type: 'string', enum: ['small', 'medium', 'large'] },
    silhouette: { type: 'string' },
    layout: { type: 'string' },
    character: { type: 'string' },
    cells: { type: 'integer' },
  },
  required: ['name', 'size', 'silhouette', 'layout', 'character'],
};

/** Content tokens a concept reply may use (a reasoning model gets room to think first on top of this) */
export const CONCEPT_TOKENS = 400;

/** The cell range of a size class within a role's range (thirds) */
export function classRange(role: Role | undefined, c: SizeClass): [number, number] | undefined {
  const r = role?.size.cells;
  if (!r) return undefined;
  const [lo, hi] = r, step = (hi - lo) / 3;
  const i = c === 'small' ? 0 : c === 'medium' ? 1 : 2;
  return [Math.round(lo + step * i), Math.round(lo + step * (i + 1))];
}

export interface ConceptHint {
  /** A silhouette to start from (one of the role's shapes) */
  shape?: string;
  /** A number to vary the pick by */
  seed?: number;
  /** Concepts already used this session (their one-line forms): this one must differ */
  used?: string[];
}

const SIZE_WORDS: Record<SizeClass, string> = { small: 'small', medium: 'medium', large: 'large' };

/** The request: a system message and a user message. `json`: the reply is a JSON object (schema); else a strict text block */
export function conceptRequest(role: Role | undefined, userBrief: string | undefined, hint: ConceptHint, json: boolean): { system: string; user: string } {
  const range = role?.size.cells;
  const box = role?.size.maxWidth && role?.size.maxHeight ? `, at most ${role.size.maxWidth} columns wide and ${role.size.maxHeight} rows long` : '';
  const system = [
    'You are the art director for a 2D space game of ships built from a grid of parts. Before the engineers draw a ship you write its concept: short and concrete.',
    role ? `Role: ${role.name}: ${role.summary}. It covers ${range![0]}-${range![1]} cells${box}.` : '',
    ...(role?.style ?? []).map((s) => `Style note: ${s}`),
    userBrief ? `The owner asks: ${userBrief}` : '',
  ].filter(Boolean).join('\n');
  const fields = [
    'name: a short ship name',
    `size: ${Object.keys(SIZE_WORDS).join(', ')} (within the role's range)`,
    'silhouette: its outline in a few words, e.g. "long needle nose, swept wings"',
    'layout: where the core, generators and stores, guns, engines and armour go; it is mirrored left to right, so say what sits on the centre line and what is paired on the sides',
    'character: one sentence on what it is like',
    'cells: your target cell count (a number)',
  ];
  const ask = [
    hint.shape ? `Start from this silhouette: ${hint.shape}` : '',
    hint.seed !== undefined ? `Variation number ${hint.seed}: let it steer you to something distinctive.` : '',
    hint.used?.length ? `These were already made this session, so make this one clearly different:\n${hint.used.map((u) => `- ${u}`).join('\n')}` : '',
    json
      ? `Reply as JSON with the keys name, size, silhouette, layout, character and cells. Keep each value to one short sentence.`
      : `Reply with exactly this block and nothing else (one short line each):\nconcept:\nname: ...\nsize: small|medium|large\nsilhouette: ...\nlayout: ...\ncharacter: ...\ncells: N\nend`,
    json ? '' : `(${fields.join('; ')})`,
  ].filter(Boolean).join('\n');
  return { system, user: `Write the concept for this ship.\n${ask}` };
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** A concept from a model's reply: JSON, or the text block. null when neither holds a silhouette or a layout */
export function parseConcept(text: string, role?: Role): Concept | null {
  const raw: Record<string, unknown> = {};
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const j = /\{[\s\S]*\}/.exec(t);
  if (j) {
    try { Object.assign(raw, JSON.parse(j[0])); } catch { /* (not JSON: try the block) */ }
  }
  if (!Object.keys(raw).length) {
    for (const line of t.split('\n')) {
      const m = /^\s*[-*]?\s*(name|size|silhouette|layout|character|cells)\s*:\s*(.+?)\s*$/i.exec(line);
      if (m && raw[m[1].toLowerCase()] === undefined) raw[m[1].toLowerCase()] = m[2];
    }
  }
  const silhouette = clip(raw.silhouette, 160), layout = clip(raw.layout, 320);
  if (!silhouette && !layout) return null;
  const sz = String(raw.size ?? raw.sizeClass ?? '').toLowerCase();
  const sizeClass: SizeClass = sz.includes('small') ? 'small' : sz.includes('large') ? 'large' : 'medium';
  const n = Number(String(raw.cells ?? '').replace(/[^\d.]/g, ''));
  const [lo, hi] = role?.size.cells ?? [1, 2000];
  const cells = Number.isFinite(n) && n > 0 ? Math.round(Math.min(hi, Math.max(lo, n))) : undefined;
  return { name: clip(raw.name, 60) || 'Untitled', sizeClass, silhouette: silhouette || 'unspecified', layout, character: clip(raw.character, 200), ...(cells ? { cells } : {}), source: 'model' };
}

/** What stands in when no concept could be read: the role's silhouette, so the run still goes ahead with a target */
export function fallbackConcept(role: Role | undefined, shape?: string): Concept | null {
  if (!shape) return null;
  return { name: 'Untitled', sizeClass: 'medium', silhouette: shape, layout: '', character: '', source: 'fallback' };
}

/** One line, for feedback messages and logs */
export function conceptLine(c: Concept): string {
  return `Concept "${c.name}": ${c.sizeClass} ship${c.cells ? ` (about ${c.cells} cells)` : ''}, ${c.silhouette}${c.layout ? `; ${c.layout}` : ''}${c.character ? `; ${c.character}` : ''}`.replace(/\.?$/, '.');
}

/** A short form to tell concepts apart (the variation list) */
export const conceptKey = (c: Concept) => `${c.name}: ${c.sizeClass}, ${c.silhouette}`;

/** The block put in the design prompt */
export function conceptBlock(c: Concept): string {
  return [
    `Follow this concept for the ship:`,
    `- name: ${c.name}; size: ${c.sizeClass}${c.cells ? `, about ${c.cells} cells` : ''}`,
    `- silhouette: ${c.silhouette}`,
    ...(c.layout ? [`- layout: ${c.layout}`] : []),
    ...(c.character ? [`- character: ${c.character}`] : []),
  ].join('\n');
}

/** Points off for straying from the plan (at most 5): a size class and a cell count against the ship's cells */
export function conceptPenalty(role: Role | undefined, c: Concept | undefined, cells: number): { points: number; notes: string[] } {
  if (!c || c.source === 'fallback') return { points: 0, notes: [] };
  const notes: string[] = [];
  let points = 0;
  const band = classRange(role, c.sizeClass);
  if (band && (cells < band[0] * 0.8 || cells > band[1] * 1.2)) { points += 2; notes.push(`the concept is a ${c.sizeClass} ship (${band[0]}-${band[1]} cells) and this has ${cells}`); }
  if (c.cells && Math.abs(cells - c.cells) / c.cells > 0.25) { points += Math.min(3, Math.round((Math.abs(cells - c.cells) / c.cells) * 4)); notes.push(`the concept planned about ${c.cells} cells and this has ${cells}`); }
  return { points: Math.min(5, points), notes };
}
