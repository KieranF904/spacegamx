/**
 * @contract server.data.validate
 * owns:       load-time validation of the game data files: shape against the interfaces, then every cross-referenced
 *             id resolves
 * needs:      validate/* (one validator per data file, shared context), GameDataFiles; browser-safe: no Node imports
 * invariants: the real data has no errors, with and without the ship files — server/src/data/validateGameData.test.ts
 *             a dangling station, person, boss design or unknown weapon kind is caught —
 *             server/src/data/validateGameData.test.ts
 * extend:     a new data file is a shape spec in validateShapes.ts and a validate<File> function in validate/, called below
 */

/**
 * Load-time validation of the game data files (docs/review-2026-10-22.md §3.3).
 *
 * Two passes:
 *   1. Shape: each file against the TypeScript interfaces the code reads it
 *      through (QuestDef, PersonDef, BossDef, FactionsFile, ItemDef, ...):
 *      required fields present and of the right type. Unknown keys on the
 *      objects that have a fixed schema are warnings (keys starting with `_`
 *      are comments and always allowed).
 *   2. Cross-reference: every id used anywhere resolves: stations, systems,
 *      people, bosses, factions, quests, items, recipes, licences, ship plans
 *      and enemy designs, arenas, surfaces, weapon kinds, part functions.
 *
 * Checks that need the ship data (plans, enemy designs, functions, weapon
 * kinds, generated part ids) run only when `opts.ships` is given; GameData
 * alone validates the rest.
 *
 * Browser-safe (no Node imports): proto mode builds GameData in the client.
 */

import type { GameDataFiles } from './GameData.js';
import { Ctx, type DataProblem } from './validateShapes.js';
import { checkShapes, createContext, type ShipDataFiles, type ValidateOptions } from './validate/context.js';
import { validateSystems } from './validate/systems.js';
import { validateStations } from './validate/stations.js';
import { validateItems } from './validate/items.js';
import { validateRecipes } from './validate/recipes.js';
import { validateMining } from './validate/mining.js';
import { validateFactions } from './validate/factions.js';
import { validateBosses } from './validate/bosses.js';
import { validateQuests } from './validate/quests.js';
import { validatePeople } from './validate/people.js';
import { validateCodex } from './validate/codex.js';
import { validateAchievements } from './validate/achievements.js';
import { validateTutorial } from './validate/tutorial.js';
import { validateShipData } from './validate/shipData.js';

export type { DataProblem, ShipDataFiles, ValidateOptions };

export function validateGameData(files: GameDataFiles, opts: ValidateOptions = {}): DataProblem[] {
  const c = new Ctx();
  const f = files as unknown as Record<string, any>;
  // Pass 1: shapes; pass 2: every id resolves, one validator per data file
  checkShapes(c, f, opts.ships);
  const v = createContext(c, f, opts.ships);
  validateSystems(v);
  validateStations(v);
  validateItems(v);
  validateRecipes(v);
  validateMining(v);
  validateFactions(v);
  validateBosses(v);
  validateQuests(v);
  validatePeople(v);
  validateCodex(v);
  validateAchievements(v);
  validateTutorial(v);
  validateShipData(v);
  return c.problems;
}

/** One problem per line, errors first */
export function formatProblems(problems: DataProblem[]): string {
  return [...problems]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
    .map((p) => `  ${p.level === 'error' ? 'ERROR' : 'warn '} ${p.file}${p.path ? ` ${p.path}` : ''}: ${p.message}`)
    .join('\n');
}

/**
 * Validate and act on it: in development and tests (NODE_ENV !== 'production')
 * any error throws with the full list; in production (and in a browser, where
 * there's no NODE_ENV) problems are logged and loading carries on.
 */
export function checkGameData(files: GameDataFiles, opts: ValidateOptions = {}): DataProblem[] {
  const problems = validateGameData(files, opts);
  if (!problems.length) return problems;
  const errors = problems.filter((p) => p.level === 'error');
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const strictMode = env !== undefined && env.NODE_ENV !== 'production';
  if (errors.length && strictMode) {
    throw new Error(`Game data has ${errors.length} error(s)${problems.length > errors.length ? ` and ${problems.length - errors.length} warning(s)` : ''}:\n${formatProblems(problems)}`);
  }
  const warnings = problems.length - errors.length;
  if (errors.length || (warnings && !(env?.VITEST))) {
    console.warn(`[GameData] ${errors.length} data error(s), ${warnings} warning(s):\n${formatProblems(problems)}`);
  }
  return problems;
}
