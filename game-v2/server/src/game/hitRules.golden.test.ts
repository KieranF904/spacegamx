/**
 * Hit rules golden (docs/design/confirmed-hits.md, part B). About 500 seeded hits go through the real ShipBridge and
 * Weapons: plain hurts with every weapon's HitInfo, shields, stage cover, a ruin piece, splash, bane rounds, marks,
 * boss "taken" scales, beams (damagePartBy), and live shells of each kind (cannon, railgun pierce, flak, magma fire,
 * arc chains, prism shards, missiles, EMP) fired at dummies. What each hit did is pinned: the damage, the share that
 * got through, the part HP and shield after, and every message Weapons broadcast.
 *
 * The rules moved into common/src/ships/hitRules.ts; this pins that the move changed nothing. A change here means
 * the server's damage changed. Regenerate only on purpose: `UPDATE_GOLDEN=1 npx vitest run server/src/game/hitRules.golden.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Rotation, Velocity, InSystem, seededRng, weaponHit, weaponDef, shipPointToWorld, type ServerMessage,
} from '@space-game/common';
import { goldenFile, hashRows } from '../../../common/src/ships/golden/testData.js';
import { createProtoServer } from '../proto/createProtoServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const shipsCfg = loadShipConfigCached(dataDir);
const pins = goldenFile<{ hash: string; rows: number; dealt: number; sample: number[][] }>(join(__dirname, 'hitRules.golden.json'));
afterAll(() => pins.save());

const DESIGNS = ['scrap_mother', 'pirate_gunship', 'pyreclast_heart', 'redtooth_brawler', 'frost_bulwark'];
const KINDS = ['cannon', 'railgun', 'flak', 'missile', 'laser', 'autocannon', 'pulse', 'arc', 'torpedo', 'mortar', 'magma', 'lance', 'cinder_bloom', 'phase', 'rivet'];

function setup() {
  resetGlobals();
  const server = createProtoServer({ files, ships: shipsCfg, autoStart: false });
  const t = new LocalTransport(server);
  t.onMessage = () => {};
  t.connect();
  t.send({ type: 'join', username: 'tester' } as never);
  const pid = t.getPlayerId();
  const bridge = server.getShips()!;
  const sys = InSystem.systemId[pid];
  Position.x[pid] = 0; Position.y[pid] = 30000;
  const bodies = DESIGNS.map((d, i) => bridge.spawnDummy(bridge.enemyDesigns[d], (i - 2) * 1500, 0, 0.3 + i * 0.7, sys));
  const weapons = (server as any).weapons;
  const host = (bridge as any).host;
  const sent: ServerMessage[] = [];
  const broadcast = weapons.host.broadcast.bind(weapons.host);
  weapons.host.broadcast = (n: number, m: ServerMessage) => { sent.push(m); broadcast(n, m); };
  // (What a shell's hit on a ship sets off is kept with the hit for its clients (every client takes confirmed hits,
  // net/hits/HitLedger.ts hitFx), not broadcast: the same messages, in the same order, counted here as they were)
  const hitFx = weapons.host.hitFx.bind(weapons.host);
  weapons.host.hitFx = (proj: number, m: ServerMessage) => { const kept = hitFx(proj, m); if (kept) sent.push(m); return kept; };
  let broken = 0;
  const shieldBroken = host.shieldBroken;
  host.shieldBroken = (eid: number) => { broken++; shieldBroken?.(eid); };
  const hold = () => bodies.forEach((b, i) => { Position.x[b] = (i - 2) * 1500; Position.y[b] = 0; Velocity.x[b] = 0; Velocity.y[b] = 0; Rotation.angle[b] = 0.3 + i * 0.7; });
  const step = (n = 1) => { for (let i = 0; i < n; i++) { server.step(); hold(); } };
  return { server, bridge, pid, sys, bodies, weapons, host, sent, step, broken: () => broken };
}

/** A message as numbers (its type's letters, then each number in it, in key order) */
function msgRow(m: ServerMessage): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'string') for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i));
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k of Object.keys(v).sort()) { walk(k); walk((v as Record<string, unknown>)[k]); }
  };
  walk(m);
  return out;
}

