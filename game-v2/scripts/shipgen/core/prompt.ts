// The words a model reads: the system prompt (rules from docs/areas/energy.md, the grid format, the legend for the
// brief's tier, a worked example, the brief) and the feedback after each try (a check() result, made specific).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getVariant, parseBlueprint } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { type LegendEntry, type TierBand, buildLegend, legendFor, legendText } from './legend';
import { allShapes, pieceShapes, shapeWords } from './shapes';
import { CodeBook, type GridError, blueprintToGrid } from './grid';
import type { Blueprint } from '../../../common/src/ships/index';
import { halfOf } from './mirror';
import { blueprintToParts, boxSize } from './partlist';
import type { CheckResult } from './check';
import { type BriefCheck, type Role, findRole, selectorWords } from './roles';

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

function roleOf(ctx: ShipgenContext, brief: Brief): Role | undefined {
  if (!brief.role) return undefined;
  if (typeof brief.role !== 'string') return brief.role;
  const r = findRole(ctx, brief.role);
  if (!r) throw new Error(`no role "${brief.role}" in data/shipgen/roles.json`);
  return r;
}

/** The grid format as the model reads it */
export function formatText(ctx: ShipgenContext, entries: LegendEntry[]): string {
  const shaped = allShapes(ctx.catalog).filter((s) => !s.box && !s.bespoke && s.letter);
  const usable = shaped.filter((s) => entries.some((e) => e.kind === 'structure' || e.pieces.includes(s.piece)));
  const boxes = allShapes(ctx.catalog).filter((s) => s.box && s.letter);
  // (Examples from the legend itself: a structure code, a 2-cell part that faces out, a 2x2 part, a shaped one)
  const cellsOf = (e: LegendEntry) => getVariant(ctx.catalog, e.pieces[0], 0, false).cells.length;
  const st = (entries.find((e) => e.kind === 'structure' && e.power.role === 'none') ?? entries.find((e) => e.kind === 'structure'))?.code ?? 'HA';
  const two = entries.find((e) => e.kind === 'model' && e.facing === 'free' && cellsOf(e) === 2);
  const lo = st.toLowerCase();
  const tri = shaped[0];
  const sf = entries.find((e) => e.facing === 'free' && !pieceShapes(ctx.catalog, e.pieces[0]).box);
  const lines = [
    'The ship is drawn on a square grid, seen from above. The FRONT of the ship is UP (row numbers grow towards the back).',
    'Line 1 is the column numbers; every other line is a row number, then one token per cell, separated by spaces:',
    '  ..      an empty cell',
    `  ${st.padEnd(8)}the FIRST cell of a part (its top-left cell: the topmost, then leftmost) = its legend code in CAPITALS`,
    `  ${lo.padEnd(8)}every OTHER cell of that part = the same code in small letters: a 2x1 block of hull is "${st} ${lo}", a 2x2 block is "${st} ${lo}" over "${lo} ${lo}"` +
      (two ? `; a ${two.name} (2x1) facing up is "${two.code}^ ${two.code.toLowerCase()}"` : ''),
    `  ${(two?.code ?? 'PI') + '^'}     a part that faces out gets a mark after its code: ^ faces forward (up), v back (down), > right, < left`,
    ...(tri ? [`  ${st}${tri.letter}2    a shaped piece gets its shape letter and number after its code` + (sf ? ` (after any facing mark: ${sf.code}v${pieceShapes(ctx.catalog, sf.pieces[0]).letter}2)` : '')] : []),
    'Every row has the same number of tokens. Parts must not overlap. Two parts of the same code side by side are told apart by their CAPITAL first cells.',
    'Draw only the ship: no empty rows above or below it and no empty columns beside it (there is no canvas to fill; numbers may start anywhere, such as -3). Never send a grid of only "..".',
  ];
  if (usable.length) {
    lines.push('Shapes (only pieces the legend says "shape" need one; any structure part may use them):');
    for (const s of usable) lines.push(`  ${s.letter}1-${s.letter}${s.classes.length} = ${s.piece}: ${s.classes.map((c) => `${s.letter}${c.index} ${shapeWords(c)}`).join(', ')}`);
  }
  if (boxes.length) lines.push(`Square pieces need no shape mark (${boxes.map((s) => `${s.letter}=${s.piece}`).join(', ')} marks exist only to settle a rare ambiguity).`);
  lines.push('Write the design as:', 'name: <a name>', 'grid:', '<the rows>', 'end');
  return lines.join('\n');
}

