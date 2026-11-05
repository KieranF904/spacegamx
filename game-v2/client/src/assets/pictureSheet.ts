/**
 * Pictures drawn one at a time as they're wanted (item icons, part pictures), kept together in the asset cache: the
 * ones drawn on an earlier visit are read back in idle time, and the set is saved again a while after new ones are
 * drawn. Until they're read, or for one not drawn before, it's drawn as it always was.
 */
import { assetKind, later } from './assetCache';

/** How long after a new picture the set is saved (more are usually drawn together) */
const SAVE_AFTER = 8000;

export interface PictureSheet<T> {
  get(key: string): T | undefined;
  add(key: string, picture: T): void;
}

/** `data`: the fingerprint of what they're drawn from (gameData.ts) */
export function pictureSheet<T>(name: string, version: number, data: () => string): PictureSheet<T> {
  const kind = assetKind<Record<string, T>>(name, version, { memory: false });
  const drawn = new Map<string, T>();
  let read = false, fresh = false, saving: ReturnType<typeof setTimeout> | null = null;
  later(async () => {
    try {
      const stored = await kind.preload(data());
      if (stored) for (const [k, v] of Object.entries(stored)) if (!drawn.has(k)) drawn.set(k, v);
    } finally {
      read = true;
    }
  });
  // (Only once the stored set is in: saving before would drop it)
  const save = () => {
    saving = null;
    if (!read) { saving = setTimeout(save, SAVE_AFTER); return; }
    if (fresh) kind.save(data(), Object.fromEntries(drawn));
    fresh = false;
  };
  return {
    get: (key) => drawn.get(key),
    add(key, picture) {
      drawn.set(key, picture);
      fresh = true;
      saving ??= setTimeout(save, SAVE_AFTER);
    },
  };
}
