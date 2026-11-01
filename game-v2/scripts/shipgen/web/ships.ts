// Every ship a batch saved, from any run under out/ (a folder holding blueprint.json and a metrics.json with the gallery
// record): one list for the page's "Saved ships", newest first, with picture and blueprint URLs under /out/.
import { readFileSync, readdirSync, statSync } from 'fs';
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
  /** /out/ URLs */
  png?: string;
  bp: string;
}

const SKIP = new Set(['stills', 'timelapse', 'renders', 'designs', 'attempts', 'trace']);
const url = (rel: string, file: string) => `/out/${rel.split('/').map(encodeURIComponent).join('/')}/${file}`;

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
          out.push({
            dir: rel, run: rel.split('/').slice(0, -2).join('/'), role: r.role ?? m.role, name: r.name, score: r.score, draftScore: r.draftScore,
            parts: r.parts, cells: r.cells, concept: r.concept, model: m.model, savedAt: r.savedAt ?? '',
            ...(names.includes('render.png') ? { png: url(rel, 'render.png') } : {}), bp: url(rel, 'blueprint.json'),
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
