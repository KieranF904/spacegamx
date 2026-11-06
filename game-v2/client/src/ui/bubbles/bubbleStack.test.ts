import { describe, it, expect } from 'vitest';
import {
  BubbleBoard, BUBBLE, ORIGIN_REFRESH, ORIGIN_EASE, approach, bubbleAlpha, bubbleDone, clipText, lifeFor,
  newOrigin, originDue, originLive, originSample, originStep, type Bubble,
} from './bubbleStack';

/** Step the board in small frames from `from` to `to` */
function run(board: BubbleBoard, from: number, to: number, dt = 1 / 60): void {
  for (let t = from + dt; t <= to + 1e-9; t += dt) board.step(t, dt);
}

describe('chat bubble stacks', () => {
  it('fades in, holds, fades out, then is gone', () => {
    const board = new BubbleBoard();
    const b = board.say(1, 'Ann', 'hi', 0, 30);
    expect(bubbleAlpha(b, 0)).toBe(0);
    expect(bubbleAlpha(b, BUBBLE.fadeIn / 2)).toBeCloseTo(0.5);
    expect(bubbleAlpha(b, BUBBLE.fadeIn)).toBe(1);
    const life = lifeFor('hi');
    expect(bubbleAlpha(b, life - 0.01)).toBe(1);
    expect(bubbleAlpha(b, life + BUBBLE.fadeOut / 2)).toBeCloseTo(0.5);
    expect(bubbleDone(b, life + BUBBLE.fadeOut)).toBe(true);
    board.step(life + BUBBLE.fadeOut, 0.016);
    expect(board.size).toBe(0);
    expect(board.stacks.size).toBe(0);
  });

  it('longer lines stay longer, up to the cap', () => {
    expect(lifeFor('a'.repeat(60))).toBeGreaterThan(lifeFor('hi'));
    expect(lifeFor('a'.repeat(1000))).toBe(BUBBLE.maxLife);
  });

  it('stacks the newest at the bottom, older ones above by their heights', () => {
    const board = new BubbleBoard();
    const a = board.say(1, 'Ann', 'one', 0, 30);
    const b = board.say(1, 'Ann', 'two', 0.1, 40);
    const c = board.say(1, 'Ann', 'three', 0.2, 20);
    const s = board.stacks.get(1)!;
    expect(s.bubbles).toEqual([a, b, c]);
    expect(c.target).toBe(0);
    expect(b.target).toBe(20 + BUBBLE.gap);
    expect(a.target).toBe(20 + BUBBLE.gap + 40 + BUBBLE.gap);
  });

  it('a measured height lays the stack out again', () => {
    const board = new BubbleBoard();
    const a = board.say(1, 'Ann', 'one', 0);
    const b = board.say(1, 'Ann', 'two', 0);
    expect(a.target).toBe(BUBBLE.gap);
    board.setHeight(b, 33);
    expect(a.target).toBe(33 + BUBBLE.gap);
  });

  it('older bubbles glide up to their new place (no jump), and a new one rises into place', () => {
    const board = new BubbleBoard();
    const a = board.say(1, 'Ann', 'one', 0, 30);
    run(board, 0, 1);
    expect(a.y).toBe(0);
    const b = board.say(1, 'Ann', 'two', 1, 30);
    expect(b.y).toBe(-BUBBLE.rise);
    board.step(1 + 1 / 60, 1 / 60);
    // (one frame in: on its way, not there)
    expect(a.y).toBeGreaterThan(0);
    expect(a.y).toBeLessThan(a.target);
    run(board, 1 + 1 / 60, 2);
    expect(a.y).toBe(30 + BUBBLE.gap);
    expect(b.y).toBe(0);
  });

  it('the glide is frame-rate independent', () => {
    let y30 = 0, y120 = 0;
    for (let i = 0; i < 15; i++) y30 = approach(y30, 100, BUBBLE.glide, 1 / 30);
    for (let i = 0; i < 60; i++) y120 = approach(y120, 100, BUBBLE.glide, 1 / 120);
    expect(y30).toBeCloseTo(y120, 3);
  });

  it('when the oldest times out, the rest settle down into its room', () => {
    const board = new BubbleBoard();
    const a = board.say(1, 'Ann', 'one', 0, 30);
    const b = board.say(1, 'Ann', 'a much longer line that stays up a good deal longer', 0, 30);
    run(board, 0, 1);
    expect(b.y).toBe(0);
    expect(a.y).toBe(30 + BUBBLE.gap);
    const gone = lifeFor('one') + BUBBLE.fadeOut;
    run(board, 1, gone + 0.1);
    expect(board.stacks.get(1)!.bubbles).toEqual([b]);
    expect(b.target).toBe(0);
  });

  it('caps a stack: the oldest fades out early, and a burst drops the extras at once', () => {
    const released: Bubble[] = [];
    const board = new BubbleBoard((b) => released.push(b));
    const said: Bubble[] = [];
    for (let i = 0; i < BUBBLE.perPilot; i++) said.push(board.say(1, 'Ann', `line ${i}`, 0, 20));
    const extra = board.say(1, 'Ann', 'one more', 0.5, 20);
    // (the oldest is fading from now, the new one stays)
    expect(said[0].fades).toBe(0.5);
    expect(extra.fades).toBeGreaterThan(1);
    for (let i = 0; i < 10; i++) board.say(1, 'Ann', `spam ${i}`, 0.6, 20);
    expect(board.stacks.get(1)!.bubbles.length).toBeLessThanOrEqual(BUBBLE.perPilot + 1);
    expect(released.length).toBeGreaterThan(0);
    expect(board.size).toBe(board.stacks.get(1)!.bubbles.length);
  });

  it('caps the total: the oldest bubble anywhere goes', () => {
    const board = new BubbleBoard();
    for (let i = 0; i < BUBBLE.total; i++) board.say(100 + i, `P${i}`, 'hey', i * 0.01, 20);
    expect(board.size).toBe(BUBBLE.total);
    board.say(999, 'Late', 'me too', 1, 20);
    expect(board.size).toBe(BUBBLE.total);
    expect(board.stacks.has(100)).toBe(false);
    expect(board.stacks.has(999)).toBe(true);
  });

  it('a pilot whose only bubble was the oldest still gets the new one', () => {
    const board = new BubbleBoard();
    board.say(1, 'Ann', 'first', 0, 20);
    for (let i = 1; i < BUBBLE.total; i++) board.say(100 + i, `P${i}`, 'hey', 0.1, 20);
    board.say(1, 'Ann', 'again', 1, 20);
    expect(board.stacks.get(1)?.bubbles.map((b) => b.text)).toEqual(['again']);
  });

  it('reuses released bubbles', () => {
    const board = new BubbleBoard();
    const a = board.say(1, 'Ann', 'hi', 0, 20);
    board.step(100, 0.016);
    const b = board.say(2, 'Bo', 'yo', 100, 20);
    expect(b).toBe(a);
    expect(b.pilot).toBe(2);
    expect(b.text).toBe('yo');
  });
});

