/// The words a model reads: the system prompt (rules from docs/areas/energy.md, the format for the reply form chosen, the
// legend for the brief's tier, a worked example, the brief) and the feedback after each try (a check() result, made specific).
// Kept short: every section is the least that lets a model do the job, and everything in it is derived from the game's data.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isEngine, parseBlueprint } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { type LegendEntry, type TierBand, buildLegend, legendFor, legendText, partInBand } from './legend';
import { allShapes, pieceShapes } from './shapes';
import { CodeBook, type GridError, blueprintToGrid } from './grid';
import type { Blueprint } from '../../../common/src/ships/index';
import { halfOf } from './mirror';
import { blueprintToParts, boxSize } from './partlist';
import type { CheckResult } from './check';
import { type BriefCheck, type Role, findRole, selectorWords } from './roles';
import { coreLeftEdge, outlineShapes, squareCornerWords } from './silhouette';

export interface Brief {
  /** A role id (data/shipgen/roles.json) or a role */
  role?: string | Role;
  /** The owner's own words */
  text?: string;
  /** Overrides the role's band */
  band?: TierBand;
  /** Name for the ship */
  name?: string;
  /** The silhouette asked for (one of the role's shapes); '' for none */
  shape?: string;
}

/** The brief with one of its role's shapes (by index, wrapping) unless it names one already */
export function withShape(ctx: ShipgenContext, brief: Brief, index: number): Brief {
  if (brief.shape !== undefined) return brief;
  const shapes = roleOf(ctx, brief)?.shapes ?? [];
  return shapes.length ? { ...brief, shape: shapes[((index % shapes.length) + shapes.length) % shapes.length] } : brief;
}

const RULES = /<!--\s*shipgen:rules\s*-->([\s\S]*?)<!--\s*\/shipgen:rules\s*-->/;

/** The design rules block maintained in docs/areas/energy.md */
export function rulesText(ctx: ShipgenContext): string {
  const p = join(ctx.dataDir, '../docs/areas/energy.md');
  const m = existsSync(p) ? RULES.exec(readFileSync(p, 'utf8')) : null;
  if (!m) throw new Error('docs/areas/energy.md has no <!-- shipgen:rules --> block');
  return m[1].replace(/\r/g, '').trim();
}

/** The rules as the prompt gives them: each point cut to its first sentence (the doc's own words, not paraphrased) */
export function rulesShort(ctx: ShipgenContext): string {
  return rulesText(ctx).split('\n').map((l) => {
    const m = /^(\s*[-*]\s+)(.*)$/.exec(l);
    if (!m) return l;
    const first = /^.*?[.!?](?=\s|$)/.exec(m[2]);
    return m[1] + (first ? first[0] : m[2]);
  }).join('\n');
}

function roleOf(ctx: ShipgenContext, brief: Brief): Role | undefined {
  if (!brief.role) return undefined;
  if (typeof brief.role !== 'string') return brief.role;
  const r = findRole(ctx, brief.role);
  if (!r) throw new Error(`no role "${brief.role}" in data/shipgen/roles.json`);
  return r;
}

/** "t1 S+W, t2 N+W": a shape's digits and the flat sides each has (the others are cut) */
const shortShape = (s: ReturnType<typeof pieceShapes>) =>
  s.classes.map((c) => {
    const xs = c.cells.map((k) => k[0]), ys = c.cells.map((k) => k[1]);
    const size = c.cells.length > 1 ? `${Math.max(...xs) - Math.min(...xs) + 1}x${Math.max(...ys) - Math.min(...ys) + 1} ` : '';
    return `${s.letter}${c.index} ${size}${c.flat.length ? c.flat.join('+') : 'curved'}`;
  }).join(', ');

