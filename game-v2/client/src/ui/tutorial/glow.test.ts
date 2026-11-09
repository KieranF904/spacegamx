import { describe, expect, it } from 'vitest';
import { Glow, type GlowHost } from './glow';

/** A page of named controls: `shown` is whether each is on screen; a selector is a name or a comma list of names */
function fakePage() {
  const present = new Map<string, { shown: boolean; lit: boolean }>();
  let clicks: ((m: (s: string) => boolean) => void)[] = [];
  let changes: (() => void)[] = [];
  const names = (sel: string) => sel.split(',').map((x) => x.trim());
  const host: GlowHost<string> = {
    find: (sel) => names(sel).filter((n) => present.get(n)?.shown),
    mark: (el, on) => { const e = present.get(el); if (e) e.lit = on; },
    onClick: (cb) => { clicks.push(cb); return () => { clicks = clicks.filter((c) => c !== cb); }; },
    onChange: (cb) => { changes.push(cb); return () => { changes = changes.filter((c) => c !== cb); }; },
  };
  return {
    host,
    add: (n: string, shown = true) => { present.set(n, { shown, lit: false }); changes.forEach((c) => c()); },
    show: (n: string, shown: boolean) => { present.get(n)!.shown = shown; },
    remove: (n: string) => { present.delete(n); changes.forEach((c) => c()); },
    click: (n: string) => clicks.slice().forEach((c) => c((sel) => names(sel).includes(n))),
    lit: () => [...present].filter(([, v]) => v.lit).map(([k]) => k).sort(),
    watching: () => clicks.length + changes.length,
  };
}

describe('glow', () => {
  it('lights controls that render after the step starts', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    g.set('refine', ['tab', 'go']);
    expect(p.lit()).toEqual([]);
    p.add('tab');
    expect(p.lit()).toEqual(['tab']);
    p.add('go');
    // the later stage takes over once its control is up
    expect(p.lit()).toEqual(['go']);
  });
  it('stops on the clicked control and moves on to the next', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('tab');
    g.set('refine', ['tab', 'go']);
    expect(p.lit()).toEqual(['tab']);
    p.click('tab');
    expect(p.lit()).toEqual([]);
    p.add('go');
    expect(p.lit()).toEqual(['go']);
    p.click('go');
    expect(p.lit()).toEqual([]);
    // a clicked stage does not come back when its control is drawn again
    p.remove('tab');
    p.add('tab');
    expect(p.lit()).toEqual([]);
  });
  it('takes the glow off a control that leaves the screen (a closed window) on refresh', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('a');
    g.set('s', ['a']);
    p.show('a', false);
    g.refresh();
    expect(p.lit()).toEqual([]);
    p.show('a', true);
    g.refresh();
    expect(p.lit()).toEqual(['a']);
  });
  it('clears on a step change and on leave, and stops watching', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('a');
    p.add('b');
    g.set('one', ['a']);
    expect(p.lit()).toEqual(['a']);
    g.set('two', ['b']);
    expect(p.lit()).toEqual(['b']);
    g.set('three', undefined);
    expect(p.lit()).toEqual([]);
    expect(p.watching()).toBe(0);
    g.set('four', ['a']);
    expect(p.lit()).toEqual(['a']);
    g.clear();
    expect(p.lit()).toEqual([]);
    expect(p.watching()).toBe(0);
  });
  it('forgets clicks when the step changes', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('a');
    g.set('one', ['a']);
    p.click('a');
    g.set('two', ['a']);
    expect(p.lit()).toEqual(['a']);
  });
  it('a list stage lights every control in it, and a click on any ends it', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('kbd');
    p.add('hint');
    g.set('dock', ['kbd, hint']);
    expect(p.lit()).toEqual(['hint', 'kbd']);
    p.click('hint');
    expect(p.lit()).toEqual([]);
  });
  it('the same step again changes nothing (clicks are kept)', () => {
    const p = fakePage();
    const g = new Glow(p.host);
    p.add('a');
    g.set('one', ['a']);
    p.click('a');
    g.set('one', ['a']);
    expect(p.lit()).toEqual([]);
  });
});
