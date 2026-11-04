/**
 * The Brood Mother (out past Borealis's belt, east of the Curtain): only what pilots call it; what it is stays
 * unexplained until its lore is written (scripts/bespoke/brood_mother.mjs). Her look only, for now: three stages (the veil, the mantle, the clutch) and no
 * moves yet. She flies as every staged boss does between moves (staged.ts), and the dev tool steps through her
 * stages (`forceShed`), so each can be seen without a fight.
 */

import type { BrainHost } from './kit.js';
import { StagedBrain, type Move } from './staged.js';

export class BroodMotherBrain extends StagedBrain {
  constructor(host: BrainHost) {
    // (the Scrap Mother's tables and flight, until she has moves of her own)
    super(host, {
      loop: [[], [], []],
      rest: [95, 75, 60], haste: [1, 0.85, 0.75],
    }, 'brood_mother');
  }

  protected make(_id: string): Move | null {
    return null;
  }
}
