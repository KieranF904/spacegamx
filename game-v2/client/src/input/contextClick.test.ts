/**
 * The right-click menu's rules: the modifier opens it and a plain right-click fires, what's
 * picked under the cursor, which options each kind of thing offers (and why
 * one can't be taken), where the menu goes on screen, and when an order's
 * action is due (and how a jump lines up, charges and fires).
 */
import { describe, it, expect } from 'vitest';
import {
  RightClick, rightPress, pickTargets, targetOptions, openSpaceOptions, jumpBlocked, defaultIndex, stepIndex,
  placeMenu, outsideBy, orderStep, jumpStep,
  MIN_FLY, TRADE_RANGE, MENU_GAP, MENU_MARGIN, JUMP_ALIGN_TICKS, JUMP_ASK_TICKS,
  type ContextTarget, type TargetFacts, type MenuOption, type DriveFacts,
} from './contextClick';

describe('menu or fire', () => {
  it('a plain right-click fires at once; with the modifier held, in flight, it opens the menu', () => {
    expect(rightPress({ modifier: false, enabled: true })).toBe('fire');
    expect(rightPress({ modifier: true, enabled: true })).toBe('menu');
    // (A window, the map or the hangar over the world: no menu, it's the guns as ever)
    expect(rightPress({ modifier: true, enabled: false })).toBe('fire');
  });

  it('a plain press never holds the right fire back', () => {
    const c = new RightClick();
    c.down(false);
    expect(c.withholding).toBe(false);
  });

  it('the press that opened the menu holds the right fire back until it is let go', () => {
    const c = new RightClick();
    c.down(true);
    expect(c.withholding).toBe(true);
    c.up();
    expect(c.withholding).toBe(false);
    c.down(true);
    c.reset(); // focus lost
    expect(c.withholding).toBe(false);
  });
});

describe('picking', () => {
  const t = (kind: ContextTarget['kind'], x: number, y: number, r: number, key: string = kind): ContextTarget => ({ kind, key, name: key, x, y, r });

  it('open space is nothing', () => {
    expect(pickTargets({ x: 5000, y: 0 }, [t('station', 0, 0, 300)])).toEqual([]);
  });

  it('everything under the cursor, small and specific first: a ship over a station over a planet', () => {
    const planet = t('surface', 0, 0, 2000), station = t('station', 1500, 0, 300), ship = t('hostile', 1550, 0, 90), rock = t('rock', 1560, 20, 60);
    expect(pickTargets({ x: 1550, y: 0 }, [planet, station, rock, ship]).map((x) => x.kind)).toEqual(['hostile', 'rock', 'station', 'surface']);
  });

  it('nearer the cursor first within a kind, and no more than the cap', () => {
    const a = t('loot', 0, 0, 50, 'a'), b = t('loot', 30, 0, 50, 'b'), c = t('loot', 60, 0, 50, 'c');
    expect(pickTargets({ x: 35, y: 0 }, [a, b, c]).map((x) => x.key)).toEqual(['b', 'c', 'a']);
    expect(pickTargets({ x: 35, y: 0 }, [a, b, c], 0, 2)).toHaveLength(2);
  });

  it('someone to talk to comes before the ship they live aboard', () => {
    expect(pickTargets({ x: 10, y: 0 }, [t('ship', 0, 0, 150), t('person', 0, 0, 220)])[0].kind).toBe('person');
  });

  it('slack widens the reach round small things', () => {
    const gate = t('gate', 0, 0, 300);
    expect(pickTargets({ x: 350, y: 0 }, [gate])).toEqual([]);
    expect(pickTargets({ x: 350, y: 0 }, [gate], 60)).toEqual([gate]);
  });
});

