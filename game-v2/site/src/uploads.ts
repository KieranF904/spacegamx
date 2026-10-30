/**
 * Images for posts (uploaded from the admin editor or the post-update CLI),
 * kept on disk in <dataDir>/uploads and served from /uploads/<name>.
 *
 * Only PNG, JPEG, GIF and WebP, checked by their bytes (never by the name or
 * the declared type; no SVG, which can carry script). A file is named by a hash
 * of its bytes, so uploading the same image twice gives the same URL (the CLI
 * can re-run a post safely).
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const UPLOAD_NAME = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** The image type from its first bytes, or null */
export function sniffImage(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function contentType(name: string): string {
  return TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
}

export class Uploads {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = path.join(dataDir, 'uploads'); }

  /** Keep an image; its URL path, or an error */
  async save(buf: Buffer): Promise<{ ok: true; url: string; name: string; bytes: number } | { ok: false; error: string }> {
    if (!buf.length) return { ok: false, error: 'Empty file' };
    if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: `Images can be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB at most` };
    const kind = sniffImage(buf);
    if (!kind) return { ok: false, error: 'Only PNG, JPEG, GIF and WebP images' };
    const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${kind}`;
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    try { await fs.access(file); } catch {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, file);
    }
    return { ok: true, url: `/uploads/${name}`, name, bytes: buf.length };
  }

  async read(name: string): Promise<Buffer | null> {
    if (!UPLOAD_NAME.test(name)) return null;
    try { return await fs.readFile(path.join(this.dir, name)); } catch { return null; }
  }
}