/** The shapes lines both formats share, and the nudge to use them */
function shapeLines(ctx: ShipgenContext, entries: LegendEntry[]): string[] {
  const shaped = allShapes(ctx.catalog).filter((s) => !s.box && !s.bespoke && s.letter);
  const usable = shaped.filter((s) => entries.some((e) => e.kind === 'structure' || e.pieces.includes(s.piece)));
  const lines: string[] = [];
  if (usable.length) {
    lines.push('Shapes (hull and armour may be any of these; the sides named are flat, the rest is cut). Rectangular pieces need no mark:');
    for (const s of usable) lines.push(`  ${s.letter} = ${s.piece}: ${shortShape(s)}`);
    const o = outlineShapes(ctx).filter((x) => usable.some((s) => s.piece === x.piece));
    if (o.length) lines.push(`Shape the outline: put shaped hull or armour on the exposed outer corners instead of square blocks (same footprint, no extra cells): ${o.map((x) => `${x.marks} ${x.words}`).join('; ')}. A ship with square corners scores lower.`);
  }
  return lines;
}

/** The grid format as the model reads it */
export function formatText(ctx: ShipgenContext, entries: LegendEntry[]): string {
  // (Examples from the legend itself: a structure code, a 2-cell part that faces out, a shaped one)
  const cellsOf = (e: LegendEntry) => pieceShapes(ctx.catalog, e.pieces[0]).classes[0].cells.length;
  const st = (entries.find((e) => e.kind === 'structure' && e.power.role === 'none') ?? entries.find((e) => e.kind === 'structure'))?.code ?? 'HA';
  const two = entries.find((e) => e.kind === 'model' && e.facing === 'free' && cellsOf(e) === 2);
  const lo = st.toLowerCase();
  const shaped = allShapes(ctx.catalog).filter((s) => !s.box && !s.bespoke && s.letter);
  const sf = entries.find((e) => e.facing === 'free' && !pieceShapes(ctx.catalog, e.pieces[0]).box);
  const lines = [
    'Top-down grid, the FRONT of the ship UP (rows grow towards the back). Line 1: the column numbers. Then one line per row: the row number, then one token per cell, space-separated:',
    '  ..      empty',
    `  ${st.padEnd(7)} the FIRST cell of a part (its top-left: topmost, then leftmost): its legend code in CAPITALS`,
    `  ${lo.padEnd(7)} every OTHER cell of that part: the same code in small letters (2x1 hull "${st} ${lo}"; 2x2 "${st} ${lo}" over "${lo} ${lo}"${two ? `; a ${two.name} facing up "${two.code}^ ${two.code.toLowerCase()}"` : ''})`,
    `  ${((two?.code ?? 'PI') + '^').padEnd(7)} facing mark after the code: ^ forward (up), v back, > right, < left`,
    ...(shaped[0] ? [`  ${(st + shaped[0].letter + '2').padEnd(7)} a shaped piece: its shape letter and number after the code${sf ? ` (after any facing mark: ${sf.code}v${pieceShapes(ctx.catalog, sf.pieces[0]).letter}2)` : ''}`] : []),
    'Every row has the same number of tokens; no blank lines; parts never overlap. Draw only the ship: no empty rows or columns around it (numbers may start anywhere, such as -3).',
    ...shapeLines(ctx, entries),
    'Write: name: <a name>, then grid:, the rows, end.',
  ];
  return lines.join('\n');
}

