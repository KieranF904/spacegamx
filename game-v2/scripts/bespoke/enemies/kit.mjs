/**
 * The shared kit for the custom enemy roster (DESIGN ONLY: docs/enemies/custom-roster.md). Each design's script
 * (scripts/bespoke/enemies/<id>.mjs) builds its hull with these helpers and writes, never into data/:
 *
 *   docs/enemies/designs/<id>.pieces.json   its bespoke pieces (the game would load them from data/ships/bespoke/<id>.json)
 *   docs/enemies/designs/<id>.json          its design, intact (data/ships/blueprints/enemy/<id>.json)
 *   docs/enemies/designs/<id>_damaged.json  the same with its shot-off pieces gone (a still, not a game file)
 *   docs/enemies/designs/<id>.meta.json     its card: faction, role, size, pieces by group (the sheets and the doc read it)
 *
 * Grid units (a cell is 24 world units), y down, nose towards -y. Angles in degrees clockwise from straight ahead.
 * Helpers copied from scripts/bespoke/scrap_mother.mjs and maw_heart.mjs (docs/boss-design.md section 3), plus a
 * `group` on every part: the destroyable piece it belongs to (a few parts drawn as one piece break as one).
 * Look: every piece is written with `fine` (its scale: its seams and bevels drawn at its size, its detail outlined in
 * shadow, not ink), and a part may take `surface: 'solar'` (the stations' solar cells, whatever its material).
 */
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { compactJson } from '../../lib/compactJson.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = process.env.DESIGNS_DIR ?? join(root, 'docs/enemies/designs');
/** The game's copy (data/ships): its hull's pieces and its design, each part numbered by its group (unset GAME_DIR='': design only) */
export const GAME = process.env.GAME_DIR ?? join(root, 'data/ships');
/** Each design's groups, in the order the game numbers them (common bodies/custom/roster.json: core first) */
const ROSTER = JSON.parse(readFileSync(join(root, 'common/src/bodies/custom/roster.json'), 'utf8')).designs;
export const DEG = Math.PI / 180;
export const round = (v) => Math.round(v * 1000) / 1000;
export const flipX = ([x, y]) => [round(-x), y];
export const mirror = (pts) => pts.map(flipX).reverse();
export const norm = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [round(x / l), round(y / l)]; };
export const mid = (a, b, t = 0.5) => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
export const centroid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
export const hash = (k) => ((Math.sin(k * 12.9898 + 4.1) * 43758.5453) % 1 + 1) % 1;
/** A point `r` out from `c`, `deg` round from straight ahead */
export const P = (r, deg, c = [0, 0]) => [round(c[0] + r * Math.sin(deg * DEG)), round(c[1] - r * Math.cos(deg * DEG))];
/** The direction `deg` round from straight ahead */
export const D = (deg) => [round(Math.sin(deg * DEG)), round(-Math.cos(deg * DEG))];
/** A polygon shrunk towards its centroid (t: 1 itself, 0 its middle) */
export const inset = (pg, t) => { const c = centroid(pg); return pg.map((q) => mid(c, q, t)); };
/** A band `w` wide from a to b, its far end `taper` narrower */
export function bar(a, b, w, taper = 1) {
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = -uy * w / 2, vy = ux * w / 2;
  return [[a[0] - vx, a[1] - vy], [b[0] - vx * taper, b[1] - vy * taper], [b[0] + vx * taper, b[1] + vy * taper], [a[0] + vx, a[1] + vy]].map(([x, y]) => [round(x), round(y)]);
}
/** A ring of `n` points */
export const ringPts = (c, r, n, off = 0) => Array.from({ length: n }, (_, k) => [round(c[0] + Math.cos(off + (k / n) * Math.PI * 2) * r), round(c[1] + Math.sin(off + (k / n) * Math.PI * 2) * r)]);
/** An oval round c, `a` along dir and `b` across */
export const oval = (c, a, b, dir = [0, -1], n = 16) => { const [ux, uy] = norm(dir); return Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2, p = Math.cos(t) * a, q = Math.sin(t) * b; return [round(c[0] + ux * p - uy * q), round(c[1] + uy * p + ux * q)]; }); };
/** An arc band round c between radii r0 and r1, from a0 to a1 degrees */
export const band = (c, r0, r1, a0, a1, n = 6) => [
  ...Array.from({ length: n + 1 }, (_, k) => P(r1, a0 + ((a1 - a0) * k) / n, c)),
  ...Array.from({ length: n + 1 }, (_, k) => P(r0, a1 - ((a1 - a0) * k) / n, c)),
];
/** A smooth closed outline through control points (Chaikin, `it` rounds) */
export function smooth(pts, it = 2) {
  let q = pts;
  for (let k = 0; k < it; k++) q = q.flatMap((a, i) => { const b = q[(i + 1) % q.length]; return [mid(a, b, 0.25), mid(a, b, 0.75)]; });
  return q;
}
/** A curved tapering horn/limb along a path (each point with its half-width), closed at its tip */
export function limb(path, widths) {
  const L = [], R = [];
  path.forEach((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), w = widths[i];
    L.push([round(p[0] - uy * w), round(p[1] + ux * w)]); R.push([round(p[0] + uy * w), round(p[1] - ux * w)]);
  });
  return [...L, ...R.reverse()];
}
/** A quadratic curve's points, a→b bending through ctl */
export const curve = (a, ctl, b, n = 6) => Array.from({ length: n + 1 }, (_, k) => { const t = k / n, u = 1 - t; return [round(u * u * a[0] + 2 * u * t * ctl[0] + t * t * b[0]), round(u * u * a[1] + 2 * u * t * ctl[1] + t * t * b[1])]; });

