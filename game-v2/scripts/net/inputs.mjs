#!/usr/bin/env node
/**
 * The input probe over every scenario: npm run net:inputs -- [--compact 0|1] [--secs 20] [--out file.json] [scenarios...]
 * Runs scripts/net/inputProbe.ts once per scenario (a process each: a GameServer is a world of its own), prints a table
 * and writes them all to --out. What it measures: the probe's header and docs/audits/input-compaction-2026-11-04.md.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const compact = opt('--compact', '1'), secs = opt('--secs', '20'), out = opt('--out', null);
const list = args.length ? args : ['idle', 'keys', 'steer', 'fight', 'docked'];
const tsx = join(root, 'server/node_modules/tsx/dist/cli.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'inputs-'));
const all = {};
try {
  for (const sc of list) {
    const f = join(tmp, `${sc}.json`);
    execFileSync(process.execPath, [tsx, '--tsconfig', join(here, 'tsconfig.json'), join(here, 'inputProbe.ts'), sc, secs, f, compact], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    const j = JSON.parse(readFileSync(f, 'utf8'));
    all[sc] = j;
    const d = j.down;
    console.log(`${sc.padEnd(7)} up ${j.up.msgsPerSec} msg/s, ${j.up.payloadBps} B/s payload, ${j.up.wireBps} B/s wire | ctl rows: packed ${d.P_packed.ctlBps} B/s | parity ${j.parity.same}/${j.parity.ticks}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (out) writeFileSync(out, JSON.stringify(all, null, 1));
