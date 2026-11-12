import { describe, it, expect } from 'vitest';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { LocalTransport } from '../net/LocalTransport.js';
import { makeServer } from '../testkits/world.testkit.js';
import { AdminChat, ADMIN_TEXT_MAX, type AdminChatConn, type AdminChatHost } from './AdminChat.js';
import { FAST_MS, IDLE_MS, nextDelay, pollOnce } from '../adminChatLink.js';

const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** A real server with two guests on, Ash and Bree, and what each has been sent */
async function world(clock = { t: 1_000_000 }) {
  resetGlobals();
  const server = makeServer({ clock: () => clock.t });
  const pilot = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const of = <T extends ServerMessage['type']>(type: T) => {
      (server.pilots.connOf(t.getPlayerId()) as any)?.packed?.drain(server.getTick());
      return got.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
    };
    return { t, got, of, send: (m: any) => t.send(m) };
  };
  const a = pilot('Ash');
  const b = pilot('Bree');
  // (A guest's pilot is made a moment after the join: only then are they in the social lists and can whisper)
  await new Promise((r) => setTimeout(r, 0));
  return { server, chat: server.adminChat, a, b, clock };
}

describe('admin chat in the game', () => {
  it('the roster says who is on, guests marked, with when they were first seen', async () => {
    const w = await world();
    expect(w.chat.roster()).toEqual([{ name: 'Ash', guest: true, since: 1_000_000 }, { name: 'Bree', guest: true, since: 1_000_000 }]);
    w.clock.t += 5000;
    expect(w.chat.roster().map((r) => r.since)).toEqual([1_000_000, 1_000_000]);
  });

  it('a message to everyone reaches every pilot as chat from "[Admin] name"', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'all', admin: 'kieran', text: 'Restart in five minutes' });
    for (const p of [w.a, w.b]) {
      expect(p.of('chat').at(-1)).toMatchObject({ type: 'chat', playerId: 0, playerName: '[Admin] kieran', text: 'Restart in five minutes' });
      expect(p.of('whisper')).toEqual([]);
    }
  });

  it('a private message reaches only its pilot, as a whisper from the admin, with one line saying who they are', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'pm', admin: 'kieran', to: 'ASH', text: 'Hi, welcome!' });
    w.chat.deliver({ id: 2, kind: 'pm', admin: 'kieran', to: 'Ash', text: 'How is it going?' });
    expect(w.a.of('whisper')).toEqual([{ type: 'whisper', from: 'kieran', to: 'Ash', text: 'Hi, welcome!' }, { type: 'whisper', from: 'kieran', to: 'Ash', text: 'How is it going?' }]);
    const notes = w.a.of('systemMessage').filter((m) => /kieran is an admin/.test(m.text));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('/w kieran');
    expect(w.b.of('whisper')).toEqual([]);
    expect(w.b.of('systemMessage').filter((m) => /admin/.test(m.text))).toEqual([]);
    expect(w.chat.outgoing().failed).toEqual([]);
  });

  it('a private message to a pilot who has gone, or a broken one, is reported failed and shown to nobody', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'pm', admin: 'kieran', to: 'Nobody', text: 'Hello?' });
    w.chat.deliver({ id: 2, kind: 'pm', admin: 'kieran', text: 'no target' });
    w.chat.deliver({ id: 3, kind: 'all', admin: 'not a name!', text: 'x' });
    w.chat.deliver({ id: 4, kind: 'all', admin: 'kieran', text: '   ' });
    expect(w.chat.outgoing().failed).toEqual([1, 2, 3, 4]);
    for (const p of [w.a, w.b]) { expect(p.of('whisper')).toEqual([]); expect(p.of('chat')).toEqual([]); }
  });

  it('each lobby message is delivered once, however often it is handed over', async () => {
    const w = await world();
    const m = { id: 7, kind: 'all' as const, admin: 'kieran', text: 'Once' };
    w.chat.deliver(m);
    w.chat.deliver(m);
    w.chat.deliver({ ...m, id: 6, text: 'Older' });
    expect(w.a.of('chat')).toHaveLength(1);
    expect(w.chat.ack).toBe(7);
  });

  it('text is cut to the limit and control characters dropped', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'all', admin: 'kieran', text: `a\u0000b\n${'x'.repeat(500)}` });
    const text = w.a.of('chat').at(-1)!.text;
    expect(text.length).toBe(ADMIN_TEXT_MAX);
    expect(text.startsWith('a b x')).toBe(true);
  });

  it("a pilot's reply to the admin (/w, or the whisper box) goes to the lobby's log and to nobody in the game", async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'pm', admin: 'kieran', to: 'Ash', text: 'Hi' });
    w.clock.t += 1000;
    w.a.send({ type: 'chat', text: '/w kieran thanks, all good' });
    w.a.send({ type: 'whisper', to: 'KIERAN', text: 'one more thing' });
    const out = w.chat.outgoing();
    expect(out.replies).toEqual([
      { from: 'Ash', guest: true, to: 'kieran', text: 'thanks, all good', at: 1_001_000 },
      { from: 'Ash', guest: true, to: 'kieran', text: 'one more thing', at: 1_001_000 },
    ]);
    // (Ash sees their own lines as sent; Bree sees nothing; nothing went out as public chat)
    expect(w.a.of('whisper').filter((m) => m.out)).toEqual([
      { type: 'whisper', from: 'Ash', to: 'kieran', text: 'thanks, all good', out: true },
      { type: 'whisper', from: 'Ash', to: 'kieran', text: 'one more thing', out: true },
    ]);
    expect(w.a.of('systemMessage').filter((m) => /offline/.test(m.text))).toEqual([]);
    expect(w.b.of('whisper')).toEqual([]);
    expect(w.b.of('chat')).toEqual([]);
    expect(w.a.of('chat')).toEqual([]);
  });

  it('after a message to everyone, anyone may reply privately to that admin', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'all', admin: 'kieran', text: 'Anyone need help?' });
    w.b.send({ type: 'whisper', to: 'kieran', text: 'yes please' });
    expect(w.chat.outgoing().replies).toMatchObject([{ from: 'Bree', to: 'kieran', text: 'yes please' }]);
  });

  it('a private message to any other name that is not on gets the usual "offline" answer and is not taken', async () => {
    const w = await world();
    w.a.send({ type: 'whisper', to: 'kieran', text: 'hello?' });
    w.chat.deliver({ id: 1, kind: 'all', admin: 'kieran', text: 'hi' });
    w.a.send({ type: 'whisper', to: 'someoneelse', text: 'hello?' });
    expect(w.chat.outgoing().replies).toEqual([]);
    expect(w.a.of('systemMessage').filter((m) => /offline/.test(m.text))).toHaveLength(2);
  });

  it('a reply stops being taken a day after the admin last wrote', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'pm', admin: 'kieran', to: 'Ash', text: 'Hi' });
    w.clock.t += 25 * 60 * 60_000;
    w.a.send({ type: 'whisper', to: 'kieran', text: 'late' });
    expect(w.chat.outgoing().replies).toEqual([]);
  });

  it('whispers between pilots who are on are untouched', async () => {
    const w = await world();
    w.chat.deliver({ id: 1, kind: 'all', admin: 'Bree', text: 'an admin who shares a pilot name' });
    w.a.send({ type: 'whisper', to: 'Bree', text: 'psst' });
    expect(w.b.of('whisper')).toEqual([{ type: 'whisper', from: 'Ash', to: 'Bree', text: 'psst' }]);
    expect(w.chat.outgoing().replies).toEqual([]);
  });
});

