// What a model replies, read tolerantly into the grid text core/grid.ts reads. Two contracts:
//   json: {"name": "...", "grid": ["<column numbers>", "<row>", ...]}   (held to DESIGN_SCHEMA where the model takes one)
//   text: name: ... / grid: / the rows / end                            (the markers; fences, chatter, <think> stripped)
// Either reply is accepted under either contract: a model told to write JSON that writes the grid instead still counts.

export const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    grid: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'grid'],
  additionalProperties: false,
} as const;

import type { Contract } from './contracts';

export type { Contract };

export interface Extracted {
  /** Grid text for gridToBlueprint (name:, grid:, rows, end), or null when the reply holds no grid */
  text: string | null;
  name?: string;
  /** How it was read */
  via: 'json' | 'markers' | 'loose' | 'none';
  /** What was guessed or missing (shown to the model if the grid then fails) */
  notes: string[];
}

/** Drops <think> blocks (closed, or an open one with nothing after it) and code fences */
export function stripChatter(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, (m) => (/<think>/i.test(m) ? m : ''))
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/```[a-z]*\n?/gi, '');
}

/** A grid: marker line, markdown dressing allowed (**grid:**, ## Grid) */
const GRID_LINE = /^\s*[*_#]*\s*grid\s*[*_]*\s*:?\s*[*_]*\s*$/i;

const ROW_LIKE = /^\s*-?\d+(\s+\S+)+\s*$|^\s*(\.\.|[A-Za-z]{2}[\^>v<]?[a-z]?\d?)(\s+(\.\.|[A-Za-z]{2}[\^>v<]?[a-z]?\d?))+\s*$/;

/** JSON cut off before it closed (a model that ran on to its token limit): the complete grid strings so far */
function fromCutJson(s: string): Extracted | null {
  const at = s.search(/"grid"\s*:\s*\[/);
  if (at < 0) return null;
  const rows = [...s.slice(at).replace(/^"grid"\s*:\s*\[/, '').matchAll(/"((?:[^"\\]|\\.)*)"\s*[,\]]/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; } })
    .map((r) => r.replace(/\s+$/, '')).filter((r) => r.trim() && !/^\s*(grid|end)\s*:?\s*$/i.test(r));
  if (rows.length < 2) return null;
  const nm = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  const name = nm ? nm[1].trim() : undefined;
  return { text: [`name: ${name || 'Untitled'}`, 'grid:', ...rows, 'end'].join('\n'), name, via: 'json', notes: [`your JSON was cut off before it closed (${rows.length - 1} rows read): keep the grid short and close the JSON`] };
}

function fromJson(s: string): Extracted | null {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0) return null;
  if (b <= a) return fromCutJson(s);
  let o: any;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return fromCutJson(s); }
  if (!o || typeof o !== 'object') return null;
  const g = o.grid ?? o.rows ?? o.design;
  const rows: string[] | null = Array.isArray(g) ? g.map((x: unknown) => (Array.isArray(x) ? x.join(' ') : String(x))) : typeof g === 'string' ? g.split('\n') : null;
  if (!rows) return null;
  const name = typeof o.name === 'string' ? o.name.trim() : undefined;
  const body = rows.map((r) => r.replace(/\s+$/, '')).filter((r) => r.trim() && !/^\s*(grid|end)\s*:?\s*$/i.test(r));
  return { text: [`name: ${name || 'Untitled'}`, 'grid:', ...body, 'end'].join('\n'), name, via: 'json', notes: [] };
}

/** The design in a reply, however it came */
export function extractDesign(reply: string): Extracted {
  const s = stripChatter(reply);
  const j = fromJson(s);
  if (j) return j;
  const ls = s.split('\n');
  const nameBefore = (at: number) => {
    for (let i = at - 1; i >= 0; i--) { const m = /^\s*[*_#]*\s*name\s*[*_]*\s*:\s*(.+)$/i.exec(ls[i]); if (m) return m[1].replace(/[*_]+/g, '').trim(); }
    return undefined;
  };
  // (The last grid: block that holds rows: a model that drafts twice, or thinks aloud, means the last)
  const marks = ls.map((l, i) => (GRID_LINE.test(l) ? i : -1)).filter((i) => i >= 0);
  let emptyBlock = false;
  for (const g of marks.reverse()) {
    const notes: string[] = [];
    let e = ls.findIndex((l, i) => i > g && (/^\s*end\s*$/i.test(l) || GRID_LINE.test(l)));
    if (e < 0 || GRID_LINE.test(ls[e])) { e = e < 0 ? ls.length : e; notes.push('no "end" line after the rows'); }
    const block = ls.slice(g + 1, e).filter((l) => l.trim());
    if (!block.length) { emptyBlock = true; continue; }
    let rows = block;
    // (Prose mixed in: the last run of grid-like lines in it)
    if (!block.every((l) => ROW_LIKE.test(l))) {
      const run = lastRun(ls.slice(g + 1, e));
      if (!run) continue;
      rows = run;
      notes.push(`skipped ${block.length - run.length} line(s) that aren't grid rows`);
    }
    const name = nameBefore(g);
    return { text: [`name: ${name ?? 'Untitled'}`, 'grid:', ...rows, 'end'].join('\n'), name, via: 'markers', notes };
  }
  // No usable markers: the last good run of lines that look like grid rows
  const run = lastRun(ls);
  if (!run) return { text: null, via: 'none', notes: [emptyBlock ? 'nothing between grid: and end' : 'no grid found: write grid:, the rows, then end'] };
  const name = nameBefore(ls.length);
  return { text: [`name: ${name ?? 'Untitled'}`, 'grid:', ...run, 'end'].join('\n'), name, via: 'loose', notes: ['no grid: / end markers'] };
}

/** The last run of grid-like lines at least half as long as the longest (and 2 or more) */
function lastRun(ls: string[]): string[] | null {
  const runs: [number, number][] = [];
  for (let i = 0; i < ls.length;) {
    if (!ROW_LIKE.test(ls[i])) { i++; continue; }
    let k = i;
    while (k < ls.length && ROW_LIKE.test(ls[k])) k++;
    runs.push([i, k]);
    i = k;
  }
  const longest = Math.max(0, ...runs.map(([a, b]) => b - a));
  const pick = runs.reverse().find(([a, b]) => b - a >= Math.max(2, longest / 2));
  return pick ? ls.slice(pick[0], pick[1]) : null;
}

/** The complete grid lines so far of a reply still streaming (null until there are two), for a live preview */
export function partialGrid(sofar: string, contract: Contract): { text: string; lines: number } | null {
  const s = stripChatter(sofar);
  let rows: string[];
  if (contract === 'grid-json' && /"grid"\s*:\s*\[/.test(s)) {
    const tail = s.slice(s.search(/"grid"\s*:\s*\[/));
    rows = [...tail.matchAll(/"((?:[^"\\]|\\.)*)"\s*[,\]]/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; } });
  } else {
    const ls = s.split('\n');
    const done = ls.slice(0, -1);
    let g = -1;
    for (let i = done.length - 1; i >= 0; i--) if (GRID_LINE.test(done[i])) { g = i; break; }
    if (g < 0) return null;
    rows = [];
    for (const l of done.slice(g + 1)) { if (/^\s*end\s*$/i.test(l)) break; if (l.trim()) rows.push(l); }
  }
  if (rows.length < 2) return null;
  return { text: ['grid:', ...rows, 'end'].join('\n'), lines: rows.length };
}
