import { hashString } from '../asteroid/polygon.js';

export function computeStateHash(
  x: number,
  y: number,
  angle: number,
  vx: number,
  vy: number,
  hp: number,
  boostFuel: number,
  systemId: string | null | undefined,
): number {
  const qx = Math.round(x * 100);
  const qy = Math.round(y * 100);
  const qang = Math.round(angle * 1000);
  const qvx = Math.round(vx * 100);
  const qvy = Math.round(vy * 100);
  const qhp = Math.round(hp);
  const qboost = Math.round(boostFuel * 10);
  const sys = systemId ? hashString(systemId) : 0;

  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v >>> 0;
    h = Math.imul(h, 0x01000193);
  };

  mix(qx);
  mix(qy);
  mix(qang);
  mix(qvx);
  mix(qvy);
  mix(qhp);
  mix(qboost);
  mix(sys);

  return h >>> 0;
}
