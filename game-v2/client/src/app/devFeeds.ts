/**
 * Where dev-only messages go (the boss tools' panel state): a dev panel registers here when it's made (app/devTools.ts,
 * dev builds only), so the message table needs no dev code of its own. In a production build nothing registers.
 */

import type { ServerBossDevMessage } from '@space-game/common';

export const devFeeds: { bossDev?: (msg: ServerBossDevMessage) => void } = {};