describe('options per kind', () => {
  const ids = (o: MenuOption[]) => o.map((x) => x.id);
  const primary = (o: MenuOption[]) => o.find((x) => x.primary)?.id;
  const f = (kind: TargetFacts['kind'], more: Partial<TargetFacts> = {}): TargetFacts => ({ kind, dist: 4000, ...more });

  it('places: the way in first, then fly to', () => {
    expect(ids(targetOptions(f('station')))).toEqual(['dock', 'flyTo']);
    expect(primary(targetOptions(f('station')))).toBe('dock');
    expect(ids(targetOptions(f('gate')))).toEqual(['travel', 'flyTo']);
    expect(ids(targetOptions(f('rift')))).toEqual(['flyInto', 'flyTo']);
    expect(ids(targetOptions(f('cave')))).toEqual(['enter', 'flyTo']);
    expect(ids(targetOptions(f('pocket')))).toEqual(['enter', 'flyTo']);
    expect(ids(targetOptions(f('surface')))).toEqual(['land', 'flyTo']);
    expect(ids(targetOptions(f('planet')))).toEqual(['flyTo']);
    expect(ids(targetOptions(f('person')))).toEqual(['talk', 'flyTo']);
  });

  it('says whether the autopilot flies there first', () => {
    expect(targetOptions(f('station', { inRange: true }))[0].hint).toBe('now');
    expect(targetOptions(f('station'))[0].hint).toBe('autopilot');
    expect(targetOptions(f('surface', { siege: true }))[0].label).toBe('Descend (siege)');
  });

  it('a barred gate: greyed with the reason, and fly to becomes the default', () => {
    const o = targetOptions(f('gate', { lock: 'Ashfall: needs a Frontier licence' }));
    expect(o[0].disabled).toBe('Ashfall: needs a Frontier licence');
    expect(primary(o)).toBe('flyTo');
  });

  it('pilots: fly to, target, inspect, trade, invite (not a party mate)', () => {
    expect(ids(targetOptions(f('pilot')))).toEqual(['flyTo', 'target', 'inspect', 'trade', 'invite']);
    expect(ids(targetOptions(f('pilot', { partyMate: true })))).toEqual(['flyTo', 'target', 'inspect', 'trade']);
    expect(targetOptions(f('pilot', { targeted: true }))[1].id).toBe('untarget');
  });

  it('trading only within its reach', () => {
    const trade = (dist: number) => targetOptions(f('pilot', { dist })).find((o) => o.id === 'trade')!;
    expect(trade(TRADE_RANGE - 1).disabled).toBeUndefined();
    expect(trade(TRADE_RANGE + 1).disabled).toMatch(/Too far/);
  });

  it('hostiles and bosses: target first; derelicts too; civilians: fly to', () => {
    expect(ids(targetOptions(f('hostile')))).toEqual(['target', 'flyTo', 'mark']);
    expect(primary(targetOptions(f('boss')))).toBe('target');
    expect(ids(targetOptions(f('derelict')))).toEqual(['target', 'flyTo']);
    expect(ids(targetOptions(f('civilian')))).toEqual(['flyTo', 'target']);
  });

  it('things: a rock to mine, a pod to collect, your wreck to recover', () => {
    expect(ids(targetOptions(f('rock')))).toEqual(['approach']);
    expect(ids(targetOptions(f('loot')))).toEqual(['collect']);
    expect(ids(targetOptions(f('wreck')))).toEqual(['recover']);
  });

  it('every kind has exactly one default, and every option an icon and a label', () => {
    const kinds: TargetFacts['kind'][] = ['station', 'gate', 'rift', 'cave', 'pocket', 'surface', 'planet', 'person', 'pilot', 'hostile', 'boss', 'derelict', 'civilian', 'ship', 'rock', 'loot', 'wreck'];
    for (const k of kinds) {
      const o = targetOptions(f(k));
      expect(o.filter((x) => x.primary), k).toHaveLength(1);
      for (const x of o) { expect(x.icon).toBeTruthy(); expect(x.label).toBeTruthy(); }
    }
  });
});

describe('open space', () => {
  const drive: DriveFacts = { phase: 'ready', reach: 50000, minRange: 5000, cool: 0 };
  const jump = (dist: number, d: DriveFacts | null = drive) => openSpaceOptions(dist, d).find((o) => o.id === 'jumpHere');

  it('fly here, jump here, mark here; fly here is the default', () => {
    const o = openSpaceOptions(20000, drive);
    expect(o.map((x) => x.id)).toEqual(['flyHere', 'jumpHere', 'mark']);
    expect(o.find((x) => x.primary)?.id).toBe('flyHere');
    expect(jump(20000)!.disabled).toBeUndefined();
    expect(jump(20000)!.hint).toBe('20 km · reach 50 km · ready');
  });

  it('no drive fitted: no jump at all', () => {
    expect(jump(20000, null)).toBeUndefined();
    expect(jump(20000, { ...drive, reach: 0 })).toBeUndefined();
  });

  it('right by the ship: nowhere to fly, so mark is the default', () => {
    const o = openSpaceOptions(MIN_FLY - 1, drive);
    expect(o[0].disabled).toBeTruthy();
    expect(o.find((x) => x.primary)?.id).toBe('mark');
  });

  it('a jump that cannot go says why: cooling, charging, too close, out of range', () => {
    expect(jumpBlocked(20000, { ...drive, phase: 'cooldown', cool: 7.2 })).toBe('Cooling down · 8 s');
    expect(jump(20000, { ...drive, phase: 'cooldown', cool: 7.2 })!.hint).toMatch(/cooling 8 s/);
    expect(jumpBlocked(20000, { ...drive, phase: 'charging' })).toMatch(/already charging/);
    expect(jumpBlocked(5200, drive)).toMatch(/^Too close/); // (just over minRange: the coast would overshoot)
    expect(jumpBlocked(80000, drive)).toBe('Out of range: the drive reaches 50 km from here');
    expect(jump(80000)!.disabled).toMatch(/Out of range/);
    expect(jumpBlocked(20000, drive)).toBeNull();
  });
});

