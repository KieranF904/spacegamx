// Every ship a batch saved, from any run under out/ (a folder holding blueprint.json and a metrics.json with the gallery
// record): one list for the app's "Saved ships", newest first, with its picture and blueprint files.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

export interface SavedShip {
  /** The ship's folder under out/, forward slashes */
  dir: string;
  /** The run (batch folder) it came from */
  run: string;
  role: string;
  name: string;
  score: number;
  draftScore?: number;
  parts?: number;
  cells?: number;
  concept?: string;
  model?: string;
  savedAt: string;
  /** Files, absolute */
  png?: string;
  bp: string;
  /** The owner's rating, 1-5 (rating.json beside the ship) */
  rating?: number;
}

/** Writes a ship's rating (1-5; 0 clears it) beside it; the folder must be a saved ship under out/ */
export function rateShip(root: string, dir: string, rating: number): { dir: string; rating?: number } {
  const clean = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '')) throw new Error('bad ship folder');
  const full = join(root, ...clean.split('/'));
  if (!existsSync(join(full, 'blueprint.json')) || !existsSync(join(full, 'metrics.json'))) throw new Error(`no saved ship at ${clean}`);
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < 0 || r > 5) throw new Error('a rating is 1 to 5 (0 clears it)');
  writeFileSync(join(full, 'rating.json'), JSON.stringify({ rating: r || null, at: new Date().toISOString() }, null, 2) + '\n');
  return { dir: clean, ...(r ? { rating: r } : {}) };
}

const SKIP = new Set(['stills', 'timelapse', 'renders', 'designs', 'attempts', 'trace']);


export function listSavedShips(root: string, maxDepth = 6): SavedShip[] {
  const out: SavedShip[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    if (names.includes('metrics.json') && names.includes('blueprint.json')) {
      try {
        const m = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'));
        const r = m?.record;
        if (r?.name) {
          const rel = relative(root, dir).split(sep).join('/');
          let rating: number | undefined;
          if (names.includes('rating.json')) { try { rating = Number(JSON.parse(readFileSync(join(dir, 'rating.json'), 'utf8')).rating) || undefined; } catch { /* (unreadable) */ } }
          out.push({
            dir: rel, run: rel.split('/').slice(0, -2).join('/'), role: r.role ?? m.role, name: r.name, score: r.score, draftScore: r.draftScore,
            parts: r.parts, cells: r.cells, concept: r.concept, model: m.model, savedAt: r.savedAt ?? '',
            ...(names.includes('render.png') ? { png: join(dir, 'render.png') } : {}), bp: join(dir, 'blueprint.json'), ...(rating ? { rating } : {}),
          });
        }
      } catch { /* (half written) */ }
      return;
    }
    if (depth >= maxDepth) return;
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const sub = join(dir, n);
      try { if (statSync(sub).isDirectory()) walk(sub, depth + 1); } catch { /* (vanished) */ }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
