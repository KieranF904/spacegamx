/** The bot task registry (bots/tasks/registry.ts): the listed tasks are found by their own names, a new one can be added. */
import { describe, it, expect } from 'vitest';
import { taskNames, taskDef, registerTask } from './registry.js';
import { mineAndDeposit } from './mineAndDeposit.js';
import { randomFlight } from './randomFlight.js';

describe('bot task registry', () => {
  it('lists mine and deposit and random flight, each found under its own name', () => {
    expect(taskNames()).toEqual(expect.arrayContaining([mineAndDeposit.name, randomFlight.name]));
    expect(taskDef(mineAndDeposit.name)).toBe(mineAndDeposit);
    expect(taskDef(randomFlight.name)).toBe(randomFlight);
    expect(taskDef('no such task')).toBeUndefined();
  });

  it('a registered task is found by name', () => {
    const t = { ...randomFlight, name: 'registry-test-task' };
    registerTask(t);
    expect(taskDef('registry-test-task')).toBe(t);
    expect(taskNames()).toContain('registry-test-task');
  });
});
