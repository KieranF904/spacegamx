/**
 * The side panel's Social tab: your friends list, status, adding a friend and requests (social/FriendsPanel.ts draws
 * it; SocialUI keeps the server's list). P opens it.
 */
import type { SocialUI } from '../../SocialUI';
import type { HubTab, HubTabContext } from '../hubTabs';

export function socialTab(social: SocialUI): HubTab {
  return {
    id: 'social',
    label: 'Social',
    title: 'Social: friends and requests',
    action: 'party',
    badge: () => social.requests(),
    attach: (ctx: HubTabContext) => { social.onChange(() => ctx.invalidate()); },
    render: (body) => social.friends.render(body),
  };
}
