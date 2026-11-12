/**
 * The plain-language pages (fixed text: views/legal.ts).
 *   GET /privacy   what we keep, who sees it, what leaves our servers
 *   GET /refunds   donations are gifts, refunds are discretionary, the contributor rank
 */

import { privacyPage, refundsPage, PRIVACY_PATH, REFUNDS_PATH } from '../views/legal.js';
import type { RouteEnv } from './env.js';

export function registerLegal(env: RouteEnv): void {
  env.router.get(PRIVACY_PATH, (ctx) => env.page(ctx, 200, privacyPage(ctx.page)));
  env.router.get(REFUNDS_PATH, (ctx) => env.page(ctx, 200, refundsPage(ctx.page)));
}
