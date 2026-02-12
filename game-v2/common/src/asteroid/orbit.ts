import { ORBIT_MU } from '../constants.js';

export enum OrbitType {
  Elliptic = 0,
  Parabolic = 1,
  Hyperbolic = 2,
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

export function calcOrbitState(
  params: KeplerOrbitParams,
  tick: number,
): OrbitState2D {
  if (params.orbitType === OrbitType.None || params.semiMajorAxis <= 0) {
    return { x: 0, y: 0, r: 0, trueAnomaly: 0 };
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