describe('hit rules golden', () => {
  it('direct hits: hurt, damagePartBy and splashAt with seeded weapons, shields, cover, bane, marks and taken scales', () => {
    const w = setup();
    const rng = seededRng(0x5eed);
    const tun = w.bridge.tuning, cs = tun.cellSize;
    let taken = 1, invulnerable = -1;
    w.host.takenScale = (eid: number) => (eid === w.bodies[0] ? taken : 1);
    w.host.baneFaction = (eid: number) => (eid === w.bodies[1] ? 'pirates' : undefined);
    const invul = w.host.invulnerable;
    w.host.invulnerable = (eid: number) => eid === invulnerable || !!invul?.(eid);
    const rows: number[][] = [];
    let total = 0;
    for (let n = 0; n < 420; n++) {
      const bi = Math.floor(rng() * w.bodies.length), eid = w.bodies[bi], ship = w.bridge.get(eid)!;
      // (a fresh hull now and then, so the fight doesn't run out of parts)
      if (n % 60 === 0) { ship.hp = [...ship.maxHp]; ship.detached = ship.detached.map(() => false); (w.bridge as any).rebuildNow(eid, ship); }
      if (rng() < 0.25) ship.shield = rng() * ship.derived.shieldMax * 1.2 + (rng() < 0.3 ? 5 : 0);
      taken = rng() < 0.2 ? 0.3 + rng() : 1;
      invulnerable = rng() < 0.03 ? eid : -1;
      if (rng() < 0.1) w.bridge.mark(eid, 30);
      if (rng() < 0.15) { const share = rng() < 0.5 ? 0.5 : undefined; w.host.stageCover = () => share; }
      const kind = KINDS[Math.floor(rng() * KINDS.length)], def = weaponDef(tun, kind);
      const hit = weaponHit(kind, def, 1 + Math.floor(rng() * 4));
      const parts = ship.hp.length, part = Math.floor(rng() * parts);
      const amount = rng() < 0.05 ? 0 : 1 + rng() * 60;
      const geoms = w.bridge.geometry(ship);
      const how = rng();
      let dealt = 0;
      if (how < 0.55) {
        const vs = {
          hit: rng() < 0.85 ? hit : undefined,
          splash: rng() < 0.2,
          shield: rng() < 0.3 ? (def.vsShield ?? rng() * 2) : undefined,
          hull: rng() < 0.3 ? (def.vsHull ?? rng() * 2) : undefined,
          at: rng() < 0.7 ? geoms[part]?.centroid : undefined,
          bane: rng() < 0.15 ? { faction: rng() < 0.6 ? 'pirates' : 'cult', damage: 1.5 + rng() } : undefined,
        };
        dealt = w.bridge.hurt(eid, ship, part, amount, rng() < 0.5 ? w.pid : -1, vs);
      } else if (how < 0.75) {
        dealt = w.bridge.damagePartBy(eid, part, amount, w.pid, rng() < 0.7 ? hit : undefined);
      } else {
        const g = geoms[part];
        const [x, y] = shipPointToWorld(ship, { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] }, g.centroid, cs);
        const before = ship.hp.reduce((a, h) => a + h, 0) + ship.shield;
        w.bridge.splashAt(w.sys, x + (rng() - 0.5) * 60, y + (rng() - 0.5) * 60, 30 + rng() * 120, amount, w.pid, rng() < 0.8 ? hit : undefined);
        dealt = before - (ship.hp.reduce((a, h) => a + h, 0) + ship.shield);
      }
      total += dealt;
      rows.push([n, bi, dealt, (w.bridge as any).lastThrough, ship.shield, ship.shieldHitTick ?? -1, w.bridge.lastHitter(eid), w.broken(), ...ship.hp]);
    }
    const pinned = pins.check('direct', { hash: hashRows(rows), rows: rows.length, dealt: total, sample: rows.slice(0, 4) });
    expect(rows.length).toBe(pinned.rows);
    expect(total).toBe(pinned.dealt);
    expect(rows.slice(0, 4)).toEqual(pinned.sample);
    expect(hashRows(rows)).toBe(pinned.hash);
  });

  it('live shells: each kind fired at the dummies, through Weapons and the collision step', () => {
    const w = setup();
    const rng = seededRng(0xbadd);
    const rows: number[][] = [];
    let total = 0;
    const kinds = ['cannon', 'railgun', 'flak', 'missile', 'magma', 'arc', 'cinder_bloom', 'prism', 'emp', 'phase', 'autocannon', 'mortar', 'torpedo'];
    for (let volley = 0; volley < 40; volley++) {
      const kind = kinds[volley % kinds.length];
      const bi = Math.floor(rng() * w.bodies.length), eid = w.bodies[bi];
      const tx = Position.x[eid], ty = Position.y[eid];
      const a = rng() * Math.PI * 2, d = 700 + rng() * 200;
      const sx = tx + Math.cos(a) * d, sy = ty + Math.sin(a) * d;
      const h = Math.atan2(ty - sy, tx - sx) + (rng() - 0.5) * 0.05;
      for (let s = 0; s < 3; s++) {
        w.weapons.spawn(w.pid, kind, sx, sy, h + (s - 1) * 0.02, 0.8 + rng() * 0.6, { speedScale: 1, sizeScale: 1, turret: false, grade: 1 + Math.floor(rng() * 3), seed: `g${volley}:${s}`, reach: d });
      }
      for (let t = 0; t < 45; t++) {
        w.step();
        const hp = w.bodies.flatMap((b) => w.bridge.get(b)?.hp ?? []);
        rows.push([volley, t, ...hp]);
      }
      for (const m of w.sent.splice(0)) rows.push([volley, -1, ...msgRow(m)]);
      for (const b of w.bodies) {
        const s = w.bridge.get(b);
        if (!s) continue;
        total += s.hp.reduce((x, y) => x + y, 0);
        if (volley % 6 === 5) { s.hp = [...s.maxHp]; s.detached = s.detached.map(() => false); (w.bridge as any).rebuildNow(b, s); }
      }
    }
    const pinned = pins.check('shells', { hash: hashRows(rows), rows: rows.length, dealt: total, sample: rows.filter((r) => r[1] === -1).slice(0, 6) });
    expect(rows.length).toBe(pinned.rows);
    expect(total).toBe(pinned.dealt);
    expect(rows.filter((r) => r[1] === -1).slice(0, 6)).toEqual(pinned.sample);
    expect(hashRows(rows)).toBe(pinned.hash);
  });
});