describe('the keys', () => {
  const o = (disabled: boolean[]): MenuOption[] => disabled.map((d, i) => ({ id: 'flyTo', icon: 'fly', label: `${i}`, disabled: d ? 'no' : undefined, primary: i === 1 }));

  it('Enter starts on the default, or the first that can be taken', () => {
    expect(defaultIndex(o([false, false, false]))).toBe(1);
    expect(defaultIndex(o([false, true, false]))).toBe(0);
    expect(defaultIndex(o([true, true]))).toBe(-1);
  });

  it('the arrows skip what cannot be taken, and go round the ends', () => {
    const opts = o([false, true, false, false]);
    expect(stepIndex(opts, 0, 1)).toBe(2);
    expect(stepIndex(opts, 3, 1)).toBe(0);
    expect(stepIndex(opts, 0, -1)).toBe(3);
    expect(stepIndex(opts, 2, -1)).toBe(0);
  });
});

describe('placing the menu', () => {
  const view = { w: 1280, h: 800 }, size = { w: 240, h: 180 };

  it('down and right of the click', () => {
    expect(placeMenu({ x: 400, y: 300 }, size, view)).toEqual({ x: 400 + MENU_GAP, y: 300 + MENU_GAP, flipX: false, flipY: false });
  });

  it('flips left at the right edge, up at the bottom', () => {
    const p = placeMenu({ x: 1200, y: 750 }, size, view);
    expect(p).toEqual({ x: 1200 - MENU_GAP - 240, y: 750 - MENU_GAP - 180, flipX: true, flipY: true });
  });

  it('kept on screen when it is bigger than the room either side', () => {
    const p = placeMenu({ x: 100, y: 100 }, { w: 240, h: 760 }, view);
    expect(p.y).toBe(MENU_MARGIN);
    expect(p.y + 760).toBeLessThanOrEqual(view.h - MENU_MARGIN);
  });

  it('how far the cursor has wandered from it', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expect(outsideBy({ x: 150, y: 150 }, box)).toBe(0);
    expect(outsideBy({ x: 350, y: 150 }, box)).toBe(50);
    expect(outsideBy({ x: 330, y: 240 }, box)).toBe(50);
  });
});

describe('orders', () => {
  it('the autopilot docking (or going down) itself: wait while it flies, done when it stops', () => {
    expect(orderStep({ selfActing: true }, { autopilot: true, arrived: false, inRange: true })).toBe('wait');
    expect(orderStep({ selfActing: true }, { autopilot: false, arrived: true, inRange: true })).toBe('done');
  });

  it('an action on reach: due once in range on the way, or on arriving in range', () => {
    const o = { selfActing: false };
    expect(orderStep(o, { autopilot: true, arrived: false, inRange: false })).toBe('wait');
    expect(orderStep(o, { autopilot: true, arrived: false, inRange: true })).toBe('act');
    expect(orderStep(o, { autopilot: false, arrived: true, inRange: true })).toBe('act');
    // Arrived short of it: nothing
    expect(orderStep(o, { autopilot: false, arrived: true, inRange: false })).toBe('done');
  });

  it('the pilot taking over in range is a cancel, not an arrival', () => {
    expect(orderStep({ selfActing: false }, { autopilot: false, arrived: false, inRange: true })).toBe('done');
  });
});

describe('a menu jump', () => {
  const base = { phase: 'ready' as const, facingErr: 0.5, angVel: 0, ticks: 0, asked: -1, charged: false };

  it('turns to the mark with the drive off, then switches it on', () => {
    expect(jumpStep(base)).toEqual({ jump: false, state: 'aligning' });
    expect(jumpStep({ ...base, facingErr: 0.01 })).toEqual({ jump: true, state: 'aligning' });
    // Still swinging through: not yet
    expect(jumpStep({ ...base, facingErr: 0.01, angVel: 0.05 }).jump).toBe(false);
  });

  it('keeps the drive on through the input delay, then holds it through the charge', () => {
    expect(jumpStep({ ...base, facingErr: 0.3, asked: 3 })).toEqual({ jump: true, state: 'aligning' });
    expect(jumpStep({ ...base, phase: 'charging', asked: 10 })).toEqual({ jump: true, state: 'charging' });
  });

  it('fires once the burn starts, and is over', () => {
    expect(jumpStep({ ...base, phase: 'burn', charged: true }).state).toBe('fired');
  });

  it('a charge that collapses is the end of it: it never starts again by itself', () => {
    expect(jumpStep({ ...base, facingErr: 0, charged: true })).toEqual({ jump: false, state: 'interrupted' });
    expect(jumpStep({ ...base, facingErr: 0, asked: JUMP_ASK_TICKS + 1 })).toEqual({ jump: false, state: 'interrupted' });
  });

  it('gives up if it can\'t line up', () => {
    expect(jumpStep({ ...base, ticks: JUMP_ALIGN_TICKS + 1 }).state).toBe('stuck');
  });
});
