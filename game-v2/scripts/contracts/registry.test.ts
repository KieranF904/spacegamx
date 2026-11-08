import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';
// @ts-expect-error plain .mjs script, no types
import { parseHeader, topComment, sectionsOf, exportsOf, packageImports } from './gen.mjs';

const ROOT = join(__dirname, '../..');

describe('contract registry', () => {
  it('headers are complete, ids are unique, named tests exist, and docs/contracts/registry.* is current (npm run contracts:gen)', () => {
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(ROOT, 'scripts/contracts/gen.mjs'), '--check'], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      throw new Error(`${err.stderr ?? ''}${err.stdout ?? ''}`);
    }
    expect(out).toContain('registry is up to date');
  });

  it('parses a header: fields, wrapped lines, invariants with their tests', () => {
    const text = [
      '/**',
      ' * @contract demo.thing',
      ' * owns:       the thing',
      ' *             and its wrap',
      ' * needs:      a, b',
      ' * invariants: one holds — a/b.test.ts',
      ' *             two holds on a wrapped',
      ' *             line — none pinned',
      ' * extend:     add a case',
      ' */',
      'export const X = 1;',
    ].join('\n');
    const h = parseHeader(topComment(text));
    expect(h.id).toBe('demo.thing');
    expect(h.owns).toBe('the thing and its wrap');
    expect(h.invariants).toEqual([
      { text: 'one holds', test: 'a/b.test.ts' },
      { text: 'two holds on a wrapped line', test: 'none pinned' },
    ]);
    expect(h.errors).toEqual([]);
  });

  it('derives exports, sections and package imports', () => {
    const text = ["import { a } from 'ws';", "import type { B } from '@space-game/common/x';", "import { c } from './c.js';", '', '/** doc */', 'export function f() {', '  return 1;', '}', '', 'export const T = {', '  a: 1,', '};', 'export { c as d };'].join('\n');
    expect(exportsOf(text)).toEqual(['T', 'd', 'f']);
    expect(sectionsOf(text)).toEqual([
      { name: 'f', kind: 'function', start: 5, end: 8 },
      { name: 'T', kind: 'const', start: 10, end: 13 },
    ]);
    expect(packageImports(text)).toEqual(['@space-game/common', 'ws']);
  });
});