/** The part-list format as the model reads it (core/partlist.ts) */
export function partsFormatText(ctx: ShipgenContext, entries: LegendEntry[]): string {
  const shaped = allShapes(ctx.catalog).filter((s) => !s.box && !s.bespoke && s.letter);
  const st = (entries.find((e) => e.kind === 'structure' && e.power.role === 'none') ?? entries.find((e) => e.kind === 'structure'))?.code ?? 'HA';
  const gun = entries.find((e) => e.power.role === 'weapon' && e.facing === 'free')?.code ?? 'PI';
  const big = entries.find((e) => e.kind === 'model' && e.pieces.length === 1 && boxSize(ctx, e.pieces[0]) === '2x2');
  const two = entries.find((e) => e.kind === 'model' && e.facing === 'free' && e.pieces.length === 1 && boxSize(ctx, e.pieces[0]) === '2x1');
  const tri = shaped[0];
  const lines = [
    'A list of parts, one per line: the legend code, then col,row (columns grow to the right, rows towards the back; the FRONT is UP; numbers may be negative). The tool places each part; you draw no grid.',
    `  ${st} 0,2        a part at column 0, row 2`,
    `  ${gun}^ -1,-2     facing mark after the code: ^ forward (up), v back, > right, < left`,
    `  ${(big?.code ?? 'HB')} -3,1 2x2   a part over one cell: its TOP-LEFT cell, then its size (columns x rows); it covers the cells right of and below that cell`,
    ...(two ? [`  ${two.code}v 1,3 1x2   a 2x1 part standing upright is 1x2`] : []),
    `  ${st} 2,2 2x1     structure (hull, armour, cargo) may be 1x1 (the default), 2x1, 1x2 or 2x2`,
    ...(tri ? [`  ${st}${tri.letter}2 -3,0     a shaped piece: its shape letter and number after the code (after any facing mark)`] : []),
    'Parts never overlap, and each shares a full edge with the rest of the ship.',
    ...shapeLines(ctx, entries),
    'Write: name: <a name>, then parts:, one part per line, end.',
  ];
  return lines.join('\n');
}

/** How mirror mode works, for the system prompt */
export function mirrorText(form: DesignForm): string {
  return [
    `MIRROR MODE: ${form === 'parts' ? 'list' : 'draw'} only the LEFT HALF of the ship and the parts ON its centre line (down the middle of the core, which you give whole; ${form === 'grid' ? 'no columns' : 'no column'} right of it). The tool adds the mirror image, so the ship is symmetric.`,
    'A part ON the centre line must look the same mirrored: facing ^ or v, never > or <. Two side-by-side parts across the line (two guns, two engines) come from ONE part just left of it. Brief counts are for the whole ship: a part left of the line counts twice, one on the line once.',
  ].join('\n');
}

export type DesignForm = 'grid' | 'parts';

/** A design as the model writes it: grid or part list, the whole ship or (mirror mode) its left half and centre line */
export function designText(ctx: ShipgenContext, bp: Blueprint, opts: { form?: DesignForm; mirror?: boolean; book?: CodeBook } = {}): string {
  const shown = opts.mirror ? halfOf(ctx, bp) : bp;
  return (opts.form === 'parts' ? blueprintToParts(ctx, shown, { book: opts.book }) : blueprintToGrid(ctx, shown, { book: opts.book })).text.trim();
}

/** The role's worked example as the model reads it, or null when it has none, or draws with a key, or a pilot of the band couldn't fit it */
function exampleText(ctx: ShipgenContext, path: string | undefined, band: TierBand, opts: { form?: DesignForm; mirror?: boolean } = {}): { text: string; parts: Blueprint['parts'] } | null {
  if (!path) return null;
  const f = join(ctx.dataDir, 'ships/blueprints', `${path}.json`);
  if (!existsSync(f)) return null;
  const bp = parseBlueprint(readFileSync(f, 'utf8'));
  // (An example with a part above the band would hand the model a code it may not use)
  if (bp.parts.some((p) => !partInBand(p, band))) return null;
  const enc = blueprintToGrid(ctx, bp, { book: new CodeBook(ctx) });
  if (enc.raw.length || enc.book.own.length) return null;
  if (!opts.form && !opts.mirror) return { text: enc.text.trim(), parts: bp.parts };
  return { text: designText(ctx, bp, opts), parts: bp.parts };
}

/** The legend entries a brief allows: its band's */
export function briefLegend(ctx: ShipgenContext, brief: Brief): LegendEntry[] {
  const role = roleOf(ctx, brief), legend = buildLegend(ctx);
  return legendFor(legend, brief.band ?? role?.band ?? { maxLevel: 99 });
}

/**
 * The entries the prompt lists: the band's, less what the role has no use for (tools the role doesn't name, thrusters that
 * are not engines, cargo holds in a role that wants none). The parts stay usable: the checker reads every code of the band.
 */
