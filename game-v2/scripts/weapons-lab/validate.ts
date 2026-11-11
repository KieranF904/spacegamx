// Checks a weapon draft with the game's own validators: the catalogue loader (loadCatalog: pieces, material, grade,
// mounting rules), validateGameData (shapes and references, only the problems about this row), and the gun range's
// cheat ship (the weapon must be mountable on a ship that fires it, buildCheatShip). Returns plain problem strings.
import { loadCatalog } from '../../common/src/ships/catalog';
import { buildCheatShip } from '../../common/src/gunRange/cheatShip';
import { readGameDataFiles } from '../../server/src/data/loadGameDataFromDisk';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig';
import { validateGameData } from '../../server/src/data/validateGameData';
import type { ShipConfig } from '../../server/src/ships/createShipBridge';
import { DATA_DIR } from './paths';
import { ID_RULE } from './drafts';

/** The game's ship config with the draft's model added (replacing a model of the same id): in memory only */
export function configWith(model: any, dir = DATA_DIR): ShipConfig {
  const cfg = loadShipConfigFromDisk(dir);
  const models = cfg.catalog.models as { models: any[] };
  return { ...cfg, catalog: { ...cfg.catalog, models: { ...models, models: [...models.models.filter((m) => m.id !== model.id), model] } } };
}

export interface Verdict { ok: boolean; problems: string[] }

export function validateModel(model: any, dir = DATA_DIR): Verdict {
  const problems: string[] = [];
  if (!model || typeof model !== 'object' || Array.isArray(model)) return { ok: false, problems: ['the weapon must be a JSON object'] };
  if (typeof model.id !== 'string' || !ID_RULE.test(model.id)) problems.push('id must be lower-case letters, digits and _ (2-48 characters, starting with a letter)');
  if (model.model !== true) problems.push('"model": true is required (a named weapon module)');
  if (typeof model.weapon !== 'string') problems.push('"weapon" must name a shell/beam kind (tuning.json weapons.<kind>)');
  if (problems.length) return { ok: false, problems };

  const cfg = configWith(model, dir);
  if (!cfg.tuning.weapons?.[model.weapon]) problems.push(`weapon kind "${model.weapon}" is not in tuning.json weapons (${Object.keys(cfg.tuning.weapons ?? {}).join(', ')})`);
  let catalog;
  try { catalog = loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink }); } catch (e) { return { ok: false, problems: [...problems, String((e as Error).message)] }; }
  if (!model.exclusive && !buildCheatShip(catalog, model.id)) problems.push('no ship can mount it: check "pieces", "mount" and "mounting" (a gun needs a free straight edge to fire out of)');

  const index = cfg.catalog.models!.models.length - 1;
  const mine = (p: { file: string; path: string; message: string }) => (p.file === 'ships/models.json' && p.path.startsWith(`models[${index}]`)) || p.message.includes(`"${model.id}"`);
  for (const p of validateGameData(readGameDataFiles(dir), { ships: cfg })) {
    // (A recipe is made with the weapon when it joins the game; a draft has none)
    if (p.level === 'error' && mine(p) && !/has no recipe/.test(p.message)) problems.push(`${p.file} ${p.path}: ${p.message}`);
  }
  return { ok: problems.length === 0, problems };
}
