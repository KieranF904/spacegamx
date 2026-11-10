/**
 * math/basic.ts invariant: the deterministic sim keeps its own copies on purpose and does not import math/basic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : n.endsWith('.ts') && !n.endsWith('.test.ts') ? [p] : [];
  });

describe('math/basic stays out of the sim', () => {
  it('sim/, ships/flight.ts, network/replication.ts and asteroid/orbit.ts do not import it', () => {
    const sim = [...files(join(SRC, 'sim')), join(SRC, 'ships/flight.ts'), join(SRC, 'network/replication.ts'), join(SRC, 'asteroid/orbit.ts'), join(SRC, 'ships/features/minebay/minebay.ts')];
    expect(sim.length).toBeGreaterThan(10);
    for (const f of sim) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/from\s+['"][^'"]*math\/basic(\.js)?['"]|from\s+['"]\.\/basic(\.js)?['"]/);
  });
});
