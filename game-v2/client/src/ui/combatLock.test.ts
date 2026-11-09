import { describe, it, expect } from 'vitest';
import { combatLabel } from './CombatLockUI';

describe('combat lock badge', () => {
  it('shows whole seconds, rounded up, and nothing once the lock is over', () => {
    expect(combatLabel(12_000)).toContain('In combat 12 s');
    expect(combatLabel(11_100)).toContain('12 s');
    expect(combatLabel(1)).toContain('1 s');
    expect(combatLabel(0)).toBe('');
    expect(combatLabel(-5)).toBe('');
  });
});
