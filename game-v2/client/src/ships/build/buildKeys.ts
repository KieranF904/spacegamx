/**
 * @contract client.ships.build-keys
 * owns:       the keys both build editors add on top of the game's key table: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo and M for
 *             symmetry, caught before the game's own handlers (M is a quick bar key there, and the table only passes a key's code)
 * needs:      DOM window keydown events
 * invariants: the three keys are told apart from plain letters and from typing in a text box — client/src/ships/build/buildKeys.test.ts
 * extend:     a new editor-wide key is one more case in buildKeyAction() and one more member of BuildKeyActions
 */

export type BuildKeyAction = 'undo' | 'redo' | 'symmetry';

/** What a key press means to a build editor (null: not ours) */
export function buildKeyAction(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): BuildKeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey) return null;
  if (mod && e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (mod && e.code === 'KeyY' && !e.shiftKey) return 'redo';
  if (!mod && !e.shiftKey && e.code === 'KeyM') return 'symmetry';
  return null;
}

export interface BuildKeyActions {
  /** Is the editor open (the keys do nothing otherwise) */
  active(): boolean;
  undo(): void;
  redo(): void;
  symmetry(): void;
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** Listen for the editor keys on the window, ahead of the game (capture phase); returns the unbind */
export function bindBuildKeys(a: BuildKeyActions): () => void {
  const on = (e: KeyboardEvent): void => {
    if (!a.active() || typing(e.target)) return;
    const act = buildKeyAction(e);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && act === 'symmetry') return;
    a[act]();
  };
  window.addEventListener('keydown', on, true);
  return () => window.removeEventListener('keydown', on, true);
}
