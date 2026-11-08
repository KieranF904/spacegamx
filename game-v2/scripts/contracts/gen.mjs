/**
 * The central contract registry. Scans common, server, client, server-browser and scripts for the contract
 * header (see docs/contracts/README.md), then writes docs/contracts/registry.md and registry.json: one entry per
 * contracted file with its fields plus what is derived from the code (line count, exports, section ranges), and an
 * "Executable contracts" list (feature contract tests, golden pins, `satisfies Record<...>` tables).
 *
 *   npm run contracts:gen             regenerate the registry
 *   npm run contracts:check           exit 1 if the registry is stale or a header is broken (the vitest runs this)
 *
 * Output is sorted and has no timestamps, so every OS writes the same bytes.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { builtinModules } from 'module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_MD = join(ROOT, 'docs/contracts/registry.md');
const OUT_JSON = join(ROOT, 'docs/contracts/registry.json');
const SCAN = ['common/src', 'server/src', 'client/src', 'server-browser/src', 'scripts'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'coverage']);
const CODE = /\.(ts|tsx|mjs|js)$/;
const TEST = /\.(test|perf\.test|spec)\.(ts|tsx|mjs|js)$/;
const MAX_LINES = 800;
const ID_RE = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const FIELDS = ['owns', 'needs', 'events', 'invariants', 'extend'];
const REQUIRED = ['owns', 'needs', 'invariants', 'extend'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort(cmp)) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

const read = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

/** The leading block comment (after a shebang and blank lines), or null */
export function topComment(text) {
  const lines = text.split('\n');
  let i = 0;
  if (lines[0]?.startsWith('#!')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (!lines[i]?.startsWith('/**')) return null;
  const body = [];
  for (let j = i; j < lines.length; j++) {
    body.push(lines[j]);
    if (lines[j].includes('*/')) return body;
  }
  return null;
}

/** Parse a header block into { id, fields, errors } or null when it carries no contract line */
export function parseHeader(block) {
  if (!block) return null;
  const inner = block.map((l) => l.replace(/^\s*\/\*\*\s?/, '').replace(/\s*\*\/\s*$/, '').replace(/^\s*\*( |$)/, ''));
  const first = inner.findIndex((l) => /^@contract\s/.test(l));
  if (first < 0) return null;
  const id = inner[first].replace(/^@contract\s+/, '').trim().split(/\s+/)[0];
  const fields = {};
  const errors = [];
  let cur = null;
  for (const raw of inner.slice(first + 1)) {
    const m = /^(owns|needs|events|invariants|extend):\s*(.*)$/.exec(raw);
    if (m) {
      cur = m[1];
      if (fields[cur]) errors.push(`field "${cur}" appears twice`);
      (fields[cur] ??= []).push(m[2].trim());
      continue;
    }
    if (raw.trim() === '') cur = null;
    else if (cur) fields[cur].push(raw.trim());
  }
  const out = { id, errors };
  for (const f of FIELDS) {
    if (!fields[f]) continue;
    const lines = fields[f].filter((l) => l !== '');
    if (f === 'invariants') {
      // each invariant ends with " — <test>"; a wrapped one is joined until it does
      const items = [];
      let pend = '';
      for (const l of lines) {
        pend = pend ? `${pend} ${l}` : l;
        if (/ — (none pinned|\S+)$/i.test(pend)) { items.push(pend); pend = ''; }
      }
      if (pend) errors.push(`invariant does not end with " — <test>": "${pend.slice(0, 60)}"`);
      out.invariants = items.map((t) => {
        const k = t.lastIndexOf(' — ');
        return { text: t.slice(0, k).trim(), test: t.slice(k + 3).trim() };
      });
    } else out[f] = lines.join(' ');
  }
  return out;
}

/** Exported names of a source file (top level only) */
export function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, '').trim();
      if (n) names.add(n);
    }
  }
  if (/^export\s+default\b/m.test(text)) names.add('default');
  for (const m of text.matchAll(/^export\s+\*(?:\s+as\s+(\w+))?\s+from/gm)) names.add(m[1] ? m[1] : '*');
  return [...names].sort(cmp);
}