describe('admin chat: the link to the lobby', () => {
  interface Conn extends AdminChatConn { sent: ServerMessage[] }
  function rig(conns: Conn[] = [{ username: 'Ash', userId: 5, joined: true, sent: [] }]) {
    const host: AdminChatHost<Conn> = { conns: () => conns, send: (c, m) => { c.sent.push(m); }, note: () => {}, now: () => 50 };
    const chat = new AdminChat(host);
    const calls: { url: string; auth: string; body: any }[] = [];
    let answer: unknown = { success: true, messages: [] };
    const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      if (answer instanceof Error) throw answer;
      return { ok: true, json: async () => answer };
    };
    const opts = { url: 'http://lobby/', secret: 'sssh', server: 'AUS Main', fetch: f as any };
    return { chat, conns, calls, opts, answer: (a: unknown) => { answer = a; } };
  }

  it('one call says who is on and brings back the messages, behind the admin secret', async () => {
    const r = rig();
    r.answer({ success: true, messages: [{ id: 3, kind: 'pm', admin: 'kieran', to: 'Ash', text: 'Hi' }] });
    expect(await pollOnce(r.chat, r.opts)).toBe(true);
    expect(r.calls[0]).toEqual({ url: 'http://lobby/admin/chat/poll', auth: 'Bearer sssh', body: { server: 'AUS Main', online: [{ name: 'Ash', guest: false, since: 50 }], replies: [], failed: [], ack: 0 } });
    expect(r.conns[0].sent).toEqual([{ type: 'whisper', from: 'kieran', to: 'Ash', text: 'Hi' }]);
    r.answer({ success: true, messages: [] });
    await pollOnce(r.chat, r.opts);
    expect(r.calls[1].body.ack).toBe(3);
  });

  it('a reply the lobby did not take is offered again; one it took is not sent twice', async () => {
    const r = rig();
    r.chat.deliver({ id: 1, kind: 'pm', admin: 'kieran', to: 'Ash', text: 'Hi' });
    r.chat.replyTo(r.conns[0], 'kieran', 'hello back');
    for (const bad of [new Error('down'), { success: false }, 'nonsense', null]) {
      r.answer(bad);
      expect(await pollOnce(r.chat, r.opts)).toBe(false);
      expect(r.chat.pending).toBe(true);
    }
    r.answer({ success: true, messages: [] });
    expect(await pollOnce(r.chat, r.opts)).toBe(true);
    expect(r.calls.at(-1)!.body.replies).toMatchObject([{ from: 'Ash', guest: false, to: 'kieran', text: 'hello back' }]);
    expect(r.chat.pending).toBe(false);
    await pollOnce(r.chat, r.opts);
    expect(r.calls.at(-1)!.body.replies).toEqual([]);
  });

  it('asks every couple of seconds while pilots are on, and slowly when nobody is', () => {
    expect(nextDelay(rig().chat)).toBe(FAST_MS);
    expect(nextDelay(rig([]).chat)).toBe(IDLE_MS);
    expect(nextDelay(rig([{ username: 'x', userId: null, joined: false, sent: [] }]).chat)).toBe(IDLE_MS);
    expect(FAST_MS).toBeLessThanOrEqual(2000);
  });
});
