/**
 * @contract common.tutorial.data
 * owns:       validateTutorialData: every problem in a parsed data/tutorial.json, as readable lines
 * needs:      types
 * invariants: the real data/tutorial.json has no problems (also run by the server's data validation) — common/src/tutorial/tutorial.test.ts
 * extend:     a new field in TutorialData gets a check here
 */

import { TUTORIAL_PANELS, type TutorialData } from './types.js';

/** What the validator can check references against (all optional: missing means that check is skipped) */
export interface TutorialRefs {
  /** Is this an item id (listed, or a generated part)? */
  item?: (id: string) => boolean;
  systems?: ReadonlySet<string>;
  /** Station ids by system */
  stations?: ReadonlyMap<string, string>;
}

const KINDS = ['rock', 'drone', 'ring', 'zone', 'exit'];
const TRIGGERS = ['ack', 'rings', 'zoneStop', 'objectsBroken', 'collect', 'panel', 'docked', 'refined', 'partPlaced', 'powered', 'jumped', 'graduate'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y);

/** Every problem in the tutorial data, one line each (empty: fine) */
export function validateTutorialData(raw: unknown, refs: TutorialRefs = {}): string[] {
  const out: string[] = [];
  const err = (path: string, msg: string) => out.push(`${path}: ${msg}`);
  if (!isObj(raw)) return ['tutorial: expected an object'];
  const d = raw as unknown as Partial<TutorialData> & Record<string, unknown>;
  if (!isNum(d.version)) err('version', 'expected a number');

  const y = d.yard;
  if (!isObj(y)) err('yard', 'expected an object');
  else {
    for (const k of ['system', 'station'] as const) if (typeof y[k] !== 'string') err(`yard.${k}`, 'expected a string');
    if (!isPt(y.center)) err('yard.center', 'expected {x, y}');
    for (const k of ['spawnRadius', 'leash', 'keepOut', 'stopSpeed', 'stopTicks'] as const) if (!isNum(y[k]) || (y[k] as number) <= 0) err(`yard.${k}`, 'expected a positive number');
    if (isNum(y.spawnRadius) && isNum(y.leash) && y.spawnRadius >= y.leash) err('yard.spawnRadius', 'must be inside the leash');
    if (isNum(y.keepOut) && isNum(y.leash) && y.keepOut < y.leash) err('yard.keepOut', 'must reach past the leash');
    if (typeof y.system === 'string' && refs.systems && !refs.systems.has(y.system)) err('yard.system', `unknown system "${y.system}"`);
    if (typeof y.station === 'string' && typeof y.system === 'string' && refs.stations && refs.stations.get(y.station) !== y.system) err('yard.station', `"${y.station}" is not a station of ${y.system}`);
  }

  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!Array.isArray(d.steps) || !steps.length) err('steps', 'expected a non-empty list');
  const stepIdSet = new Set<string>();
  steps.forEach((s, i) => {
    const p = `steps[${i}]`;
    if (!isObj(s)) return err(p, 'expected an object');
    if (typeof s.id !== 'string' || !s.id) err(`${p}.id`, 'expected a string');
    else if (stepIdSet.has(s.id)) err(`${p}.id`, `duplicate step "${s.id}"`);
    else stepIdSet.add(s.id);
    if (typeof s.title !== 'string') err(`${p}.title`, 'expected a string');
    if (!Array.isArray(s.lines) || s.lines.length < 1 || s.lines.length > 2 || s.lines.some((l) => !(typeof l === 'string' || (isObj(l) && typeof l.screen === 'string' && typeof l.helm === 'string')))) err(`${p}.lines`, 'expected one or two lines: a string, or {screen, helm}');
    const t = s.trigger;
    if (!isObj(t) || !TRIGGERS.includes(t.kind as string)) err(`${p}.trigger.kind`, `expected one of ${TRIGGERS.join(', ')}`);
    else if (t.kind === 'panel') {
      const list = Array.isArray(t.panels) ? t.panels : [t.panel];
      if (!list.length || list.some((x) => !TUTORIAL_PANELS.includes(x as never))) err(`${p}.trigger.panel`, `expected one of ${TUTORIAL_PANELS.join(', ')} (or a list in panels)`);
    }
    for (const [k, n] of Object.entries(isObj(s.grant) ? s.grant : {})) {
      if (!isNum(n) || n <= 0) err(`${p}.grant.${k}`, 'expected a positive number');
      else if (refs.item && !refs.item(k)) err(`${p}.grant.${k}`, `unknown item "${k}"`);
    }
  });
  if (steps.length && isObj(steps[0]) && steps[0].id !== 'welcome') err('steps[0].id', 'the first step must be "welcome" (TUTORIAL_FIRST_STEP)');
  if (steps.length && isObj(steps[steps.length - 1]) && (steps[steps.length - 1] as { id?: unknown }).id !== 'graduate') err(`steps[${steps.length - 1}].id`, 'the last step must be "graduate"');

  const objects = Array.isArray(d.objects) ? d.objects : [];
  const objIds = new Map<string, string>();
  objects.forEach((o, i) => {
    const p = `objects[${i}]`;
    if (!isObj(o)) return err(p, 'expected an object');
    if (typeof o.id !== 'string' || !o.id) err(`${p}.id`, 'expected a string');
    else if (objIds.has(o.id)) err(`${p}.id`, `duplicate object "${o.id}"`);
    else objIds.set(o.id, o.kind as string);
    if (!KINDS.includes(o.kind as string)) err(`${p}.kind`, `expected one of ${KINDS.join(', ')}`);
    if (typeof o.step !== 'string' || !stepIdSet.has(o.step)) err(`${p}.step`, `unknown step "${String(o.step)}"`);
    if (!isPt(o.at)) err(`${p}.at`, 'expected {x, y}');
    if (!isNum(o.radius) || o.radius <= 0) err(`${p}.radius`, 'expected a positive number');
    if (o.kind === 'rock' || o.kind === 'drone') {
      if (!isNum(o.hp) || o.hp <= 0) err(`${p}.hp`, 'a rock or drone needs a positive hp');
    }
    if (o.kind === 'rock' && isObj(o.drops)) {
      if (!isNum(o.chunks) || o.chunks < 1) err(`${p}.chunks`, 'a rock with drops needs chunks >= 1');
      for (const [k, n] of Object.entries(o.drops)) {
        if (!isNum(n) || n <= 0) err(`${p}.drops.${k}`, 'expected a positive number');
        else if (refs.item && !refs.item(k)) err(`${p}.drops.${k}`, `unknown item "${k}"`);
      }
    }
  });

  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    const refList = [...(Array.isArray(s.targets) ? s.targets : []), ...(isObj(s.trigger) && Array.isArray(s.trigger.objects) ? s.trigger.objects : [])];
    for (const id of refList) if (typeof id !== 'string' || !objIds.has(id)) err(`steps[${i}]`, `unknown object "${String(id)}"`);
    const t: Record<string, unknown> = isObj(s.trigger) ? s.trigger : {};
    const needs = (kind: string, want: string) => {
      if (t.kind !== kind) return;
      const first = Array.isArray(t.objects) ? objIds.get(t.objects[0] as string) : undefined;
      if (first !== want) err(`steps[${i}].trigger.objects`, `${kind} needs a ${want} object first`);
    };
    needs('zoneStop', 'zone');
    needs('jumped', 'exit');
    if ((t.kind === 'rings' || t.kind === 'objectsBroken') && !(Array.isArray(t.objects) && t.objects.length)) err(`steps[${i}].trigger.objects`, `${String(t.kind)} needs objects`);
  });

  const pack = d.starterPack;
  if (!isObj(pack)) err('starterPack', 'expected an object');
  else {
    if (!isNum(pack.credits) || pack.credits < 0) err('starterPack.credits', 'expected a number >= 0');
    const items = isObj(pack.items) ? pack.items : null;
    if (!items || !Object.keys(items).length) err('starterPack.items', 'expected a non-empty bag');
    else for (const [k, n] of Object.entries(items)) {
      if (!isNum(n) || n <= 0 || Math.floor(n) !== n) err(`starterPack.items.${k}`, 'expected a whole number > 0');
      else if (refs.item && !refs.item(k)) err(`starterPack.items.${k}`, `unknown item "${k}"`);
    }
  }
  return out;
}