const DECL = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Top-level declarations with their line ranges (a leading comment block belongs to the declaration under it) */
export function sectionsOf(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    let s = i;
    while (s > 0 && /^(\/\/|\/\*\*|\s\*|\*\/)/.test(lines[s - 1])) s--;
    starts.push({ name: m[2], kind: m[1], start: s + 1, decl: i + 1 });
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const nextStart = k + 1 < starts.length ? starts[k + 1].start : lines.length + 1;
    let end = Math.min(nextStart - 1, lines.length);
    while (end > starts[k].decl && lines[end - 1].trim() === '') end--;
    out.push({ name: starts[k].name, kind: starts[k].kind, start: starts[k].start, end });
  }
  return out;
}

const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
/** Bare package imports of a file: '@scope/pkg/x' -> '@scope/pkg', 'ws/x' -> 'ws' (node builtins dropped) */
export function packageImports(text) {
  const out = new Set();
  for (const m of text.matchAll(/^(?:import|export)\b[^'"\n;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1] ?? m[2];
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || NODE.has(spec)) continue;
    const parts = spec.split('/');
    out.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return [...out].sort(cmp);
}

function groupOf(path) {
  const parts = path.split('/');
  const pkg = parts[0];
  const inner = parts.slice(pkg === 'scripts' ? 1 : 2, -1);
  return [pkg, ...inner.slice(0, 2)].join('/');
}

function goldenExists(name) {
  const dir = join(ROOT, 'server/src/golden');
  if (!existsSync(dir)) return false;
  const stem = (n) => n.replace(/\.(test\.ts|golden\.json|json|ts)$/, '');
  return readdirSync(dir).some((f) => f === name || stem(f) === stem(name));
}

export function collect() {
  const contracts = [];
  const problems = [];
  const warnings = [];
  const exec = { featureContracts: [], goldens: [], tables: [] };
  for (const dir of SCAN) {
    for (const file of walk(join(ROOT, dir))) {
      const path = rel(file);
      const text = read(file);
      if (TEST.test(path)) {
        for (const m of text.matchAll(/runPartContract\(\s*['"]([^'"]+)['"]/g)) exec.featureContracts.push({ feature: m[1], path });
        if (path.startsWith('server/src/golden/')) exec.goldens.push(path);
        continue;
      }
      if (path.startsWith('server/src/golden/')) exec.goldens.push(path);
      text.split('\n').forEach((line, i) => {
        if (/\bsatisfies\s+Record</.test(line) && !/^\s*(\/\/|\*)/.test(line)) exec.tables.push({ path, line: i + 1, text: line.trim().slice(0, 110) });
      });
      const header = parseHeader(topComment(text));
      if (!header) {
        if (/^\s\*\s@contract\s/m.test(text)) problems.push(`${path}: the contract line is not in the header block at the very top of the file`);
        continue;
      }
      for (const e of header.errors) problems.push(`${path}: ${e}`);
      if (!ID_RE.test(header.id)) problems.push(`${path}: contract id "${header.id}" is not kebab/dot lowercase`);
      for (const f of REQUIRED) if (!header[f] || (f === 'invariants' && !header.invariants.length)) problems.push(`${path}: header lacks "${f}"`);
      const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (lines > MAX_LINES) warnings.push(`${path}: ${lines} lines (over ${MAX_LINES}, split candidate)`);
      for (const inv of header.invariants ?? []) {
        if (/^none pinned$/i.test(inv.test)) continue;
        if (existsSync(join(ROOT, inv.test)) && statSync(join(ROOT, inv.test)).isFile()) continue;
        if (goldenExists(inv.test)) continue;
        problems.push(`${path}: invariant names "${inv.test}", which is not a file under game-v2 or a golden in server/src/golden`);
      }
      const needs = (header.needs ?? '').toLowerCase();
      for (const pkg of packageImports(text)) {
        const short = pkg.split('/').pop().toLowerCase();
        if (needs.includes(pkg.toLowerCase()) || needs.includes(short) || (pkg === '@space-game/common' && needs.includes('common'))) continue;
        warnings.push(`${path}: imports "${pkg}", which its needs line does not mention`);
      }
      contracts.push({
        id: header.id, path, group: groupOf(path), lines,
        owns: header.owns ?? '', needs: header.needs ?? '', events: header.events ?? '',
        invariants: header.invariants ?? [], extend: header.extend ?? '',
        exports: exportsOf(text), sections: sectionsOf(text),
      });
    }
  }
  const seen = new Map();
  for (const c of contracts) {
    if (seen.has(c.id)) problems.push(`${c.path}: contract id "${c.id}" is already used by ${seen.get(c.id)}`);
    else seen.set(c.id, c.path);
  }
  contracts.sort((a, b) => cmp(a.group, b.group) || cmp(a.path, b.path));
  exec.featureContracts.sort((a, b) => cmp(a.feature, b.feature) || cmp(a.path, b.path));
  exec.goldens.sort(cmp);
  exec.tables.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  problems.sort(cmp);
  warnings.sort(cmp);
  return { contracts, exec, problems, warnings };
}

export function renderJson({ contracts, exec }) {
  return JSON.stringify({ contracts, executable: exec }, null, 2) + '\n';
}

const fmtSections = (secs, cap) => {
  const shown = secs.slice(0, cap).map((s) => `${s.name} ${s.start}-${s.end}`);
  return shown.join('; ') + (secs.length > cap ? `; +${secs.length - cap} more (registry.json)` : '');
};

export function renderMd({ contracts, exec }) {
  const L = [];
  L.push('# Contract registry', '');
  L.push('GENERATED by scripts/contracts/gen.mjs (`npm run contracts:gen`): do not edit by hand. Format and rules: [README](README.md).', '');
  L.push(`${contracts.length} contracted files. Lines, exports and sections are derived from the code; owns / needs / events / invariants / extend are the file headers.`, '');
  L.push('## Index', '');
  L.push('| id | file | lines |', '| --- | --- | ---: |');
  for (const c of contracts) L.push(`| ${c.id} | \`${c.path}\` | ${c.lines} |`);
  L.push('');
  let group = null;
  for (const c of contracts) {
    if (c.group !== group) { group = c.group; L.push(`## ${group}`, ''); }
    L.push(`### ${c.id}`, '', `\`${c.path}\` (${c.lines} lines)`, '');
    L.push(`- owns: ${c.owns}`);
    L.push(`- needs: ${c.needs}`);
    if (c.events) L.push(`- events: ${c.events}`);
    L.push('- invariants:');
    for (const inv of c.invariants) {
      const none = /^none pinned$/i.test(inv.test);
      L.push(`  - ${inv.text} — ${none ? 'none pinned' : `[${inv.test}](../../${inv.test})`}`);
    }
    L.push(`- extend: ${c.extend}`);
    if (c.exports.length) L.push(`- exports: ${c.exports.slice(0, 40).join(', ')}${c.exports.length > 40 ? `, +${c.exports.length - 40} more` : ''}`);
    if (c.sections.length) L.push(`- sections: ${fmtSections(c.sections, 30)}`);
    L.push('');
  }
  L.push('## Executable contracts', '');
  L.push('These are checked by tsc or vitest rather than described; listed here so they are found from one place, not copied.', '');
  L.push('### Feature contract suites (`runPartContract`)', '');
  for (const f of exec.featureContracts) L.push(`- ${f.feature}: [${f.path}](../../${f.path})`);
  L.push('', '### Golden pins (`server/src/golden`)', '');
  for (const g of exec.goldens) L.push(`- [${g}](../../${g})`);
  L.push('', '### `satisfies Record<...>` tables (tsc fails when a key is missing)', '');
  for (const t of exec.tables) L.push(`- [${t.path}:${t.line}](../../${t.path}) \`${t.text.replace(/`/g, "'")}\``);
  L.push('');
  return L.join('\n');
}

export function run({ check }) {
  const data = collect();
  const md = renderMd(data);
  const json = renderJson(data);
  const msgs = { problems: [...data.problems], warnings: data.warnings, wrote: [] };
  for (const [out, text] of [[OUT_MD, md], [OUT_JSON, json]]) {
    const have = existsSync(out) ? read(out) : '';
    if (have === text) continue;
    if (check) msgs.problems.push(`${rel(out)} is stale; run npm run contracts:gen`);
    else { writeFileSync(out, text); msgs.wrote.push(rel(out)); }
  }
  return { ...msgs, count: data.contracts.length };
}

const isMain = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const check = process.argv.includes('--check');
  const r = run({ check });
  for (const w of r.warnings) console.warn(`contracts: warning: ${w}`);
  for (const p of r.problems) console.error(`contracts: ${p}`);
  if (!check) {
    // generation writes the registry even with broken headers, but still reports them
    for (const f of r.wrote) console.log(`contracts: wrote ${f} (${r.count} contracts).`);
    if (!r.wrote.length) console.log(`contracts: registry already up to date (${r.count} contracts).`);
  }
  if (r.problems.length) process.exit(1);
  if (check) console.log(`contracts: ${r.count} contracts ok, registry is up to date (${r.warnings.length} warnings).`);
}
