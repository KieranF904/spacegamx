// The words a model reads: the system prompt (rules from docs/areas/energy.md, the grid format, the legend for the
// brief's tier, a worked example, the brief) and the feedback after each try (a check() result, made specific).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getVariant, parseBlueprint } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import { type LegendEntry, type TierBand, buildLegend, legendFor, legendText } from './legend';
import { allShapes, pieceShapes, shapeWords } from './shapes';
import { CodeBook, type GridError, blueprintToGrid } from './grid';
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

function exampleText(ctx: ShipgenContext, path: string | undefined): { text: string; codes: Set<string> } | null {
  if (!path) return null;
  const f = join(ctx.dataDir, 'ships/blueprints', `${path}.json`);
  if (!existsSync(f)) return null;
  const bp = parseBlueprint(readFileSync(f, 'utf8'));
  const enc = blueprintToGrid(ctx, bp, { book: new CodeBook(ctx) });
  if (enc.raw.length || enc.book.own.length) return null;
  const codes = new Set<string>();
  for (const m of enc.text.matchAll(/\b([A-Z]{2})(?=[\^>v<a-z0-9]*\b)/g)) codes.add(m[1]);
  return { text: enc.text.trim(), codes };
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
  if (brief.text) out.push(brief.text.trim());
  if (brief.name) out.push(`Call it "${brief.name}".`);
  if (!out.length) out.push('Design a good, balanced small warship.');
  return out.join('\n');
}

export function systemPrompt(ctx: ShipgenContext, brief: Brief): string {
  const role = roleOf(ctx, brief);
  const entries = briefLegend(ctx, brief);
  const ex = exampleText(ctx, role?.example);
  const parts = [
    'You design spaceships for a 2D space game. A ship is a grid of parts. You write the design as a text grid; a checker builds it, runs its power and tells you what to fix.',
    '## Rules\n' + rulesText(ctx),
    '## Grid format\n' + formatText(ctx, entries),
    '## Legend: the only codes you may use (each line: what it is, its size, how it faces, what it does with power)\n' + legendText(entries),
  ];
  if (ex) parts.push('## Example: a good design (study how power flows from generators through stores to every gun and engine)\n' + ex.text);
  parts.push('## Your brief\n' + briefText(ctx, brief));
  parts.push('## Reply\nReply with the design only: the name: line, grid:, the rows, and end. No other words.');
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
  const r = f.result;
  if (!r) return 'No result.';
  out.push(`Checked: ${r.valid ? 'valid' : 'NOT valid'}, score ${r.score}/100. ${r.stats.parts} parts, ${r.stats.cells} cells (${r.stats.width}x${r.stats.height}), mass ${r.stats.mass}, thrust/mass ${r.stats.thrustToMass}, generation ${r.stats.generation} E/s.`);
  if (f.gridWarnings?.length) out.push('How your reply was read:', ...cap(f.gridWarnings, (w) => `- ${w}`));
  if (r.errors.length) out.push('Must fix (the game refuses the design until these are gone):', ...cap(r.errors, (e) => `- ${e.message}`));
  if (f.brief?.unmet.length) out.push('Brief not met:', ...cap(f.brief.unmet, (x) => `- ${x}`));
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
  if (f.brief?.missing.length) out.push('Would be better with:', ...cap(f.brief.missing, (x) => `- ${x}`));
  const weak = (Object.entries(r.scores) as [string, number | null][]).filter(([, v]) => v !== null && v < 0.75).sort((a, b) => a[1]! - b[1]!);
  out.push(`Scores (0-1): ${(Object.entries(r.scores) as [string, number | null][]).map(([k, v]) => `${k} ${v === null ? '-' : v.toFixed(2)}`).join(', ')}.`);
  for (const [k] of weak.slice(0, 3)) if (SCORE_HINTS[k]) out.push(`- ${k}: ${SCORE_HINTS[k]}`);
  out.push(r.valid && !f.brief?.unmet.length ? 'Improve it if you can, and reply with the whole design in the same format.' : 'Fix these and reply with the whole corrected design in the same format.');
  return out.join('\n');
}
