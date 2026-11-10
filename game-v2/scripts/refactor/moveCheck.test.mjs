// Runs under vitest (npm test)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkMoves, extractFunctions, normalise } from './moveCheck.mjs';

const A_OLD = `
export class Server {
  private x = 1;
  private doThing(a: number): number {
    // compute it
    const v = this.x + a; // trailing
    return this.helper(v) * 2;
  }
  private same(): void {
    this.x++;
  }
  private rewritten(n: number): { a: number } {
    return { a: this.x + n };
  }
  private gone() { return "}{ not a brace"; }
  private oldName() { for (const k of this.list) { this.use(\`\${k}\`); } }
  stays() { return 1; }
}
`;
const A_NEW = `
export class Server {
  private x = 1;
  stays() { return 1; }
}
`;
const B_NEW = `
export function doThing(ctx: Server, a: number): number {
  const v = ctx.x   +   a;
  return ctx.helper(v)*2;
}
export function same(b: Server): void { b.x++; }
export function rewritten(s: Server, n: number): { a: number } {
  return { a: s.x + n + 1 };
}
export const newName = (ctx: Server) => { for (const k of ctx.list) { ctx.use(\`\${k}\`); } };
`;

test('extracts methods with return types, strings and templates', () => {
  const names = extractFunctions(A_OLD).map((f) => f.name);
  assert.deepEqual(names, ['doThing', 'same', 'rewritten', 'gone', 'oldName', 'stays']);
});

test('normalise unifies receivers, whitespace and comments', () => {
  assert.equal(normalise('// hi\n this.a  = 1 ;'), normalise('ctx.a=1;'));
  assert.notEqual(normalise('this.a = 1'), normalise('this.a = 2'));
  assert.notEqual(normalise('x.this.a = 1'), normalise('x.ctx.b = 1'));
});

test('classifies moved, changed, renamed and unmatched functions', () => {
  const r = checkMoves({
    oldFiles: new Map([['a.ts', A_OLD]]),
    newFiles: new Map([['a.ts', A_NEW], ['b.ts', B_NEW]]),
  });
  assert.deepEqual(r.ok.map((m) => m.name).sort(), ['doThing', 'same']);
  assert.deepEqual(r.changed.map((m) => m.name), ['rewritten']);
  assert.deepEqual(r.renamed.map((m) => `${m.name}>${m.as}`), ['oldName>newName']);
  assert.deepEqual(r.unmatched.map((m) => m.name), ['gone']);
  assert.equal(r.ok[0].from, 'a.ts');
  assert.equal(r.ok[0].to, 'b.ts');
});

test('custom receivers', () => {
  const r = checkMoves({
    oldFiles: new Map([['a.ts', 'class A {\n  f() { return this.z + 1; }\n}']]),
    newFiles: new Map([['a.ts', 'class A { }'], ['b.ts', 'function f(self) { return self.z + 1; }']]),
    receivers: ['self'],
  });
  assert.equal(r.ok.length, 1);
});
