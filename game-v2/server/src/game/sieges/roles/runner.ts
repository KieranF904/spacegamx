/** A runner: ignores pilots (even ones shooting it) and dives at the bastion */

import type { SiegeRole } from './index.js';
import { bastionAt } from './bastion.js';

export const runner: SiegeRole = {
  id: 'runner',
  onSpawn(ctx, run, eids) {
    ctx.host.order(eids, { at: bastionAt(run), prey: run.bastion, only: true });
  },
};
