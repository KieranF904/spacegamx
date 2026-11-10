/**
 * @contract client.ships.build-detail-toggle
 * owns:       the small "Simple · Advanced" switch in an editor's header
 * needs:      build/detailMode; DOM
 * invariants: the switch shows the stored mode and follows changes made elsewhere — client/src/ships/build/buildViews.test.ts
 * extend:     none
 */

import { detailMode, onDetailMode, setDetailMode, type DetailMode } from './detailMode';

const CSS = "display:inline-flex; flex:none; border:1px solid #2a3a5a; border-radius:5px; overflow:hidden; font:600 10px 'Segoe UI',system-ui,sans-serif; letter-spacing:0.5px;";

/** The switch; `dispose` stops it listening (call when the editor goes) */
export function detailToggle(): { el: HTMLElement; dispose(): void } {
  const el = document.createElement('div');
  el.style.cssText = CSS;
  el.setAttribute('role', 'radiogroup');
  el.setAttribute('aria-label', 'Detail level');
  el.title = 'Simple shows what a new pilot needs; Advanced shows every number';
  const btns = (['simple', 'advanced'] as DetailMode[]).map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m === 'simple' ? 'Simple' : 'Advanced';
    b.setAttribute('role', 'radio');
    b.dataset.detail = m;
    b.style.cssText = 'all:unset; cursor:pointer; padding:3px 8px; text-transform:uppercase;';
    b.onclick = () => setDetailMode(m);
    el.append(b);
    return b;
  });
  const paint = (cur: DetailMode) => btns.forEach((b) => {
    const on = b.dataset.detail === cur;
    b.setAttribute('aria-checked', String(on));
    b.style.background = on ? '#24406b' : '#0f1626';
    b.style.color = on ? '#fff' : '#8ea0bd';
  });
  paint(detailMode());
  const off = onDetailMode(paint);
  return { el, dispose: off };
}
