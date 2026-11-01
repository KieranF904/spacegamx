import { describe, it, expect } from 'vitest';
import { loadContext, blueprintToGrid, gridToBlueprint, partKey } from '../core/index';
import { ship } from '../core/testShips';
import { extractDesign, partialGrid, stripChatter } from './reply';
import { parseVerdict } from './critic';

const ctx = loadContext();
const wren = ship('dev/review-wren');
const grid = blueprintToGrid(ctx, wren).text;
const rows = grid.split('\n').filter((l) => !/^(name|grid|end)\b/.test(l.trim()));
const keys = (t: string) => gridToBlueprint(ctx, t).bp!.parts.map((p) => partKey(ctx, p)).sort();
const wrenKeys = wren.parts.map((p) => partKey(ctx, p)).sort();

describe('shipgen reply parser', () => {
  it('reads a clean text reply', () => {
    const ex = extractDesign(grid);
    expect(ex.via).toBe('markers');
    expect(ex.name).toBe('Review: Wren');
    expect(keys(ex.text!)).toEqual(wrenKeys);
  });

  it('ignores chatter, code fences, bold markers and <think> blocks', () => {
    const reply = `<think>Let me plan.\ngrid:\nXX XX\nend</think>\nSure! Here is my design:\n\`\`\`text\n**name:** Wren II\n**grid:**\n${rows.join('\n')}\nend\n\`\`\`\nHope you like it.`;
    const ex = extractDesign(reply);
    expect(ex.via).toBe('markers');
    expect(ex.name).toBe('Wren II');
    expect(keys(ex.text!)).toEqual(wrenKeys);
  });

  it('takes the last of two drafts', () => {
    const reply = `name: Draft\ngrid:\n0 CA ca\nend\nActually, better:\nname: Final\ngrid:\n${rows.join('\n')}\nend`;
    expect(extractDesign(reply).name).toBe('Final');
  });

  it('finds the final grid in a model that thinks aloud (prose after grid:, sketches before)', () => {
    const reply = `Okay, let me plan.\nLet's define the grid:\n\nColumns: 0, 1, 2\n0 PI^ HA PI^\n1 HA CR HA\nHmm, that has no core. Let me redo it.\nGrid:\n\n${rows.join('\n')}\n\nThat should work: the battery feeds the guns.`;
    const ex = extractDesign(reply);
    expect(ex.via).toBe('markers');
    expect(ex.notes.join()).toMatch(/skipped/);
    expect(keys(ex.text!)).toEqual(wrenKeys);
  });

  it('copes with a missing end marker (and says so)', () => {
    const ex = extractDesign(`name: X\ngrid:\n${rows.join('\n')}\n`);
    expect(ex.notes.join()).toMatch(/end/);
    expect(keys(ex.text!)).toEqual(wrenKeys);
  });

  it('finds rows with no markers at all', () => {
    const ex = extractDesign(`Here:\n${rows.join('\n')}\nThat's it.`);
    expect(ex.via).toBe('loose');
    expect(keys(ex.text!)).toEqual(wrenKeys);
  });

  it('reads the JSON contract, wrapped in prose or fences, and grids given as token arrays', () => {
    const j = JSON.stringify({ name: 'Jay', grid: rows });
    for (const reply of [j, `\`\`\`json\n${j}\n\`\`\``, `Here you go: ${j} Enjoy`]) {
      const ex = extractDesign(reply);
      expect(ex.via).toBe('json');
      expect(ex.name).toBe('Jay');
      expect(keys(ex.text!)).toEqual(wrenKeys);
    }
    const arrays = JSON.stringify({ name: 'Arr', rows: rows.map((r) => r.trim().split(/\s+/)) });
    expect(keys(extractDesign(arrays).text!)).toEqual(wrenKeys);
  });

  it('says when there is no grid', () => {
    const ex = extractDesign('I am sorry, I cannot design ships.');
    expect(ex.text).toBeNull();
    expect(ex.via).toBe('none');
    expect(ex.notes.length).toBeGreaterThan(0);
  });

  it('strips an unclosed think block, and a reply that starts mid-thought', () => {
    expect(stripChatter('grid:\n0 CA\nend\n<think>more')).not.toMatch(/more/);
    expect(stripChatter('hmm, planning...</think>name: A')).toBe('name: A');
  });

  it('previews complete rows while streaming (text and JSON)', () => {
    const text = `name: X\ngrid:\n${rows.join('\n')}\nend`;
    const cut = text.slice(0, text.indexOf(rows[2]) + 3);
    const pg = partialGrid(cut, 'text')!;
    expect(pg.lines).toBe(2);
    expect(partialGrid('name: X\ngrid:\n' + rows[0], 'text')).toBeNull();
    const j = JSON.stringify({ name: 'J', grid: rows });
    const jc = j.slice(0, j.indexOf(rows[3]) + 4);
    expect(partialGrid(jc, 'json')!.lines).toBe(3);
    expect(gridToBlueprint(ctx, partialGrid(j, 'json')!.text).bp!.parts.length).toBe(wren.parts.length);
  });

  it('salvages JSON cut off at the token limit, and says so', () => {
    const j = JSON.stringify({ name: 'Cut', grid: rows });
    const ex = extractDesign(j.slice(0, j.indexOf(rows[rows.length - 1]) - 2));
    expect(ex.via).toBe('json');
    expect(ex.name).toBe('Cut');
    expect(ex.notes[0]).toMatch(/cut off/);
    expect(ex.text!.split('\n').length).toBe(rows.length - 1 + 3);
  });

  it('reads critic verdicts', () => {
    expect(parseVerdict('{"looks": 7, "reason": "tidy"}')).toEqual({ looks: 7, reason: 'tidy' });
    expect(parseVerdict('{"looks": 14, "reason": "x"}').looks).toBe(10);
    expect(parseVerdict('I give it 6/10: a bit boxy.').looks).toBe(6);
    expect(parseVerdict('no idea').looks).toBeNull();
  });
});