/** The part-list format as the model reads it (core/partlist.ts) */
export function partsFormatText(ctx: ShipgenContext, entries: LegendEntry[]): string {
  const shaped = allShapes(ctx.catalog).filter((s) => !s.box && !s.bespoke && s.letter);
  const usable = shaped.filter((s) => entries.some((e) => e.kind === 'structure' || e.pieces.includes(s.piece)));
  const st = (entries.find((e) => e.kind === 'structure' && e.power.role === 'none') ?? entries.find((e) => e.kind === 'structure'))?.code ?? 'HA';
  const gun = entries.find((e) => e.power.role === 'weapon' && e.facing === 'free')?.code ?? 'PI';
  const big = entries.find((e) => e.kind === 'model' && e.pieces.length === 1 && boxSize(ctx, e.pieces[0]) === '2x2');
  const two = entries.find((e) => e.kind === 'model' && e.facing === 'free' && e.pieces.length === 1 && boxSize(ctx, e.pieces[0]) === '2x1');
  const tri = shaped[0];
  const lines = [
    'The ship sits on a square grid seen from above. The FRONT of the ship is UP: rows (y) grow towards the back, columns (x) grow to the right; numbers may be negative.',
    'Write the design as a LIST OF PARTS, one per line: its legend code, then its position as col,row. You never draw the grid: the tool places each part.',
    `  ${st} 0,2        a part at column 0, row 2`,
    `  ${gun}^ -1,-2     a part that faces out gets a mark after its code: ^ faces forward (up), v back (down), > right, < left`,
    `  ${(big?.code ?? 'HB')} -3,1 2x2   a part bigger than one cell: its position is its TOP-LEFT cell, and its size (columns x rows) follows; it covers the cells right of and below that cell`,
    ...(two ? [`  ${two.code}v 1,3 1x2   a 2x1 part may stand upright: size 1x2 (across is 2x1, the default)`] : []),
    `  ${st} 2,2 2x1     structure (hull, armour, cargo) may be 1x1 (the default), 2x1, 1x2 or 2x2`,
    ...(tri ? [`  ${st}${tri.letter}2 -3,0     a shaped piece gets its shape letter and number after its code (after any facing mark)`] : []),
    'Parts must not overlap: two parts may never cover the same cell (the tool names any that do). Each part must share a full edge with the rest of the ship.',
  ];
  if (usable.length) {
    lines.push('Shapes (only pieces the legend says "shape" need one; any structure part may use them):');
    for (const s of usable) lines.push(`  ${s.letter}1-${s.letter}${s.classes.length} = ${s.piece}: ${s.classes.map((c) => `${s.letter}${c.index} ${shapeWords(c)}`).join(', ')}`);
  }
  lines.push('Write the design as:', 'name: <a name>', 'parts:', '<one part per line>', 'end');
  return lines.join('\n');
}

/** How mirror mode works, for the system prompt */
export function mirrorText(form: DesignForm): string {
  const what = form === 'parts' ? 'List' : 'Draw';
  return [
    `MIRROR MODE: ${what} only the LEFT HALF of the ship and the parts ON its centre line. The tool adds the right half as the mirror image of your left half, so the ship is always symmetric.`,
    'The centre line runs down the middle of the core. Give the core whole; give everything else only where it is left of that line' + (form === 'grid' ? ' (draw no columns right of the core).' : ' (no column right of the core).'),
    'A part ON the centre line (across it) must look the same mirrored: facing ^ or v, never > or <. A part on the left facing < becomes one facing > on the right; left-handed shapes become right-handed.',
    'Two parts side by side across the centre line (two guns, two engines) come from ONE part just left of it.',
    'Counts in the brief are for the whole ship: a part left of the centre line counts twice (it and its mirror image), a part on the line once.',
  ].join('\n');
}

export type DesignForm = 'grid' | 'parts';

/** A design as the model writes it: grid or part list, the whole ship or (mirror mode) its left half and centre line */
export function designText(ctx: ShipgenContext, bp: Blueprint, opts: { form?: DesignForm; mirror?: boolean; book?: CodeBook } = {}): string {
  const shown = opts.mirror ? halfOf(ctx, bp) : bp;
  return (opts.form === 'parts' ? blueprintToParts(ctx, shown, { book: opts.book }) : blueprintToGrid(ctx, shown, { book: opts.book })).text.trim();
}

