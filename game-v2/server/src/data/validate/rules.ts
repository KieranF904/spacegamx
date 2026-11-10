/**
 * @contract validate.rules
 * owns:       rules.json: its sections are known, the siege profiles and turrets resolve against the real ids (bastion profiles
 *             in systems.json, enemy designs, factions), and the number fields the modules read are numbers
 * needs:      validate/context (the ids and reference helpers); browser-safe: no Node imports
 * invariants: the real data has no errors — server/src/data/validateGameData.test.ts
 *             a siege roster naming a missing enemy design or a bastion naming no profile is caught — server/src/data/validate/extras.test.ts
 * extend:     a new cross-reference check for rules.json goes in the function below
 */

import { type V, entries, str } from './context.js';
import { isObj, join, list, typeName } from '../validateShapes.js';

const F = 'rules.json';
const SECTIONS = ['sieges', 'surfaces', 'events', 'operations', 'memory'];

export function validateRules(v: V): void {
  const { c, f, systems } = v;
  const rules = f.rules;
  if (rules === undefined) return;
  if (!isObj(rules)) { c.err('', `must be an object, not ${typeName(rules)}`, F); return; }
  for (const [k, sec] of entries(rules)) {
    if (!SECTIONS.includes(k)) c.warn(k, `unknown section (${SECTIONS.join(', ')}); no module reads it`, F);
    else if (!isObj(sec)) c.err(k, `must be an object, not ${typeName(sec)}`, F);
  }
  // Numbers stay finite numbers: a bad one would silently replace a module's default
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'number' && !Number.isFinite(x)) c.err(path, 'not a finite number', F);
    else if (isObj(x)) for (const [k, y] of entries(x)) walk(y, join(path, k));
  };
  for (const k of SECTIONS) walk(rules[k], k);

  const s = rules.sieges;
  if (!isObj(s)) return;
  const profiles = new Map(entries(s.profiles));
  if (s.defaultProfile !== undefined) v.ref(F, 'sieges.defaultProfile', 'siege profile', profiles, s.defaultProfile);
  const unit = (path: string, u: unknown) => {
    if (!isObj(u)) { c.err(path, `must be an object, not ${typeName(u)}`, F); return; }
    v.design(F, `${path}.ship`, u.ship);
    if (u.faction !== undefined) v.faction(F, `${path}.faction`, u.faction);
    for (const k of ['cost', 'from', 'until', 'hp', 'damage', 'range', 'aggro', 'group']) {
      if (u[k] !== undefined && typeof u[k] !== 'number') c.err(`${path}.${k}`, `must be a number, not ${typeName(u[k])}`, F);
    }
    if (typeof u.from !== 'number') c.err(`${path}.from`, 'required number (the first night it appears)', F);
  };
  // A profile is named by a surface's bastion (systems.json surface.bastion.profile): it must exist, and be used
  const used = new Set<string>();
  for (const [sid, sy] of systems) {
    const name = str(sy?.surface?.bastion?.profile);
    if (name === undefined) continue;
    used.add(name);
    v.ref('systems.json', `systems[${sid}].surface.bastion.profile`, 'siege profile', profiles, name);
  }
  for (const [id, p] of profiles) {
    if (!used.has(id)) c.warn(`sieges.profiles.${id}`, 'no surface bastion uses this profile', F);
    const P = `sieges.profiles.${id}`;
    if (!isObj(p)) { c.err(P, `must be an object, not ${typeName(p)}`, F); continue; }
    if (typeof p.name !== 'string') c.err(`${P}.name`, 'required string', F);
    if (!Array.isArray(p.roster) || !p.roster.length) c.err(`${P}.roster`, 'required: at least one unit', F);
    list(p.roster).forEach((u, i) => unit(`${P}.roster[${i}]`, u));
    list(p.bosses?.ships).forEach((u, i) => unit(`${P}.bosses.ships[${i}]`, u));
  }
  for (const [kind, t] of entries(s.turrets)) {
    list(t?.marks).forEach((m, i) => v.design(F, `sieges.turrets.${kind}.marks[${i}].design`, str(m?.design)));
  }
}
