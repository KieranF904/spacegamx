/**
 * Import rules for the ShipBridge split (bridge/core.ts):
 *  - a bridge module imports ShipBridge as a type only, never its value (runtime imports run one way:
 *    ShipBridge.ts -> bridge/*.ts -> core.ts / common)
 *  - the bridge's private state (BridgeCtx, BridgeInternals) is used only by ShipBridge.ts and bridge/*.ts
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const bridgeDir = __dirname;
const serverSrc = join(__dirname, '../..');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('ShipBridge split imports', () => {
  it('bridge modules import ShipBridge as a type only', () => {
    const bad: string[] = [];
    for (const f of tsFiles(bridgeDir)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)) {
        if (/ShipBridge(\.js)?$/.test(m[2]) && !m[1]) bad.push(`${relative(bridgeDir, f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only ShipBridge.ts and bridge/*.ts use the bridge internals', () => {
    const bad: string[] = [];
    for (const f of tsFiles(serverSrc)) {
      const rel = relative(serverSrc, f).replace(/\\/g, '/');
      if (rel === 'ships/ShipBridge.ts' || rel.startsWith('ships/bridge/')) continue;
      if (/\bBridge(Ctx|Internals)\b/.test(readFileSync(f, 'utf8'))) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
