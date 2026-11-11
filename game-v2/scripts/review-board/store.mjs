// The review board's file: review/board/board.json, shared by the server (Kieran's answers) and the CLI (Claude's posts).
// Every write re-reads the file first and replaces it atomically (temp file + rename), so neither side drops the other's edits.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..', '..');
export const boardDir = path.join(root, 'review', 'board');
const boardFile = path.join(boardDir, 'board.json');
const keyFile = path.join(boardDir, 'key.txt');

/**
 * An item: { id, batch, title, body, options?: string[], created,
 *            answer?: { choice?: string, text?: string, at }, seen?: at (Claude has read the answer), archived?: at }
 * A batch: { id, title, created }
 */
export function load() {
  try { return JSON.parse(fs.readFileSync(boardFile, 'utf-8')); } catch { return { batches: [], items: [] }; }
}

export function save(board) {
  fs.mkdirSync(boardDir, { recursive: true });
  const tmp = `${boardFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 1));
  fs.renameSync(tmp, boardFile);
}

/** Load, change, save in one step */
export function update(fn) {
  const board = load();
  const out = fn(board);
  save(board);
  return out;
}

/** The page's access key (made once; anyone on the network needs it to open the board) */
export function accessKey() {
  try { return fs.readFileSync(keyFile, 'utf-8').trim(); } catch {}
  fs.mkdirSync(boardDir, { recursive: true });
  const k = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(keyFile, k);
  return k;
}

export const newId = () => crypto.randomBytes(4).toString('hex');
export const now = () => new Date().toISOString();