// ---- detail shorthands (PieceDetail, common/src/ships/types.ts) ----
export const rivet = (at, r = 0.14, color = '#8a8d92') => ({ kind: 'ring', at, r, w: r * 0.75, sides: 8, color });
export const rivets = (a, b, n, r = 0.14, color) => Array.from({ length: n }, (_, k) => rivet(mid(a, b, (k + 0.5) / n), r, color));
export const glow = (at, r, color, sides) => ({ kind: 'glow', at, r, color, ...(sides ? { sides } : {}) });
export const halo = (at, r, w = 0.06, color, sides) => ({ kind: 'halo', at, r, w, ...(color ? { color } : {}), ...(sides ? { sides } : {}) });
export const ring = (at, r, w, color, sides) => ({ kind: 'ring', at, r, w, ...(color ? { color } : {}), ...(sides ? { sides } : {}) });
export const raise = (poly, color) => ({ kind: 'raise', poly, ...(color ? { color } : {}) });
export const recess = (poly, color) => ({ kind: 'recess', poly, ...(color ? { color } : {}) });
export const channel = (poly, color) => ({ kind: 'channel', poly, ...(color ? { color } : {}) });
export const vein = (pts, w, color) => ({ kind: 'vein', poly: pts, w, ...(color ? { color } : {}) });
export const shard = (at, dir, r, w, color) => ({ kind: 'shard', crystal: true, at, dir: norm(dir), r, w, ...(color ? { color } : {}) });
export const vent = (poly, fins, color) => ({ kind: 'vent', poly, fins, ...(color ? { color } : {}) });
export const bell = (at, dir, r, w) => ({ kind: 'bell', at, dir: norm(dir), r, w });
export const nozzle = (at, dir, r) => ({ kind: 'nozzle', at, dir: norm(dir), r });
export const cable = (pts, w, color) => ({ kind: 'cable', poly: pts, w, ...(color ? { color } : {}) });
/** Hazard stripes along a→b, `w` wide */
export function stripes(a, b, w, n, c1 = '#c9a23a', c2 = '#24262b') {
  const out = [];
  const [ux, uy] = norm([b[0] - a[0], b[1] - a[1]]), vx = -uy * w / 2, vy = ux * w / 2, sk = 0.35 * (Math.hypot(b[0] - a[0], b[1] - a[1]) / n);
  for (let k = 0; k < n; k++) {
    const p0 = mid(a, b, k / n), p1 = mid(a, b, (k + 1) / n);
    out.push({ kind: 'raise', color: k % 2 ? c2 : c1, poly: [[p0[0] - vx, p0[1] - vy], [p1[0] - vx, p1[1] - vy], [p1[0] + vx + ux * sk, p1[1] + vy + uy * sk], [p0[0] + vx + ux * sk, p0[1] + vy + uy * sk]].map((q) => q.map(round)) });
  }
  return out;
}
/** A dent or patch (a recess) roughly round `at` */
export const dent = (at, r, seed, color) => recess(Array.from({ length: 6 }, (_, k) => { const a = (k / 6) * Math.PI * 2 + seed, rr = r * (0.7 + 0.5 * hash(seed * 9 + k)); return [round(at[0] + Math.cos(a) * rr), round(at[1] + Math.sin(a) * rr)]; }), color);

