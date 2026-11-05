import { describe, it, expect } from 'vitest';
import { simAim, simAimQ } from '@space-game/common';
import { BotInputSource, inputOfBotControls, keysOfInput } from './controlSource.js';
import { idle, type Controls } from './types.js';

describe('BotInputSource', () => {
  it('a bot\'s controls come out as the keys, aim and mining laser it set', () => {
    let c: Controls = { forward: true, backward: false, left: false, right: true, boost: true, aim: 2.5, aimDist: 300, mine: true };
    const src = new BotInputSource(() => c);
    const inp = src.inputAt(3);
    expect(keysOfInput(inp)).toMatchObject({ forward: true, backward: false, left: false, right: true, boost: true });
    expect(keysOfInput(inp).targetAngle).toBe(simAim(simAimQ(2.5)));
    expect(inp).toMatchObject({ fire: false, fireAlt: true, aimDist: 75 });
    expect(src.knowledge).toBe('decided');
    expect(src.confirmedThrough()).toBe(3);
    c = idle(1);
    expect(inputOfBotControls(c)).toMatchObject({ bits: 0, fireAlt: false });
    expect(src.inputAt(4).bits).toBe(0);
  });
});
