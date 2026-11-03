/**
 * The server's journal of a client finding its own hits (SelfHitJournal.ts, docs/design/confirmed-hits.md part D):
 * agreement settles, silence means no change, a hit seen a snapshot apart is not corrected, a missing or unexpected hit
 * is (after a second judging), and reports from before a correction are not compared.
 */
import { describe, it, expect } from 'vitest';
import { hitHash, chainAdd } from '@space-game/common';
import { SelfHitJournal, type JournalHit } from './SelfHitJournal.js';

const hit = (shell: number, target = 50, part = 3, tick = 0): JournalHit => ({ rec: { shell, ago: 0, target, part, gone: true, glancing: false }, tick, dealt: 9.5 });
const sumOf = (...hs: JournalHit[]) => hs.reduce((c, h) => chainAdd(c, hitHash(h.rec.shell, h.rec.target, h.rec.part)), 0);
const WAIT = 12;

describe('SelfHitJournal', () => {
  it('a report that agrees settles everything up to it; nothing to correct', () => {
    const j = new SelfHitJournal(0);
    const a = hit(100, 50, 3, 2), b = hit(101, 50, 4, 5);
    j.close(3, [a]);
    j.close(6, [b]);
    j.report(6, sumOf(a, b) & 0xff, 0);
    expect(j.unsettled).toBe(0);
    for (let now = 9; now < 60; now += 3) expect(j.judge(now, WAIT)).toBeNull();
    expect(j.stats.fixes).toBe(0);
  });

  it('silence is agreement when there was nothing to find', () => {
    const j = new SelfHitJournal(0);
    for (let now = 3; now < 90; now += 3) { j.close(now, []); expect(j.judge(now, WAIT)).toBeNull(); }
    expect(j.stats.disagreed).toBe(0);
  });

  it('a hit the client never reports is corrected once its time is up and a second judging still disagrees', () => {
    const j = new SelfHitJournal(0);
    const a = hit(100, 50, 3, 2);
    j.close(3, [a]);
    let fix = null, at = -1;
    for (let now = 6; now < 60 && !fix; now += 3) { fix = j.judge(now, WAIT); at = now; }
    expect(fix).not.toBeNull();
    // (first judged at 15, corrected at the next: 18)
    expect(at).toBe(3 + WAIT + 3);
    expect(fix!.hits.map((h) => h.rec.shell)).toEqual([100]);
    expect(fix!.c).toBe(sumOf(a));
    expect(fix!.s).toBe(0);
    expect(fix!.t).toBe(at - WAIT);
    expect(fix!.e).toBe(1);
    expect(j.unsettled).toBe(0);
  });

  it('a hit the client sees a snapshot late (or early) is not corrected', () => {
    const late = new SelfHitJournal(0), early = new SelfHitJournal(0);
    const a = hit(100, 50, 3, 3);
    // Server: tick 3; client: in the snapshot after (6), reporting it
    late.close(3, [a]);
    early.close(6, [a]);
    late.report(6, sumOf(a) & 0xff, 0);
    early.report(3, sumOf(a) & 0xff, 0);
    for (let now = 6; now < 60; now += 3) {
      expect(late.judge(now, WAIT)).toBeNull();
      expect(early.judge(now, WAIT)).toBeNull();
    }
    expect(late.stats.fixes + early.stats.fixes).toBe(0);
  });

  it('a hit the client found that the server never had is corrected (with the hits the server did have)', () => {
    const j = new SelfHitJournal(0);
    const wrong = hit(300, 51, 1, 2);
    j.report(3, sumOf(wrong) & 0xff, 0);
    // (nothing unsettled: a report alone isn't judged until the server has a window to judge)
    j.close(9, [hit(301, 50, 2, 8)]);
    let fix = null;
    for (let now = 12; now < 60 && !fix; now += 3) fix = j.judge(now, WAIT);
    expect(fix).not.toBeNull();
    expect(fix!.hits.map((h) => h.rec.shell)).toEqual([301]);
  });

  it('after a correction, reports in the old count are not compared, and judging waits for the new one', () => {
    const j = new SelfHitJournal(0);
    const a = hit(100, 50, 3, 2);
    j.close(3, [a]);
    let fix = null, now = 3;
    while (!fix) { now += 3; fix = j.judge(now, WAIT); }
    // An old report arrives late: ignored
    j.report(now - 2, 0x11, 0);
    expect(j.stats.stale).toBe(1);
    // Meanwhile another hit; judging waits for the client's first report in the new count
    const b = hit(101, 50, 4, now + 1);
    j.close(now + 3, [b]);
    expect(j.judge(now + 3 + WAIT + 6, WAIT)).toBeNull();
    // It comes: the server's chain at the fix plus its own hits since
    j.report(now + 3, sumOf(a, b) & 0xff, fix.e);
    expect(j.unsettled).toBe(0);
    expect(j.stats.fixes).toBe(1);
  });
});
