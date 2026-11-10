import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readGameDataFiles } from '../loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { validateGameData } from '../validateGameData.js';
import type { GameDataFiles } from '../GameData.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigCached(dataDir);

const problems = (edit: (f: any, s: any) => void) => {
  const f = structuredClone(files) as any;
  const s = structuredClone(ships) as any;
  edit(f, s);
  return validateGameData(f as GameDataFiles, { ships: s });
};

describe('validate.extras', () => {
  it('the real data has no errors, and no warnings outside the generated ship files', () => {
    expect(problems(() => {}).filter((x) => x.level === 'error' || !x.file.startsWith('ships/'))).toEqual([]);
  });

  it('catches a launched mob that mobs.json does not have', () => {
    const p = problems((_f, s) => { s.catalog.functions.functions.find((d: any) => d.launches).launches.mob = 'ember_dronee'; });
    expect(p.some((x) => x.level === 'error' && /launches\.mob$/.test(x.path) && /did you mean "ember_drone"/.test(x.message))).toBe(true);
  });

  it('catches an unbalanced placeholder and a string that is not text', () => {
    const p = problems((f) => { f.strings['people.goodbye'] = 'Bye {name'; f.strings['people.ok'] = 3; });
    expect(p.some((x) => x.file === 'strings.json' && x.path === 'people.goodbye')).toBe(true);
    expect(p.some((x) => x.file === 'strings.json' && x.path === 'people.ok')).toBe(true);
  });

  it('catches a terrain file named for no system, and a malformed mob', () => {
    const p = problems((f) => { f.terrain.nowhere = f.terrain.ashfall_surface; delete f.mobs.mobs.scrap_mite.blast; });
    expect(p.some((x) => x.file === 'terrain' && x.path === 'nowhere')).toBe(true);
    expect(p.some((x) => x.file === 'mobs.json' && x.path === 'mobs.scrap_mite.blast')).toBe(true);
  });

  it('catches a malformed terrain outline', () => {
    const p = problems((f) => { f.terrain.ashfall_surface.rocks[0] = [[0, 0], [1, 1]]; f.terrain.ashfall_surface.rocks[1][0] = [1]; });
    expect(p.some((x) => x.file === 'terrain/ashfall_surface.json' && x.path === 'rocks[0]')).toBe(true);
    expect(p.some((x) => x.file === 'terrain/ashfall_surface.json' && x.path === 'rocks[1][0]')).toBe(true);
  });

  it('catches a siege roster naming a missing design, and a bastion naming no profile', () => {
    const p = problems((f) => { f.rules.sieges.profiles.selene.roster[0].ship = 'scrap_mitee'; f.systems.systems.find((x: any) => x.id === 'selene_siege').surface.bastion.profile = 'nowhere'; });
    expect(p.some((x) => x.file === 'rules.json' && x.path === 'sieges.profiles.selene.roster[0].ship' && /did you mean "scrap_mite"/.test(x.message))).toBe(true);
    expect(p.some((x) => x.file === 'systems.json' && /bastion\.profile$/.test(x.path) && /unknown siege profile "nowhere"/.test(x.message))).toBe(true);
  });
});
