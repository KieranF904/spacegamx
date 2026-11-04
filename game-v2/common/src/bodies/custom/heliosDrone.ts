/**
 * Helios Drone (Sol): a maintenance drone strayed from the Array. It drifts on its round and only welds what comes too
 * close. TORCH: it noses in on you, slowly, its torch lit (the burn is the server's). No drive: it drifts.
 */
import { drift, goTo, groupBit, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const DRIVE = groupBit('helios_drone', 'drive');
export const TORCH_TICKS = 90;

export const HELIOS_DRONE: CustomDesign = {
  id: 'helios_drone',
  moves: [{ name: 'torch', ticks: TORCH_TICKS }],
  fly(c, f) {
    if (c.move === 0) goTo(c, f, c.tgt.x, c.tgt.y, 1e9);
    if (lost(c, DRIVE)) drift(f);
  },
};
