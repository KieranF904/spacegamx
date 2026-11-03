/**
 * Deterministic trigonometry: the same bits in Node and every browser engine.
 *
 * Math.sin, cos, atan2, hypot and pow are "implementation-approximated" by the spec, and V8, SpiderMonkey and
 * JavaScriptCore do differ in the last bit (docs/audits/js-math-determinism-2026-11-01.md). These use only + - * /
 * and Math.sqrt, Math.round, Math.abs (exact by the spec, IEEE 754 binary64, no fused multiply-add in JS), in a fixed
 * order: fdlibm's kernels and argument reduction, written out as Horner steps. Accuracy is within an ulp or two of
 * Math's; what matters is that every engine gets the same answer.
 *
 * Used by what clients work out for themselves and must agree on with the server (debris: ships/debris.ts). The
 * first piece of the lockstep work (docs/design/netcode-lockstep.md). Lint rule for code that uses it: no Math.sin,
 * cos, tan, atan, atan2, hypot, pow, exp, log or `**` in the deterministic path.
 */

// pi/2 in three parts (fdlibm __ieee754_rem_pio2): k × each part is exact for |k| < 2^20, so the reduction is too
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_3 = 2.02226624871116645580e-21;
const INV_PIO2 = 6.36619772367581382433e-01;

// fdlibm __kernel_sin
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/** sin on [-pi/4, pi/4] */
function kSin(x: number): number {
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

/** cos on [-pi/4, pi/4] */
function kCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z, w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}

/** x reduced to [-pi/4, pi/4] and its quadrant (0-3). For |x| up to about 1e6: angles here are never far off */
function reduce(x: number): [number, number] {
  const k = Math.round(x * INV_PIO2);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  return [r, ((k % 4) + 4) % 4];
}

export function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  switch (q) {
    case 0: return kSin(r);
    case 1: return kCos(r);
    case 2: return -kSin(r);
    default: return -kCos(r);
  }
}

export function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  switch (q) {
    case 0: return kCos(r);
    case 1: return -kSin(r);
    case 2: return -kCos(r);
    default: return kSin(r);
  }
}

/** Both at once (one reduction): out[0] = sin, out[1] = cos */
export function dsincos(x: number, out: [number, number] = [0, 0]): [number, number] {
  if (!Number.isFinite(x)) { out[0] = out[1] = NaN; return out; }
  const [r, q] = reduce(x);
  const s = kSin(r), c = kCos(r);
  switch (q) {
    case 0: out[0] = s; out[1] = c; break;
    case 1: out[0] = c; out[1] = -s; break;
    case 2: out[0] = -s; out[1] = -c; break;
    default: out[0] = -c; out[1] = s; break;
  }
  return out;
}

// fdlibm s_atan
const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-01, AT1 = -1.99999999998764832476e-01, AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01, AT4 = 9.09088713343650656196e-02, AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02, AT7 = -5.83357013379057348645e-02, AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02, AT10 = 1.62858201153657823623e-02;
const PI = 3.14159265358979311600e+00;
const PI_LO = 1.2246467991473531772e-16;
const PIO2 = 1.57079632679489655800e+00;

export function datan(x: number): number {
  if (x !== x) return x;
  const neg = x < 0;
  let a = neg ? -x : x;
  if (a >= 7.37869762948382064640e+19) return neg ? -(ATAN_HI[3] + ATAN_LO[3]) : ATAN_HI[3] + ATAN_LO[3];
  let id: number;
  if (a < 0.4375) {
    if (a < 3.7252902984e-09) return x;
    id = -1;
  } else if (a < 1.1875) {
    if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); }
  } else if (a < 2.4375) {
    id = 2; a = (a - 1.5) / (1 + 1.5 * a);
  } else {
    id = 3; a = -1 / a;
  }
  const z = a * a, w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) { const r = a - a * (s1 + s2); return neg ? -r : r; }
  const r = ATAN_HI[id] - ((a * (s1 + s2) - ATAN_LO[id]) - a);
  return neg ? -r : r;
}

/** atan2(y, x) in (-pi, pi]. (0, 0) gives 0 */
export function datan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (y === 0) return x < 0 ? PI : 0;
  if (x === 0) return y > 0 ? PIO2 : -PIO2;
  const t = datan(Math.abs(y / x));
  if (x > 0) return y > 0 ? t : -t;
  const r = PI - (t - PI_LO);
  return y > 0 ? r : -r;
}

/** sqrt(x² + y²): only + * and sqrt, so exact alike everywhere (no overflow care: world units are small) */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