function exampleText(ctx: ShipgenContext, path: string | undefined, opts: { form?: DesignForm; mirror?: boolean } = {}): { text: string; codes: Set<string> } | null {
  if (!path) return null;
  const f = join(ctx.dataDir, 'ships/blueprints', `${path}.json`);
  if (!existsSync(f)) return null;
  const bp = parseBlueprint(readFileSync(f, 'utf8'));
  const enc = blueprintToGrid(ctx, bp, { book: new CodeBook(ctx) });
  if (enc.raw.length || enc.book.own.length) return null;
  const codes = new Set<string>();
  for (const m of enc.text.matchAll(/\b([A-Z]{2})(?=[\^>v<a-z0-9]*\b)/g)) codes.add(m[1]);
  if (!opts.form && !opts.mirror) return { text: enc.text.trim(), codes };
  return { text: designText(ctx, bp, opts), codes };
}

/** The legend entries a brief shows: its band's, plus any its example uses */
export function briefLegend(ctx: ShipgenContext, brief: Brief): LegendEntry[] {
  const role = roleOf(ctx, brief), legend = buildLegend(ctx);
  const band = brief.band ?? role?.band ?? { maxLevel: 99 };
  const out = legendFor(legend, band);
  const ex = exampleText(ctx, role?.example);
  for (const e of legend.entries) if (ex?.codes.has(e.code) && !out.includes(e)) out.push(e);
  return out;
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
  const entries = briefLegend(ctx, brief);
  const form = opts.form ?? 'grid';
  const ex = exampleText(ctx, role?.example, opts.form || opts.mirror ? { form, mirror: opts.mirror } : {});
  const how = form === 'parts' ? 'You write the design as a list of parts with positions' : 'You write the design as a text grid';
  const parts = [
    `You design spaceships for a 2D space game. A ship is a grid of parts. ${how}; a checker builds it, runs its power and tells you what to fix.` +
      (opts.staged ? ' You build it in steps: each step adds one system to a ship that already works.' : ''),
    '## Rules\n' + rulesText(ctx),
    (form === 'parts' ? '## Part list format\n' + partsFormatText(ctx, entries) : '## Grid format\n' + formatText(ctx, entries)),
  ];
  if (opts.mirror) parts.push('## Mirror mode\n' + mirrorText(form));
  parts.push('## Legend: the only codes you may use (each line: what it is, its size, how it faces, what it does with power)\n' + legendText(entries));
  if (ex) parts.push(`## Example: a good design${opts.mirror ? ', as its left half and centre line' : ''} (study how power flows from generators through stores to every gun and engine; do not copy it: your ship has its own shape)\n` + ex.text);
  parts.push('## Your brief\n' + briefText(ctx, brief));
  const body = form === 'parts' ? 'the name: line, parts:, one part per line, and end' : 'the name: line, grid:, the rows, and end';
  parts.push(`## Reply\nReply with the design only: ${body}${opts.mirror ? ' (the left half and the centre line only)' : ''}. No other words.`);
  return parts.join('\n\n') + '\n';
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
};

/** The message after a try: what to fix, most important first */
export function feedbackMessage(f: FeedbackInput): string {
  const max = f.maxItems ?? 8, out: string[] = [];
  const cap = <T>(xs: T[], fmt: (x: T) => string) => [...xs.slice(0, max).map(fmt), ...(xs.length > max ? [`... and ${xs.length - max} more`] : [])];
  if (f.gridErrors?.length) {
    out.push("I couldn't read your grid:");
    out.push(...cap(f.gridErrors, (e) => `- ${e.row !== undefined ? `row ${e.row} col ${e.col}: ` : ''}${e.message}`));
    if (f.gridWarnings?.length) out.push('Also:', ...cap(f.gridWarnings, (w) => `- ${w}`).slice(0, 4));
    out.push('Reply with the whole design again, every row the same width, in the format given.');
    return out.join('\n');
  }
  if (f.buildErrors?.length) {
    out.push("I read your reply but couldn't build the ship from it:");
    out.push(...cap(f.buildErrors, (e) => `- ${e.message}`));
    if (f.gridWarnings?.length) out.push('Also:', ...cap(f.gridWarnings, (w) => `- ${w}`).slice(0, 4));
    if (f.ship) out.push('What you sent, as read:', f.ship);
    out.push('Fix these and reply with the whole design again, in the format given.');
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
  out.push(r.valid && !f.brief?.unmet.length ? 'Improve it if you can, and reply with the whole design in the same format.' : 'Fix these and reply with the whole corrected design in the same format.');
  return out.join('\n');
}
