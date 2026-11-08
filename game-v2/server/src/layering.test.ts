/**
 * Layering rules, checked by reading the source (DEVELOPMENT.md "Layering"):
 *  - no import cycles in common/, server/ or client/ (scripts/cycles/check.mjs; also `npm run cycles:check`)
 *  - the client and the server do not import each other, except tests (*.test.ts), test kits (*.testkit.ts),
 *    server bench/ code, proto/ folders, and the client's proto and replay tools (Proto*.ts, replay*.ts)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Every module specifier a file names: import/export-from, dynamic import(), vi.mock(), require() */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bmock\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const norm = (p: string) => p.split(sep).join('/');

/** May this file import across client <-> server? */
function exempt(file: string): boolean {
  const f = norm(relative(ROOT, file));
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (/\.test\.[tj]sx?$/.test(base) || /\.testkit\.[tj]sx?$/.test(base)) return true;
  if (f.startsWith('server/src/testkits/')) return true;
  if (/\/bench\//.test(f) || /\/proto\//.test(f)) return true;
  // The client's prototype tools and replay worker (they run a server in the page)
  if (f.startsWith('client/src/') && /^(proto|replay)/i.test(base)) return true;
  return false;
}

function crossings(from: 'client' | 'server', other: 'client' | 'server'): string[] {
  const bad: string[] = [];
  const base = join(ROOT, from, 'src');
  for (const file of walk(base)) {
    if (exempt(file)) continue;
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      let hit = spec === `@space-game/${other}` || spec.startsWith(`@space-game/${other}/`);
      if (!hit && spec.startsWith('.')) {
        const target = norm(relative(ROOT, resolve(dirname(file), spec)));
        hit = target === other || target.startsWith(`${other}/`);
      }
      if (hit) bad.push(`${norm(relative(ROOT, file))} imports ${spec}`);
    }
  }
  return bad;
}

describe('layering', () => {
  it('the client imports nothing from the server outside tests, kits, proto and replay tools', () => {
    expect(crossings('client', 'server')).toEqual([]);
  });

  it('the server imports nothing from the client outside tests, kits, bench and proto', () => {
    expect(crossings('server', 'client')).toEqual([]);
  });

  it('common/, server/ and client/ have no import cycles', () => {
    let out = '';
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'cycles', 'check.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}` || String(e);
    }
    expect(out).toBe('');
  });
});
