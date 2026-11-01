// Where the shipgen page reads and writes. Overridable (tests point them at a temp folder).
import { join } from 'path';

export interface Paths {
  /** The page's static files */
  ui: string;
  /** Run output, renders and timelapse frames (gitignored); served under /out/ */
  out: string;
  /** data/ships/blueprints (the library: player ships, enemy/, dev/) */
  blueprints: string;
  /** Where Save writes (gen-<role>-<n>.json: flyable from the in-game F9 panel) */
  dev: string;
  /** The Energy Lab (served under /lab/) and its ship exporter */
  lab: string;
  exporter: string;
  /** game-v2 (the exporter's working folder) */
  root: string;
}

export function defaultPaths(dataDir: string): Paths {
  const root = join(__dirname, '../../..');
  return {
    ui: join(__dirname, '../ui'),
    out: join(__dirname, '../out'),
    blueprints: join(dataDir, 'ships/blueprints'),
    dev: join(dataDir, 'ships/blueprints/dev'),
    lab: join(root, 'prototypes/energy-lab'),
    exporter: join(root, 'prototypes/energy-lab/export-ships.ts'),
    root,
  };
}
