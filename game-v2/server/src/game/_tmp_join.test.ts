import { it } from 'vitest';
import { join } from 'path';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { readFileSync } from 'fs';
import { createShipState, loadCatalog } from '@space-game/common';
const dataDir = join(__dirname, '../../../data');
it('joins', () => {
  const cfg = loadShipConfigFromDisk(dataDir);
  const bp = JSON.parse(readFileSync(join(dataDir, 'ships/blueprints/enemy/pyreclast.json'), 'utf8'));
  const cat = loadCatalog(cfg.catalog as any); const s = createShipState(cat, cfg.tuning as any, 1, bp, 0);
  const n = bp.parts.map((p: any) => p.piece.replace('pyreclast_', ''));
  const sk = n.indexOf('skeleton_l');
  console.log('alive skeleton', s.derived.alive[sk], 'joins:', s.derived.joins.filter(([a, b]: number[]) => a === sk || b === sk).map(([a, b]: number[]) => n[a === sk ? b : a]).join(','));
});
