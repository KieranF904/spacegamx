// Where the shipgen engine reads and writes. Overridable (tests point them at a temp folder).
import { join } from 'path';

export interface Paths {
  /** Run output, renders and timelapse frames (gitignored) */
  out: string;
  /** data/ships/blueprints (the library: player ships, enemy/, dev/) */
  blueprints: string;
  /** Where Save writes (gen-<role>-<n>.json: flyable from the in-game F9 panel) */
  dev: string;
  /** The Energy Lab (a page opened from disk) and its ship exporter */
  lab: string;
  exporter: string;
  /** game-v2 (the exporter's working folder) */
  root: string;
}

export function defaultPaths(dataDir: string): Paths {
  const root = join(__dirname, '../../..');
  return {
    out: join(__dirname, '../out'),
    blueprints: join(dataDir, 'ships/blueprints'),
    dev: join(dataDir, 'ships/blueprints/dev'),
    lab: join(root, 'prototypes/energy-lab'),
    exporter: join(root, 'prototypes/energy-lab/export-ships.ts'),
    root,
  };
}
