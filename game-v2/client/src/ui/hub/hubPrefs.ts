/**
 * What the side panel remembers between sessions: the tab each pilot last had open (by pilot name, so two pilots on
 * one browser keep their own), whether it was folded, and its height. localStorage, every access in try/catch (a
 * private window, blocked site data): without storage it starts on its defaults.
 */

/** The bit of Storage it uses (a fake in tests) */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TAB_KEY = 'sg.hub.tab.';
const FOLD_KEY = 'sg.hub.folded';
const HEIGHT_KEY = 'sg.hub.height';

function store(): PrefStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function read(s: PrefStore | null, key: string): string | null {
  try { return s?.getItem(key) ?? null; } catch { return null; }
}

function write(s: PrefStore | null, key: string, value: string): void {
  try { s?.setItem(key, value); } catch { /* no storage */ }
}

/** A pilot's key part: case-insensitive, so "Wren" and "wren" are one pilot */
const who = (pilot: string) => pilot.trim().toLowerCase() || '_';

/** The tab this pilot last had open, if it is still one of `known` */
export function loadTab(pilot: string, known: readonly string[], s: PrefStore | null = store()): string | null {
  const t = read(s, TAB_KEY + who(pilot));
  return t && known.includes(t) ? t : null;
}

export function saveTab(pilot: string, tab: string, s: PrefStore | null = store()): void {
  write(s, TAB_KEY + who(pilot), tab);
}

export function loadFolded(s: PrefStore | null = store()): boolean {
  return read(s, FOLD_KEY) === '1';
}

export function saveFolded(on: boolean, s: PrefStore | null = store()): void {
  write(s, FOLD_KEY, on ? '1' : '0');
}

/** The body height the pilot dragged it to (null: never, or nonsense) */
export function loadHeight(min: number, s: PrefStore | null = store()): number | null {
  const h = Number(read(s, HEIGHT_KEY));
  return Number.isFinite(h) && h >= min ? Math.round(h) : null;
}

export function saveHeight(h: number, s: PrefStore | null = store()): void {
  write(s, HEIGHT_KEY, String(Math.round(h)));
}
