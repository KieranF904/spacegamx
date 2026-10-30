/**
 * Contributor notes kept on disk (data/contributor/): the ContribStore the
 * real server hands ContributorNotes. Kept apart from it so the browser proto,
 * which bundles the server, never pulls in fs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { writeFileDurableSync } from '../profile/durableWrite.js';
import { join } from 'path';
import type { ContribStore } from './ContributorNotes.js';

export function contribFileStore(dir: string): ContribStore {
  const box = join(dir, 'inbox');
  mkdirSync(box, { recursive: true });
  return {
    read: (name) => readJson(join(dir, name)),
    write: (name, text) => writeAtomic(join(dir, name), text),
    takeInbox: () => {
      let files: string[] = [];
      try { files = readdirSync(box).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
      return files.map((f) => {
        const path = join(box, f);
        const op = readJson(path);
        try { unlinkSync(path); } catch { /* gone already */ }
        return { name: f, op };
      });
    },
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.warn(`[contrib] couldn't read ${path}:`, (e as Error).message);
    // Keep the broken file to look at; start from nothing rather than refuse to start
    try { renameSync(path, `${path}.broken-${Date.now()}`); } catch { /* leave it */ }
    return null;
  }
}

/** Temp file, flushed, then rename: a crash or a full disk never leaves half a file (durableWrite.ts) */
function writeAtomic(path: string, text: string): void {
  writeFileDurableSync(path, text);
}
