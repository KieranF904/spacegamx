/** The field guide's pages, split out of the main chunk (Game prefetches it after sign-in; the menu reads it when its guide page shows) */
import { Lazy } from '../lazy';

export const fieldGuide = new Lazy(() => import('./fieldGuide').then((m) => {
  // (its CSS goes just ahead of the menu's, as it always has)
  const style = document.createElement('style');
  style.textContent = m.GUIDE_CSS;
  const menu = document.getElementById('game-menu-css');
  if (menu) menu.before(style); else document.head.appendChild(style);
  return m;
}));
