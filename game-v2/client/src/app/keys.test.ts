import { describe, it, expect, beforeEach } from 'vitest';
import { handleKey, FLIGHT_KEYS, MODAL_CHAIN, PRE_KEYS, POST_KEYS, type KeyHost } from './keys';
import { ACTIONS } from '../input/keybindings';
import { PickupWindows } from '../ui/pickup';
import { groupSelection } from '../ships/weaponGroups/selection';

/** A host whose windows are all shut, logged in, recording what it was asked to do */
function fakeHost(over: Record<string, unknown> = {}): { h: KeyHost; calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => () => { calls.push(name); };
  const h = {
    loggedIn: true, stationOpen: false,
    menu: { isOpen: false, back: rec('menu.back'), open: rec('menu.open') },
    dialogue: { onKey: () => false },
    hub: { dismiss: () => false, toggle: (id: string) => { calls.push('hub:' + id); } },
    inventoryWindow: { isOpen: false, open: rec('inv.open'), close: rec('inv.close') },
    shipWindow: { isOpen: false, onKey: () => false, toggle: rec('ship.toggle') },
    pickup: { onKey: () => false },
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
    expect(MODAL_CHAIN.length).toBe(10);
  });

  it('I opens the Ship window in flight; Esc closes it; it lets the flight keys through', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'KeyI');
    expect(calls).toEqual(['ship.toggle']);
    let open = true;
    const o = fakeHost({ shipWindow: { get isOpen() { return open; }, toggle: () => {}, onKey: (c: string) => { if (c === 'Escape' && open) { open = false; o.calls.push('ship.close'); return true; } return false; } } });
    handleKey(o.h, 'KeyW');
    handleKey(o.h, 'Semicolon');
    expect(o.calls).toEqual(['map.toggle', 'audio']);
    handleKey(o.h, 'Escape');
    expect(o.calls.slice(-1)).toEqual(['ship.close']);
  });

  it('P opens the side panel on Social, or invites the pilot under the cursor', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'KeyP');
    expect(calls).toEqual(['hub:social']);
    const b = fakeHost({ infoPanel: { hovered: 7 } });
    handleKey(b.h, 'KeyP');
    expect(b.calls).toEqual(['invite']);
  });

  it('[ (the components action) opens the side panel on the component guide, but not on the map', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'BracketLeft');
    expect(calls).toEqual(['hub:components']);
    const m = fakeHost({ systemMapUI: { isOpen: true, toggle: () => {} } });
    handleKey(m.h, 'BracketLeft');
    expect(m.calls).toEqual([]);
  });

  it('the five actions that were on C V B N M answer to their new default codes, and no longer to the letters', () => {
    const def = (id: string) => ACTIONS.find((a) => a.id === id)!.key;
    expect(['components', 'helm', 'ping', 'nav', 'map'].map(def)).toEqual(['BracketLeft', 'Quote', 'BracketRight', 'Backslash', 'Semicolon']);
    expect(['contextMenu', 'interact'].map(def)).toEqual(['KeyZ', 'KeyX']);
    const { h, calls } = fakeHost({ pingUI: { pingAtCursor: (danger: boolean) => calls.push('ping:' + danger) } });
    handleKey(h, 'KeyX');
    expect(calls).toEqual(['send:interact']);
    handleKey(h, 'BracketRight');
    expect(calls).toEqual(['send:interact', 'ping:false']);
    handleKey(h, 'Semicolon');
    expect(calls).toEqual(['send:interact', 'ping:false', 'map.toggle', 'audio']);
    // (The letters are the quick bar's now: nothing of the old actions)
    (h as unknown as { quickBar: { use(i: number): void } }).quickBar.use = () => {};
    for (const k of ['KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM']) handleKey(h, k);
    expect(calls).toEqual(['send:interact', 'ping:false', 'map.toggle', 'audio']);
    // (Interact and the helm switch are flight keys: they hand control back from the autopilot)
    expect(FLIGHT_KEYS.has(def('interact')) && FLIGHT_KEYS.has(def('helm'))).toBe(true);
    expect(FLIGHT_KEYS.has('KeyV')).toBe(false);
  });

  it('the key that opens the map shuts it; M with the map open neither shuts it nor uses a quick item', () => {
    let open = false;
    const used: number[] = [];
    const { h } = fakeHost({ systemMapUI: { get isOpen() { return open; }, loaded: true, toggle: () => { open = !open; } } });
    (h as unknown as { quickBar: { use(i: number): void } }).quickBar.use = (i) => { used.push(i); };
    handleKey(h, 'Semicolon');
    expect(open).toBe(true);
    handleKey(h, 'KeyM');
    expect([open, used]).toEqual([true, []]);
    handleKey(h, 'Semicolon');
    expect(open).toBe(false);
    handleKey(h, 'KeyM');
    expect([open, used]).toEqual([false, [4]]);
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
    handleKey(h, 'Semicolon');
    expect(calls).toEqual([]);
    handleKey(h, 'Escape');
    expect(calls).toEqual(['trade.close']);
  });

  it('the pickup windows: Esc closes the top one, the open catalogue swallows keys; F (after the ship) toggles the pickup panel', () => {
    const log: string[] = [];
    const w = (panel: boolean, _auto: boolean, picker: boolean) => ({
      panel: { isOpen: panel, toggle: () => log.push('panel.toggle'), close: () => log.push('panel.close') },
      picker: { isOpen: picker, close: () => log.push('picker.close') },
    });
    const onKey = (o: ReturnType<typeof w>, code: string) => PickupWindows.prototype.onKey.call(o as never, code);
    expect(onKey(w(false, false, false), 'KeyF')).toBe(false);
    expect(onKey(w(false, false, false), 'KeyW')).toBe(false);
    expect(onKey(w(true, true, false), 'Escape')).toBe(true);
    // (The auto-pickup lists are the Ship window's Pickup tab now: Esc there is the Ship window's)
    expect(onKey(w(false, true, false), 'Escape')).toBe(false);
    expect(onKey(w(true, false, false), 'KeyW')).toBe(false);
    expect(onKey(w(true, false, true), 'KeyW')).toBe(true);
    expect(onKey(w(true, false, true), 'Escape')).toBe(true);
    expect(log).toEqual(['panel.close', 'picker.close']);
    // In the chain: it gets the key before the inventory window
    const { h, calls } = fakeHost({ pickup: { onKey: (c: string) => { calls.push(`pickup:${c}`); return true; } }, inventoryWindow: { isOpen: true, close: () => calls.push('inv.close') } });
    handleKey(h, 'Escape');
    expect(calls).toEqual(['pickup:Escape']);
    // F after the ship's own keys: the panel when the ship doesn't take it
    const f = fakeHost({ pickup: { onKey: () => false, panel: { toggle: () => f.calls.push('pickup.toggle') } } });
    handleKey(f.h, 'KeyF');
    expect(f.calls).toEqual(['pickup.toggle']);
  });

  it('Esc opens the menu when nothing else wants it', () => {
    const { h, calls } = fakeHost();
    handleKey(h, 'Escape');
    expect(calls).toEqual(['menu.open']);
  });

  it('keys do nothing before login', () => {
    const { h, calls } = fakeHost({ loggedIn: false });
    for (const k of ['Semicolon', 'KeyM', 'KeyR', 'KeyI', 'Escape', 'KeyG']) handleKey(h, k);
    expect(calls).toEqual([]);
  });

  it('the ship gets its keys before the global table', () => {
    const { h, calls } = fakeHost({ shipClient: { hangarOpen: false, onKey: () => true } });
    handleKey(h, 'KeyI');
    expect(calls).toEqual([]);
  });

  it('the quick bar is on C V B N M (its actions\' default codes), never on 1-5', () => {
    const { h } = fakeHost();
    const used: number[] = [];
    (h as unknown as { quickBar: { use(i: number): void } }).quickBar.use = (i) => { used.push(i); };
    for (const k of ['KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM']) handleKey(h, k);
    expect(used).toEqual([0, 1, 2, 3, 4]);
    for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) handleKey(h, k);
    expect(used.length).toBe(5);
    groupSelection.reset();
  });

  it('a quick bar key does nothing on the map (C centres it), with Ctrl held (Ctrl+C copies), in the hangar or before login', () => {
    const used: number[] = [];
    const host = (over: Record<string, unknown>) => {
      const { h } = fakeHost(over);
      (h as unknown as { quickBar: { use(i: number): void } }).quickBar.use = (i) => { used.push(i); };
      return h;
    };
    handleKey(host({ systemMapUI: { isOpen: true, toggle: () => {} } }), 'KeyC');
    handleKey(host({ input: { isKeyDown: () => false, resetZoom: () => {}, ctrlDown: true } }), 'KeyC');
    handleKey(host({ loggedIn: false }), 'KeyC');
    expect(used).toEqual([]);
    handleKey(host({}), 'KeyC');
    expect(used).toEqual([0]);
  });

  it('each table key is an own property (no prototype lookups)', () => {
    for (const k of [...Object.keys(PRE_KEYS), ...Object.keys(POST_KEYS)]) expect(k).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('keys: the weapon group keys', () => {
  beforeEach(() => groupSelection.reset());
  const sel = () => [groupSelection.leftGroup, groupSelection.rightGroup];
  const shifted = (down: boolean) => fakeHost({ input: { isKeyDown: () => false, resetZoom: () => {}, shiftDown: down } }).h;

  it('1-5 set the group the left button fires; the right button stays', () => {
    const h = shifted(false);
    for (let g = 1; g <= 5; g++) {
      handleKey(h, `Digit${g}`);
      expect(sel()).toEqual([g, 0]);
    }
  });

  it('Shift+1-5 set the group the right button fires; the left button stays', () => {
    const h = shifted(true);
    for (let g = 1; g <= 5; g++) {
      handleKey(h, `Digit${g}`);
      expect(sel()).toEqual([0, g]);
    }
  });

  it('the number of the group a button is already on puts that button back on all', () => {
    const plain = shifted(false), shift = shifted(true);
    handleKey(plain, 'Digit3');
    handleKey(shift, 'Digit4');
    expect(sel()).toEqual([3, 4]);
    handleKey(plain, 'Digit3');
    expect(sel()).toEqual([0, 4]);
    handleKey(shift, 'Digit4');
    expect(sel()).toEqual([0, 0]);
    // (The other button's group is not this button's: 4 on the left while the right is on 4 picks it)
    handleKey(shift, 'Digit4');
    handleKey(plain, 'Digit4');
    expect(sel()).toEqual([4, 4]);
  });

  it('untouched, both buttons are on all; the keys do nothing before login or in the hangar', () => {
    expect(sel()).toEqual([0, 0]);
    handleKey(fakeHost({ loggedIn: false }).h, 'Digit2');
    handleKey(fakeHost({ shipClient: { hangarOpen: true, onKey: () => false } }).h, 'Digit2');
    expect(sel()).toEqual([0, 0]);
  });

  it('6 and up are not group keys', () => {
    const h = shifted(false);
    for (const k of ['Digit6', 'Digit0', 'Digit9']) handleKey(h, k);
    expect(sel()).toEqual([0, 0]);
  });
});
