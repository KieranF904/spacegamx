/**
 * The preview's block wall (BlockArt.sync): only a block whose HP changed (marked dirty) is redrawn.
 */
import { describe, expect, it, vi } from 'vitest';
import { BlockArt } from './blockArt';
import type { Block, BlockTarget } from './blockTarget';

const block = (i: number): Block => ({ id: i, col: i, row: 0, x: i * 10, y: 0, size: 10, hp: 5, max: 5, armour: false, alive: true, appear: 1, dirty: true } as Block);

describe('only a block whose HP changed is redrawn', () => {
  it('a second sync draws nothing; a block marked dirty is drawn again, and only that one', () => {
    const art = new BlockArt(null);
    const draw = vi.spyOn(art as unknown as { drawBlock: (b: Block) => void }, 'drawBlock').mockImplementation(() => {});
    const t = { blocks: [block(0), block(1), block(2)] } as unknown as BlockTarget;
    art.sync(t);
    expect(draw).toHaveBeenCalledTimes(3);
    art.sync(t);
    expect(draw).toHaveBeenCalledTimes(3);
    t.blocks[1].hp = 3; t.blocks[1].dirty = true;
    art.sync(t);
    expect(draw).toHaveBeenCalledTimes(4);
    expect(draw.mock.calls[3][0]).toBe(t.blocks[1]);
    expect(t.blocks[1].dirty).toBe(false);
  });
});
