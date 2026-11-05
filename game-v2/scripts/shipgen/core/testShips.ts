// Test-only: every bundled blueprint (data/ships/blueprints/**), by path under that folder.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { Blueprint } from '../../../common/src/ships/index';
import { parseBlueprint } from '../../../common/src/ships/index';
import { DATA_DIR } from './context';

export const BLUEPRINTS = join(DATA_DIR, 'ships/blueprints');

export function bundledShips(): { path: string; bp: Blueprint }[] {
  const out: { path: string; bp: Blueprint }[] = [];
  const walk = (d: string, rel: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, `${rel}${f}/`);
      else if (f.endsWith('.json')) out.push({ path: `${rel}${f.slice(0, -5)}`, bp: parseBlueprint(readFileSync(p, 'utf8')) });
    }
  };
  walk(BLUEPRINTS, '');
  return out;
}

export const REVIEW_SHIPS = ['dev/review-wren', 'dev/review-kestrel', 'dev/review-heron', 'dev/review-mako', 'dev/review-monarch'];

export function ship(path: string): Blueprint {
  return parseBlueprint(readFileSync(join(BLUEPRINTS, `${path}.json`), 'utf8'));
}
