/**
 * @contract client.app.rock-tables
 * owns:       registering this build's rock types and belts (a dev build adds the dev-only rock system's field)
 * needs:      data/mining.json, common registerRockTypes
 * invariants: both sides generate the same rocks from the same table — client/src/app/appInvariants.test.ts
 * extend:     a new dev-only rock field is one more entry merged into the table below
 */

import miningTable from '../../../data/mining.json';
import { registerRockTypes, type MiningTable } from '@space-game/common';

// This build's rock types and belts (both sides generate the same rocks from them); a dev build adds the
// dev-only rock system's field, as the dev server does (data/dev/rockery.json, server/src/data/devData.ts)
if (import.meta.env.DEV) {
  const found = import.meta.glob('../../../data/dev/rockery.json', { eager: true, import: 'default' });
  const dev = Object.values(found)[0] as { system: { id: string }; field: Record<string, number>; outliers?: number } | undefined;
  const t = miningTable as unknown as MiningTable;
  if (dev) {
    t.fields = { ...t.fields, [dev.system.id]: dev.field };
    if (t.outliers && dev.outliers) t.outliers.systems = { ...t.outliers.systems, [dev.system.id]: dev.outliers };
  }
}
registerRockTypes(miningTable as unknown as MiningTable);
