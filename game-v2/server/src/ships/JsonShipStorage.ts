/**
 * Node-only ShipStorage: one canonical blueprint file per account in
 * data/ships/players/ (gitignored). Writes go through a temp file and rename,
 * so a crash mid-write can't leave a half-written ship.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Blueprint, parseBlueprint, serializeBlueprint } from '@space-game/common';
import type { ShipStorage } from './ShipStorage.js';

const SAFE_KEY = /^[a-z0-9_-]{1,64}$/;

export class JsonShipStorage implements ShipStorage {
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  load(key: string): Blueprint | null {
    if (!SAFE_KEY.test(key)) return null;
    const file = join(this.dir, `${key}.json`);
    if (!existsSync(file)) return null;
    try {
      return parseBlueprint(readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error(`Ship storage: unreadable ${file}:`, e);
      return null;
    }
  }

  save(key: string, blueprint: Blueprint): void {
    if (!SAFE_KEY.test(key)) return;
    const file = join(this.dir, `${key}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, serializeBlueprint(blueprint));
    renameSync(tmp, file);
  }
}
