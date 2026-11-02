// The ship library (data/ships/blueprints: player ships, enemy/, dev/) for "start from", and Save: a valid design written
// as dev/gen-<role>-<n>.json, a normal blueprint the in-game F9 panel can fly.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type Blueprint, parseBlueprint, serializeBlueprint } from '../../../common/src/ships/index';
import { type ShipgenContext, check } from '../core/index';
import { EngineError } from './errors';

export interface LibraryShip { id: string; name: string; group: string }

const GROUPS: [string, string][] = [['', 'Player ships'], ['dev', 'Dev ships'], ['enemy', 'Enemy ships']];

export function listLibrary(blueprints: string): LibraryShip[] {
  const out: LibraryShip[] = [];
  for (const [sub, group] of GROUPS) {
    const d = sub ? join(blueprints, sub) : blueprints;
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
      const id = `${sub ? `${sub}/` : ''}${f.slice(0, -5)}`;
      let name = id;
      try { name = JSON.parse(readFileSync(join(d, f), 'utf8')).name || id; } catch { continue; }
      out.push({ id, name, group });
    }
  }
  return out;
}

const ID = /^(?:(dev|enemy)\/)?([\w.-]+)$/;

export function loadLibrary(blueprints: string, id: string): Blueprint {
  const m = ID.exec(id);
  if (!m || m[2].startsWith('.')) throw new EngineError(400, `bad ship id: ${id}`);
  const p = join(blueprints, ...(m[1] ? [m[1]] : []), `${m[2]}.json`);
  if (!existsSync(p)) throw new EngineError(404, `no ship ${id}`);
  return parseBlueprint(readFileSync(p, 'utf8'));
}

/** A blueprint from the page, read the way the game reads one */
export function blueprintFrom(x: unknown): Blueprint {
  if (!x || typeof x !== 'object') throw new EngineError(400, 'no blueprint');
  try { return parseBlueprint(JSON.stringify(x)); } catch (e) { throw new EngineError(400, `not a blueprint: ${(e as Error).message}`); }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'ship';

export function saveGenerated(ctx: ShipgenContext, dev: string, bp: Blueprint, role: string): { id: string; file: string; name: string } {
  const result = check(ctx, bp);
  if (!result.valid) throw new EngineError(422, `not valid, not saved: ${result.errors.slice(0, 3).map((e) => e.message).join('; ')}`);
  mkdirSync(dev, { recursive: true });
  const stem = `gen-${slug(role)}-`;
  const taken = readdirSync(dev).map((f) => (f.startsWith(stem) && f.endsWith('.json') ? Number(f.slice(stem.length, -5)) : 0)).filter(Number.isFinite);
  const n = Math.max(0, ...taken) + 1;
  const file = join(dev, `${stem}${n}.json`);
  writeFileSync(file, serializeBlueprint(bp), { flag: 'wx' });
  return { id: `dev/${stem}${n}`, file, name: bp.name };
}
