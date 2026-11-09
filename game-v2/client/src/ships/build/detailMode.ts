/**
 * @contract client.ships.build-detail-mode
 * owns:       the one remembered Simple / Advanced choice of the build editors (hangar and world build view): read it, set it, hear of changes
 * needs:      browser localStorage (optional: blocked storage just means the choice is not kept)
 * invariants: the default is Simple, and a blocked or broken store reads as Simple — client/src/ships/build/detailMode.test.ts
 *             listeners hear only real changes — client/src/ships/build/detailMode.test.ts
 * extend:     a view reads detailMode() and subscribes with onDetailMode(); no second mode without a new key here
 */

export type DetailMode = 'simple' | 'advanced';

const KEY = 'sg.build.detail';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The remembered mode: Simple unless the player chose Advanced */
export function loadDetailMode(storage: Store | null = safeStorage()): DetailMode {
  try {
    return storage?.getItem(KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

export function saveDetailMode(m: DetailMode, storage: Store | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, m);
  } catch { /* blocked storage: the choice just isn't kept */ }
}

let current: DetailMode | null = null;
const listeners = new Set<(m: DetailMode) => void>();

export function detailMode(): DetailMode {
  return (current ??= loadDetailMode());
}

export const isSimple = (): boolean => detailMode() === 'simple';

export function setDetailMode(m: DetailMode): void {
  if (m === detailMode()) return;
  current = m;
  saveDetailMode(m);
  for (const fn of [...listeners]) fn(m);
}

/** Hear of a change; returns the way to stop */
export function onDetailMode(fn: (m: DetailMode) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests: forget what was read so the next read goes to storage */
export function resetDetailMode(): void {
  current = null;
  listeners.clear();
}
