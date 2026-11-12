/**
 * Saved key bindings from before a default key moved (Settings.ts BINDINGS_VERSION; keybindings.ts OLD_DEFAULT_KEYS):
 *  - version 1 (production): the quick bar on 1-5, no group1..group5;
 *  - version 2 (dev only): 1-5 the groups, the quick bar on [ ] ; ' \;
 *  - version 3 (dev only): the quick bar on Z X C V B, the action menu on \, interact on ;, the guide, helm and ping on [ ' ];
 *  - version 4 (today): the quick bar on C V B N M; the guide, the helm switch, the ping, the nav markers and the map on
 *    [ ' ] \ ; and the action menu and interact on Z and X, as they always were but in version 3.
 * An untouched action moves to today's key, a pilot's own choices stay, and no two actions are left sharing a key.
 */
import { describe, expect, it } from 'vitest';
import { ACTIONS, OLD_DEFAULT_KEYS } from '../input/keybindings';
import { BINDINGS_VERSION, defaultSettings, loadSettings, migrateBindings } from './Settings';

type V = 1 | 2 | 3;
const DEFAULTS = defaultSettings().bindings;
const QUICK = ['quick1', 'quick2', 'quick3', 'quick4', 'quick5'];
const FIVE = ['components', 'helm', 'ping', 'nav', 'map'];
/** Version 3's defaults for the three actions that are on the same keys today (so OLD_DEFAULT_KEYS leaves them out) */
const SAME_IN_3: Record<string, string> = { components: 'BracketLeft', helm: 'Quote', ping: 'BracketRight' };
/** A save made against version `v`'s defaults: every action then, on its key then */
function oldSave(v: V, over: Record<string, string> = {}): Record<string, string> {
  const b: Record<string, string> = {};
  for (const [id, code] of Object.entries(DEFAULTS)) if (v > 1 || !/^group[1-5]$/.test(id)) b[id] = OLD_DEFAULT_KEYS[v][id] ?? code;
  return { ...b, ...over };
}
const load = (v: V, over: Record<string, string> = {}) => loadSettings(v === 1 ? { bindings: oldSave(1, over) } : { bindings: oldSave(v, over), bindingsVersion: v });
const clashes = (b: Record<string, string>): string[] => {
  const seen = new Map<string, string>(), out: string[] = [];
  for (const [id, code] of Object.entries(b)) {
    if (!code) continue;
    if (seen.has(code)) out.push(`${seen.get(code)}+${id}@${code}`);
    seen.set(code, id);
  }
  return out;
};
const keys = (b: Record<string, string>, ids: string[]) => ids.map((id) => b[id]);

