/**
 * @contract client.ui.footer-bar
 * owns:       the HUD's footer: shortcut buttons along the bottom right (right of the XP bar, under the power readout), each with its key (Ship, Build,
 *             Jobs, Map, Station (at a station's ring only), Social, Guide, Settings); a click does what its key does
 * needs:      FooterItem list from app/windows.ts (each its action id, a run and an optional shown()), domWrite, keybindings
 *             boundKeyName (key names follow rebinds)
 * invariants: a button's key is its action's bound key, never a literal letter; the bar holds no state of its own —
 *             client/src/ui/ship/shipWindow.test.ts
 * extend:     a new button is one FooterItem in app/windows.ts
 */

import { setStyle, setText } from '../domWrite';
import { injectWindowStyles } from '../windowKit';

export interface FooterItem {
  id: string;
  label: string;
  /** The keybinding action (input/keybindings.ts ACTIONS, or a part feature's) whose key is shown; '' none */
  action: string;
  title: string;
  run(): void;
  /** Shown now (absent: always) */
  shown?(): boolean;
  /** Lit now (its window is open) */
  on?(): boolean;
}

const CSS = `
.sgft { position: fixed; right: 16px; bottom: 14px; display: none; gap: 4px; z-index: 880; flex-wrap: wrap-reverse; justify-content: flex-end; max-width: calc(50% - 200px); }
.sgft button { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px; min-width: 40px; padding: 4px 6px 3px;
  border-radius: 8px; background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(125, 160, 210, 0.28); color: #cfe0f5; font: 600 11px 'Segoe UI', system-ui, sans-serif; }
.sgft button:hover { background: rgba(28, 45, 82, 0.92); border-color: rgba(125, 211, 252, 0.6); color: #fff; }
.sgft button.on { border-color: #7dd3fc; background: rgba(29, 94, 122, 0.55); color: #fff; }
.sgft button kbd { font: 700 9px 'Segoe UI', sans-serif; color: #7dd3fc; letter-spacing: 0.5px; }
`;

/** The key shown under a button: the bound key's name, or nothing for an unbound action */
export function footerKey(action: string, keyName: (a: string) => string): string {
  if (!action) return '';
  const k = keyName(action);
  return k && k !== '?' ? k : '';
}

export class FooterBar {
  private root: HTMLDivElement | null = null;
  private els = new Map<string, { b: HTMLButtonElement; k: HTMLElement }>();

  constructor(private items: readonly FooterItem[], private keyName: (a: string) => string) {}

  private make(): HTMLDivElement {
    injectWindowStyles();
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    const root = document.createElement('div');
    root.className = 'sgft';
    root.dataset.hudAvoid = '1';
    for (const it of this.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = it.title;
      const l = document.createElement('span');
      l.textContent = it.label;
      const k = document.createElement('kbd');
      b.append(l, k);
      // (The click is the panel's, not the guns'; the focus goes back so the flight keys fly)
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', () => { b.blur(); it.run(); });
      root.appendChild(b);
      this.els.set(it.id, { b, k });
    }
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame (cheap: domWrite skips what hasn't changed) */
  update(visible: boolean): void {
    if (!visible && !this.root) return;
    const root = this.root ?? this.make();
    setStyle(root, 'display', visible ? 'flex' : 'none');
    if (!visible) return;
    for (const it of this.items) {
      const e = this.els.get(it.id)!;
      setStyle(e.b, 'display', !it.shown || it.shown() ? '' : 'none');
      e.b.classList.toggle('on', !!it.on?.());
      setText(e.k, footerKey(it.action, this.keyName));
    }
  }
}
