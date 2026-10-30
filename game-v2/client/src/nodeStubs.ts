/**
 * Node's built-ins, for the browser build only (vite.config.ts aliases fs, fs/promises, path, os, url and zlib here
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
export const fileURLToPath = (u: string | URL): string => new URL(String(u)).pathname;
export const createDeflateRaw = refuse('createDeflateRaw');
export const constants = {};

export default { existsSync, readdirSync, readFileSync, writeFileSync, promises, join, dirname, resolve, tmpdir };
