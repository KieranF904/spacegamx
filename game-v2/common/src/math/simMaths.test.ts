/**
 * The guard: no engine-dependent maths on the simulation's paths (docs/design/deterministic-maths.md).
 *
 * Math.sin, cos, tan, atan, atan2, asin, acos, exp, log, pow, hypot, cbrt, the hyperbolics, and `**`, are
 * "implementation-approximated" and differ between engines in the last bit; on these paths they go through
 * common/src/math/detTrig.ts (dsin, dcos, datan2, dhypot, dpow, ...). Math.random is never used here: what both sides
 * work out draws from a seeded generator (math/rng.ts: tickRng, hashUnit, mulberry32), and a decision only the server
 * makes keeps its own seeded generator.
 *
 * Checked: all of common/src, and the server's simulation (game/, ships/, GameServer.ts, tickOrder.ts, net/handlers/).
 * Not checked: tests, benches, the client (rendering and UI may keep Math).
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, sep } from 'path';

const ROOT = join(__dirname, '../../..');
const PATHS = ['common/src', 'server/src/game', 'server/src/ships', 'server/src/GameServer.ts', 'server/src/tickOrder.ts', 'server/src/net/handlers'];

const BANNED = new Set(['sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'pow',
  'hypot', 'cbrt', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'random']);

/** File (from game-v2/) -> why it may use native Math. Keep this short: pure rendering only */
const ALLOW: Record<string, string> = {};

function files(p: string, out: string[] = []): string[] {
  const abs = join(ROOT, p);
  if (statSync(abs).isFile()) { out.push(p); return out; }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${p}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') files(rel, out); }
    else if (/\.ts$/.test(e.name) && !/\.(test|testkit|d)\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every banned use in some source, as `what:line` */
function scan(src: string, name = 'x.ts'): string[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isMath = (n: ts.Node) => ts.isIdentifier(n) && n.text === 'Math';
  const visit = (n: ts.Node): void => {
    // Math.sin, Math.random (called or passed on), Math['sin'], const { sin } = Math
    if (ts.isPropertyAccessExpression(n) && isMath(n.expression) && BANNED.has(n.name.text)) out.push(`Math.${n.name.text}:${line(n)}`);
    if (ts.isElementAccessExpression(n) && isMath(n.expression)) out.push(`Math[]:${line(n)}`);
    if (ts.isVariableDeclaration(n) && n.initializer && isMath(n.initializer) && ts.isObjectBindingPattern(n.name)) out.push(`{} = Math:${line(n)}`);
    // x ** y, except 2 ** (a whole literal): a power of two, exact everywhere
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken || n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)) {
      const pow2 = ts.isNumericLiteral(n.left) && n.left.text === '2' && ts.isNumericLiteral(n.right) && Number.isInteger(Number(n.right.text));
      if (!pow2) out.push(`**:${line(n)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const scanFile = (rel: string) => scan(readFileSync(join(ROOT, rel), 'utf-8'), rel);

describe('simulation maths: deterministic only', () => {
  it('no Math transcendentals, ** or Math.random in common/ or the server\'s simulation (math/detTrig.ts, math/rng.ts instead)', () => {
    const all = PATHS.flatMap((p) => files(p)).map((f) => f.split(sep).join('/'));
    expect(all.length).toBeGreaterThan(200);
    const bad: string[] = [];
    for (const f of all) {
      if (ALLOW[f]) continue;
      const hits = scanFile(f);
      if (hits.length) bad.push(`${f}: ${hits.join(' ')}`);
    }
    expect(bad, 'use detTrig (dsin, dcos, datan2, dhypot, dpow, ...) or a seeded generator (math/rng.ts); pure rendering: ALLOW, with why').toEqual([]);
  });

  it('the allowlist names only files that exist and still need it', () => {
    for (const f of Object.keys(ALLOW)) { expect(statSync(join(ROOT, f)).isFile(), f).toBe(true); expect(scanFile(f).length, f).toBeGreaterThan(0); }
  });

  it('catches each way in, and lets exact maths through', () => {
    expect(scan('const a = Math.sin(x);\nconst b = Math.hypot(1, 2);')).toEqual(['Math.sin:1', 'Math.hypot:2']);
    expect(scan('f(Math.random); g(Math.random());')).toEqual(['Math.random:1', 'Math.random:1']);
    expect(scan("const { cos } = Math; Math['pow'](2, 3);")).toEqual(['{} = Math:1', 'Math[]:1']);
    expect(scan('const a = x ** 2; let b = 3; b **= 2; const c = 2 ** n;')).toEqual(['**:1', '**:1', '**:1']);
    expect(scan('const a = 2 ** 51, b = Math.sqrt(x) + Math.floor(y) + Math.abs(z) + Math.imul(p, q) + Math.PI; // Math.sin(x)')).toEqual([]);
  });
});
