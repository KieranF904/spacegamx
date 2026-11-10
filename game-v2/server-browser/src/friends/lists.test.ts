/** The pure friend rules (friends/lists.ts): requests, answers, caps, and cleaning what a record holds. */
import { describe, expect, it } from 'vitest';
import { MAX_FRIENDS, MAX_PENDING, cleanLists, emptyLists, forgetIn, isEmpty, isStatus, request, respond, unfriend, type Lists } from './lists.js';

const lists = (...ids: number[]): Lists => new Map(ids.map((i) => [i, emptyLists()]));
const nums = (n: number, from = 100) => Array.from({ length: n }, (_, i) => from + i);

describe('requests', () => {
  it("can't befriend yourself, and a repeat request is pending, not doubled", () => {
    const l = lists(1, 2);
    expect(request(l, 1, 1)).toBe('self');
    expect(request(l, 1, 2)).toBe('sent');
    expect(request(l, 1, 2)).toBe('pending');
    expect(l.get(1)!.out).toEqual([2]);
    expect(l.get(2)!.in).toEqual([1]);
  });

  it('asking someone who asked you is an accept, on both sides, with no request left', () => {
    const l = lists(1, 2);
    request(l, 2, 1);
    expect(request(l, 1, 2)).toBe('accepted');
    expect(l.get(1)).toMatchObject({ friends: [2], in: [], out: [] });
    expect(l.get(2)).toMatchObject({ friends: [1], in: [], out: [] });
    expect(request(l, 1, 2)).toBe('already');
  });

  it('their full friend list stops it; your full one does too', () => {
    const l = lists(1, 2);
    l.get(2)!.friends = nums(MAX_FRIENDS);
    expect(request(l, 1, 2)).toBe('theirFull');
    l.get(1)!.friends = nums(MAX_FRIENDS);
    expect(request(l, 1, 2)).toBe('full');
  });

  it('too many requests sent: full', () => {
    const l = lists(1, 2);
    l.get(1)!.out = nums(MAX_PENDING);
    expect(request(l, 1, 2)).toBe('full');
    expect(l.get(2)!.in).toEqual([]);
  });
});

describe('answers', () => {
  it('only a request that is there can be answered', () => {
    const l = lists(1, 2);
    expect(respond(l, 1, 2, true)).toBe(false);
    expect(l.get(1)!.friends).toEqual([]);
  });

  it('a decline clears the request and makes no friendship', () => {
    const l = lists(1, 2);
    request(l, 2, 1);
    expect(respond(l, 1, 2, false)).toBe(false);
    expect(isEmpty(l.get(1)!)).toBe(true);
    expect(isEmpty(l.get(2)!)).toBe(true);
  });

  it('an accept that would pass a friend cap fails and still clears the request', () => {
    const l = lists(1, 2);
    request(l, 2, 1);
    l.get(2)!.friends = nums(MAX_FRIENDS);
    expect(respond(l, 1, 2, true)).toBe(false);
    expect(l.get(1)!.friends).toEqual([]);
    expect(l.get(1)!.in).toEqual([]);
    expect(l.get(2)!.out).toEqual([]);
  });

  it('accepting also settles a request sent the other way', () => {
    const l = lists(1, 2);
    l.get(2)!.in = [1]; l.get(1)!.out = [2];
    l.get(1)!.in = [2]; l.get(2)!.out = [1];
    expect(respond(l, 1, 2, true)).toBe(true);
    expect(l.get(1)).toMatchObject({ in: [], out: [], friends: [2] });
    expect(l.get(2)).toMatchObject({ in: [], out: [], friends: [1] });
  });
});

describe('unfriend', () => {
  it('ends the friendship on both sides, and cancels a request either way', () => {
    const l = lists(1, 2, 3);
    request(l, 1, 2); respond(l, 2, 1, true);
    expect(unfriend(l, 2, 1)).toBe(true);
    expect(l.get(1)!.friends).toEqual([]);
    expect(l.get(2)!.friends).toEqual([]);
    request(l, 1, 3);
    expect(unfriend(l, 3, 1)).toBe(true);
    expect(l.get(1)!.out).toEqual([]);
    expect(unfriend(l, 3, 1)).toBe(false);
  });
});

describe('records', () => {
  it('cleanLists drops anything odd: bad ids, self, duplicates, an unknown status', () => {
    const c = cleanLists({ status: 'dancing', friends: [2, 2, '3', -1, 0, 1.5, 7, 'x', null], in: 'nope', out: [7] }, 7);
    expect(c).toEqual({ status: 'online', friends: [2, 3], in: [], out: [] });
    expect(cleanLists(null, 1)).toEqual(emptyLists());
    expect(cleanLists({ status: 'busy' }, 1).status).toBe('busy');
  });

  it('isStatus accepts the four statuses only', () => {
    for (const s of ['online', 'away', 'busy', 'invisible']) expect(isStatus(s)).toBe(true);
    expect(isStatus('offline')).toBe(false);
    expect(isStatus(3)).toBe(false);
  });

  it('forgetIn removes an account from every list of a record and says if it changed anything', () => {
    const r = { status: 'online' as const, friends: [1, 2], in: [2], out: [3, 2] };
    expect(forgetIn(r, 2)).toBe(true);
    expect(r).toMatchObject({ friends: [1], in: [], out: [3] });
    expect(forgetIn(r, 2)).toBe(false);
  });

  it('a record with only the default status and nothing else is empty', () => {
    expect(isEmpty(emptyLists())).toBe(true);
    expect(isEmpty({ ...emptyLists(), status: 'away' })).toBe(false);
    expect(isEmpty({ ...emptyLists(), in: [1] })).toBe(false);
  });
});
