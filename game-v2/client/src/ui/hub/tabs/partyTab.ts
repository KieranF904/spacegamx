/**
 * The side panel's Party tab: your party with each member's options, invite by name, the pilots nearby (invite,
 * trade, fly to) and what a party gives you (SocialUI.renderParty draws it). Redrawn as the party changes and once a
 * second for the distances.
 */
import type { SocialUI } from '../../SocialUI';
import type { HubTab, HubTabContext } from '../hubTabs';

export function partyTab(social: SocialUI): HubTab {
  return {
    id: 'party',
    label: 'Party',
    title: 'Party: your party and the pilots nearby',
    live: 1000,
    attach: (ctx: HubTabContext) => { social.onChange(() => ctx.invalidate()); },
    render: (body) => social.renderParty(body),
  };
}
