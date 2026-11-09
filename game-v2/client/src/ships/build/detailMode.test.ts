/** The Simple / Advanced store: Simple by default, remembered, tolerant of blocked storage, tells listeners only of real changes. */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDetailMode, saveDetailMode, onDetailMode, setDetailMode, detailMode, resetDetailMode, isSimple } from './detailMode';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const blocked = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };

describe('detail mode', () => {
  beforeEach(() => resetDetailMode());
  it('defaults to Simple, also on blocked or missing storage', () => {
    expect(loadDetailMode(mem())).toBe('simple');
    expect(loadDetailMode(blocked)).toBe('simple');
    expect(loadDetailMode(null)).toBe('simple');
  });
  it('remembers Advanced', () => {
    const s = mem();
    saveDetailMode('advanced', s);
    expect(loadDetailMode(s)).toBe('advanced');
    saveDetailMode('simple', s);
    expect(loadDetailMode(s)).toBe('simple');
    expect(() => saveDetailMode('advanced', blocked)).not.toThrow();
  });
  it('tells listeners only of changes, and stops when asked', () => {
    const seen: string[] = [];
    const off = onDetailMode((m) => seen.push(m));
    expect(isSimple()).toBe(true);
    setDetailMode('simple');
    setDetailMode('advanced');
    setDetailMode('advanced');
    expect(detailMode()).toBe('advanced');
    off();
    setDetailMode('simple');
    expect(seen).toEqual(['advanced']);
  });
});
