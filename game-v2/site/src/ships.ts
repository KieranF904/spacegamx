/**
 * Shared ships (the gallery): checking what the game sends, so the site only ever stores a drawable plan and
 * plain numbers. The contract is docs/game-integration.md, section 3.
 *
 *   POST /api/v1/ships    { userId, userName, name, plan, stats, power? }   (the game server's key)
 */

import type { PlanPart, RenderData, ShipStats } from './catalog/types.js';
import type { ShipInput } from './store/types.js';

export const MAX_SHIPS_PER_PILOT = 10;
export const MAX_PLAN_PARTS = 400;
export const SHIP_BODY_MAX = 128 * 1024;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown, hi = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= hi;
const ID = /^[a-z0-9_]{1,48}$/;

export function cleanShipName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The plan: parts the site can draw. `render` (the catalog's shapes) is checked when there is one */
export function checkPlan(v: unknown, render: RenderData | null): { ok: true; plan: PlanPart[] } | { ok: false; error: string } {
  if (!Array.isArray(v) || !v.length) return { ok: false, error: 'plan must be a list of parts' };
  if (v.length > MAX_PLAN_PARTS) return { ok: false, error: `plan can have ${MAX_PLAN_PARTS} parts at most` };
  const plan: PlanPart[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'each part must be an object' };
    const { fn, piece, x, y, rot, flip } = p as Record<string, unknown>;
    if (typeof fn !== 'string' || !ID.test(fn)) return { ok: false, error: 'a part has a bad fn' };
    if (typeof piece !== 'string' || !ID.test(piece)) return { ok: false, error: 'a part has a bad piece' };
    if (render && !render.shapes[piece]) return { ok: false, error: `unknown piece "${piece}"` };
    if (!isInt(x, -500, 500) || !isInt(y, -500, 500)) return { ok: false, error: 'a part is out of range' };
    if (!isInt(rot, 0, 3)) return { ok: false, error: 'rot must be 0 to 3' };
    plan.push({ fn, piece, x, y, rot, ...(flip === true ? { flip: true } : {}) });
  }
  return { ok: true, plan };
}

export function checkStats(v: unknown): ShipStats | null {
  const s = v as Record<string, any> | null;
  if (!s || typeof s !== 'object') return null;
  const g = s.guns as Record<string, unknown> | undefined;
  const keys = ['parts', 'cells', 'mass', 'hp', 'gen', 'draw', 'thrust', 'shield', 'cargo'] as const;
  if (!keys.every((k) => isNum(s[k])) || !g || !isInt(g.fixed, 0, 1000) || !isInt(g.turret, 0, 1000)) return null;
  const out: any = { guns: { fixed: g.fixed, turret: g.turret } };
  for (const k of keys) out[k] = round1(s[k]);
  return out as ShipStats;
}

export type ShipCheck = { ok: true; value: ShipInput } | { ok: false; error: string; status: number };

export function checkShip(body: Record<string, any>, render: RenderData | null): ShipCheck {
  const ownerId = body.userId;
  if (!isInt(ownerId, 1, 2 ** 31)) return { ok: false, status: 400, error: 'userId must be the pilot\'s account number' };
  const ownerName = typeof body.userName === 'string' ? body.userName.trim().slice(0, 20) : '';
  if (!/^[A-Za-z0-9_-]{2,20}$/.test(ownerName)) return { ok: false, status: 400, error: 'userName must be the pilot\'s name' };
  const name = cleanShipName(body.name);
  if (!name) return { ok: false, status: 400, error: 'name is required (40 characters at most)' };
  const plan = checkPlan(body.plan, render);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  const stats = checkStats(body.stats);
  if (!stats) return { ok: false, status: 400, error: 'stats must have parts, cells, mass, hp, gen, draw, thrust, shield, cargo and guns { fixed, turret }' };
  return { ok: true, value: { ownerId, ownerName, name, plan: plan.plan, stats, power: body.power === 'ports' ? 'ports' : 'pool' } };
}
