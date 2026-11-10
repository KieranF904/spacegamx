// Validate every data file (shapes, then every cross-referenced id): npm run data:validate
// Exits 1 on any error (warnings are printed only). deploy/vps/deploy.sh runs it first.
import { join } from 'path';
import { readGameDataFiles } from '../server/src/data/loadGameDataFromDisk';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';
import { validateGameData, formatProblems } from '../server/src/data/validateGameData';

const dataDir = join(__dirname, '../data');
const problems = validateGameData(readGameDataFiles(dataDir), { ships: loadShipConfigFromDisk(dataDir) });
const errors = problems.filter((p) => p.level === 'error').length;
if (problems.length) console.log(formatProblems(problems));
console.log(`data: ${errors} error(s), ${problems.length - errors} warning(s)`);
process.exit(errors ? 1 : 0);