describe('clipText', () => {
  it('leaves short lines and folds whitespace', () => {
    expect(clipText('  hello   there ')).toBe('hello there');
  });
  it('cuts long lines at a word, with an ellipsis', () => {
    const t = 'the quick brown fox jumps over the lazy dog '.repeat(10);
    const c = clipText(t, 50);
    expect(c.length).toBeLessThanOrEqual(50);
    expect(c.endsWith('…')).toBe(true);
    expect(t.startsWith(c.slice(0, -1))).toBe(true);
    expect(c.slice(0, -1).endsWith(' ')).toBe(false);
  });
  it('cuts an unbroken run where it is', () => {
    const c = clipText('x'.repeat(300), 40);
    expect(c).toBe('x'.repeat(39) + '…');
  });
});

describe('bubble origins', () => {
  it('a live one follows exactly', () => {
    const o = newOrigin();
    originLive(o, 10, 20, 0);
    originLive(o, 15, 25, 0.016);
    expect([o.x, o.y, o.live]).toEqual([15, 25, true]);
  });

  it('a far one is sampled on the refresh, and eased to the new place', () => {
    const o = newOrigin();
    expect(originDue(o, 0)).toBe(true);
    originSample(o, 100, 0, 0);
    expect([o.x, o.y, o.known, o.live]).toEqual([100, 0, true, false]);
    expect(originDue(o, ORIGIN_REFRESH / 2)).toBe(false);
    expect(originDue(o, ORIGIN_REFRESH)).toBe(true);
    originSample(o, 200, 0, ORIGIN_REFRESH);
    originStep(o, ORIGIN_REFRESH);
    expect(o.x).toBe(100);
    originStep(o, ORIGIN_REFRESH + ORIGIN_EASE / 2);
    expect(o.x).toBeCloseTo(150);
    originStep(o, ORIGIN_REFRESH + ORIGIN_EASE);
    expect(o.x).toBe(200);
    // (held there till the next sample)
    originStep(o, ORIGIN_REFRESH + 0.9);
    expect(o.x).toBe(200);
  });

  it('leaving the live view: sampled at once, eased from where it was drawn', () => {
    const o = newOrigin();
    originLive(o, 0, 0, 0);
    expect(originDue(o, 0.01)).toBe(true);
    originSample(o, 40, 0, 0.01);
    originStep(o, 0.01);
    expect(o.x).toBe(0);
    originStep(o, 0.01 + ORIGIN_EASE);
    expect(o.x).toBe(40);
  });

  it('the board eases a stack origin as it steps', () => {
    const board = new BubbleBoard();
    board.say(1, 'Ann', 'hi', 0, 20);
    const o = board.stacks.get(1)!.origin;
    originSample(o, 0, 0, 0);
    originSample(o, 0, 100, 0.5);
    board.step(0.5 + ORIGIN_EASE, 0.016);
    expect(o.y).toBe(100);
  });
});
