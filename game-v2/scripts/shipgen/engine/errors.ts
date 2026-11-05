// What the engine refuses, with a status a caller can act on (400 a bad request, 404 not found, 409 busy, 422 not valid),
// and the path guard for files a caller names.
import { existsSync, statSync } from 'fs';
import { resolve, sep } from 'path';

export class EngineError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A file under `root` named by a relative path, or null when the path leaves the root or names no file */
export function inside(root: string, rel: string): string | null {
  let clean: string;
  try { clean = decodeURIComponent(rel); } catch { return null; }
  if (clean.includes('\0')) return null;
  const base = resolve(root);
  const p = resolve(base, '.' + sep + clean.replace(/^[/\\]+/, ''));
  if (p !== base && !p.startsWith(base + sep)) return null;
  return existsSync(p) && statSync(p).isFile() ? p : null;
}
