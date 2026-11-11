// Weapons lab: browse every weapon in the game's data, watch it fire in the game's own sim, draft changes with a local
// model, and keep the drafts apart from the game (lab/weapons/).
//   npm run lab:weapons      then open the printed http://<lan-ip>:5480/?k=<key> (same Wi-Fi; the key is lab/key.txt)
// Standalone: it never touches the game's servers or data (read only); drafts and config live in lab/ (gitignored).
// LAB_PORT changes the port; LAB_FAKE_LLM=1 answers prompts with a canned weapon and calls no model.
import os from 'os';
import { createLab, accessKey } from './lab';

const port = Number(process.env.LAB_PORT ?? 5480);
const key = accessKey();

createLab().listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
  console.log('Weapons lab up. On your phone (same network):');
  for (const ip of ips) console.log(`  http://${ip}:${port}/?k=${key}`);
  console.log(`  (this PC: http://localhost:${port}/?k=${key})`);
});
