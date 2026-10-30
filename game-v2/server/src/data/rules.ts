/**
 * Tuning (data/rules.json) and player-facing text (data/strings.json).
 *
 * Every module keeps its own defaults in code; what the data files give is
 * merged over them, so a missing file, section or key changes nothing.
 */

import type { SiegeRules } from '../game/Sieges.js';
import type { SurfaceRules } from '../game/Surfaces.js';
import type { EventRules } from '../game/Events.js';
import type { OpsRules } from '../game/Operations.js';
import type { MemoryRules } from '../game/SystemMemory.js';

/** data/rules.json: one section per module, each merged over that module's defaults */
export interface RulesFile {
  sieges?: RulesPatch<SiegeRules>;
  surfaces?: RulesPatch<SurfaceRules>;
  events?: RulesPatch<EventRules>;
  operations?: RulesPatch<OpsRules>;
  /** What's remembered of a system left empty, and how it mends (game/SystemMemory.ts) */
  memory?: RulesPatch<MemoryRules>;
}

/** data/strings.json: flat, dotted keys (`people.goodbye`) to text with `{name}` placeholders */
export type StringsFile = Record<string, string>;

/** Deep partial of a rules section, as it may come from data */
export type RulesPatch<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? RulesPatch<T[K]> : T[K] };

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `patch` over `defaults`: objects merge key by key, anything else (numbers, strings, arrays) replaces */
export function mergeRules<T>(defaults: T, patch: unknown): T {
  if (!plain(defaults) || !plain(patch)) return patch === undefined || patch === null ? defaults : (patch as T);
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(patch)) out[k] = k in defaults ? mergeRules((defaults as Record<string, unknown>)[k], v) : v;
  return out as T;
}

/** Fill `{name}` placeholders (unknown ones are left as they are) */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Looks up a module's text by key and fills it in */
export type Texts<K extends string> = (key: K, vars?: Record<string, string | number>) => string;

/** A module's text: its own defaults, with whatever strings.json has for the same keys */
export function texts<K extends string>(defaults: Record<K, string>, strings: StringsFile | undefined): Texts<K> {
  const table: Record<string, string> = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const s = strings?.[k];
    if (typeof s === 'string') table[k] = s;
  }
  return (key, vars) => fmt(table[key], vars);
}
