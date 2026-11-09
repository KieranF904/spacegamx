import { describe, it, expect } from 'vitest';
import { History } from './history';

const mk = (cap?: number) => new History<number>((a, b) => a === b, cap);

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = mk();
    h.record(0, 1); h.record(1, 2); h.record(2, 3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.redo(3)).toBeNull();
    expect(h.undo(3)).toBe(2);
  });

  it('nothing to undo or redo gives null', () => {
    const h = mk();
    expect(h.undo(5)).toBeNull();
    expect(h.redo(5)).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  it('a new edit drops the redo steps', () => {
    const h = mk();
    h.record(0, 1); h.record(1, 2);
    h.undo(2);
    expect(h.canRedo).toBe(true);
    h.record(1, 9);
    expect(h.canRedo).toBe(false);
    expect(h.undo(9)).toBe(1);
  });

  it('a drag is one step, whatever edits it holds', () => {
    const h = mk();
    h.begin(0);
    h.record(0, 1); h.record(1, 2); h.record(2, 3);
    h.end(3);
    expect(h.size).toBe(1);
    expect(h.undo(3)).toBe(0);
    expect(h.undo(0)).toBeNull();
  });

  it('an edit or drag that changed nothing is no step', () => {
    const h = mk();
    h.record(4, 4);
    h.begin(4); h.end(4);
    expect(h.canUndo).toBe(false);
  });

  it('a second begin inside a drag is ignored', () => {
    const h = mk();
    h.begin(0); h.begin(5); h.end(7);
    expect(h.undo(7)).toBe(0);
  });

  it('keeps only the newest steps past the cap', () => {
    const h = mk(3);
    for (let i = 0; i < 6; i++) h.record(i, i + 1);
    expect(h.size).toBe(3);
    expect(h.undo(6)).toBe(5);
    expect(h.undo(5)).toBe(4);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBeNull();
  });

  it('clear forgets everything', () => {
    const h = mk();
    h.record(0, 1);
    h.undo(1);
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});
