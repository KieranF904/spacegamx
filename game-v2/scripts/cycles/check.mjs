// Import-cycle check. Finds strongly connected groups among relative value imports
// (type-only imports are ignored: they erase at compile time).
//   node scripts/cycles/check.mjs [--edges] [roots...]   default roots: all three
// An import line ending in a `// cycle-ok: <why>` comment is left out of the graph: use it only for an edge that is read
// lazily (inside functions, never at module load) and cannot be removed; say why.
// Fails (exit 1) on any cycle. Default roots: common/src, server/src, client/src. No allow-list: break the cycle.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const showEdges = args.includes('--edges');
const roots = args.filter((a) => !a.startsWith('--'));
if (!roots.length) roots.push('common/src', 'server/src', 'client/src');

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'review'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$|\.testkit\.ts$|\.d\.ts$/.test(e.name)) out.push(p);
  }
}

function analyse(root) {
  const abs = path.resolve(repo, root);
  const files = [];
  collect(abs, files);
  const set = new Set(files.map((f) => path.resolve(f)));
  const g = new Map();
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const out = [];
    for (const m of t.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)';?([^\n]*)/gms)) {
      if (m[1]) continue;
      if (/cycle-ok/.test(m[3])) continue; // a documented lazy edge
      const p = path.resolve(path.dirname(f), m[2].replace(/\.js$/, ''));
      for (const c of [p + '.ts', path.join(p, 'index.ts')]) if (set.has(c)) { out.push(c); break; }
    }
    g.set(path.resolve(f), out);
  }
  let idx = 0;
  const st = [], on = new Set(), ind = new Map(), low = new Map(), sccs = [];
  const sc = (v) => {
    ind.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of g.get(v) || []) {
      if (!ind.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), ind.get(w)));
    }
    if (low.get(v) === ind.get(v)) {
      const c = []; let w;
      do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1) sccs.push(c);
    }
  };
  for (const v of g.keys()) if (!ind.has(v)) sc(v);
  const rel = (x) => path.relative(abs, x).split(path.sep).join('/');
  return {
    n: files.length,
    sccs: sccs.map((c) => ({
      files: c.map(rel).sort(),
      edges: c.flatMap((a) => (g.get(a) || []).filter((b) => c.includes(b)).map((b) => [rel(a), rel(b)])),
    })),
  };
}

let bad = 0;
for (const root of roots) {
  const { sccs, n } = analyse(root);
  console.log(`${root}: ${n} files, ${sccs.length} cyclic group(s)`);
  for (const c of sccs) {
    bad++;
    console.log(`  CYCLE ${c.files.length} files: ${c.files.slice(0, 8).join(', ')}${c.files.length > 8 ? ', ...' : ''}`);
    if (showEdges) for (const [a, b] of c.edges) console.log(`      ${a} -> ${b}`);
  }
}
if (bad) {
  console.error(`\n${bad} import cycle(s). Break them: move the shared piece to a leaf module, or pass the dependency in.`);
  process.exit(1);
}
