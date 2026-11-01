// The live assembly view: reads the grid text a model writes (whole or still streaming) and draws it cell by cell,
// coloured by part category, with what changed since last round outlined and the power check laid over it.

export const COLOURS = {
  core: '#e2c15c', generator: '#ef8a4c', dynamo: '#e9a95a', store: '#58a9df', conduit: '#6f97b4', diode: '#9b8fe0',
  weapon: '#e0585c', thruster: '#4cc59b', tool: '#c57ad0', armour: '#8a939e', hull: '#4f5966', cargo: '#7d6b4c', other: '#5b5f66',
};
export const CATEGORY_NAMES = {
  core: 'core', generator: 'generator', dynamo: 'dynamo', store: 'store (battery)', conduit: 'conduit', diode: 'diode (one way)',
  weapon: 'weapon', thruster: 'engine', tool: 'tool / shield', armour: 'armour', hull: 'hull', cargo: 'cargo', other: 'other / unknown',
};

const TOKEN = /^([A-Za-z]{2})([\^>v<])?([a-z]\d)?$/;
const INT = /^-?\d+$/;

/** The grid lines of a reply so far: text between grid: and end, or the strings of a JSON "grid" array (the last may be unfinished) */
export function gridLinesOf(text) {
  let s = text.replace(/\r/g, '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```[a-z]*\n?/gi, '');
  const j = s.search(/"grid"\s*:\s*\[/);
  if (j >= 0) {
    const tail = s.slice(j).replace(/^"grid"\s*:\s*\[/, '');
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)("|$)/g;
    let m;
    while ((m = re.exec(tail))) {
      let v = m[1];
      try { v = JSON.parse(`"${v.replace(/\\$/, '')}"`); } catch { /* (cut mid-escape) */ }
      out.push(...v.split('\n'));
      if (!m[2]) break;
      const after = tail.slice(re.lastIndex).match(/^\s*([,\]])/);
      if (!after || after[1] === ']') break;
    }
    return out;
  }
  const ls = s.split('\n');
  let g = -1;
  for (let i = ls.length - 1; i >= 0; i--) if (/^\s*[*_#]*\s*grid\s*[*_]*\s*:?\s*[*_]*\s*$/i.test(ls[i])) { g = i; break; }
  const body = g >= 0 ? ls.slice(g + 1) : ls.filter((l) => /^\s*-?\d+\s+\S/.test(l) || /^\s*(\.\.|[A-Z]{2})\s/.test(l));
  const out = [];
  for (const l of body) { if (/^\s*end\s*$/i.test(l)) break; if (/^\s*(key|raw)\s*:/i.test(l)) break; out.push(l); }
  return out;
}

/** Grid lines -> cells. "r,c" -> { code, first, facing, shape, token } */
export function parseGrid(lines) {
  const cells = new Map();
  let header = null, n = 0;
  for (const line of lines) {
    const toks = line.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if (/^name\s*:/i.test(line.trim())) continue;
    if (!header && toks.every((t) => INT.test(t)) && (toks.length > 1 || n === 0)) { header = toks.map(Number); continue; }
    let row = n, rest = toks;
    if (INT.test(toks[0])) { row = Number(toks[0]); rest = toks.slice(1); }
    n++;
    rest.forEach((t, i) => {
      const col = header && i < header.length ? header[i] : (header ? header[header.length - 1] + 1 + i - header.length : i);
      if (t === '..') return;
      if (t === '##') { cells.set(`${row},${col}`, { code: '##', first: true, token: t }); return; }
      const m = TOKEN.exec(t);
      if (!m) return;
      cells.set(`${row},${col}`, { code: m[1].toUpperCase(), first: m[1] === m[1].toUpperCase(), facing: m[2], shape: m[3], token: t });
    });
  }
  return cells;
}

const bounds = (maps) => {
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const m of maps) for (const k of m.keys()) { const [r, c] = k.split(',').map(Number); r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  return r0 === Infinity ? null : { r0, r1, c0, c1 };
};

/** A tri piece's corners (fractions of the cell), by shape number: t1 flat on S+W ... t4 flat on E+S */
const TRI = { t1: [[0, 0], [0, 1], [1, 1]], t2: [[0, 0], [1, 0], [0, 1]], t3: [[0, 0], [1, 0], [1, 1]], t4: [[1, 0], [1, 1], [0, 1]] };

/**
 * Draws cells onto a canvas.
 * opts: { legend: Map code -> { cat, name }, prev?: cells (outline what changed), overlay?: { result, cells }, partial?: bool }
 */
export function drawGrid(canvas, cells, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 400, H = canvas.clientHeight || 400;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const b = bounds(opts.prev ? [cells, opts.prev] : [cells]);
  if (!b) return;
  const rows = b.r1 - b.r0 + 1, cols = b.c1 - b.c0 + 1;
  const pad = 18;
  const s = Math.max(4, Math.min(56, Math.floor(Math.min((W - pad * 2) / cols, (H - pad * 2) / rows))));
  const ox = Math.round((W - cols * s) / 2), oy = Math.round((H - rows * s) / 2);
  const X = (c) => ox + (c - b.c0) * s, Y = (r) => oy + (r - b.r0) * s;

  // Faint lattice and labels
  g.strokeStyle = '#161c23'; g.lineWidth = 1;
  for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(ox, oy + r * s + .5); g.lineTo(ox + cols * s, oy + r * s + .5); g.stroke(); }
  for (let c = 0; c <= cols; c++) { g.beginPath(); g.moveTo(ox + c * s + .5, oy); g.lineTo(ox + c * s + .5, oy + rows * s); g.stroke(); }
  if (s >= 12) {
    g.fillStyle = '#3c4754'; g.font = `9px ui-monospace, Consolas, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let c = b.c0; c <= b.c1; c++) g.fillText(String(c), X(c) + s / 2, oy - 8);
    g.textAlign = 'right';
    for (let r = b.r0; r <= b.r1; r++) g.fillText(String(r), ox - 4, Y(r) + s / 2);
  }

  const catOf = (code) => (code === '##' ? 'other' : opts.legend?.get(code)?.cat ?? 'other');
  for (const [k, cell] of cells) {
    const [r, c] = k.split(',').map(Number);
    const x = X(c), y = Y(r);
    g.fillStyle = COLOURS[catOf(cell.code)];
    g.globalAlpha = cell.first ? 1 : 0.78;
    const tri = cell.shape && TRI[cell.shape];
    if (tri) {
      g.beginPath(); tri.forEach(([a, bb], i) => (i ? g.lineTo(x + a * s, y + bb * s) : g.moveTo(x + a * s, y + bb * s))); g.closePath(); g.fill();
    } else g.fillRect(x + 0.5, y + 0.5, s - 1, s - 1);
    g.globalAlpha = 1;
    // (Edges where the next cell is another part: same code in small letters continues the part)
    g.strokeStyle = '#0b0e12'; g.lineWidth = Math.max(1, s / 14);
    const other = (rr, cc) => { const n = cells.get(`${rr},${cc}`); return !n || n.code !== cell.code || n.first; };
    if (!tri) {
      g.beginPath();
      if (other(r, c + 1)) { g.moveTo(x + s, y); g.lineTo(x + s, y + s); }
      if (other(r + 1, c)) { g.moveTo(x, y + s); g.lineTo(x + s, y + s); }
      if (cell.first) { g.moveTo(x, y); g.lineTo(x + s, y); g.moveTo(x, y); g.lineTo(x, y + s); }
      g.stroke();
    }
    if (cell.first && s >= 14 && !tri) {
      g.fillStyle = '#0b0e12'; g.font = `600 ${Math.min(13, Math.floor(s * 0.36))}px ui-monospace, Consolas, monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(cell.code, x + s / 2, y + s / 2 + (cell.facing ? s * 0.08 : 0));
    }
    if (cell.facing) {
      const cx = x + s / 2, cy = y + s / 2, a = s * 0.16, d = s * 0.36;
      const dir = { '^': [0, -1], v: [0, 1], '>': [1, 0], '<': [-1, 0] }[cell.facing];
      g.fillStyle = '#0b0e12'; g.beginPath();
      const tx = cx + dir[0] * d, ty = cy + dir[1] * d;
      g.moveTo(tx + dir[0] * a, ty + dir[1] * a);
      g.lineTo(tx - dir[1] * a - dir[0] * a * 0.3, ty + dir[0] * a - dir[1] * a * 0.3);
      g.lineTo(tx + dir[1] * a - dir[0] * a * 0.3, ty - dir[0] * a - dir[1] * a * 0.3);
      g.closePath(); g.fill();
    }
  }

  // What changed since last round
  if (opts.prev) {
    g.setLineDash([3, 2]); g.strokeStyle = '#ffd866'; g.lineWidth = 1.5;
    const keys = new Set([...cells.keys(), ...opts.prev.keys()]);
    for (const k of keys) {
      const a = cells.get(k)?.token, p = opts.prev.get(k)?.token;
      if (a === p) continue;
      const [r, c] = k.split(',').map(Number);
      g.strokeRect(X(c) + 1.5, Y(r) + 1.5, s - 3, s - 3);
    }
    g.setLineDash([]);
  }

  // The power check
  const ov = opts.overlay;
  if (ov?.result) {
    const pc = ov.cells ?? {};
    const power = ov.result.power;
    if (power) {
      for (const u of power.unpowered) {
        for (const [r, c] of pc[u.uid] ?? [[u.row, u.col]]) {
          const x = X(c), y = Y(r);
          g.fillStyle = 'rgba(239,80,80,.45)'; g.fillRect(x, y, s, s);
          g.strokeStyle = '#ff5b5b'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, s - 2, s - 2);
        }
      }
      for (const bn of power.bottlenecks) {
        const cs = pc[bn.uid] ?? [[bn.row, bn.col]];
        const cr = cs.reduce((a, x) => a + x[0], 0) / cs.length, cc = cs.reduce((a, x) => a + x[1], 0) / cs.length;
        const rad = s * (0.55 + 0.35 * Math.sqrt(cs.length));
        g.strokeStyle = '#f0b64e'; g.lineWidth = 2; g.beginPath(); g.arc(X(cc) + s / 2, Y(cr) + s / 2, rad, 0, Math.PI * 2); g.stroke();
      }
      g.font = `600 ${Math.max(9, Math.min(11, s * 0.3))}px ui-monospace, Consolas, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const w of power.weapons) {
        const pct = Math.round(w.pctLong ?? w.pct);
        const x = X(w.col) + s / 2, y = Y(w.row) - 1;
        const label = `${pct}%`, tw = g.measureText(label).width + 6;
        g.fillStyle = 'rgba(8,10,13,.85)'; g.fillRect(x - tw / 2, y - 7, tw, 13);
        g.fillStyle = pct >= 95 ? '#5fd39a' : pct >= 50 ? '#f0b64e' : '#ef6b6b'; g.fillText(label, x, y);
      }
    }
    for (const e of ov.result.errors ?? []) {
      const r = e.row ?? e.part?.row, c = e.col ?? e.part?.col;
      if (r === undefined || c === undefined) continue;
      g.strokeStyle = '#ff5b5b'; g.lineWidth = 2; g.beginPath();
      g.moveTo(X(c) + 3, Y(r) + 3); g.lineTo(X(c) + s - 3, Y(r) + s - 3); g.moveTo(X(c) + s - 3, Y(r) + 3); g.lineTo(X(c) + 3, Y(r) + s - 3); g.stroke();
    }
  }
}
