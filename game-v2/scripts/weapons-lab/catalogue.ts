// The weapon list, read live from the game's own data on every call, so a weapon added to the game appears at once:
//   models   data/ships/models.json rows with a `weapon` (the player's named guns; `exclusive` ones are the game's own)
//   legacy   data/ships/functions.json rows with a `weapon` (what enemies and bosses fly)
//   kinds    data/ships/tuning.json `weapons.<kind>` (the shell/beam behind each of the above, boss-only kinds too)
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './paths';
import { weaponStats, type Stat } from './stats';

export type Source = 'model' | 'legacy' | 'kind' | 'draft';
export interface WeaponEntry {
  /** Unique in the list: the model/function id, or `kind:<kind>` */
  id: string;
  name: string;
  source: Source;
  /** player: a model players can fit; enemy: exclusive or legacy rows and raw kinds */
  owner: 'player' | 'enemy';
  /** Shell or beam kind (tuning.json weapons.<kind>) */
  kind: string;
  family?: string;
  description?: string;
  /** Audio refs: the model's sfx names, and which of them audio.json knows */
  audio: { sfx?: string; sfxTurret?: string; known: string[] };
  stats: Stat[];
  raw: unknown;
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

/** The data files the lab reads (models, functions, tuning, audio) */
export function loadSources(dir = DATA_DIR) {
  const audioFile = join(dir, 'audio.json');
  return {
    models: read(join(dir, 'ships', 'models.json')).models as any[],
    functions: read(join(dir, 'ships', 'functions.json')).functions as any[],
    tuning: read(join(dir, 'ships', 'tuning.json')),
    audio: existsSync(audioFile) ? read(audioFile) : {},
  };
}

/** Every key and string in audio.json, wherever nested (a sound name is "known" when it appears) */
function audioNames(audio: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(audio)) audio.forEach((a) => audioNames(a, out));
  else if (audio && typeof audio === 'object') for (const [k, v] of Object.entries(audio)) { out.add(k); audioNames(v, out); }
  else if (typeof audio === 'string') out.add(audio);
  return out;
}

/** A weapon row (a models.json model, or a draft) as a list entry */
export function modelEntry(m: any, tuning: any, names: Set<string>, source: Source = 'model'): WeaponEntry {
  const known = [m.sfx, m.sfxTurret].filter((s) => s && names.has(s)) as string[];
  return { id: m.id, name: m.name ?? m.id, source, owner: m.exclusive ? 'enemy' : 'player', kind: m.weapon, family: m.family, description: m.description, audio: { sfx: m.sfx, sfxTurret: m.sfxTurret, known }, stats: weaponStats(m, tuning), raw: m };
}

export function listWeapons(dir = DATA_DIR): WeaponEntry[] {
  const src = loadSources(dir), names = audioNames(src.audio);
  const out: WeaponEntry[] = [];
  for (const m of src.models) if (m.weapon) out.push(modelEntry(m, src.tuning, names));
  for (const f of src.functions) {
    if (!f.weapon) continue;
    const known = [f.sfx, f.sfxTurret].filter((s) => s && names.has(s)) as string[];
    out.push({ id: f.id, name: f.name ?? f.id, source: 'legacy', owner: 'enemy', kind: f.weapon, description: f.description, audio: { sfx: f.sfx, sfxTurret: f.sfxTurret, known }, stats: weaponStats(f, src.tuning), raw: f });
  }
  for (const [kind, def] of Object.entries<any>(src.tuning.weapons ?? {})) out.push({ id: `kind:${kind}`, name: kind, source: 'kind', owner: 'enemy', kind, audio: { known: [] }, stats: weaponStats({ weapon: kind }, src.tuning), raw: def });
  return out;
}

/** A draft's row as a list entry (its stats and audio refs as the game's data would give them) */
export function draftEntry(model: any, dir = DATA_DIR): WeaponEntry {
  const src = loadSources(dir);
  return modelEntry(model, src.tuning, audioNames(src.audio), 'draft');
}

export const getWeapon =(id: string, dir = DATA_DIR) => listWeapons(dir).find((w) => w.id === id);
