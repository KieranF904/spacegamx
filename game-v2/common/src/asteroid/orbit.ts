import { ORBIT_MU } from '../constants.js';

export enum OrbitType {
  Elliptic = 0,
  Parabolic = 1,
  Hyperbolic = 2,
  /** Keeps still: always semiMajorAxis from the centre at angle argPeriapsis (a stationary field's rock) */
  Fixed = 3,
  None = 255,
}

export interface KeplerOrbitParams {
  orbitType: OrbitType;
  semiMajorAxis: number;   // a (ellipse/hyperbola) or periapsis distance for parabolic
  eccentricity: number;    // e
  argPeriapsis: number;    // ω
  meanAnomaly0: number;    // M at epochTick
  epochTick: number;       // tick where M = meanAnomaly0
}

export interface OrbitState2D {
  x: number;
  y: number;
  r: number;
  trueAnomaly: number;
}

export function calcAsteroidPosition(
  params: KeplerOrbitParams,
  tick: number,
): { x: number; y: number } {
  const state = calcOrbitState(params, tick);
  return { x: state.x, y: state.y };
}

/**
 * Scratch result reused by calcOrbitStateInto to avoid per-call allocation.
 * Single-threaded use only (the game server tick loop qualifies).
 */
const orbitScratch: OrbitState2D = { x: 0, y: 0, r: 0, trueAnomaly: 0 };

/**
 * Allocation-free orbit evaluation taking raw numeric fields.
 * Avoids both the result object AND the params object allocation.
 * Writes into a shared scratch object — read fields before the next call.
 */
export function calcOrbitStateRaw(
  orbitType: number,
  semiMajorAxis: number,
  eccentricity: number,
  argPeriapsis: number,
  meanAnomaly0: number,
  epochTick: number,
  tick: number,
): OrbitState2D {
  const s = orbitScratch;
  s.x = 0; s.y = 0; s.r = 0; s.trueAnomaly = 0;

  if (orbitType === OrbitType.None || semiMajorAxis <= 0) {
    return s;
  }

  if (orbitType === OrbitType.Fixed) {
    s.r = semiMajorAxis;
    s.x = Math.cos(argPeriapsis) * semiMajorAxis;
    s.y = Math.sin(argPeriapsis) * semiMajorAxis;
    return s;
  }

  const dt = tick - epochTick;
  const e = eccentricity;

  if (orbitType === OrbitType.Elliptic) {
    const a = semiMajorAxis;
    const n = Math.sqrt(ORBIT_MU / (a * a * a));
    const M = wrapAngle(meanAnomaly0 + n * dt);
    const E = solveKeplerElliptic(M, e);
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    s.r = a * (1 - e * cosE);
    s.trueAnomaly = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2),
    );
  } else if (orbitType === OrbitType.Hyperbolic) {
    const a = semiMajorAxis;
    const n = Math.sqrt(ORBIT_MU / (a * a * a));
    const M = meanAnomaly0 + n * dt;
    const H = solveKeplerHyperbolic(M, e);
    s.r = a * (e * Math.cosh(H) - 1);
    const tanhH2 = Math.tanh(H / 2);
    s.trueAnomaly = 2 * Math.atan(tanhH2 * Math.sqrt((e + 1) / (e - 1)));
  } else {
    const q = semiMajorAxis;
    const k = Math.sqrt(ORBIT_MU / (2 * q * q * q));
    const M = meanAnomaly0 + k * dt;
    const D = solveKeplerParabolic(M);
    s.trueAnomaly = 2 * Math.atan(D);
    s.r = q * (1 + D * D);
  }

  const theta = s.trueAnomaly + argPeriapsis;
  s.x = Math.cos(theta) * s.r;
  s.y = Math.sin(theta) * s.r;
  return s;
}

/**
 * Allocation-free variant of calcOrbitState. Writes into a shared scratch
 * object — read the fields before the next call. Ideal for hot loops that
 * process many orbits per tick (e.g. 1200+ asteroids at 60Hz).
 */
