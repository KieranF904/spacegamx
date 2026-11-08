import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { esc } from './escape';

const SRC = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('esc', () => {
  it('escapes & < > " and the single quote', () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  it('stringifies non-strings', () => {
    expect(esc(12)).toBe('12');
    expect(esc(null)).toBe('null');
  });
});

describe('one HTML escaper', () => {
  it('no file under client/src defines its own escaper (import ui/escape.ts)', () => {
    const offenders: string[] = [];
    for (const f of tsFiles(SRC)) {
      if (f.replace(/\\/g, '/').endsWith('/ui/escape.ts')) continue;
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(\/\/|\*)/.test(l)) continue;
        if (/\b(?:const|let|var|function)\s+(?:esc|escT|escHtml|escapeHtml|escapeHTML|escAttr|escapeAttr)\b/.test(l) || /^\s*(?:private\s+|static\s+)+(?:esc|escHtml|escapeHtml)\s*\(/.test(l)) {
          offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
