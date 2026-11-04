/**
 * Deterministic trigonometry: the same bits in Node and every browser engine.
 *
 * Math.sin, cos, atan2, hypot and pow are "implementation-approximated" by the spec, and V8, SpiderMonkey and
 * JavaScriptCore do differ in the last bit (docs/audits/js-math-determinism-2026-11-01.md). These use only + - * /
 * and Math.sqrt, Math.round, Math.abs (exact by the spec, IEEE 754 binary64, no fused multiply-add in JS), in a fixed
 * order: fdlibm's kernels and argument reduction, written out as Horner steps. Accuracy is within an ulp or two of
 * Math's; what matters is that every engine gets the same answer.
 *
 * exp, log, log2 and pow (fdlibm's exp and log, pow built on them, whole powers by multiplication) are here too, on the
 * same terms, and sinh, cosh, tanh, asinh and log1p on them (asteroid orbits). Allocation-free: the hot paths (flight,
 * shells) call these every tick.
 *
 * Used by all of common/ and the server's simulation (docs/design/deterministic-maths.md): flight, shells, hits, debris,
 * asteroid orbits, AI, bosses, spawns. The guard, common/src/math/simMaths.test.ts, fails on Math.sin, cos, tan, atan,
 * atan2, hypot, pow, exp, log, the hyperbolics, `**` (but 2 ** a whole literal) or Math.random there. The cross-engine
 * check: npm run det:engines. Angles are reduced exactly for |x| up to about 1e6; past that still the same bits
 * everywhere, but less accurate.
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

// (reduce's result: module scratch, so the hot paths allocate nothing)
let redR = 0, redQ = 0;

/** x reduced to [-pi/4, pi/4] (redR) and its quadrant 0-3 (redQ). For |x| up to about 1e6: angles here are never far off */
function reduce(x: number): void {
  const k = Math.round(x * INV_PIO2);
  redR = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  redQ = ((k % 4) + 4) % 4;
}

export function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  reduce(x);
  const r = redR;
  switch (redQ) {
    case 0: return kSin(r);
    case 1: return kCos(r);
    case 2: return -kSin(r);
    default: return -kCos(r);
  }
}

export function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  reduce(x);
  const r = redR;
  switch (redQ) {
    case 0: return kCos(r);
    case 1: return -kSin(r);
    case 2: return -kCos(r);
    default: return kSin(r);
  }
}

