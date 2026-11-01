// Reply contracts: how a model writes a design. One registry entry each; the loop only calls through it.
//   grid-text  the text grid between name:/grid:/end markers (core/grid.ts)
//   grid-json  the same grid as JSON {"name", "grid": [rows]}, held to a schema where the model takes one
//   parts      a part list, "CODE col,row [WxH]" per line (core/partlist.ts): the model never draws cells
// Every contract reads the others' replies too (a model asked for JSON that writes a grid still counts).
import { type CodeBook, type DecodeResult, type DesignForm, type ShipgenContext, gridToBlueprint, partsToBlueprint } from '../core/index';
import { DESIGN_SCHEMA, type Extracted, extractDesign, partialGrid, stripChatter } from './reply';

export type Contract = 'grid-text' | 'grid-json' | 'parts';
export const CONTRACT_IDS: Contract[] = ['grid-text', 'grid-json', 'parts'];

export interface ContractDef {
  id: Contract;
  form: DesignForm;
  label: string;
  /** A JSON schema for the reply (where the model takes one) */
  schema?: object;
  /** The reply instruction (after every ask and feedback) */
  ask(mirror: boolean): string;
  /** The design in a reply, as text decode() reads */
  extract(reply: string): Extracted;
  decode(ctx: ShipgenContext, text: string, book: CodeBook): DecodeResult;
  /** The complete lines so far of a reply still streaming (a live preview), or null */
  partial(sofar: string): { text: string; lines: number } | null;
}

export const PARTS_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } } },
  required: ['name', 'parts'],
  additionalProperties: false,
} as const;

const half = (mirror: boolean) => (mirror ? ' Only the LEFT half and the centre line (the core whole): the tool mirrors it.' : '');

/** A part-list entry line (loose: the tool's own reader decides) */
const ENTRY_LIKE = /^\s*[-*•]?\s*[A-Z]{2}[\^>v<]?[a-z]?\d?\s*(?:at\s*|@\s*)?[([]?\s*-?\d+\s*[,\s]\s*-?\d+\s*[)\]]?(?:\s*\d\s*[x×]\s*\d)?\s*,?\s*(?:;.*)?$/;

/** The part list in a reply: a parts: block, JSON {"parts": [...]}, or the last run of entry lines */
export function extractParts(reply: string): Extracted {
  const s = stripChatter(reply);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(s.slice(a, b + 1));
      const list = o?.parts ?? o?.design;
      if (Array.isArray(list)) {
        const name = typeof o.name === 'string' ? o.name.trim() : undefined;
        const rows = list.map((x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x as object).join(' ') : String(x)));
        return { text: [`name: ${name || 'Untitled'}`, 'parts:', ...rows, 'end'].join('\n'), name, via: 'json', notes: [] };
      }
    } catch { /* (not JSON: read it as text) */ }
  }
  const ls = s.split('\n');
  const nameOf = () => { for (const l of ls) { const m = /^\s*[*_#]*\s*name\s*[*_]*\s*:\s*(.+)$/i.exec(l); if (m) return m[1].replace(/[*_]+/g, '').trim(); } return undefined; };
  const head = ls.map((l, i) => (/^\s*[*_#]*\s*parts\s*[*_]*\s*:?\s*[*_]*\s*$/i.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (head !== undefined) {
    const notes: string[] = [];
    let e = ls.findIndex((l, i) => i > head && /^\s*end\s*$/i.test(l));
    if (e < 0) { e = ls.length; notes.push('no "end" line after the parts'); }
    const rows = ls.slice(head + 1, e).filter((l) => l.trim());
    const bad = rows.filter((l) => !ENTRY_LIKE.test(l));
    if (rows.length && bad.length < rows.length) {
      const name = nameOf();
      return { text: [`name: ${name ?? 'Untitled'}`, 'parts:', ...rows, 'end'].join('\n'), name, via: 'markers', notes };
    }
  }
  const rows = ls.filter((l) => ENTRY_LIKE.test(l));
  if (rows.length) {
    const name = nameOf();
    return { text: [`name: ${name ?? 'Untitled'}`, 'parts:', ...rows, 'end'].join('\n'), name, via: 'loose', notes: ['no parts: / end markers'] };
  }
  // (A grid where a part list was asked for: read it as a grid)
  const g = extractDesign(reply);
  if (g.text) return { ...g, notes: [...g.notes, 'you drew a grid instead of listing parts: I read it as a grid'] };
  return { text: null, via: 'none', notes: ['no part list found: write parts:, one "CODE col,row" per line, then end'] };
}

const gridDecode = (ctx: ShipgenContext, text: string, book: CodeBook) => gridToBlueprint(ctx, text, { book });

export const CONTRACTS: Record<Contract, ContractDef> = {
  'grid-text': {
    id: 'grid-text', form: 'grid', label: 'grid (text)',
    ask: (m) => `Reply with the design only, between the markers: the name: line, grid:, the rows, and end. No other words.${half(m)}`,
    extract: extractDesign, decode: gridDecode, partial: (s) => partialGrid(s, 'grid-text'),
  },
  'grid-json': {
    id: 'grid-json', form: 'grid', label: 'grid (JSON)', schema: DESIGN_SCHEMA,
    ask: (m) => `Reply as JSON only: {"name": "<a name>", "grid": ["<line 1: the column numbers>", "<row line>", ...]}: each string in "grid" is one line of the grid, exactly as the format shows it (a row number, then one token per cell).${half(m)}`,
    extract: extractDesign, decode: gridDecode, partial: (s) => partialGrid(s, 'grid-json'),
  },
  parts: {
    id: 'parts', form: 'parts', label: 'part list',
    ask: (m) => `Reply with the design only: the name: line, parts:, one part per line as CODE col,row (and its size, like 2x2, if it is bigger than one cell), and end. No other words.${half(m)}`,
    extract: extractParts,
    decode: (ctx, text, book) => (/^\s*grid\s*:/im.test(text) && !/^\s*parts\s*:/im.test(text) ? gridToBlueprint(ctx, text, { book }) : partsToBlueprint(ctx, text, { book })),
    partial(sofar) {
      const s = stripChatter(sofar);
      const done = s.split('\n').slice(0, -1);
      const rows = done.filter((l) => ENTRY_LIKE.test(l));
      return rows.length >= 2 ? { text: ['parts:', ...rows, 'end'].join('\n'), lines: rows.length } : null;
    },
  },
};

/** "text"/"json" (the old names) and the new ones; undefined for anything else */
export function parseContract(s: string | undefined): Contract | 'auto' | undefined {
  if (!s) return undefined;
  const k = s.trim().toLowerCase();
  if (k === 'auto') return 'auto';
  if (k === 'text' || k === 'grid' || k === 'grid-text') return 'grid-text';
  if (k === 'json' || k === 'grid-json') return 'grid-json';
  if (k === 'parts' || k === 'part-list' || k === 'list') return 'parts';
  return undefined;
}

/** Back-compat: the reply instruction per contract (mirror off) */
export const CONTRACT_TEXT: Record<Contract, string> = Object.fromEntries(CONTRACT_IDS.map((c) => [c, CONTRACTS[c].ask(false)])) as Record<Contract, string>;
