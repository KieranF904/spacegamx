// DESIGN PROTOTYPE, not loaded by the game: the redesigned Heart of the Maw's own hull surfaces (docs/bosses/maw-heart-redesign.md,
// "Surface"). scripts/bespoke/maw_heart_render.mjs splices this into a private copy of client/src/ships/hullTextures.ts
// (in its own render bundle only), in place of the Scrap Mother's tiles 18-21, so the stills can show what the four
// proposed materials would look like. Building it for real means giving them tiles of their own (a seventh atlas row),
// not borrowing these.
//
// Each tile is drawn six times larger than a hull material's (as the bosses' are) and each part takes its own patch of it,
// turned its own way (tiles 18 and up), so no two plates show the same rock. In the hull atlas's terms: h (height: slopes
// and cavity come from it), e (own light: the material's `emit`, gold), k (tone: stains it, whatever the height).
//
//   18 maw_crust       the shard ring's rock: broken into chunks, each tilted its own way; cracks between, a few of them
//                      lit gold deep down; a fine grain; pitting; lighter weathered edges
//   19 maw_heartstone  dense stone in strata, warped; fine grain; pits; hairline cracks across the strata
//   20 maw_seamglass   dark glass with a flow through it; fissures, most of them lit
//   21 maw_bone        bone: a fibrous grain one way, pores, faint growth rings
//   22 maw_coreglass   the core's glass: smooth, slow cells of light in it, as a sun's surface (in place of the Scrap Mother's 22)

function mawTile(kind: number, h: Float32Array, e: Float32Array, groove: (d: number, w: number) => number): Tile {
  const k = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const o = j * N + i;
    let v = 0;
    if (kind === 18) {
      // chunks: each a plane tilted its own way, its edge rounded off into the crack
      const c = voronoi(i, j, 3, 401), fine = voronoi(i, j, 11, 402), dx = i - c.sx, dy = j - c.sy, R = N / 3;
      const tilt = hash2(c.id, 1, 403) * Math.PI * 2, rim = Math.min(1, c.gap / 12);
      v = Math.sqrt(rim) * 1.4 + ((dx * Math.cos(tilt) + dy * Math.sin(tilt)) / R) * 1.4 + groove(c.gap, 2.0) * 3.4;
      // (a few smaller fractures running in from the chunks' edges, not a net)
      if (c.gap < 10 && hash2(fine.id, 7, 409) < 0.4) v += groove(fine.gap, 1.0) * 1.2 * (1 - c.gap / 10);
      // grain, coarse and fine: the rock's own surface
      v += (fbm(i, j, 8, 404, 4) - 0.5) * 2.4 + (fbm(i, j, 48, 410, 2) - 0.5) * 0.8;
      // pitting: rare, each its own size, shallow
      const pit = voronoi(i, j, 13, 405), pr = 1.6 + hash2(pit.id, 4, 406) * 3.4, pd = Math.hypot(i - pit.sx, j - pit.sy);
      if (hash2(pit.id, 2, 406) < 0.16 && pd < pr) v -= (1 - (pd / pr) ** 2) * 0.9;
      // a few cracks lit gold deep down
      const lit = hash2(Math.min(c.id, c.id2), Math.max(c.id, c.id2), 407) < 0.18;
      if (lit && c.gap < 2) e[o] = (1 - c.gap / 2) * 0.55;
      // weathered: each chunk its own shade, the edges lighter
      k[o] = (hash2(c.id, 3, 408) - 0.5) * 0.35 + Math.max(0, 1 - c.gap / 6) * 0.18;
    } else if (kind === 19) {
      // strata, warped; each band its own shade
      // strata: bands of uneven thickness, warped, each a step proud of the next
      const warp = fbm(i, j, 4, 411, 3) * 10, ph = (j / N) * 7 + warp * 0.25, bandI = Math.floor(ph), bf = ph - bandI;
      v = (hash2(bandI, 1, 417) - 0.5) * 2.2 + Math.min(1, bf * 8) * 0.6 + (fbm(i, j, 16, 412, 3) - 0.5) * 1.4;
      k[o] = (hash2(bandI, 2, 418) - 0.5) * 0.3 + (fbm(i, j, 8, 413, 2) - 0.5) * 0.15;
      // hairline cracks across the strata, few
      const c = voronoi(i, j, 2, 414);
      v += groove(c.gap, 1.0) * 1.8;
      // pits: rare, uneven
      const pit = voronoi(i, j, 11, 415), pr = 1.4 + hash2(pit.id, 4, 419) * 2.8, pd = Math.hypot(i - pit.sx, j - pit.sy);
      if (hash2(pit.id, 2, 416) < 0.12 && pd < pr) v -= (1 - (pd / pr) ** 2) * 0.8;
    } else if (kind === 20) {
      // glass with a flow through it; fissures, most of them lit
      v = Math.sin((i * 0.6 + j * 0.25) * 0.07 + fbm(i, j, 4, 421, 2) * 4) * 0.35;
      const c = voronoi(i, j, 4, 422);
      v += groove(c.gap, 1.6) * 1.6;
      if (hash2(Math.min(c.id, c.id2), Math.max(c.id, c.id2), 423) < 0.35 && c.gap < 2.0) e[o] = (1 - c.gap / 2.0) * 0.55;
      k[o] = (fbm(i, j, 6, 424, 2) - 0.5) * 0.3;
    } else if (kind === 22) {
      // the core's glass: smooth to the touch, cells of light slowly turning in it (as a sun's surface), bright in their
      // middles, dimmer in the lanes between; a faint swirl over all
      const cell = voronoi(i, j, 9, 451), swirl = fbm(i, j, 3, 452, 3);
      v = Math.sqrt(Math.min(1, cell.gap / 9)) * 0.18 + (swirl - 0.5) * 0.35;
      e[o] = 0.012 + 0.05 * Math.min(1, cell.gap / 7) * (0.6 + 0.8 * swirl);
      k[o] = -Math.max(0, 1 - cell.gap / 3) * 0.12;
    } else {
      // bone: a fibrous grain one way, pores, faint growth rings
      v = (vnoise2(i, j, 64, 4, 431) - 0.5) * 1.4 + Math.sin(j * 0.9 + fbm(i, j, 8, 432, 2) * 6) * 0.12;
      const pore = voronoi(i, j, 21, 433), pd = Math.hypot(i - pore.sx, (j - pore.sy) * 0.5);
      if (hash2(pore.id, 2, 434) < 0.5 && pd < 2.2) v -= (1 - pd / 2.2) * 1.0;
      v += Math.sin(Math.hypot(wd(i - 128), wd(j - 128)) * 0.18) * 0.12;
      k[o] = (fbm(i, j, 12, 435, 2) - 0.5) * 0.22;
    }
    h[o] += v;
  }
  return { h, e, k };
}
