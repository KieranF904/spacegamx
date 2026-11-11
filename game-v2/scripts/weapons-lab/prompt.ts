// The prompt for the weapon-editing model: the weapon data schema (the real TypeScript types, pulled from the source so
// they never drift), the ids a row may reference (read live from data/), the house rules (short), the selected weapon's
// JSON, and the request. It asks for one JSON object and nothing else.
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { ROOT, DATA_DIR } from './paths';
import { loadSources } from './catalogue';

/** FunctionDef members a weapon model row uses (the interface has many more for engines, shields, cargo...) */
const ROW_FIELDS = new Set(['id', 'pieces', 'hpScale', 'demand', 'priority', 'fireInterval', 'fire', 'weapon', 'mount', 'mounting', 'exclusive', 'ports']);

/** The source text of one interface (optionally only the named members), comments kept: they are the rules */
export function interfaceText(file: string, name: string, only?: Set<string>): string {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  let out = '';
  src.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== name) return;
    const members = n.members.filter((m) => !only || (m.name && only.has(m.name.getText())));
    out = `interface ${name} {\n${members.map((m) => '  ' + m.getFullText(src).trim().replace(/\n\s*/g, '\n  ')).join('\n')}\n}`;
  });
  return out;
}

/** A type alias's source line, e.g. `type FireModel = 'cycle' | ...` */
function aliasText(file: string, name: string): string {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  let out = '';
  src.forEachChild((n) => { if (ts.isTypeAliasDeclaration(n) && n.name.text === name) out = n.getText(src); });
  return out;
}

/** The weapon data schema as text: the TS types plus the validator's rules, with the live id lists */
export function schemaText(dir = DATA_DIR): string {
  const types = join(ROOT, 'common', 'src', 'ships', 'types.ts'), tuning = join(ROOT, 'common', 'src', 'ships', 'tuning.ts');
  const src = loadSources(dir);
  const pieces = JSON.parse(readFileSync(join(dir, 'ships', 'pieces.json'), 'utf-8')), materials = JSON.parse(readFileSync(join(dir, 'ships', 'materials.json'), 'utf-8'));
  return [
    'A weapon is one row of data/ships/models.json (a "model"). Its TypeScript shape (only the members a weapon uses):',
    interfaceText(types, 'FunctionDef', ROW_FIELDS),
    interfaceText(types, 'MountingRules'),
    aliasText(types, 'Mount'), aliasText(types, 'FireModel'), interfaceText(types, 'FireSpec'),
    interfaceText(types, 'WeaponMods'), aliasText(types, 'WeaponModNumber'),
    'Model rows also carry (all plain JSON): "model": true, "name", "family" (a weapon family, e.g. cannon), "material", "grade" (1..5), "points", "unlock": {"level": n}, "description", "rarity", "category": "weapons", "color", "decor", "sfx", "blast", "guide".',
    'The shell or beam a weapon fires is the "kind" named by its "weapon" field: tuning.json weapons.<kind>. Its tunable numbers:',
    interfaceText(tuning, 'WeaponTuning'),
    '',
    'Validator rules (the game rejects a row that breaks them):',
    '- "id": lower-case letters, digits, _; "model": true; "weapon" must be one of: ' + Object.keys(src.tuning.weapons ?? {}).join(', ') + '.',
    '- "pieces": a non-empty list of piece ids (the shapes it may be built on): ' + (pieces.pieces ?? []).map((p: any) => p.id).join(', ') + '.',
    '- "material" must be one of: ' + (materials.materials ?? []).filter((m: any) => !m.exclusive).map((m: any) => m.id).join(', ') + '. "grade" is an integer 1..5. "family" is required.',
    '- "mounting": attach "back" or "any"; angle "straight" or "right"; arc 1..360; clear: [[right, ahead]] integer cells with ahead >= 1.',
    '- A weapon must be mountable: it needs a free straight edge to fire out of.',
    '- Number changes go in "weaponMods": {"mul": {field: change (0.3 means x1.3)}, "add": {...}, "set": {...}} over the kind\'s tuning, not in a new kind.',
  ].filter(Boolean).join('\n');
}

/** House rules, short */
export const HOUSE_RULES = [
  '- The sim is deterministic and shared by the server and every client: no randomness, no clocks; every number is plain data, times are ticks (60 a second), speeds are units a tick.',
  '- Weapons draw power through ports (an "in" port on a side, with a rate); "demand" is what it asks per cell, "priority" 1..3 who is fed first. Do not add behaviour the data cannot express: only use the fields above and kinds that exist.',
  '- Keep balance sane for its grade: compare with the existing weapons and do not make a weapon strictly better than its family with no cost.',
  '- "exclusive" is only for the game\'s own enemy weapons: never set it.',
].join('\n');

export interface PromptInput {
  /** 'modify': change `weapon`; 'new': create a different weapon (`weapon`, if given, is the example to start from) */
  mode: 'modify' | 'new';
  weapon?: unknown;
  /** The id the reply's row will get */
  id: string;
  request: string;
  /** Earlier requests on this draft, oldest first */
  history?: string[];
}

export function buildPrompt(input: PromptInput, dir = DATA_DIR): { system: string; user: string } {
  const system = [
    'You edit weapon data for a deterministic multiplayer space game. You answer with ONE JSON object: the complete weapon row, valid against the schema, and nothing else (no prose, no code fences).',
    '', 'SCHEMA', schemaText(dir), '', 'HOUSE RULES', HOUSE_RULES,
  ].join('\n');
  const user = [
    input.mode === 'modify' ? `Modify this weapon. Return the whole changed row with "id": "${input.id}".` : `Create a new weapon with "id": "${input.id}". Return the whole row.`,
    input.weapon ? `${input.mode === 'modify' ? 'CURRENT WEAPON' : 'EXAMPLE OF A WEAPON ROW'}:\n${JSON.stringify(input.weapon, null, 1)}` : '',
    input.history?.length ? `EARLIER REQUESTS ON THIS DRAFT:\n${input.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
    `REQUEST:\n${input.request}`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}
