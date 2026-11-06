import { describe, it, expect } from 'vitest';
import { ChatLog, lineText, parseToggles, saveToggles, toggleChannel, allOn, channelBubbles, CHAT_HISTORY, ALL_CHANNELS, type ChatChannel } from './chatLog';

const on = (...c: ChatChannel[]) => new Set(c);
const ALL = new Set(ALL_CHANNELS);

describe('chat log', () => {
  it('tags each line with its channel and shows the channels toggled on', () => {
    const log = new ChatLog();
    log.add('chat', 'Ann', 'hello');
    log.add('game', '', 'Raid inbound');
    log.add('private', 'Cy', 'psst');
    log.add('private', 'Me', 'hi Cy', undefined, 'Cy');
    log.add('chat', '[Party] Bo', 'ready?');
    expect(log.visible(ALL).map((l) => l.text)).toEqual(['hello', 'Raid inbound', 'psst', 'hi Cy', 'ready?']);
    expect(log.visible(on('chat')).map((l) => l.name)).toEqual(['Ann', '[Party] Bo']);
    expect(log.visible(on('game')).map((l) => l.text)).toEqual(['Raid inbound']);
    expect(log.visible(on('private')).map((l) => [l.name, l.to])).toEqual([['Cy', undefined], ['Me', 'Cy']]);
    // Private mixes into public when both are on, in order
    expect(log.visible(on('chat', 'private')).map((l) => l.text)).toEqual(['hello', 'psst', 'hi Cy', 'ready?']);
  });

  it('toggles: independent, All is every one on, the last one stays on', () => {
    let t = new Set(ALL);
    expect(allOn(t)).toBe(true);
    t = toggleChannel(t, 'game');
    expect([...t]).toEqual(['chat', 'private']);
    expect(allOn(t)).toBe(false);
    t = toggleChannel(toggleChannel(t, 'chat'), 'private');
    expect([...t]).toEqual(['private']);
    t = toggleChannel(t, 'game');
    expect(t.has('game') && t.has('private')).toBe(true);
    expect([...toggleChannel(on('game'), 'game')]).toEqual(['game']);
  });

  it('only public chat may show as bubbles', () => {
    expect(channelBubbles('chat')).toBe(true);
    expect(channelBubbles('private')).toBe(false);
    expect(channelBubbles('game')).toBe(false);
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
    expect(log.visible(on('game'))).toHaveLength(2);
  });

  it('keeps only the newest lines', () => {
    const log = new ChatLog();
    for (let i = 0; i < CHAT_HISTORY + 5; i++) log.add('chat', 'a', String(i));
    expect(log.lines).toHaveLength(CHAT_HISTORY);
    expect(log.lines[0].text).toBe('5');
  });

  it('reads saved toggles (and the old single tab), defaulting to all on', () => {
    expect([...parseToggles(saveToggles(on('private', 'game')))]).toEqual(['private', 'game']);
    expect([...parseToggles('game')]).toEqual(['game']);
    expect([...parseToggles('chat')]).toEqual(['chat']);
    expect(allOn(parseToggles('all'))).toBe(true);
    expect(allOn(parseToggles('nope'))).toBe(true);
    expect(allOn(parseToggles('[]'))).toBe(true);
    expect(allOn(parseToggles('["bogus"'))).toBe(true);
    expect(allOn(parseToggles(null))).toBe(true);
  });
});
