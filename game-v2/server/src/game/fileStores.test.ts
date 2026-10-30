/**
 * The files the game keeps (docs/audits/server-robustness.md): the world's
 * memory, contributor notes, and the durable write under them.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { worldFileStore } from './SystemMemory.js';
import { contribFileStore } from './contribFiles.js';
import { writeFileDurable, writeFileDurableSync } from '../profile/durableWrite.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'stores-'));
const quiet = () => [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];

describe('durable writes', () => {
  it('replace the file whole, and a failed one leaves the old file and no temp file', async () => {
    const dir = tmp(), file = join(dir, 'a.json');
    await writeFileDurable(file, 'one');
    writeFileDurableSync(file, 'two');
    expect(readFileSync(file, 'utf-8')).toBe('two');
    // (A folder can't be renamed over: the write fails at the last step)
    const blocked = join(dir, 'b.json');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'keep'), 'x');
    await expect(writeFileDurable(blocked, 'nope')).rejects.toThrow();
    expect(() => writeFileDurableSync(blocked, 'nope')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
    expect(readFileSync(join(blocked, 'keep'), 'utf-8')).toBe('x');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the world's memory file", () => {
  it('a broken file is kept aside (a fresh world starts)', () => {
    const dir = tmp(), file = join(dir, 'memory.json');
    writeFileSync(file, '{"systems": {');
    const q = quiet();
    expect(worldFileStore(file).load()).toBeNull();
    q.forEach((s) => s.mockRestore());
    expect(readdirSync(dir).some((f) => f.startsWith('memory.json.bad-'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a file that's there but can't be read isn't saved over by this run", async () => {
    const dir = tmp(), file = join(dir, 'memory.json');
    mkdirSync(file); // (EISDIR: stands in for EACCES)
    writeFileSync(join(file, 'precious'), 'x');
    const store = worldFileStore(file);
    const q = quiet();
    expect(store.load()).toBeNull();
    await store.save({ version: 1 } as never);
    q.forEach((s) => s.mockRestore());
    expect(readFileSync(join(file, 'precious'), 'utf-8')).toBe('x');
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and loads', async () => {
    const dir = tmp(), file = join(dir, 'world', 'memory.json');
    const store = worldFileStore(file);
    expect(store.load()).toBeNull();
    await Promise.all([store.save({ n: 1 } as never), store.save({ n: 2 } as never)]);
    expect([1, 2]).toContain((store.load() as { n: number }).n);
    expect(readdirSync(join(dir, 'world'))).toEqual(['memory.json']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('contributor files', () => {
  it('a broken notes file is kept aside; writes are whole', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'notes.json'), '{bad');
    const store = contribFileStore(dir);
    const q = quiet();
    expect(store.read('notes.json')).toBeNull();
    q.forEach((s) => s.mockRestore());
    store.write('notes.json', '{"version":1,"notes":[]}');
    expect(JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf-8')).version).toBe(1);
    expect(readdirSync(dir).some((f) => f.startsWith('notes.json.broken-'))).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