describe('the default keys', () => {
  it('1-5 are the weapon groups, the quick bar is C V B N M, and no two rebindable actions share a default key', () => {
    expect(BINDINGS_VERSION).toBe(4);
    for (let n = 1; n <= 5; n++) expect(DEFAULTS[`group${n}`]).toBe(`Digit${n}`);
    expect(keys(DEFAULTS, QUICK)).toEqual(['KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM']);
    expect(keys(DEFAULTS, FIVE)).toEqual(['BracketLeft', 'Quote', 'BracketRight', 'Backslash', 'Semicolon']);
    expect(keys(DEFAULTS, ['contextMenu', 'interact'])).toEqual(['KeyZ', 'KeyX']);
    expect(clashes(DEFAULTS)).toEqual([]);
    expect(ACTIONS.filter((a) => /^(group|quick)[1-5]$/.test(a.id) || FIVE.includes(a.id)).every((a) => a.rebindable !== false)).toBe(true);
  });

  it('the old saves this file makes are what they were', () => {
    expect(keys(oldSave(1), QUICK)).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);
    expect(keys(oldSave(2), QUICK)).toEqual(['BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Backslash']);
    expect(keys(oldSave(3), QUICK)).toEqual(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB']);
    for (const v of [1, 2] as const) expect(keys(oldSave(v), [...FIVE, 'contextMenu', 'interact'])).toEqual(['KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'KeyZ', 'KeyX']);
    expect(keys(oldSave(3), [...FIVE, 'contextMenu', 'interact'])).toEqual(['BracketLeft', 'Quote', 'BracketRight', 'KeyN', 'KeyM', 'Backslash', 'Semicolon']);
    for (const [id, code] of Object.entries(SAME_IN_3)) expect(DEFAULTS[id]).toBe(code);
    expect('group1' in oldSave(1)).toBe(false);
    for (const v of [1, 2, 3] as const) expect(clashes(oldSave(v)), `v${v}`).toEqual([]);
  });
});

describe.each([1, 2, 3] as const)('migrateBindings: a version %i save to version 4', (v) => {
  it("untouched: every action is on today's default", () => {
    const data = load(v);
    expect(data.bindings).toEqual(DEFAULTS);
    expect(data.bindingsVersion).toBe(BINDINGS_VERSION);
  });

  it('a quick slot the pilot had moved stays where it was; the rest move to C V B N M', () => {
    const data = load(v, { quick1: 'F1' });
    expect(keys(data.bindings, QUICK)).toEqual(['F1', 'KeyV', 'KeyB', 'KeyN', 'KeyM']);
    // (C has no slot on it now: the component guide still moves to its new key)
    expect(keys(data.bindings, [...FIVE, 'contextMenu', 'interact', 'group1'])).toEqual(['BracketLeft', 'Quote', 'BracketRight', 'Backslash', 'Semicolon', 'KeyZ', 'KeyX', 'Digit1']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it('the map and the nav markers the pilot had moved stay; the others move to their new keys', () => {
    const data = load(v, { map: 'F2', nav: 'F3' });
    expect(keys(data.bindings, FIVE)).toEqual(['BracketLeft', 'Quote', 'BracketRight', 'F3', 'F2']);
    expect(keys(data.bindings, QUICK)).toEqual(['KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM']);
    expect(keys(data.bindings, ['contextMenu', 'interact'])).toEqual(['KeyZ', 'KeyX']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it("a pilot's own key on a new default keeps it: the action that only has it as a default is left unbound", () => {
    // (The pilot log put on ; where the map now goes, skills on \ where the nav markers go; in a save where a default of
    // its day sat on one of those, that action is first moved off by the pilot too)
    const off: Record<number, Record<string, string>> = { 1: {}, 2: { quick3: 'F6', quick5: 'F7' }, 3: { interact: 'F6', contextMenu: 'F7' } };
    const data = load(v, { log: 'Semicolon', skills: 'Backslash', ...off[v] });
    expect(keys(data.bindings, ['log', 'skills', 'map', 'nav'])).toEqual(['Semicolon', 'Backslash', '', '']);
    expect(data.bindings.components).toBe('BracketLeft');
    expect(clashes(data.bindings)).toEqual([]);
  });

  it("the map and the nav markers swapped by the pilot (the map on N, the markers on M) keep the pilot's keys: those quick slots are left unbound", () => {
    const data = load(v, { map: 'KeyN', nav: 'KeyM' });
    expect(keys(data.bindings, ['map', 'nav'])).toEqual(['KeyN', 'KeyM']);
    expect(keys(data.bindings, QUICK)).toEqual(['KeyC', 'KeyV', 'KeyB', '', '']);
    expect(clashes(data.bindings)).toEqual([]);
  });
});

describe('migrateBindings: by version', () => {
  it("version 1: a pilot's own key on 1-5 keeps it: that group key is left unbound, never shared", () => {
    // (Quick slot 1 moved onto 3, and the pilot log put on 2)
    const data = load(1, { quick1: 'Digit3', log: 'Digit2', quick3: 'F1' });
    expect(keys(data.bindings, ['quick1', 'log', 'group3', 'group2', 'group1'])).toEqual(['Digit3', 'Digit2', '', '', 'Digit1']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it('version 1: a quick slot the pilot had put on [ is their own choice (it stays, and the component guide is left unbound)', () => {
    const data = load(1, { quick1: 'BracketLeft' });
    expect(keys(data.bindings, ['quick1', 'components'])).toEqual(['BracketLeft', '']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it('version 2: a quick slot the pilot had put back on 1 is their own choice (it stays, and group 1 keeps what the save had)', () => {
    const data = load(2, { quick1: 'Digit1', group1: 'F8' });
    expect(keys(data.bindings, ['quick1', 'group1'])).toEqual(['Digit1', 'F8']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it('version 2: an action the migration to 2 left unbound stays unbound', () => {
    const data = load(2, { group2: '' });
    expect(keys(data.bindings, ['group2', 'quick1'])).toEqual(['', 'KeyC']);
  });

  it('version 3: interact on ; and the action menu on \\ (that version\'s defaults) go back to X and Z; the map takes ;', () => {
    const data = load(3);
    expect(keys(data.bindings, ['interact', 'contextMenu', 'map', 'nav'])).toEqual(['KeyX', 'KeyZ', 'Semicolon', 'Backslash']);
  });

  it("version 3: interact the pilot had put back on X stays there, and one put on a key of the pilot's own stays too", () => {
    const back = load(3, { interact: 'KeyX', quick2: 'F5' });
    expect(keys(back.bindings, ['interact', 'quick2'])).toEqual(['KeyX', 'F5']);
    expect(clashes(back.bindings)).toEqual([]);
    const own = load(3, { interact: 'F9' });
    expect(keys(own.bindings, ['interact', 'contextMenu'])).toEqual(['F9', 'KeyZ']);
    expect(clashes(own.bindings)).toEqual([]);
  });

  it('version 3: the guide, the helm switch and the ping, on the same keys then as now, stay (and so does one the pilot had moved)', () => {
    const data = load(3, { ping: 'F4' });
    expect(keys(data.bindings, ['components', 'helm', 'ping'])).toEqual(['BracketLeft', 'Quote', 'F4']);
    expect(clashes(data.bindings)).toEqual([]);
  });

  it('runs once: a save already on this version is taken as it is', () => {
    const b = { ...DEFAULTS, quick1: 'Digit1', group1: 'KeyQ', interact: 'Semicolon', map: 'KeyM', quick5: 'F4' };
    const data = loadSettings({ bindings: b, bindingsVersion: BINDINGS_VERSION });
    expect(keys(data.bindings, ['quick1', 'group1', 'interact', 'map', 'quick5'])).toEqual(['Digit1', 'KeyQ', 'Semicolon', 'KeyM', 'F4']);
  });

  it('no save, or one with no bindings: the defaults', () => {
    expect(loadSettings(null).bindings).toEqual(DEFAULTS);
    expect(loadSettings({ audio: {} }).bindings).toEqual(DEFAULTS);
    expect(migrateBindings({ quick1: 'Digit1', map: 'KeyM', junk: 7 }, DEFAULTS)).toEqual({});
    expect(migrateBindings({ quick1: 'BracketLeft', helm: 'KeyV' }, DEFAULTS, 2)).toEqual({});
    expect(migrateBindings({ quick1: 'KeyZ', interact: 'Semicolon', contextMenu: 'Backslash' }, DEFAULTS, 3)).toEqual({});
  });
});
