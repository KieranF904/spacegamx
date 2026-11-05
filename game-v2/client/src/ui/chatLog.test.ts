import { describe, it, expect } from 'vitest';
import { ChatLog, lineText, parseTab, CHAT_HISTORY } from './chatLog';

describe('chat log', () => {
  it('tags each line with its channel and filters by tab', () => {
    const log = new ChatLog();
    log.add('chat', 'Ann', 'hello');
    log.add('game', '', 'Raid inbound');
    log.add('chat', '[Party] Bo', 'ready?');
    expect(log.visible('all').map((l) => l.text)).toEqual(['hello', 'Raid inbound', 'ready?']);
    expect(log.visible('chat').map((l) => l.name)).toEqual(['Ann', '[Party] Bo']);
    expect(log.visible('game').map((l) => l.text)).toEqual(['Raid inbound']);
  });

  it('folds identical game lines in a row into one with a count', () => {
    const log = new ChatLog();
    expect(log.add('game', '', 'No power').merged).toBe(false);
    expect(log.add('game', '', 'No power').merged).toBe(true);
    log.add('game', '', 'No power');
    expect(log.lines).toHaveLength(1);
    expect(lineText(log.lines[0])).toBe('No power ×3');
    log.add('game', '', 'Other');
    log.add('game', '', 'No power');
    expect(log.lines.map(lineText)).toEqual(['No power ×3', 'Other', 'No power']);
  });

  it('does not fold player chat, or a game line across a chat line', () => {
    const log = new ChatLog();
    log.add('chat', 'Ann', 'hi');
    log.add('chat', 'Ann', 'hi');
    expect(log.lines).toHaveLength(2);
    log.add('game', '', 'x');
    log.add('chat', 'Ann', 'yo');
    log.add('game', '', 'x');
    expect(log.visible('game')).toHaveLength(2);
  });

  it('keeps only the newest lines', () => {
    const log = new ChatLog();
    for (let i = 0; i < CHAT_HISTORY + 5; i++) log.add('chat', 'a', String(i));
    expect(log.lines).toHaveLength(CHAT_HISTORY);
    expect(log.lines[0].text).toBe('5');
  });

  it('reads a saved tab, defaulting to All', () => {
    expect(parseTab('game')).toBe('game');
    expect(parseTab('chat')).toBe('chat');
    expect(parseTab('nope')).toBe('all');
    expect(parseTab(null)).toBe('all');
  });
});
