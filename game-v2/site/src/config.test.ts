import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const prod = { NODE_ENV: 'production', SITE_SECRET: 'x'.repeat(40), LOBBY_ADMIN_SECRET: 'lobby-secret', SITE_ORIGIN: 'https://space.example.com' };

describe('site settings', () => {
  it('run on dev defaults outside production', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.production).toBe(false);
    expect(cfg.secret).toHaveLength(64); // random for this run
    expect(cfg.lobbyAdminSecret).toBe('dev-lobby-admin-secret');
  });

  it('production takes its secrets from the environment', () => {
    const cfg = loadConfig(prod as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ production: true, secret: prod.SITE_SECRET, lobbyAdminSecret: 'lobby-secret', origin: prod.SITE_ORIGIN, secureCookies: true });
  });

  it('production without them stops, naming everything missing at once', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SITE_SECRET is not set[\s\S]*LOBBY_ADMIN_SECRET is not set[\s\S]*SITE_ORIGIN must be/);
    expect(() => loadConfig({ ...prod, SITE_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/too short/);
    expect(() => loadConfig({ ...prod, SITE_ORIGIN: 'http://space.example.com' } as NodeJS.ProcessEnv)).toThrow(/https/);
    expect(() => loadConfig({ ...prod, SITE_STORE_BACKEND: 'postgres' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});
