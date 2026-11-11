import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readGameDataFiles } from './loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { validateGameData, checkGameData, formatProblems, type DataProblem } from './validateGameData.js';
import type { GameDataFiles } from './GameData.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigCached(dataDir);

const errors = (p: DataProblem[]) => p.filter((x) => x.level === 'error');
const broken = (edit: (f: any, s: any) => void) => {
  const f = structuredClone(files) as any;
  const s = structuredClone(ships) as any;
  edit(f, s);
  return errors(validateGameData(f as GameDataFiles, { ships: s }));
};

describe('game data validation', () => {
  it('the real data has no errors', () => {
    const problems = validateGameData(files, { ships });
    const warnings = problems.filter((p) => p.level === 'warning');
    if (warnings.length) console.log(`data warnings:\n${formatProblems(warnings)}`);
    expect(formatProblems(errors(problems))).toBe('');
  });

  it('the real data validates clean: no warnings but functions not yet in the wire dictionary (a protocol bump)', () => {
    const rest = validateGameData(files, { ships }).filter((p) => !(p.level === 'warning' && p.file === 'ships/functions.json' && p.message.includes('wire DICTIONARY')));
    expect(formatProblems(rest)).toBe('');
  });

  it('the real data passes without the ship files too (GameData on its own)', () => {
    expect(formatProblems(errors(validateGameData(files)))).toBe('');
  });

  it('catches a dangling station id in a quest step', () => {
    const e = broken((f) => {
      const q = f.quests.quests.find((x: any) => x.steps.some((s: any) => s.type === 'dock'));
      q.steps.find((s: any) => s.type === 'dock').station = 'sol_station_centrall';
    });
    expect(e.some((p) => p.file === 'quests.json' && /steps\[\d+\]\.station$/.test(p.path) && /unknown station "sol_station_centrall".*did you mean "sol_station_central"/.test(p.message))).toBe(true);
  });

  it('catches a person placed at a station that does not exist', () => {
    const e = broken((f) => { f.people.people[0].at = { station: 'nowhere_station' }; });
    expect(e.some((p) => p.file === 'people.json' && p.path === 'people[0].at.station')).toBe(true);
  });

  it('catches a missing boss design', () => {
    const e = broken((f, s) => {
      delete s.enemies.boss_rustjaw;
      f.bosses.bosses.boss_hoarfrost.design = 'boss_nope';
    });
    expect(e.some((p) => p.file === 'bosses.json' && p.path === 'bosses.boss_rustjaw')).toBe(true);
    expect(e.some((p) => p.file === 'bosses.json' && p.path === 'bosses.boss_hoarfrost.design')).toBe(true);
  });

  it('catches an unknown weapon kind (a function naming one, and a projectile the client cannot draw)', () => {
    const e = broken((_f, s) => {
      s.catalog.functions.functions.find((d: any) => d.id === 'railgun').weapon = 'railgunn';
      s.tuning.weapons.plasma_bolt = { type: 'projectile', speed: 20, damage: 5, life: 60 };
    });
    expect(e.some((p) => p.file === 'ships/functions.json' && /unknown weapon kind.*"railgunn"/.test(p.message))).toBe(true);
    expect(e.some((p) => p.file === 'ships/tuning.json' && p.path === 'weapons.plasma_bolt' && p.message.includes('WEAPON_KIND_TYPE'))).toBe(true);
  });

  it('catches a function with no display name', () => {
    const e = broken((_f, s) => { s.catalog.functions.functions.push({ id: 'tractor', pieces: '*', hpScale: 1 }); });
    expect(e.some((p) => p.message.includes('"tractor" has no display name in FN_NAMES'))).toBe(true);
  });

  it('catches dangling dialogue targets, spawn systems and items', () => {
    const e = broken((f) => {
      f.people.people[0].topics[0].lines.push({ reveal: 'no_such_job' }, { give: { unobtainium: 1 } });
      f.factions.spawns.sool = f.factions.spawns.sol;
      f.quests.quests[0].requires = ['main_99'];
    });
    expect(e.some((p) => p.message.includes('unknown quest "no_such_job"'))).toBe(true);
    expect(e.some((p) => p.message.includes('unknown item "unobtainium"'))).toBe(true);
    expect(e.some((p) => p.path === 'spawns.sool' && p.message.includes('did you mean "sol"'))).toBe(true);
    expect(e.some((p) => p.path === 'quests[0].requires[0]')).toBe(true);
  });

  it('loot tables: a missing item, a weight of 0, a dangling table or bad rolls are caught', () => {
    const at = (e: DataProblem[]) => e.map((p) => `${p.file} ${p.path}`);
    expect(at(broken((f) => { f.loot.tables.scrap_common.entries[0].item = 'scrap_electronix'; }))).toContain('loot.json tables.scrap_common.entries[0].item');
    expect(at(broken((f) => { f.loot.tables.scrap_rare.entries[1].weight = 0; }))).toContain('loot.json tables.scrap_rare.entries[1].weight');
    expect(at(broken((f) => { f.factions.factions.scrapborn.ships.scrap_hulk.drops[1].table = 'scrap_rarer'; }))).toContain('factions.json factions.scrapborn.ships.scrap_hulk.drops[1].table');
    expect(at(broken((f) => { f.bosses.bosses.boss_tallyman.drops[0].rolls = 0; }))).toContain('bosses.json bosses.boss_tallyman.drops[0].rolls');
    expect(at(broken((f) => { f.factions.spawns.sol_scrap_nest.loot.scrap_crawler.eliteDrop = 'nope'; }))).toContain('factions.json spawns.sol_scrap_nest.loot.scrap_crawler.eliteDrop');
  });

  it('catches shape errors: a missing required field and a wrong type', () => {
    const e = broken((f) => {
      delete f.quests.quests[0].intro;
      f.stations.stations[0].radius = '300';
      f.quests.quests[1].steps.push({ type: 'teleport' });
    });
    expect(e.some((p) => p.path === 'quests[0].intro' && p.message === 'missing required field')).toBe(true);
    expect(e.some((p) => p.path === 'stations[0].radius' && p.message.includes('expected a number'))).toBe(true);
    expect(e.some((p) => p.path.startsWith('quests[1].steps') && p.message.includes('unknown step type "teleport"'))).toBe(true);
  });

  it('unknown fields are warnings, not errors', () => {
    const f = structuredClone(files) as any;
    f.quests.quests[0].rewardz = { xp: 1 };
    const problems = validateGameData(f, { ships });
    expect(problems.some((p) => p.level === 'warning' && p.path === 'quests[0].rewardz')).toBe(true);
    expect(errors(problems)).toEqual([]);
  });

  it('checks lodestones: orbit or position, unique ids, and a camp zone centred on a fixed one', () => {
    const sol = (f: any) => f.systems.systems.find((s: any) => s.id === 'sol');
    const camped = (f: any) => sol(f).lodestones.find((l: any) => l.zone);
    expect(camped(files)).toBeTruthy();
    const both = broken((f) => { Object.assign(sol(f).lodestones[0], { position: { x: 1, y: 2 }, orbit: { radius: 90000, phase: 0, period: 3000 } }); });
    expect(both.some((p) => p.path === 'systems[0].lodestones[0]' && /exactly one of/.test(p.message))).toBe(true);
    const dup = broken((f) => { sol(f).lodestones[1].id = sol(f).lodestones[0].id; });
    expect(dup.some((p) => p.path === 'systems[0].lodestones[1].id' && /duplicate lodestone/.test(p.message))).toBe(true);
    const moved = broken((f) => { camped(f).position.x += 500; });
    expect(moved.some((p) => /lodestones\[\d+\]\.zone$/.test(p.path) && /isn't centred on it/.test(p.message))).toBe(true);
    const orbiting = broken((f) => { const l = camped(f); delete l.position; l.orbit = { radius: 200000, phase: 0, period: 6000 }; });
    expect(orbiting.some((p) => /lodestones\[\d+\]\.zone$/.test(p.path) && /fixed `position`/.test(p.message))).toBe(true);
    const missing = broken((f) => { camped(f).zone = 'nowhere'; });
    expect(missing.some((p) => /lodestones\[\d+\]\.zone$/.test(p.path) && /isn't one of this system's zones/.test(p.message))).toBe(true);
    const state = broken((f) => { sol(f).lodestones[0].state = 'glowing'; });
    expect(state.some((p) => p.path === 'systems[0].lodestones[0].state')).toBe(true);
    const scar = broken((f) => { const l = sol(f).lodestones.find((x: any) => !x.state); l.scar = { from: 0, to: 90 }; });
    expect(scar.some((p) => /lodestones\[\d+\]\.scar$/.test(p.path) && /only a scarred/.test(p.message))).toBe(true);
  });

  it('nests: circle a real planet or moon, have packs, and keep hostiles out of safe space', () => {
    const sys = (f: any, id: string) => f.systems.systems.find((s: any) => s.id === id);
    const at = (id: string) => files.systems.systems.findIndex((s: any) => s.id === id);
    const planet = broken((f) => { sys(f, 'ashfall').nests[0].around = 'nowhere'; });
    expect(planet.some((p) => p.path === `systems[${at('ashfall')}].nests[0].around` && /isn't one of this system's planets/.test(p.message))).toBe(true);
    const moon = broken((f) => { sys(f, 'ashfall').nests[0].moon = 9; });
    expect(moon.some((p) => p.path === `systems[${at('ashfall')}].nests[0].moon` && /no moon 9/.test(p.message))).toBe(true);
    const stray = broken((f) => { f.factions.spawns.ashfall.nests[0].id = 'ashfall_nowhere'; });
    expect(stray.some((p) => p.path === 'spawns.ashfall.nests[0].id' && /isn't one of ashfall's nests/.test(p.message))).toBe(true);
    const style = broken((f) => { f.factions.spawns.ashfall.nests[0].style = 'wandering'; f.factions.spawns.ashfall.nests[1].bias = 2; });
    expect(style.some((p) => p.path === 'spawns.ashfall.nests[0].style')).toBe(true);
    expect(style.some((p) => p.path === 'spawns.ashfall.nests[1].bias' && /0\.\.1/.test(p.message))).toBe(true);
    // Inner Sol is safe: a hostile nest whose ships could reach into it is an error (a passive one isn't)
    const inward = broken((f) => { sys(f, 'sol').nests[0].orbit.radius = 20000; });
    expect(inward.some((p) => p.path === 'spawns.sol.nests[0]' && /safe space/.test(p.message))).toBe(true);
    expect(broken((f) => { sys(f, 'sol').nests[0].orbit.radius = 20000; for (const g of f.factions.spawns.sol.nests[0].groups) g.passive = true; })
      .some((p) => /safe space/.test(p.message))).toBe(false);
  });

  it("checks a star's plasma look: known fields, numbers in range, colours", () => {
    const e = broken((f) => {
      const cb = f.systems.systems.find((s: any) => s.id === 'sol').centralBody;
      cb.plasma = { ...cb.plasma, threds: 1, limbDarkening: 3, rimColor: 'orange', iridescence: { mode: 'stripes', colors: ['#fff'] } };
    });
    const at = (k: string) => e.find((p) => p.path === `systems[0].centralBody.plasma.${k}`);
    expect(at('threds')?.message).toMatch(/not a plasma field/);
    expect(at('limbDarkening')?.message).toMatch(/out of range \(0\.\.1\)/);
    expect(at('rimColor')?.message).toMatch(/#rrggbb/);
    expect(at('iridescence.mode')).toBeTruthy();
    expect(at('iridescence.colors')).toBeTruthy();
  });

  it('lodestone and jump tuning fields are known (a typo warns)', () => {
    const f = structuredClone(files) as any;
    const s = structuredClone(ships) as any;
    f.systems.systems[0].lodestones[0].orbt = 1;
    s.tuning.jump.lodestoneFeild = 900;
    const problems = validateGameData(f, { ships: s });
    expect(problems.some((p) => p.level === 'warning' && p.path === 'systems[0].lodestones[0].orbt')).toBe(true);
    expect(problems.some((p) => p.level === 'warning' && p.file === 'ships/tuning.json' && p.path === 'jump.lodestoneFeild')).toBe(true);
    expect(validateGameData(files, { ships }).filter((p) => /lodestone|^jump\./.test(p.path))).toEqual([]);
  });

  it('checkGameData throws outside production and only logs in production', () => {
    const f = structuredClone(files) as any;
    f.stations.stations[0].system = 'atlantis';
    expect(() => checkGameData(f)).toThrow(/stations\[0\]\.system: unknown system "atlantis"/);
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const warn = console.warn;
    let logged = '';
    console.warn = (s: string) => { logged += s; };
    try {
      expect(errors(checkGameData(f)).length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
      process.env.NODE_ENV = was;
    }
    expect(logged).toContain('atlantis');
  });
});
