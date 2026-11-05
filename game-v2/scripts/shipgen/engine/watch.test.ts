// Watching CLI runs: the list, the follow of a growing file (partial last line), and the path guard. No network.
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { followJsonl, listWatchRuns, watchFile } from './watch';

const root = mkdtempSync(join(tmpdir(), 'shipgen-watch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const line = (o: object) => JSON.stringify(o) + '\n';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('listWatchRuns', () => {
  it('finds runs, newest first, with what the start event says and whether they finished', () => {
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'trial/b'), { recursive: true });
    mkdirSync(join(root, 'stills'), { recursive: true });
    writeFileSync(join(root, 'stills/events.jsonl'), line({ type: 'start' }));
    writeFileSync(join(root, 'a/events.jsonl'), line({ type: 'start', mode: 'design', model: 'm1', role: 'starter', t: 0 }));
    writeFileSync(join(root, 'a/metrics.json'), '{}');
    writeFileSync(join(root, 'trial/b/events.jsonl'), line({ type: 'start', mode: 'compare', model: 'x', models: ['x', 'y'], t: 0 }) + line({ type: 'done', t: 1 }));
    const old = new Date(Date.now() - 60000);
    require('fs').utimesSync(join(root, 'a/events.jsonl'), old, old);
    const runs = listWatchRuns(root);
    expect(runs.map((r) => r.id)).toEqual(['trial/b', 'a']);
    expect(runs[0]).toMatchObject({ mode: 'compare', model: 'x vs y', finished: true });
    expect(runs[1]).toMatchObject({ mode: 'design', model: 'm1', role: 'starter', finished: true });
  });
  it('marks a run with no done event or metrics as unfinished', () => {
    mkdirSync(join(root, 'c'), { recursive: true });
    writeFileSync(join(root, 'c/events.jsonl'), line({ type: 'start', mode: 'design', model: 'm', t: 0 }));
    expect(listWatchRuns(root).find((r) => r.id === 'c')?.finished).toBe(false);
  });
});

describe('followJsonl', () => {
  it('replays, follows growth, and waits for the rest of a partial last line', async () => {
    const f = join(root, 'grow.jsonl');
    writeFileSync(f, line({ n: 1 }) + line({ n: 2 }) + '{"n":');
    const got: number[] = [];
    const fol = followJsonl(f, (e: any) => got.push(e.n), 20);
    expect(got).toEqual([1, 2]);
    appendFileSync(f, '3}\n' + line({ n: 4 }));
    await wait(80);
    expect(got).toEqual([1, 2, 3, 4]);
    appendFileSync(f, line({ n: 5 }));
    await wait(80);
    fol.stop();
    appendFileSync(f, line({ n: 6 }));
    await wait(80);
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });
  it('waits for a file that does not exist yet', async () => {
    const f = join(root, 'later.jsonl');
    const got: number[] = [];
    const fol = followJsonl(f, (e: any) => got.push(e.n), 20);
    writeFileSync(f, line({ n: 7 }));
    await wait(80);
    fol.stop();
    expect(got).toEqual([7]);
  });
});

describe('watchFile path guard', () => {
  it('only gives events files under the output folder', () => {
    expect(watchFile(root, 'a')).toBe(join(root, 'a', 'events.jsonl'));
    expect(watchFile(root, '../a')).toBeNull();
    expect(watchFile(root, 'a/../../x')).toBeNull();
    expect(watchFile(root, '%2e%2e/a')).toBeNull();
    expect(watchFile(root, 'nope')).toBeNull();
  });
});
