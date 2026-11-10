/**
 * moveCheck: prove that code moved between files was moved verbatim.
 *
 * Compares a git ref (default HEAD~1) with the working tree. A function/method that exists in file A at the ref
 * but is gone from A now, and appears in another file B, is a "move". Its body is compared after normalising:
 *   - comments removed (--keep-comments to compare them too)
 *   - whitespace collapsed (and dropped around punctuation)
 *   - receivers renamed: `this.` and each configured receiver (default ctx, b, s) all become `@.`
 * Signatures (parameter lists) are NOT compared, only bodies, since a moved method usually gains a receiver parameter.
 *
 * Usage:
 *   node scripts/refactor/moveCheck.mjs [ref] [--receivers ctx,b,s] [--files a.ts,b.ts] [--json] [--verbose] [--keep-comments]
 *
 * Output sections: MOVED OK, MOVED BUT CHANGED (exit code 1), RENAMED (name changed, body identical),
 * UNMATCHED (removed from a file and found nowhere else: deleted or heavily rewritten; reported, exit code 0).
 * Default file set: every .ts/.tsx/.js/.mjs file changed vs the ref, plus untracked ones (paths relative to the repo root).
 *
 * Limits: a lightweight scanner, not a parser. Handles comments, strings and template literals when matching
 * braces; regex literals containing unbalanced braces or quotes can confuse it. Only functions with brace bodies
 * (methods, `function`, `const f = (...) => {`) are considered. Same-named functions in one file are matched in order.
 *
 * Also importable: checkMoves({ oldFiles: Map<path,text>, newFiles: Map<path,text>, receivers, keepComments }).
 * Self-test: node --test scripts/refactor/moveCheck.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'new', 'await', 'typeof', 'delete', 'throw', 'case', 'void', 'super', 'with', 'import', 'export']);

/** Index just past the end of a string/template/comment starting at i (or i if none starts there) */
function skipLiteral(s, i) {
  const c = s[i], d = s[i + 1];
  if (c === '/' && d === '/') { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; }
  if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); return e < 0 ? s.length : e + 2; }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '$' && s[j + 1] === '{') j = matchClose(s, j + 1) + 1;
      else j++;
    }
    return j + 1;
  }
  return i;
}

/** Index of the bracket closing the one at i (-1 if unbalanced) */
function matchClose(s, i) {
  const open = s[i], close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < s.length;) {
    const k = skipLiteral(s, j);
    if (k !== j) { j = k; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
    j++;
  }
  return -1;
}

const METHOD = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>(\n]*>)?\s*\(/;
const ARROW = /^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/;

/** Functions in a source text: [{ name, body }] (body = text between the outer braces) */
export function extractFunctions(src) {
  const out = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  let skipUntil = 0; // inside an extracted function, nested ones are not extracted separately
  for (const ls of lineStarts) {
    if (ls < skipUntil) continue;
    const eol = src.indexOf('\n', ls);
    const line = src.slice(ls, eol < 0 ? src.length : eol);
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    let m = METHOD.exec(line);
    let name, parenAt;
    if (m && !CONTROL.has(m[1])) {
      name = m[1];
      parenAt = ls + m[0].length - 1;
    } else if ((m = ARROW.exec(line))) {
      name = m[1];
      const arrowAt = src.indexOf('=>', ls + m[0].length - 1);
      if (arrowAt < 0) continue;
      let j = arrowAt + 2;
      while (/\s/.test(src[j] ?? '')) j++;
      if (src[j] !== '{') continue;
      const end = matchClose(src, j);
      if (end > 0) { out.push({ name, body: src.slice(j + 1, end) }); skipUntil = end; }
      continue;
    } else continue;
    const close = matchClose(src, parenAt);
    if (close < 0) continue;
    // find the body's `{`, hopping over object-type braces in the return type
    let j = close + 1, prev = ')', body = -1;
    while (j < src.length) {
      const k = skipLiteral(src, j);
      if (k !== j) { j = k; continue; }
      const ch = src[j];
      if (ch === ';' || (ch === '=' && src[j + 1] !== '>')) break; // a call or a field, not a definition
      if (ch === '{') {
        if (/[:|&<,]/.test(prev)) { j = matchClose(src, j) + 1; prev = '}'; continue; }
        body = j;
        break;
      }
      if (!/\s/.test(ch)) prev = ch;
      j++;
    }
    if (body < 0) continue;
    const end = matchClose(src, body);
    if (end < 0) continue;
    out.push({ name, body: src.slice(body + 1, end) });
    skipUntil = end;
  }
  return out;
}

function stripComments(s) {
  let r = '';
  for (let i = 0; i < s.length;) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && (d === '/' || d === '*')) { r += ' '; i = skipLiteral(s, i); continue; }
    if (c === '"' || c === "'" || c === '`') { const k = skipLiteral(s, i); r += s.slice(i, k); i = k; continue; }
    r += c;
    i++;
  }
  return r;
}

