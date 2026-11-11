// Where the weapons lab reads and writes: the game's data (read only) and the lab's own folder (drafts, key, config).
// The lab folder is gitignored (lab/): drafts are never loaded by the game; the key and the model config stay on this PC.
import { join } from 'path';

/** game-v2/ */
export const ROOT = join(__dirname, '..', '..');
export const DATA_DIR = join(ROOT, 'data');
export const LAB_DIR = process.env.LAB_DIR ?? join(ROOT, 'lab');
export const draftDir = (lab = LAB_DIR) => join(lab, 'weapons');
export const keyFile = (lab = LAB_DIR) => join(lab, 'key.txt');
export const configFile = (lab = LAB_DIR) => join(lab, 'config.json');
