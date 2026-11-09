/**
 * @contract validate.tutorial
 * owns:       tutorial.json: the training yard resolves against the real ids
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { validateTutorialData } from '@space-game/common';
import { type V, str } from './context.js';

export function validateTutorial(v: V): void {
  const { c, f, systems, stations, itemRows } = v;
  const tutorialFile = (f as { tutorial?: { yard?: { station?: string } } }).tutorial;
  if (tutorialFile !== undefined) {
    const refs = { item: (id: string) => itemRows.has(id) || id.startsWith('part:'), systems: new Set(systems.keys()), stations: new Map([...stations].map(([id, st]) => [id, str(st?.system) ?? ''] as [string, string])) };
    for (const msg of validateTutorialData(tutorialFile, refs)) c.err('', msg, 'tutorial.json');
    const ys = tutorialFile?.yard?.station;
    if (ys && stations.get(ys) && !stations.get(ys).tutorial) c.err('yard.station', `station "${ys}" must be marked tutorial: true in stations.json`, 'tutorial.json');
  }
}
