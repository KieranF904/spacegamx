// npm run wire:bump "short reason"
// Rebuilds common, recomputes the wire hash, and if it differs from PROTOCOL_WIRE_HASH in
// common/src/network/protocol.ts: increments PROTOCOL_VERSION, writes the new hash, and appends
// "- <version> (<date>): <reason>" to common/src/network/PROTOCOL_CHANGELOG.md (oldest first).
// If the hash already matches (nothing changed since the last bump) it does nothing, so running it twice is safe.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const protoPath = join(root, 'common/src/network/protocol.ts');
const logPath = join(root, 'common/src/network/PROTOCOL_CHANGELOG.md');
const reason = process.argv.slice(2).join(' ').trim();

execSync('npx tsc', { cwd: join(root, 'common'), stdio: 'inherit' });
const { computeWireHash } = await import(pathToFileURL(join(root, 'common/dist/network/wireHash.js')).href);
const hash = computeWireHash();

let src = readFileSync(protoPath, 'utf8');
const pinned = /export const PROTOCOL_WIRE_HASH = '([0-9a-f]+)';/.exec(src)?.[1];
const version = Number(/export const PROTOCOL_VERSION = (\d+);/.exec(src)?.[1]);
if (!pinned || !version) { console.error('Could not find PROTOCOL_VERSION / PROTOCOL_WIRE_HASH in protocol.ts'); process.exit(1); }
if (hash === pinned) { console.log(`Wire hash ${hash} already matches PROTOCOL_VERSION ${version}: nothing to bump.`); process.exit(0); }
if (!reason) { console.error(`The wire changed (${pinned} -> ${hash}). Give a reason:  npm run wire:bump "what changed"`); process.exit(1); }

const next = version + 1;
src = src.replace(/export const PROTOCOL_VERSION = \d+;/, `export const PROTOCOL_VERSION = ${next};`)
  .replace(/export const PROTOCOL_WIRE_HASH = '[0-9a-f]+';/, `export const PROTOCOL_WIRE_HASH = '${hash}';`);
writeFileSync(protoPath, src);
const date = new Date().toISOString().slice(0, 10);
let log = readFileSync(logPath, 'utf8');
if (!log.endsWith('\n')) log += '\n';
writeFileSync(logPath, `${log}- ${next} (${date}): ${reason.replace(/\s*\n\s*/g, ' ')}\n`);
console.log(`PROTOCOL_VERSION ${version} -> ${next}, PROTOCOL_WIRE_HASH ${pinned} -> ${hash}; logged in PROTOCOL_CHANGELOG.md`);
execSync('npx tsc', { cwd: join(root, 'common'), stdio: 'inherit' }); // dist carries the new version too