/** The comparison form of a body */
export function normalise(body, { receivers = ['ctx', 'b', 's'], keepComments = false } = {}) {
  let t = keepComments ? body : stripComments(body);
  const recv = ['this', ...receivers].map((r) => r.replace(/[^\w$]/g, '')).join('|');
  t = t.replace(new RegExp(`(^|[^\\w$.])(?:${recv})\\.`, 'g'), '$1@.');
  return t.replace(/\s+/g, ' ').replace(/ ?([^\w\s$@]) ?/g, '$1').trim();
}

function firstDiff(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
function near(s, i) { return s.slice(Math.max(0, i - 30), i + 50); }

/** Core comparison, on in-memory file maps (path -> text). */
export function checkMoves({ oldFiles, newFiles, receivers = ['ctx', 'b', 's'], keepComments = false }) {
  const opts = { receivers, keepComments };
  const fnsOf = (files) => {
    const m = new Map();
    for (const [p, t] of files) {
      const byName = new Map();
      for (const f of extractFunctions(t)) {
        const arr = byName.get(f.name) ?? [];
        arr.push({ name: f.name, norm: normalise(f.body, opts) });
        byName.set(f.name, arr);
      }
      m.set(p, byName);
    }
    return m;
  };
  const oldFns = fnsOf(oldFiles), newFns = fnsOf(newFiles);
  const result = { ok: [], changed: [], renamed: [], unmatched: [] };
  for (const [path, byName] of oldFns) {
    const nowHere = newFns.get(path) ?? new Map();
    for (const [name, olds] of byName) {
      for (let i = (nowHere.get(name) ?? []).length; i < olds.length; i++) { // the ones that left this file
        const old = olds[i];
        if (old.norm.length < 2) continue; // empty bodies prove nothing
        let found = null;
        for (const [p2, nb] of newFns) {
          if (p2 === path) continue;
          for (const cand of nb.get(name) ?? []) {
            if (!found || cand.norm === old.norm) found = { to: p2, cand };
          }
        }
        if (found) {
          if (found.cand.norm === old.norm) result.ok.push({ name, from: path, to: found.to });
          else {
            const at = firstDiff(old.norm, found.cand.norm);
            result.changed.push({ name, from: path, to: found.to, diffAt: at, oldNear: near(old.norm, at), newNear: near(found.cand.norm, at) });
          }
          continue;
        }
        let ren = null; // same body under another name elsewhere
        for (const [p2, nb] of newFns) {
          if (p2 === path) continue;
          for (const [n2, arr] of nb) if (arr.some((c) => c.norm === old.norm)) ren = { to: p2, as: n2 };
        }
        if (ren) result.renamed.push({ name, from: path, to: ren.to, as: ren.as });
        else result.unmatched.push({ name, from: path });
      }
    }
  }
  return result;
}

const CODE = /\.(?:ts|tsx|js|mjs)$/;
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }

function main() {
  const argv = process.argv.slice(2);
  let ref = 'HEAD~1', receivers = ['ctx', 'b', 's'], files = null, json = false, verbose = false, keepComments = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--receivers') receivers = argv[++i].split(',').filter(Boolean);
    else if (a === '--files') files = argv[++i].split(',');
    else if (a === '--json') json = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--keep-comments') keepComments = true;
    else if (!a.startsWith('--')) ref = a;
  }
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  if (!files) {
    const changed = git(root, 'diff', '--name-only', '--no-renames', ref).split('\n');
    const untracked = git(root, 'ls-files', '--others', '--exclude-standard').split('\n');
    files = [...new Set([...changed, ...untracked])].filter((f) => f && CODE.test(f));
  }
  const oldFiles = new Map(), newFiles = new Map();
  for (const f of files) {
    try { oldFiles.set(f, git(root, 'show', `${ref}:${f}`)); } catch { /* new file */ }
    const abs = join(root, f);
    if (existsSync(abs)) newFiles.set(f, readFileSync(abs, 'utf8'));
  }
  const r = checkMoves({ oldFiles, newFiles, receivers, keepComments });
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`moveCheck vs ${ref}: ${files.length} files, receivers this/${receivers.join('/')}`);
    console.log(`\nMOVED OK (${r.ok.length})`);
    if (verbose) for (const m of r.ok) console.log(`  ${m.name}  ${m.from} -> ${m.to}`);
    console.log(`\nMOVED BUT CHANGED (${r.changed.length})`);
    for (const m of r.changed) console.log(`  ${m.name}  ${m.from} -> ${m.to}\n    old: ...${m.oldNear}\n    new: ...${m.newNear}`);
    console.log(`\nRENAMED, body identical (${r.renamed.length})`);
    for (const m of r.renamed) console.log(`  ${m.name} -> ${m.as}  ${m.from} -> ${m.to}`);
    console.log(`\nUNMATCHED: removed, found in no other file (${r.unmatched.length})`);
    for (const m of r.unmatched) console.log(`  ${m.name}  (${m.from})`);
  }
  process.exit(r.changed.length ? 1 : 0);
}

let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (isMain) main();
