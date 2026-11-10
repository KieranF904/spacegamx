/**
 * Test-only: the catalog and tuning the ports core's tests run on. Not exported from index.ts (it reads the data from
 * disk through testData.ts).
 */

import type { ShipTuning } from '../tuning.js';
import { readShipJson, testCatalog } from '../testData.js';

export const catalog = testCatalog();
export const tuning: ShipTuning = readShipJson('tuning.json');
