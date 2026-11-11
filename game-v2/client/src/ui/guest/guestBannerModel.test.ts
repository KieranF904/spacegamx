import { describe, it, expect } from 'vitest';
import { guestBannerModel, spanText } from './guestBannerModel';

const H = 60 * 60_000, D = 24 * H;

describe('guest banner words', () => {
  it('spans in few words', () => {
    expect(spanText(2 * D + 5 * H + 40 * 60_000)).toBe('2 d 5 h');
    expect(spanText(3 * D)).toBe('3 d');
    expect(spanText(12 * H)).toBe('12 h');
    expect(spanText(5 * H + 20 * 60_000)).toBe('5 h 20 m');
    expect(spanText(40 * 60_000 + 5_000)).toBe('40 m');
    expect(spanText(30_000)).toBe('under a minute');
    expect(spanText(-5)).toBe('under a minute');
  });

  it('an active guest: the keep rule and the time left, counting down from when the status arrived', () => {
    const s = { state: 'active' as const, keepMs: 12 * H, expiresInMs: 2 * D + 5 * H };
    const m = guestBannerModel(s, 1000, 1000);
    expect(m.title).toBe('Guest account — register to save your progress');
    expect(m.detail).toBe('Kept 12 h after you leave · expires in 2 d 5 h');
    expect(m.expired).toBe(false);
    expect(m.urgent).toBe(false);
    expect(guestBannerModel(s, 1000, 1000 + 5 * H).detail).toBe('Kept 12 h after you leave · expires in 2 d');
    // (a clock that went back counts nothing off; past the end it stops at zero)
    expect(guestBannerModel(s, 1000, 0).detail).toContain('expires in 2 d 5 h');
    const end = guestBannerModel(s, 0, 3 * D);
    expect(end.detail).toContain('expires in under a minute');
    expect(end.urgent).toBe(true);
  });

  it('an expired guest is told to register to keep playing, and how long until the wipe', () => {
    const m = guestBannerModel({ state: 'expired', keepMs: 12 * H, expiresInMs: 11 * H + 30 * 60_000 }, 0, 0);
    expect(m.expired).toBe(true);
    expect(m.title).toContain('expired');
    expect(m.detail).toBe('Register to keep playing · wiped in 11 h');
  });
});