export function calcOrbitStateInto(
  params: KeplerOrbitParams,
  tick: number,
): OrbitState2D {
  return calcOrbitStateRaw(
    params.orbitType,
    params.semiMajorAxis,
    params.eccentricity,
    params.argPeriapsis,
    params.meanAnomaly0,
    params.epochTick,
    tick,
  );
}

export function calcOrbitState(
  params: KeplerOrbitParams,
  tick: number,
): OrbitState2D {
  if (params.orbitType === OrbitType.None || params.semiMajorAxis <= 0) {
    return { x: 0, y: 0, r: 0, trueAnomaly: 0 };
  }
  if (params.orbitType === OrbitType.Fixed) {
    const a = params.semiMajorAxis, w = params.argPeriapsis;
    return { x: Math.cos(w) * a, y: Math.sin(w) * a, r: a, trueAnomaly: 0 };
  }

  const dt = tick - params.epochTick;
  const e = params.eccentricity;
  let r = 0;
  let nu = 0;

  if (params.orbitType === OrbitType.Elliptic) {
    const a = params.semiMajorAxis;
    const n = Math.sqrt(ORBIT_MU / (a * a * a));
    const M = wrapAngle(params.meanAnomaly0 + n * dt);
    const E = solveKeplerElliptic(M, e);
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    r = a * (1 - e * cosE);
    nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2),
    );
  } else if (params.orbitType === OrbitType.Hyperbolic) {
    const a = params.semiMajorAxis;
    const n = Math.sqrt(ORBIT_MU / (a * a * a));
    const M = params.meanAnomaly0 + n * dt;
    const H = solveKeplerHyperbolic(M, e);
    r = a * (e * Math.cosh(H) - 1);
    const tanhH2 = Math.tanh(H / 2);
    nu = 2 * Math.atan(tanhH2 * Math.sqrt((e + 1) / (e - 1)));
  } else {
    const q = params.semiMajorAxis;
    const k = Math.sqrt(ORBIT_MU / (2 * q * q * q));
    const M = params.meanAnomaly0 + k * dt;
    const D = solveKeplerParabolic(M);
    nu = 2 * Math.atan(D);
    r = q * (1 + D * D);
  }

  const theta = nu + params.argPeriapsis;
  return {
    x: Math.cos(theta) * r,
    y: Math.sin(theta) * r,
    r,
    trueAnomaly: nu,
  };
}

function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a < -Math.PI) a += twoPi;
  return a;
}

function solveKeplerElliptic(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 10; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-6) break;
  }
  return E;
}

function solveKeplerHyperbolic(M: number, e: number): number {
  let H = Math.asinh(M / e);
  for (let i = 0; i < 12; i++) {
    const sinhH = Math.sinh(H);
    const coshH = Math.cosh(H);
    const f = e * sinhH - H - M;
    const fp = e * coshH - 1;
    const d = f / fp;
    H -= d;
    if (Math.abs(d) < 1e-6) break;
  }
  return H;
}

function solveKeplerParabolic(M: number): number {
  let D = M;
  for (let i = 0; i < 12; i++) {
    const f = D + (D * D * D) / 3 - M;
    const fp = 1 + D * D;
    const d = f / fp;
    D -= d;
    if (Math.abs(d) < 1e-6) break;
  }
  return D;
}

/** Fastest a station may orbit (world units per tick) so a ship can catch it and dock */
export const MAX_STATION_ORBIT_SPEED = 1.2;

/**
 * Orbit clock rate for a station on a circular-ish orbit of this size: real
 * Kepler speed near the star can outrun a ship, so the clock is slowed until
 * the orbital speed is at most MAX_STATION_ORBIT_SPEED.
 */
export function stationOrbitTimeScale(semiMajorAxis: number): number {
  if (semiMajorAxis <= 0) return 1;
  const keplerSpeed = Math.sqrt(ORBIT_MU / semiMajorAxis);
  return Math.min(1, MAX_STATION_ORBIT_SPEED / keplerSpeed);
}

/** The tick to evaluate an orbit at when its clock runs at `timeScale`. */
export function scaledOrbitTick(tick: number, epochTick: number, timeScale: number): number {
  return epochTick + (tick - epochTick) * timeScale;
}
