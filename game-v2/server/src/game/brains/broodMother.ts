/**
 * The Brood Mother (out past Borealis's belt, east of the Curtain): a Frost Brood grown huge
 * (scripts/bespoke/brood_mother.mjs). Her look only, for now: three stages (the veil, the mantle, the clutch) and no
 * moves yet. She flies as every staged boss does between moves (staged.ts), and the dev tool steps through her
 * stages (`forceShed`), so each can be seen without a fight.
 */

import type { BrainHost } from './kit.js';
import { StagedBrain, type Move } from './staged.js';

export class BroodMotherBrain extends StagedBrain {
  constructor(host: BrainHost) {
    // (the Scrap Mother's tables, until she has moves of her own)
    super(host, {
      loop: [[], [], []],
      range: [2100, 1500, 1200], circle: [0.3, 0.4, 0.55], rest: [95, 75, 60], haste: [1, 0.85, 0.75],
      drive: [0.12, 0.2, 0.3], homeR: 5000,
    });
  }

  protected make(_id: string): Move | null {
    return null;
  }
}
