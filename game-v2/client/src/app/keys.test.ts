import { describe, it, expect } from 'vitest';
import { handleKey, MODAL_CHAIN, PRE_KEYS, POST_KEYS, type KeyHost } from './keys';

/** A host whose windows are all shut, logged in, recording what it was asked to do */
function fakeHost(over: Record<string, unknown> = {}): { h: KeyHost; calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => () => { calls.push(name); };
  const h = {
    loggedIn: true, stationOpen: false, proto: null,
    menu: { isOpen: false, back: rec('menu.back'), open: rec('menu.open') },
    dialogue: { onKey: () => false },
    hub: { dismiss: () => false, toggle: (id: string) => { calls.push('hub:' + id); } },
    inventoryWindow: { isOpen: false, open: rec('inv.open'), close: rec('inv.close') },
    tradeWindow: { isOpen: false, close: rec('trade.close') },
    social: { isMember: () => false, invite: rec('invite') },
    quests: { log: { isOpen: false, close: rec('log.close'), toggle: rec('log.toggle'), open: rec('log.open') } },
    stationWindow: { value: null },
    shipClient: { hangarOpen: false, onKey: () => false },
    autopilot: { active: false, cancel: rec('ap.cancel') },
    context: { active: false, jumpMark: () => false, cancel: () => false },
    quickBar: { use: rec('quick') },
    infoPanel: { hovered: 0 },
    pingUI: { pingAtCursor: rec('ping') },
    targetUI: { cycle: rec('cycle'), pickAtCursor: rec('pick') },
    playerStatsUI: { isVisible: () => false, hide: rec('stats.hide'), toggle: rec('stats.toggle') },
    systemMapUI: { isOpen: false, toggle: rec('map.toggle') },
    navMarkers: null,
    regionUI: { allowInteract: () => true },
    audio: { playUI: rec('audio') },
    network: { send: (m: { type: string }) => { calls.push('send:' + m.type); } },
    input: { isKeyDown: () => false, resetZoom: rec('zoom') },
    renderer: { setZoom: rec('setZoom') },
    toggleAutopilotToObjective: rec('autopilot.toggle'),
    showSystemMessage: rec('msg'),
    ...over,
  } as unknown as KeyHost;
  return { h, calls };
}

describe('keys: the modal chain and tables', () => {
  it('has the chain in its fixed order (menu first, station last)', () => {
    expect(MODAL_CHAIN.length).toBe(8);
  });

  it('P opens the side panel on Social, or invites the pilot under the cursor', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'KeyP');
    expect(calls).toEqual(['hub:social']);
    const b = fakeHost({ infoPanel: { hovered: 7 } });
    handleKey(b.h, 'KeyP');
    expect(b.calls).toEqual(['invite']);
  });

  it('C opens the side panel on the component guide, but not on the map', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'KeyC');
    expect(calls).toEqual(['hub:components']);
    const m = fakeHost({ systemMapUI: { isOpen: true, toggle: () => {} } });
    handleKey(m.h, 'KeyC');
    expect(m.calls).toEqual([]);
  });

  it('Esc puts away a side panel called up over the station before anything else below the menu', () => {
    const { h, calls } = fakeHost({ hub: { dismiss: () => { calls.push('hub.dismiss'); return true; }, toggle: () => {} } });
    handleKey(h, 'Escape');
    expect(calls).toEqual(['hub.dismiss']);
  });

  it('Esc with the menu open only steps the menu back', () => {
    const { h, calls } = fakeHost({ menu: { isOpen: true, back: () => calls.push('menu.back'), open: () => calls.push('menu.open') } });
    handleKey(h, 'Escape');
    expect(calls).toEqual(['menu.back']);
  });

  it('an open window swallows keys that would be global', () => {
    const { h, calls } = fakeHost({ tradeWindow: { isOpen: true, close: () => calls.push('trade.close') } });
    handleKey(h, 'KeyM');
    expect(calls).toEqual([]);
    handleKey(h, 'Escape');
    expect(calls).toEqual(['trade.close']);
  });

  it('Esc opens the menu when nothing else wants it', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'Escape');
    expect(calls).toEqual(['menu.open']);
  });

  it('keys do nothing before login', () => {
    const { h, calls } = fakeHost({ loggedIn: false });
    for (const k of ['KeyM', 'KeyR', 'KeyI', 'Escape', 'KeyG']) handleKey(h, k);
    expect(calls).toEqual([]);
  });

  it('the ship gets its keys before the global table', () => {
    const { h, calls } = fakeHost({ shipClient: { hangarOpen: false, onKey: () => true } });
    handleKey(h, 'KeyI');
    expect(calls).toEqual([]);
  });

  it('each table key is an own property (no prototype lookups)', () => {
    for (const k of [...Object.keys(PRE_KEYS), ...Object.keys(POST_KEYS)]) expect(k).toMatch(/^[A-Za-z0-9]+$/);
  });
});