export function shownLegend(ctx: ShipgenContext, brief: Brief): LegendEntry[] {
  const role = roleOf(ctx, brief);
  const sels = [...(role?.require ?? []), ...(role?.encourage ?? [])];
  const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const named = (e: LegendEntry) => sels.some((s) => list(s.fn).includes(e.fn) || list(s.family).includes(ctx.catalog.functions.get(e.fn)?.family ?? '\0'));
  return briefLegend(ctx, brief).filter((e) => {
    const fn = ctx.catalog.functions.get(e.fn);
    if (e.kind === 'structure') return e.fn !== 'cargo' || named(e);
    if (named(e)) return true;
    if (e.power.role === 'tool') return fn?.family === 'shield';
    if (e.power.role === 'thruster') return isEngine(fn);
    return true;
  });
}

export function briefText(ctx: ShipgenContext, brief: Brief): string {
  const role = roleOf(ctx, brief);
  const out: string[] = [];
  if (role) {
    out.push(`Design a ${role.name}: ${role.summary}.`);
    const s = role.size;
    out.push(`Size: ${s.cells[0]}-${s.cells[1]} cells${s.maxWidth ? `, at most ${s.maxWidth} columns wide` : ''}${s.maxHeight ? ` and ${s.maxHeight} rows long` : ''}.`);
    if (role.require?.length) out.push(`It must have: ${role.require.map(selectorWords).join('; ')}.`);
    if (role.encourage?.length) out.push(`It should have: ${role.encourage.map((x) => selectorWords(x) + (x.why ? ` (${x.why})` : '')).join('; ')}.`);
    for (const st of role.style ?? []) out.push(`- ${st}`);
  }
  if (brief.shape) out.push(`Its shape: ${brief.shape}. Your own design in that shape, not a copy of the example.`);
  if (brief.text) out.push(brief.text.trim());
  if (brief.name) out.push(`Call it "${brief.name}".`);
  if (!out.length) out.push('Design a good, balanced small warship.');
  return out.join('\n');
}

export interface PromptOptions {
  /** How the model writes a design: a drawn grid (default) or a part list */
  form?: DesignForm;
  /** Mirror mode: the model writes the left half and the centre line */
  mirror?: boolean;
  /** Staged build: the ship grows one system a step from a given skeleton */
  staged?: boolean;
}

export function systemPrompt(ctx: ShipgenContext, brief: Brief, opts: PromptOptions = {}): string {
  const role = roleOf(ctx, brief);
  const entries = shownLegend(ctx, brief);
  const form = opts.form ?? 'grid';
  const band = brief.band ?? role?.band ?? { maxLevel: 99 };
  const ex = exampleText(ctx, role?.example, band, opts.form || opts.mirror ? { form, mirror: opts.mirror } : {});
  // (The example's own parts are listed too, so every code it shows is one the legend explains)
  if (ex) for (const p of ex.parts) { const e = buildLegend(ctx).find(p.fn, p.material); if (e && !entries.includes(e)) entries.push(e); }
  const parts = [
    `You design spaceships for a 2D space game: a grid of parts. You write the design as ${form === 'parts' ? 'a list of parts with positions' : 'a text grid'}; a checker builds it, runs its power and tells you what to fix.` +
      (opts.staged ? ' You build it in steps: each step adds one system to a ship that already works.' : ''),
    '## Rules\n' + rulesShort(ctx),
    (form === 'parts' ? '## Part list format\n' + partsFormatText(ctx, entries) : '## Grid format\n' + formatText(ctx, entries)),
  ];
  if (opts.mirror) parts.push('## Mirror mode\n' + mirrorText(form));
  parts.push('## Legend: the only codes you may use\n' + legendText(entries));
  if (ex) parts.push(`## Example${opts.mirror ? ' (left half and centre line)' : ''}: study how power flows from generators through stores to every gun and engine; do not copy it\n` + ex.text);
  parts.push('## Your brief\n' + briefText(ctx, brief));
  return parts.join('\n\n') + '\n';
}

