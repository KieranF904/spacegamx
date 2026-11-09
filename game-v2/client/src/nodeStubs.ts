/**
 * Node's built-ins, for the browser build only (vite.config.ts aliases fs, fs/promises, path, os, url, zlib and crypto here
 * when building). The client bundles server code for the sandbox and replays, and some of it imports these by name;
 * Vite's own stand-in has no named exports, so the build would fail. In the browser nothing reads or writes files:
 * reads find nothing and writes are refused.
 */

const refuse = (what: string) => (): never => { throw new Error(`${what} is not available in the browser`); };

// fs
export const existsSync = (): boolean => false;
export const readdirSync = (): string[] => [];
export const readFileSync = refuse('readFileSync');
export const writeFileSync = refuse('writeFileSync');
export const appendFileSync = refuse('appendFileSync');
export const mkdirSync = refuse('mkdirSync');
export const mkdtempSync = refuse('mkdtempSync');
export const renameSync = refuse('renameSync');
export const rmSync = refuse('rmSync');
export const unlinkSync = refuse('unlinkSync');
export const openSync = refuse('openSync');
export const fsyncSync = refuse('fsyncSync');
export const closeSync = refuse('closeSync');

// fs/promises (and fs.promises)
const refuseAsync = (what: string) => async (): Promise<never> => refuse(what)();
export const readFile = refuseAsync('readFile');
export const writeFile = refuseAsync('writeFile');
export const appendFile = refuseAsync('appendFile');
export const mkdir = refuseAsync('mkdir');
export const rename = refuseAsync('rename');
export const rm = refuseAsync('rm');
export const promises = { readFile, writeFile, appendFile, mkdir, rename, rm };

// path
export const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (p: string): string => p.replace(/[\\/][^\\/]*$/, '') || '.';
export const resolve = join;

// os, url, zlib
export const tmpdir = (): string => '/tmp';
export const hostname = (): string => 'browser';
export const fileURLToPath = (u: string | URL): string => new URL(String(u)).pathname;
export const createDeflateRaw = refuse('createDeflateRaw');
export const constants = {};

// crypto: createHash for the guest keep's ids (server pilots/guests.ts). In the browser server only, so its guests stay
// in this tab: a plain 256-bit FNV-1a mix stands in for sha256 (the same key gives the same id; not cryptographic)
export const createHash = (_alg: string) => {
  let text = '';
  const h = {
    update(s: string) { text += s; return h; },
    digest(_enc: 'hex') {
      let out = '';
      for (let lane = 0; lane < 8; lane++) {
        let x = (0x811c9dc5 ^ Math.imul(lane + 1, 0x9e3779b1)) >>> 0;
        for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193) >>> 0;
        out += x.toString(16).padStart(8, '0');
      }
      return out;
    },
  };
  return h;
};

export default { existsSync, readdirSync, readFileSync, writeFileSync, promises, join, dirname, resolve, tmpdir };
