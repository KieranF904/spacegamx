// Shared star generation utilities for starfield
// Uses an inline simplex-noise implementation to avoid external dependency

// Simplex noise constants (2D)
const SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
const SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;
const SIMPLEX_GRAD: [number, number][] = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];

export function seededRandom(seed: number): () => number {
    let x = Math.sin(seed) * 10000;
    return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
    };
}

function simplexNoise2D(x: number, y: number, seed: number = 0): number {
    const s = (x + y) * SIMPLEX_F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * SIMPLEX_G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;

    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    else { i1 = 0; j1 = 1; }

    const x1 = x0 - i1 + SIMPLEX_G2;
    const y1 = y0 - j1 + SIMPLEX_G2;
    const x2 = x0 - 1 + 2 * SIMPLEX_G2;
    const y2 = y0 - 1 + 2 * SIMPLEX_G2;

    const perm = (n: number): number => {
      let h = Math.imul(n, 374761393) ^ Math.imul(seed, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return (h >>> 0) % 8;
    };

    const ii = i & 0xff;
    const jj = j & 0xff;
    const gi0 = perm(ii + perm(jj));
    const gi1 = perm(ii + i1 + perm(jj + j1));
    const gi2 = perm(ii + 1 + perm(jj + 1));

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0*x0 - y0*y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (SIMPLEX_GRAD[gi0][0] * x0 + SIMPLEX_GRAD[gi0][1] * y0);
    }

    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (SIMPLEX_GRAD[gi1][0] * x1 + SIMPLEX_GRAD[gi1][1] * y1);
    }

    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (SIMPLEX_GRAD[gi2][0] * x2 + SIMPLEX_GRAD[gi2][1] * y2);
    }

    return 70 * (n0 + n1 + n2);
}

export function generateStars(
    starCount: number,
    width: number,
    height: number,
    depth: number,
    seed: number
) {
    const stars: any[] = [];
    const rand = seededRandom(seed);
    for (let i = 0; i < starCount; i++) {
        const x = rand();
        const y = rand();
        // Cluster stars using inline noise
        const cluster = simplexNoise2D(x * 10, y * 10, seed);
        const h = rand();
        const s = 0.5 + 0.5 * rand();
        const l = 0.5 + 0.5 * rand();
        const twinkle = rand();
        stars.push({ x, y, z: depth, h, s, l, twinkle, cluster });
    }
    return stars;
}
