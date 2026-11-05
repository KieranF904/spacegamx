import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonUserStore } from './JsonUserStore.js';
import type { UserStore } from './types.js';
import { BAN_FOREVER } from './utils.js';

/**
 * What every account backend does the same. The Postgres one runs it too when DATABASE_URL points at a scratch
 * database with schema.sql applied (it adds and removes its own accounts, named "contract-*"):
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest npx vitest run server-browser/src/accounts/userStore.test.ts
 * (and `npm install --no-save pg` in server-browser/, or anywhere above it)
 */
function contract(name: string, make: () => Promise<{ store: UserStore; done: () => Promise<void> | void }>) {
  describe(`${name} account store`, () => {
    it('registers, signs in, validates and signs out', async () => {
      const { store, done } = await make();
      const reg = await store.register('contract-ace', 'contract-ace@example.com', 'pw-1234');
      if (!reg.success) throw new Error(reg.error);
      expect((await store.register('CONTRACT-ACE', 'other@example.com', 'pw')).success).toBe(false);
      expect((await store.register('contract-two', 'Contract-Ace@example.com', 'pw')).success).toBe(false);
      expect((await store.login('contract-ace', 'wrong')).success).toBe(false);
      const login = await store.login('Contract-Ace', 'pw-1234');
      if (!login.success) throw new Error(login.error);
      expect((await store.validateSession(login.token))?.id).toBe(reg.user.id);
      await store.logout(login.token);
      expect(await store.validateSession(login.token)).toBeNull();
      expect(await store.validateSession(reg.token)).not.toBeNull();
      await store.deleteUser(reg.user.id);
      await done();
    });

    it('changes the password and email, and ends the other sessions', async () => {
      const { store, done } = await make();
      const reg = await store.register('contract-bob', 'contract-bob@example.com', 'old-pw');
      if (!reg.success) throw new Error(reg.error);
      const id = reg.user.id;
      const other = await store.login('contract-bob', 'old-pw');
      if (!other.success) throw new Error(other.error);
      expect(await store.checkPassword(id, 'old-pw')).toBe(true);
      await store.setPassword(id, 'new-pw');
      expect(await store.checkPassword(id, 'old-pw')).toBe(false);
      expect(await store.checkPassword(id, 'new-pw')).toBe(true);
      expect(await store.endSessions(id, reg.token)).toBe(1);
      expect(await store.validateSession(other.token)).toBeNull();
      expect(await store.validateSession(reg.token)).not.toBeNull();
      expect(await store.setEmail(id, 'contract-bob2@example.com')).toBeNull();
      expect((await store.getUserById(id))?.email).toBe('contract-bob2@example.com');
      expect(await store.setEmail(id, 'not an email')).not.toBeNull();
      await store.deleteUser(id);
      await done();
    });

    it('bans, lists and ranks accounts', async () => {
      const { store, done } = await make();
      const reg = await store.register('contract-cy', 'contract-cy@example.com', 'pw');
      if (!reg.success) throw new Error(reg.error);
      const id = reg.user.id;
      await store.setBan(id, BAN_FOREVER, 'spam', 'boss');
      expect(await store.getUserById(id)).toMatchObject({ banned_until: BAN_FOREVER, ban_reason: 'spam', banned_by: 'boss' });
      await store.setBan(id, null, '', '');
      expect((await store.getUserById(id))?.banned_until).toBeNull();
      await store.setAdmin(id, true);
      expect((await store.getUserByUsername('CONTRACT-CY'))?.is_admin).toBe(true);
      expect(reg.user.is_owner).toBe(false);
      await store.setOwner(id, true);
      expect((await store.getUserById(id))?.is_owner).toBe(true);
      expect((await store.validateSession(reg.token))?.is_owner).toBe(true);
      await store.setOwner(id, false);
      expect((await store.getUserByUsername('contract-cy'))?.is_owner).toBe(false);
      const page = await store.listUsers('contract-', 0, 10);
      expect(page.users.map((u) => u.username)).toContain('contract-cy');
      expect(page.total).toBeGreaterThanOrEqual(1);
      await store.deleteUser(id);
      await done();
    });

    it('deletes an account for good, sessions with it, and never gives its id out again', async () => {
      const { store, done } = await make();
      const reg = await store.register('contract-dee', 'contract-dee@example.com', 'pw');
      if (!reg.success) throw new Error(reg.error);
      await store.deleteUser(reg.user.id);
      await store.deleteUser(reg.user.id); // nothing left is fine
      expect(await store.getUserById(reg.user.id)).toBeNull();
      expect(await store.validateSession(reg.token)).toBeNull();
      expect((await store.login('contract-dee', 'pw')).success).toBe(false);
      const next = await store.register('contract-eve', 'contract-eve@example.com', 'pw');
      if (!next.success) throw new Error(next.error);
      expect(next.user.id).toBeGreaterThan(reg.user.id);
      await store.deleteUser(next.user.id);
      await done();
    });
  });
}

contract('JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-contract-'));
  const store = new JsonUserStore(join(dir, 'users.json'));
  return { store, done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
});

if (process.env.DATABASE_URL) {
  contract('postgres', async () => {
    const { PostgresUserStore } = await import('./PostgresUserStore.js');
    const store = await PostgresUserStore.create(process.env.DATABASE_URL!);
    return { store, done: () => store.close() };
  });
}
