/**
 * Every part function's data as the client's look and sound read it, before a
 * catalogue is loaded: data/ships/functions.json and the player models
 * (data/ships/models.json), as loadCatalog merges them.
 */

import shipFunctions from '../../../data/ships/functions.json';
import shipModels from '../../../data/ships/models.json';
import type { FunctionDef } from '@space-game/common';

export const SHIP_FUNCTIONS: FunctionDef[] = [
  ...(shipFunctions as unknown as { functions: FunctionDef[] }).functions,
  ...(shipModels as unknown as { models: FunctionDef[] }).models,
];