/** Both at once (one reduction): out[0] = sin, out[1] = cos */
export function dsincos(x: number, out: [number, number] = [0, 0]): [number, number] {
  if (!Number.isFinite(x)) { out[0] = out[1] = NaN; return out; }
  reduce(x);
  const r = redR;
  const s = kSin(r), c = kCos(r);
  switch (redQ) {
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

// ---------------------------------------------------------------------------
// exp, log, log2, pow (fdlibm's e_exp.c and e_log.c kernels; pow built on them)
// ---------------------------------------------------------------------------

// (A double's two 32-bit words, through one module scratch: read and set the exponent without allocating)
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0, LO = LITTLE ? 0 : 1;

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const LN2 = 6.93147180559945286227e-01;
const TWO54 = 1.80143985094819840000e+16;

// fdlibm __ieee754_log
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;

/** Natural log (fdlibm e_log.c): within an ulp of Math.log, the same bits everywhere */
export function dlog(x: number): number {
  F64[0] = x;
  let hx = U32[HI] | 0;
  const lx = U32[LO];
  let k = 0;
  if (hx < 0x00100000) {
    // (zero, negative or subnormal)
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54; x *= TWO54; F64[0] = x; hx = U32[HI] | 0;
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  // (x or x/2 into [sqrt(2)/2, sqrt(2)))
  U32[HI] = hx | (i ^ 0x3ff00000);
  x = F64[0];
  k += i >> 20;
  const f = x - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - ((R - dk * LN2_LO) - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

// fdlibm __ieee754_exp
const EP1 = 1.66666666666666019037e-01, EP2 = -2.77777777770155933842e-03, EP3 = 6.61375632143793436117e-05;
const EP4 = -1.65339022054652515390e-06, EP5 = 4.13813679705723846039e-08;
const O_THRESHOLD = 7.09782712893383973096e+02;
const U_THRESHOLD = -7.45133219101941108420e+02;
const TWOM1000 = 9.33263618503218878990e-302;

/** e^x (fdlibm e_exp.c): within an ulp of Math.exp, the same bits everywhere */
export function dexp(x: number): number {
  F64[0] = x;
  let hx = U32[HI] | 0;
  const neg = hx < 0;
  hx &= 0x7fffffff;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) return x !== x ? x : neg ? 0 : Infinity;
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  let hi = 0, lo = 0, k = 0;
  if (hx > 0x3fd62e42) {
    // (|x| > ln2/2: x = k·ln2 + r, |r| <= ln2/2)
    if (hx < 0x3ff0a2b2) {
      hi = neg ? x + LN2_HI : x - LN2_HI; lo = neg ? -LN2_LO : LN2_LO; k = neg ? -1 : 1;
    } else {
      k = (INV_LN2 * x + (neg ? -0.5 : 0.5)) | 0;
      hi = x - k * LN2_HI; lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  // (× 2^k on the exponent bits)
  F64[0] = y;
  if (k >= -1021) { U32[HI] = U32[HI] + (k << 20); return F64[0]; }
  U32[HI] = U32[HI] + ((k + 1000) << 20);
  return F64[0] * TWOM1000;
}

/** v × 2^n, exact unless it over- or underflows */
function ldexp(v: number, n: number): number {
  while (n > 1023) { v *= 8.98846567431158e307; n -= 1023; }
  while (n < -1022) { v *= 2.2250738585072014e-308; n += 1022; }
  F64[0] = 0;
  U32[HI] = (n + 1023) << 20;
  return v * F64[0];
}

// (splitDec's result: x = 2^decK × decM, decM in [sqrt(2)/2, sqrt(2)], for x > 0 finite)
let decK = 0, decM = 0;
const SQRT2 = 1.4142135623730951;

function splitDec(x: number): void {
  let k = 0;
  if (x < 2.2250738585072014e-308) { x *= TWO54; k = -54; }
  F64[0] = x;
  const hx = U32[HI];
  k += (hx >>> 20) - 1023;
  U32[HI] = (hx & 0x000fffff) | 0x3ff00000;
  let m = F64[0];
  if (m > SQRT2) { m *= 0.5; k += 1; }
  decK = k; decM = m;
}

/** log2 (exact for powers of two), within an ulp or two of Math.log2 */
export function dlog2(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return x;
  splitDec(x);
  return decK + dlog(decM) * INV_LN2;
}

/**
 * x^y, the same bits everywhere. Whole powers up to 4 are multiplication, as are whole numbers to whole powers that
 * come out exact (10^k); otherwise 2^(k·y) × e^(y·ln m) for x = 2^k·m,
 * within an ulp or two of Math.pow for the game's small exponents (a few ulps by |y·ln x| ≈ 25), exact when the answer
 * is a power of two. Special cases as Math.pow. (A hot path with a fixed whole exponent multiplies it out instead:
 * this is ~5x Math.pow's cost)
 */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  const yInt = y === Math.trunc(y);
  if (yInt && y <= 4 && y >= -4 && x - x === 0) {
    const n = y < 0 ? -y : y, x2 = x * x;
    const r = n === 1 ? x : n === 2 ? x2 : n === 3 ? x2 * x : x2 * x2;
    return y < 0 ? 1 / r : r;
  }
  // (A whole number to a whole power that comes out exact, as 10^k: multiplied out, so exact as Math.pow is)
  if (yInt && y <= 64 && y >= -64 && x === Math.trunc(x) && x < 67108864 && x > -67108864) {
    let r = 1, i = y < 0 ? -y : y;
    for (; i > 0; i--) { const p = r * x; if (!exactProduct(r, x, p)) break; r = p; }
    if (i === 0) return y < 0 ? 1 / r : r;
  }
  const odd = yInt && Math.abs(y) < 9007199254740992 && y % 2 !== 0;
  if (y - y !== 0) {
    // (y = ±Infinity)
    const ax = x < 0 ? -x : x;
    if (ax === 1) return NaN;
    return (ax > 1) === (y > 0) ? Infinity : 0;
  }
  if (x === 0) {
    const negZero = 1 / x < 0 && odd;
    return y > 0 ? (negZero ? -0 : 0) : negZero ? -Infinity : Infinity;
  }
  if (x - x !== 0) {
    // (x = ±Infinity)
    if (x > 0) return y > 0 ? Infinity : 0;
    return y > 0 ? (odd ? -Infinity : Infinity) : odd ? -0 : 0;
  }
  let sign = 1;
  if (x < 0) { if (!yInt) return NaN; if (odd) sign = -1; x = -x; }
  if (x === 1) return sign;
  // (Far out of the game's range: plainly, it's 0, 1-ish or infinite anyway)
  if (y > 1e20 || y < -1e20) return sign * dexp(y * dlog(x));
  splitDec(x);
  const k = decK, f = decM - 1;
  // x^y = 2^(k·y) · e^(y·ln m): k·y = ph + pl exactly (k has at most 11 bits, so only y is split), n its whole part
  const ph = k * y;
  let c = SPLIT * y;
  const yh = c - (c - y), yl = y - yh;
  const pl = (k * yh - ph) + k * yl;
  if (ph > 2100) return sign * Infinity;
  if (ph < -2200) return sign * 0;
  const n = Math.round(ph);
  const fr = ph - n;
  // ln m = f + tail (f = m - 1, exact), so y·ln m = y·f (exactly, as qh + ql) + y·tail
  const qh = y * f;
  c = SPLIT * f;
  const fh = c - (c - f), fl = f - fh;
  const ql = ((yh * fh - qh) + yh * fl + yl * fh) + yl * fl;
  // fr·ln2 = ah + al
  const ah = fr * LN2;
  c = SPLIT * fr;
  const rh = c - (c - fr), rl = fr - rh;
  const al = ((rh * LN2_H - ah) + rh * LN2_L + rl * LN2_H) + rl * LN2_L + fr * LN2_TAIL;
  // th + tl = the exponent, the roundings of its sums kept (twoSum) and applied after: e^(th + tl) ≈ e^th · (1 + tl)
  const r = y * logTail(f);
  const s1 = qh + r, b1 = s1 - qh;
  const e1 = (qh - (s1 - b1)) + (r - b1);
  const th = s1 + ah, b2 = th - s1;
  const e2 = (s1 - (th - b2)) + (ah - b2);
  const tl = e1 + e2 + al + ql + pl * LN2;
  const e = dexp(th);
  return sign * ldexp(e + e * tl, n);
}

const SPLIT = 134217729;
// ln2 = LN2 + LN2_TAIL, and LN2 split into halves of 26 bits (LN2_H + LN2_L) for exact products
const LN2_TAIL = 2.3190468138462996e-17;
const LN2_H = 0.6931471824645996;
const LN2_L = -1.904654323148236e-9;

/** Is p = a × b with no rounding (Dekker's product: its error term is 0)? */
function exactProduct(a: number, b: number, p: number): boolean {
  let c = SPLIT * a;
  const ah = c - (c - a), al = a - ah;
  c = SPLIT * b;
  const bh = c - (c - b), bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl === 0;
}

/** ln(1 + f) - f for f in [sqrt(2)/2 - 1, sqrt(2) - 1] (fdlibm's log kernel, without its f) */
function logTail(f: number): number {
  if (f === 0) return 0;
  const s = f / (2 + f), z = s * s, w = z * z;
  const R = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7))) + w * (LG2 + w * (LG4 + w * LG6));
  const hfsq = 0.5 * f * f;
  return s * (hfsq + R) - hfsq;
}

// ---------------------------------------------------------------------------
// sinh, cosh, tanh, asinh (asteroid orbits' hyperbolic Kepler: asteroid/orbit.ts), on dexp and dlog
// ---------------------------------------------------------------------------

/** sinh's odd series for |x| < 0.5 (to x^17: the next term is under an ulp), so no cancellation near 0 */
function sinhSeries(x: number): number {
  const z = x * x;
  return x + x * z * (1 / 6 + z * (1 / 120 + z * (1 / 5040 + z * (1 / 362880 + z * (1 / 39916800
    + z * (1 / 6227020800 + z * (1 / 1307674368000 + z * (1 / 355687428096000))))))));
}

/** sinh, within a few ulps of Math.sinh, the same bits everywhere */
export function dsinh(x: number): number {
  if (x !== x) return x;
  const a = x < 0 ? -x : x;
  if (a < 0.5) return sinhSeries(x);
  if (a > 710) return x < 0 ? -Infinity : Infinity;
  const e = dexp(a), r = 0.5 * (e - 1 / e);
  return x < 0 ? -r : r;
}

/** cosh, within a few ulps of Math.cosh, the same bits everywhere */
export function dcosh(x: number): number {
  if (x !== x) return x;
  const a = x < 0 ? -x : x;
  if (a > 710) return Infinity;
  const e = dexp(a);
  return 0.5 * (e + 1 / e);
}

/** tanh, within 4 ulps of Math.tanh, the same bits everywhere */
export function dtanh(x: number): number {
  if (x !== x || x === 0) return x;
  const a = x < 0 ? -x : x;
  if (a > 22) return x < 0 ? -1 : 1;
  let r: number;
  if (a < 0.5) { const s = sinhSeries(a); r = s / Math.sqrt(1 + s * s); } else { r = 1 - 2 / (dexp(2 * a) + 1); }
  return x < 0 ? -r : r;
}

/** ln(1 + x) for x > -1, near 0 too (Goldberg's: log(u)·x/(u - 1), u = 1 + x rounded) */
export function dlog1p(x: number): number {
  const u = 1 + x;
  if (u === 1) return x;
  return dlog(u) * (x / (u - 1));
}

/** asinh, within a few ulps of Math.asinh, the same bits everywhere */
export function dasinh(x: number): number {
  if (x !== x || x - x !== 0 || x === 0) return x;
  const a = x < 0 ? -x : x;
  let r: number;
  if (a > 1e8) r = dlog(a) + LN2;
  else if (a < 0.5) { const z = a * a; r = dlog1p(a + z / (1 + Math.sqrt(1 + z))); } else r = dlog(a + Math.sqrt(a * a + 1));
  return x < 0 ? -r : r;
}
