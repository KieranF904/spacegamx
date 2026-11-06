/**
 * The side panel's Components tab: the component guide (ui/ComponentGuideUI.ts, its own chunk, app/lazyScreens.ts),
 * drawn small for the HUD. C opens it.
 */
import type { Lazy } from '../../../lazy';
import type { ComponentGuideUI } from '../../ComponentGuideUI';
import type { HubTab, HubTabContext } from '../hubTabs';

export function componentsTab(guide: Lazy<ComponentGuideUI>): HubTab {
  let ctx: HubTabContext | null = null;
  return {
    id: 'components',
    label: 'Components',
    title: 'Component guide: every part, its level and what it takes',
    action: 'components',
    fill: true,
    attach: (c) => { ctx = c; },
    render: (body) => {
      if (guide.value) { guide.value.mount(body); return; }
      body.innerHTML = '<div style="padding:10px; color:#6f8099">Loading…</div>';
      guide.use(() => { if (ctx?.shown()) ctx.invalidate(); });
    },
    hide: () => guide.value?.hide(),
  };
}