/** Square corners left on a valid ship, named as a suggestion */
export function shapeSuggestion(ctx: ShipgenContext, bp: Blueprint, mirror = false): string | null {
  const sq = squareCornerWords(ctx, bp, 5, mirror ? coreLeftEdge(ctx, bp) : undefined);
  const o = outlineShapes(ctx);
  if (!sq.length || !o.length) return null;
  return `Outline: ${sq.length === 5 ? 'several' : sq.length} exposed corner(s) are still square, e.g. ${sq.join('; ')}. Swap them for shaped pieces (${o.map((x) => x.marks).join(', ')}) where it fits; the same footprint.`;
}

export interface FeedbackInput {
  /** The grid couldn't be read (gridToBlueprint's errors): nothing else is known */
  gridErrors?: GridError[];
  gridWarnings?: string[];
  result?: CheckResult;
  brief?: BriefCheck;
  /** Most items listed under each heading (default 8) */
  maxItems?: number;
  /** The ship as built, as a grid (shown so the model can read what it made) */
  ship?: string;
  /** Mirror mode was on (the ship shown is whole; the model replies with the left half) */
  mirror?: boolean;
  /** Mirror mode off: cells that differ from their mirror image, and what each costs */
  asymmetry?: string[];
  asymmetryPoints?: number;
  /** The design couldn't be put together (mirror or merge errors, after it was read) */
  buildErrors?: GridError[];
}

const at = (r: { code?: string; row?: number; col?: number; name?: string }) => (r.row !== undefined ? `${r.name ?? r.code} (${r.code} at row ${r.row} col ${r.col})` : r.name ?? r.code ?? '');

const SCORE_HINTS: Record<string, string> = {
  power: 'every gun, engine and tool should touch a store, conduit, generator or the core, with enough generation behind it',
  symmetry: 'mirror the left half onto the right',
  armourOutside: 'keep the core, generators and stores inside; hull or armour on the outside',
  enginesAft: 'engines at the back, facing v',
  gunsOut: 'fixed guns facing ^; side guns on their own side facing out',
  compactness: 'fill the gaps: fewer holes and spikes',
  lean: 'too much of the ship is power plant: fewer stores and generators, more hull, armour and the parts the role is for',
};