/** Detail that's painted, not lit: toned (write) */
const TONED = new Set(['raise', 'recess', 'ring', 'cable', 'vent']);
/** A colour a quarter of the way to its own grey */
export function tone(c, k = 0.25) {
  const v = parseInt(c.slice(1), 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255, l = 0.299 * r + 0.587 * g + 0.114 * b;
  return '#' + [r, g, b].map((q) => Math.round(q + (l - q) * k).toString(16).padStart(2, '0')).join('');
}
export const mirrorDetail = (d) => ({ ...d, ...(d.poly ? { poly: d.kind === 'vein' || d.kind === 'cable' ? d.poly.map(flipX) : mirror(d.poly) } : {}), ...(d.at ? { at: flipX(d.at) } : {}), ...(d.dir ? { dir: flipX(d.dir) } : {}) });

/**
 * A design under construction. `part(name, fn, material, polygon, opts)`; opts: group (the destroyable piece it is
 * part of; default its own name), relief, mount {at, dir, width}, turret (size in cells: a turret mount), surface, detail.
 * `pair(...)` builds name_l as given and name_r mirrored (groups get _l/_r too unless `shared`; `matR`: the right's material).
 */
export function design(id, card) {
  const pieces = [], parts = [];
  const d = {
    id, card,
    part(name, fn, material, polygon, opts = {}) {
      const pid = `${id}_${name}`;
      pieces.push({
        id: pid, polygon: polygon.map((q) => q.map(round)),
        ...(opts.mount ? { mount: { ...opts.mount, at: opts.mount.at.map(round), dir: norm(opts.mount.dir) } } : {}),
        ...(opts.relief ? { relief: opts.relief } : {}), ...(opts.turret ? { turret: opts.turret } : {}),
        ...(opts.under ? { under: true } : {}), ...(opts.surface ? { surface: opts.surface } : {}), ...(opts.detail?.length ? { detail: opts.detail } : {}),
      });
      parts.push({ uid: parts.length, piece: pid, fn, material, x: 0, y: 0, rot: 0, flip: false, ...(opts.turret ? { mount: 'turret' } : {}), _group: opts.group ?? name });
      return d;
    },
    pair(name, fn, material, polygon, opts = {}) {
      const g = opts.group ?? name, gl = opts.shared ? g : `${g}_l`, gr = opts.shared ? g : `${g}_r`;
      d.part(`${name}_l`, fn, material, polygon, { ...opts, group: gl });
      const m = opts.mount && { ...opts.mount, at: flipX(opts.mount.at), dir: flipX(opts.mount.dir) };
      d.part(`${name}_r`, fn, opts.matR ?? material, mirror(polygon), { ...opts, group: gr, mount: m, detail: opts.detail?.map(mirrorDetail) });
      return d;
    },
    /** Write the files; `damaged`: the groups shot off in the damaged still; `drive`: its engines' output (Blueprint drive, 0.1-1: a slow design) */
    write({ damaged = [], paint = '#34363c', scale = 1, drive } = {}) {
      mkdirSync(OUT, { recursive: true });
      // (painted detail toned to the game's palette: its plates, trim, rings and cables a quarter of the way to their
      // own grey, so a brass strip reads as worn metal beside the grid ships, not a flat saturated fill; lights keep theirs)
      for (const p of pieces) if (p.detail) p.detail = p.detail.map((x) => (x.color && TONED.has(x.kind) ? { ...x, color: tone(x.color) } : x));
      // (drawn at `scale` on the way out: authored roomy, written at its size; turrets keep their size in cells)
      if (scale !== 1) {
        const sc = (q) => [round(q[0] * scale), round(q[1] * scale)];
        const sd = (x) => ({ ...x, ...(x.poly ? { poly: x.poly.map(sc) } : {}), ...(x.at ? { at: sc(x.at) } : {}), ...(x.r !== undefined ? { r: round(x.r * scale) } : {}), ...(x.w !== undefined ? { w: round(x.w * scale) } : {}) });
        for (const p of pieces) {
          p.polygon = p.polygon.map(sc);
          if (p.mount) p.mount = { ...p.mount, at: sc(p.mount.at), ...(p.mount.width ? { width: round(p.mount.width * scale) } : {}) };
          if (p.detail) p.detail = p.detail.map(sd);
          // (and its finish drawn at that size too: seams and bevels are a share of a cell, so a hull drawn small would
          // otherwise wear its authored size's outlines, heavy and inked; PieceDef `fine`)
          p.fine = round(scale);
        }
      }
      const coreGroup = parts.find((q) => q.fn === 'core')?._group;
      if (!coreGroup) throw new Error(`${id}: no core`);
      // (under pieces first, so they're drawn beneath)
      const byId = new Map(pieces.map((p) => [p.id, p]));
      const ordered = [...parts.filter((q) => byId.get(q.piece).under), ...parts.filter((q) => !byId.get(q.piece).under)];
      const clean = (list) => list.map((q, k) => { const { _group, ...rest } = q; return { ...rest, uid: k }; });
      const bp = (name, list) => ({ name, catalogVersion: 1, paint, rigid: true, parts: clean(list) });
      const gone = new Set(damaged);
      for (const g of gone) if (!parts.some((q) => q._group === g)) throw new Error(`${id}: no group ${g}`);
      const left = ordered.filter((q) => !gone.has(q._group));
      // The game's files: each part's group by its number in the roster
      const order = ROSTER.find((r) => r.id === id)?.groups;
      if (GAME && order) {
        for (const q of parts) if (!order.includes(q._group)) throw new Error(`${id}: group ${q._group} isn't in roster.json`);
        const numbered = ordered.map((q, k) => { const { _group, ...rest } = q; return { ...rest, uid: k, group: order.indexOf(_group) }; });
        mkdirSync(join(GAME, 'bespoke'), { recursive: true });
        writeFileSync(join(GAME, 'bespoke', `${id}.json`), compactJson({ _comment: `${card.name}'s own hull (docs/enemies/custom-roster.md). Written by scripts/bespoke/enemies/${id}.mjs: edit that, not this.`, pieces }));
        writeFileSync(join(GAME, 'blueprints', 'enemy', `${id}.json`), JSON.stringify({ name: card.name, catalogVersion: 1, paint, rigid: true, parts: numbered, ...(drive !== undefined ? { drive } : {}) }, null, 1) + '\n');
      }
      writeFileSync(join(OUT, `${id}.pieces.json`), JSON.stringify({ _comment: `DESIGN ONLY, not loaded by the game: ${card.name} (docs/enemies/custom-roster.md). Written by scripts/bespoke/enemies/${id}.mjs.`, pieces }, null, 1) + '\n');
      writeFileSync(join(OUT, `${id}.json`), JSON.stringify(bp(card.name, ordered), null, 1) + '\n');
      writeFileSync(join(OUT, `${id}_damaged.json`), JSON.stringify(bp(`${card.name} (damaged)`, left), null, 1) + '\n');
      // Size and connectivity (bespoke parts join what they touch: every part must reach the core, also once the
      // damaged still's groups are gone)
      let R = 0;
      for (const p of pieces) {
        for (const [x, y] of p.polygon) R = Math.max(R, Math.hypot(x, y));
        // (and what's drawn past it: crystals' tips)
        for (const q of p.detail ?? []) if (q.kind === 'shard') R = Math.max(R, Math.hypot(q.at[0] + q.dir[0] * q.r, q.at[1] + q.dir[1] * q.r));
      }
      const groups = {};
      for (const q of parts) (groups[q._group] ??= []).push(q.piece.slice(id.length + 1));
      const meta = { id, ...card, parts: parts.length, groups, damaged, radiusCells: round(R), radius: Math.round(R * 24) };
      writeFileSync(join(OUT, `${id}.meta.json`), JSON.stringify(meta, null, 1) + '\n');
      const orph = (list) => orphans(list.map((q) => byId.get(q.piece)), byId.get(parts.find((q) => q.fn === 'core').piece));
      const o1 = orph(ordered), o2 = orph(left);
      console.log(`${id}: ${parts.length} parts in ${Object.keys(groups).length} groups, radius ${meta.radius} wu (${round(R)} cells)` +
        `; connectivity ${o1.length ? `ORPHANS ${o1}` : 'ok'}, damaged ${o2.length ? `ORPHANS ${o2}` : 'ok'}`);
      return meta;
    },
  };
  return d;
}

// ---- connectivity: every piece reaches the core through touching/overlapping pieces ----
const segX = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
const inPoly = ([x, y], pg) => { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if ((pg[i][1] > y) !== (pg[j][1] > y) && x < ((pg[j][0] - pg[i][0]) * (y - pg[i][1])) / (pg[j][1] - pg[i][1]) + pg[i][0]) c = !c; return c; };
const touch = (A, B) => A.some((q) => inPoly(q, B)) || B.some((q) => inPoly(q, A)) || A.some((a, i) => B.some((b, j) => segX(a, A[(i + 1) % A.length], b, B[(j + 1) % B.length])));
function orphans(ps, core) {
  const i0 = ps.indexOf(core), seen = new Set([i0]), todo = [i0];
  while (todo.length) { const i = todo.pop(); ps.forEach((p, j) => { if (!seen.has(j) && touch(ps[i].polygon, p.polygon)) { seen.add(j); todo.push(j); } }); }
  return ps.filter((_, j) => !seen.has(j)).map((p) => p.id);
}
