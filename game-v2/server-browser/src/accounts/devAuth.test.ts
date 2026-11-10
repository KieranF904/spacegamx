/**
 * SEC-09: the known-password fallbacks (the seeded `admin` password, the default lobby secret) are on only with an
 * explicit DEV_AUTH=1, and never in production.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { devAuthOn } from './devAuth.js';
import { JsonUserStore } from './JsonUserStore.js';

const dirs: string[] = [];
const saved = { dev: process.env.DEV_AUTH, node: process.env.NODE_ENV, pw: process.env.ADMIN_PASSWORD };
afterEach(() => {
  for (const [k, v] of [['DEV_AUTH', saved.dev], ['NODE_ENV', saved.node], ['ADMIN_PASSWORD', saved.pw]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-devauth-'));
  dirs.push(dir);
  return new JsonUserStore(join(dir, 'users.json'));
}

describe('devAuthOn', () => {
  it('needs DEV_AUTH=1, and production never has it', () => {
    expect(devAuthOn({})).toBe(false);
    expect(devAuthOn({ NODE_ENV: 'development' })).toBe(false);
    expect(devAuthOn({ DEV_AUTH: '0' })).toBe(false);
    expect(devAuthOn({ DEV_AUTH: 'true' })).toBe(false);
    expect(devAuthOn({ DEV_AUTH: '1' })).toBe(true);
    expect(devAuthOn({ NODE_ENV: 'development', DEV_AUTH: '1' })).toBe(true);
    expect(devAuthOn({ NODE_ENV: 'production', DEV_AUTH: '1' })).toBe(false);
  });
});

describe('the seeded admin', () => {
  it('without DEV_AUTH there is no admin with the known password (not in dev, not in production)', async () => {
    delete process.env.DEV_AUTH;
    delete process.env.ADMIN_PASSWORD;
    process.env.NODE_ENV = 'development';
    expect((await fresh().login('admin', 'admin')).success).toBe(false);
    process.env.NODE_ENV = 'production';
    expect((await fresh().login('admin', 'admin')).success).toBe(false);
  });
  it('with DEV_AUTH=1 the dev admin exists, but never in production', async () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.DEV_AUTH = '1';
    process.env.NODE_ENV = 'development';
    expect((await fresh().login('admin', 'admin')).success).toBe(true);
    process.env.NODE_ENV = 'production';
    expect((await fresh().login('admin', 'admin')).success).toBe(false);
  });
  it('ADMIN_PASSWORD still seeds the admin whatever DEV_AUTH says', async () => {
    delete process.env.DEV_AUTH;
    process.env.ADMIN_PASSWORD = 'chosen-by-hand';
    expect((await fresh().login('admin', 'chosen-by-hand')).success).toBe(true);
  });
});
