// DESIGN PROTOTYPE, not loaded by the game: smoother glows and veins for the redesigned Heart of the Maw
// (docs/bosses/maw-heart-redesign.md, "Surface"). scripts/bespoke/maw_heart_render.mjs appends this to a private copy of
// client/src/ships/bespokeRelief.ts (its own render bundle only) and points `glowDisc` and the `vein` detail at it.
//
// The game's own versions draw a glow as five flat discs stacked (so it posterises into rings) and a vein as one quad a
// step plus a dark groove under each (so it reads as bars with square ends). Both of these use per-vertex colour instead,
// which the hull's geometry already carries, so the GPU blends between the vertices:
//   mawGlow  one disc of rings, its colour running from the detail's colour at its rim through gold to white at its
//            middle, smoothly (and its own light rising with it)
//   mawVein  one smooth stroke along a Catmull-Rom of the path, tapering to a point, its middle bright, its sides gold,
//            and a halo either side fading to the stone's own colour (a soft light on the rock, not a band)

function mawGlow(g: ShipGeometry, x: number, y: number, r: number, sides: number, rim: number, rot = 0): void {
  const RINGS = 20, GOLDC = 0xffc04a, WHITE = 0xfff6e4;
  const colourAt = (f: number) => (f < 0.6 ? mix(rim, GOLDC, f / 0.6) : mix(GOLDC, WHITE, (f - 0.6) / 0.4));
  const n = Math.max(sides, 32), rows: number[][] = [];
  for (let k = 0; k < RINGS; k++) {
    // (rings closer together towards the middle, where the colour changes fastest)
    const f = k / RINGS, rr = r * (1 - f) ** 0.8, c = colourAt(f ** 2.0), gl = 0.25 + 0.75 * f * f;
    const row: number[] = [];
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; row.push(g.vertex(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0, 0, 1, c, gl)); }
    rows.push(row);
  }
  const mid = g.vertex(x, y, 0, 0, 1, WHITE, 1);
  for (let k = 0; k < RINGS - 1; k++) for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = rows[k], b = rows[k + 1];
    g.tri(a[i], a[j], b[j]); g.tri(a[i], b[j], b[i]);
  }
  const last = rows[RINGS - 1];
  for (let i = 0; i < n; i++) g.tri(last[i], last[(i + 1) % n], mid);
}

function mawVein(g: ShipGeometry, poly: number[], w: number, c: number, body: number): void {
  const P: number[][] = [];
  for (let i = 0; i < poly.length / 2; i++) P.push([poly[i * 2], poly[i * 2 + 1]]);
  // (a smooth path through its points)
  const S: number[][] = [], per = 6, m = P.length;
  for (let k = 0; k < m - 1; k++) for (let s = 0; s < per; s++) {
    const t = s / per, p0 = P[Math.max(0, k - 1)], p1 = P[k], p2 = P[k + 1], p3 = P[Math.min(m - 1, k + 2)];
    const cr = (a: number, b: number, c2: number, d: number) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t * t + (-a + 3 * b - 3 * c2 + d) * t * t * t);
    S.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
  }
  S.push(P[m - 1]);
  const n = S.length, L: number[] = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1]));
  const total = L[n - 1] || 1, rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = S[Math.max(0, i - 1)], b = S[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l, t = L[i] / total;
    // (full at its root, narrowing to a point at its tip; its halo three times as wide)
    const core = (w / 2) * (1 - t) ** 0.85, halo = core * 3.6 + (w / 2) * 0.6 * (1 - t);
    const hot = mix(c, 0xfff0c8, 0.5 * (1 - t)), [x, y] = S[i];
    const at = (d: number, col: number, gl: number) => g.vertex(x + nx * d, y + ny * d, 0, 0, 1, col, gl);
    const warm = mix(c, body, 0.45);
    rows.push([at(-halo, body, 0), at(-core, warm, 0.45), at(0, hot, 1), at(core, warm, 0.45), at(halo, body, 0)]);
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < 4; k++) {
    const a = rows[i], b = rows[i + 1];
    g.tri(a[k], a[k + 1], b[k + 1]); g.tri(a[k], b[k + 1], b[k]);
  }
}