/** The message after a try: what to fix, most important first */
export function feedbackMessage(f: FeedbackInput): string {
  const max = f.maxItems ?? 8, out: string[] = [];
  const cap = <T>(xs: T[], fmt: (x: T) => string) => [...xs.slice(0, max).map(fmt), ...(xs.length > max ? [`... and ${xs.length - max} more`] : [])];
  if (f.gridErrors?.length) {
    out.push("I couldn't read your grid:");
    out.push(...cap(f.gridErrors, (e) => `- ${e.row !== undefined ? `row ${e.row} col ${e.col}: ` : ''}${e.message}`));
    if (f.gridWarnings?.length) out.push('Also:', ...cap(f.gridWarnings, (w) => `- ${w}`).slice(0, 4));
    out.push('Fix these and send it again (a grid: every row the same width; a part list: one CODE col,row per line).');
    return out.join('\n');
  }
  if (f.buildErrors?.length) {
    out.push("I read your reply but couldn't build the ship from it:");
    out.push(...cap(f.buildErrors, (e) => `- ${e.message}`));
    if (f.gridWarnings?.length) out.push('Also:', ...cap(f.gridWarnings, (w) => `- ${w}`).slice(0, 4));
    if (f.ship) out.push('What you sent, as read:', f.ship);
    out.push('Fix these.');
    return out.join('\n');
  }
  const r = f.result;
  if (!r) return 'No result.';
  out.push(`Checked: ${r.valid ? 'valid' : 'NOT valid'}, score ${r.score}/100. ${r.stats.parts} parts, ${r.stats.cells} cells (${r.stats.width}x${r.stats.height}), mass ${r.stats.mass}, thrust/mass ${r.stats.thrustToMass}, generation ${r.stats.generation} E/s.`);
  if (f.ship) out.push(f.mirror ? 'Your ship as built (whole: the right half is the mirror of your left half):' : 'Your ship as built:', f.ship);
  if (f.gridWarnings?.length) out.push('How your reply was read:', ...cap(f.gridWarnings, (w) => `- ${w}`));
  if (r.errors.length) out.push('Must fix (the game refuses the design until these are gone):', ...cap(r.errors, (e) => `- ${e.message}`));
  if (f.brief?.unmet.length) out.push('Brief not met:', ...cap(f.brief.unmet, (x) => `- ${x}`));
  if (f.mirror && f.brief?.unmet.some((x) => /^needs at least/.test(x))) out.push('- (mirror mode: a part LEFT of the centre line counts twice, as it gets a mirror twin; a part ON the centre line counts once)');
  const p = r.power;
  if (p) {
    const issues: string[] = [];
    for (const u of p.unpowered) issues.push(`${at(u)} gets no power: it must touch a GENERATOR, STORE, CONDUIT, DIODE or the core (hull and armour carry none) that leads back to a generator`);
    for (const c of p.consumers) {
      if (!c.linked || (c.pct >= 95 && c.pctLong >= 90)) continue;
      const what = c.kind === 'weapon' ? 'fires' : c.kind === 'thruster' ? 'pushes' : 'works';
      issues.push(`${at(c)} ${what} at ${c.pct}% over 10 s and ${c.pctLong}% sustained: it needs more power near it (a generator or a bigger store touching it)`);
    }
    if (p.thrust.boostPct < 80 && p.thrust.cruisePct >= 95) issues.push(`engines boost at only ${p.thrust.boostPct}%: a store beside the engines (or a Diode-guarded reserve) would feed the boost`);
    for (const b of p.bottlenecks) issues.push(`${at(b)} is a bottleneck: ${b.limitedPct >= 30 ? `it gives all it can ${b.limitedPct}% of the time` : `it is empty ${b.emptyPct}% of the time`}; add a second route or generation beside it`);
    if (issues.length) out.push('Power:', ...cap(issues, (x) => `- ${x}`));
    else if (r.errors.some((e) => e.code === 'unreachable')) out.push(`Power: the parts joined to the core are powered (${p.generation} E/s made, ${p.storage} E stored); parts not joined to the core don't count until they are.`);
    else if (!p.consumers.length) out.push(`Power: nothing uses power yet (no guns, engines or tools; ${p.generation} E/s made).`);
    else out.push(`Power: everything powered (${p.generation} E/s made, ${p.storage} E stored); guns and engines at full.`);
  }
  if (f.asymmetry?.length) out.push(`Not symmetric: ${f.asymmetry.length} cell(s) differ from their mirror across the core's centre line${f.asymmetryPoints ? ` (it costs ${f.asymmetryPoints} points a cell)` : ''}:`, ...cap(f.asymmetry, (x) => `- ${x}`));
  if (f.brief?.missing.length) out.push('Would be better with:', ...cap(f.brief.missing, (x) => `- ${x}`));
  const weak = (Object.entries(r.scores) as [string, number | null][]).filter(([, v]) => v !== null && v < 0.75).sort((a, b) => a[1]! - b[1]!);
  out.push(`Scores (0-1): ${(Object.entries(r.scores) as [string, number | null][]).map(([k, v]) => `${k} ${v === null ? '-' : v.toFixed(2)}`).join(', ')}.`);
  for (const [k] of weak.slice(0, 3)) if (SCORE_HINTS[k]) out.push(`- ${k}: ${SCORE_HINTS[k]}`);
  // (The role's targets it falls short of: what to add more of)
  const short = (r.fit ?? []).filter((f) => f.share < 1);
  if (short.length) out.push(`- fit: ${short.map((f) => `${f.words} is ${f.value} and the role wants ${f.target}`).join('; ')}`);
  out.push(r.valid && !f.brief?.unmet.length ? 'Improve it if you can.' : 'Fix these.');
  return out.join('\n');
}
