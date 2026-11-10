/**
 * Dev-only known credentials (SEC-09, docs/audits/full-audit-2026-11-10.md): the default lobby secret exists only when
 * DEV_AUTH=1 is set explicitly (the dev npm scripts do, from game-v2/dev.env), and never when NODE_ENV=production.
 * Merely not being production is not enough: a server started without DEV_AUTH fails closed.
 */

/** Is the known-password fallback on? (The same rule is in server-browser/src/accounts/devAuth.ts) */
export function devAuthOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_AUTH === '1';
}
