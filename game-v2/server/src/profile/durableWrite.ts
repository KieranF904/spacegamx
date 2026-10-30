/**
 * Writing a file so that a crash, a power cut or a full disk never leaves it
 * half written: the new contents go to a temp file beside it, which is flushed
 * to disk (fsync) and then renamed over the old one (atomic on one filesystem).
 * If anything fails the old file is untouched and the temp file is removed.
 */
import { promises as fs, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'fs';
import { dirname } from 'path';

let seq = 0;
const tmpName = (file: string) => `${file}.${process.pid}.${++seq}.tmp`;

export async function writeFileDurable(file: string, data: string): Promise<void> {
  const tmp = tmpName(file);
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, file);
  } catch (e) {
    await fh?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  // The rename itself is made durable by flushing the folder (not possible on Windows: skipped there)
  if (process.platform !== 'win32') {
    const dh = await fs.open(dirname(file), 'r').catch(() => null);
    await dh?.sync().catch(() => {});
    await dh?.close().catch(() => {});
  }
}

/** The same, synchronously (for stores whose callers write synchronously) */
export function writeFileDurableSync(file: string, data: string): void {
  const tmp = tmpName(file);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* already failing */ }
    try { rmSync(tmp, { force: true }); } catch { /* already failing */ }
    throw e;
  }
  if (process.platform !== 'win32') {
    try { const d = openSync(dirname(file), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ }
  }
}
