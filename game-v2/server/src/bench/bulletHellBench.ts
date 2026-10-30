/**
 * Bullet-hell bench (measurement only, changes nothing in the game): one boss in its densest phase with N pilots
 * round it, every pilot weaving and firing at it. Staged bosses (a `brain`) are stepped to their last stage with the
 * dev tool (forceShed); the rest are worn below every phase (escorts out, enraged, nova on), as `devBoss wear` does.
 * The pilots' hits on the boss are scaled down (`--bossDamage`, a wrapper on ShipBridge.hurt) so the phase holds.
 * Reports tick time (mean/p50/p95/p99/worst), the tick by part, live projectiles (the boss's, its escorts', the
 * pilots'), and every byte sent to each pilot, with the share that is projectile rows (and their removals) worked
 * out exactly by re-encoding each snapshot without them.
 * Run (in server/):
 *   npx tsx src/bench/bulletHellBench.ts --boss boss_pyreclast [--pilots 4] [--seconds 40] [--warm 5] [--bossDamage 0.02] [--json out.json]
 *   npx tsx src/bench/bulletHellBench.ts --survey [--seconds 40]       (every boss, 1 pilot: peak projectiles only)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Position, Input, Rotation, ClientSocket, splitServerFrame, encodeServerMessage, EntityType, Projectile, InSystem } from '@space-game/common';
import * as bitecs from 'bitecs';
import { writeFileSync, readFileSync } from 'fs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const argN = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argS = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SECS = argN('--seconds', 40), WARM = argN('--warm', 5), BOSS_DMG = argN('--bossDamage', 0.02);
const SURVEY = process.argv.includes('--survey');
const NOFIRE = process.argv.includes('--nofire');
const allBosses: Record<string, any> = JSON.parse(readFileSync(join(dataDir, 'bosses.json'), 'utf8')).bosses;

interface Result {
  boss: string; pilots: number; stage: string; ticks: number;
  tick: { mean: number; p50: number; p95: number; p99: number; worst: number };
  parts: Record<string, { us: number; calls: number }>;
  proj: { spawnedPerS: Record<string, number>; peak: number; mean: number; bossPeak: number; bossMean: number; escortPeak: number; pilotPeak: number; mobsPeak: number; hostilesNear: number };
  net: { kibPerPilotS: number; projKibPerPilotS: number; projRowsPerPilotS: number; byType: Record<string, number>; snapshotsPerS: number; peakKibPerPilotS1s: number };
}

async function run(bossId: string, PILOTS: number, secs: number, quiet = false): Promise<Result> {
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), clock: () => clock.t,
  });
  const S = server as any;
  const bridge = S.ships;
  const def = allBosses[bossId];

  // ---- timers (inclusive) ----
  const spent: Record<string, number> = {}, calls: Record<string, number> = {};
  let on = false;
  const wrap = (obj: any, fn: string, key: string) => {
    if (!obj || typeof obj[fn] !== 'function') return;
    const orig = obj[fn].bind(obj);
    spent[key] = 0; calls[key] = 0;
    obj[fn] = (...a: unknown[]) => { if (!on) return orig(...a); const s = performance.now(); try { return orig(...a); } finally { spent[key] += performance.now() - s; calls[key]++; } };
  };
  for (const [fn, key] of [
    ['buildSpatialGrid', 'spatialGrid'], ['playerMovementSystem', 'playerMovement'], ['weaponSystem', 'weaponSystem (pilot guns)'],
    ['projectileSystem', 'projectileSystem (Weapons.tick + move)'], ['collisionSystem', 'collisionSystem'],
    ['lifetimeSystem', 'lifetime'], ['cleanupSystem', 'cleanup (removals)'], ['sendSnapshots', 'sendSnapshots'],
    ['flushOutbox', 'flushOutbox (encode+send)'], ['systemRows', '  systemRows (rows built per system)'],
    ['broadcastProjectileHit', '  broadcastProjectileHit'],
  ] as const) wrap(S, fn, key);
  for (const [o, key] of [['enemies', 'enemies'], ['bosses', 'bosses (phases, novas, brains)'], ['mobs', 'mobs'], ['ships', 'ShipBridge.tick'], ['lod', 'SimLod']] as const) wrap(S[o], 'tick', key);
  wrap(S.weapons, 'tick', '  Weapons.tick (homing, fuses)');
  wrap(S.replication, 'endTick', 'replication.endTick');
  wrap(bridge, 'hitProjectile', '  hitProjectile (per shot, ships)');
  wrap(bridge, 'segmentHit', '    segmentHit');
  wrap(bridge, 'splashAt', '  * splashAt');
  wrap(bridge, 'fireWeapons', '  fireWeapons (NPC guns)');
  wrap(bridge, 'resolveContacts', '  resolveContacts');
  wrap(S.spatialGrid, 'queryRay', '  spatialGrid.queryRay');
  wrap(S.asteroidOrbits, 'query', '  asteroid query');
  wrap(S.mobs, 'rayHit', '  mobs.rayHit');
  wrap(S.weapons, 'onShipHit', '  Weapons.onShipHit');

  // ---- pilots ----
  const byType: Record<string, number> = {};
  let bytes = 0, projBytes = 0, projRows = 0, snaps = 0;
  const perSecond: number[] = [];
  let secBytes = 0;
  const projIds = new Set<number>();
  const count = (d: string | Uint8Array) => {
    if (!on || typeof d === 'string') return;
    bytes += d.byteLength; secBytes += d.byteLength;
    for (const m of splitServerFrame(d)) {
      byType[m.msg.type] = (byType[m.msg.type] ?? 0) + m.bytes;
      if (m.msg.type === 'snapshot') {
        snaps++;
        const snap = m.msg as any;
        const pe = (snap.entities ?? []).filter((e: any) => e.type === EntityType.Projectile);
        for (const e of pe) projIds.add(e.id);
        const pr = (snap.removed ?? []).filter((id: number) => projIds.has(id));
        if (pe.length || pr.length) {
          projRows += pe.length;
          const stripped = { ...snap, entities: (snap.entities ?? []).filter((e: any) => e.type !== EntityType.Projectile), removed: (snap.removed ?? []).filter((id: number) => !projIds.has(id)) };
          projBytes += encodeServerMessage(snap).byteLength - encodeServerMessage(stripped).byteLength;
          for (const id of pr) projIds.delete(id);
        }
      }
    }
  };
  const pilots: number[] = [], conns: any[] = [];
  for (let i = 0; i < PILOTS; i++) {
    const socket: ClientSocket = { isOpen: () => true, send: (d: string | Uint8Array) => { if (i === 0) count(d); } } as ClientSocket;
    server.connect(socket).receive({ type: 'join', username: `bh${i}` } as never);
    const pid = server.getPlayerId(socket);
    pilots.push(pid);
    conns.push([...S.clients.values()].find((c: any) => c.playerId === pid));
  }
  const num = S.gameData.getSystemNum(def.system);
  const lair = def.lair;
  const spot = (i: number) => { const a = (i / Math.max(1, PILOTS)) * Math.PI * 2 + 0.3; return { x: lair.x + Math.cos(a) * 1800, y: lair.y + Math.sin(a) * 1800 }; };
  // Gun ships (the Lancer: forward cannons, one of the boss doc's reference ships), not the guest's beam Sparrow
  const SHIP = argS('--ship', 'lancer');
  const bp = bridge.library.get(SHIP);
  if (bp) for (const c of conns) { S.pilots.devSwapShip(c, bp); S.ammo?.restock?.(c, { report: false, quiet: true }); }
  pilots.length = 0; for (const c of conns) pilots.push(c.playerId);
  // God mode (the client profile's /god): hits still land and stop the shells, the pilots just don't lose their guns
  for (const c of conns) S.admin?.god?.add(c);
  pilots.forEach((pid, i) => { const p = spot(i); S.travelTo(conns[i], num, p.x, p.y, false); });
  for (let i = 0; i < 30; i++) { clock.t += 1000 / 60; server.step(); }
  let boss = [...S.bosses.inSystem(num)].find((e: number) => S.bosses.live?.get(bossId)?.eid === e) ?? -1;
  if (boss < 0 || !bridge.has(boss)) boss = S.bosses.spawn(bossId);
  if (boss < 0) throw new Error(`couldn't spawn ${bossId}`);
  // Other bosses in the same system (lairs where the pilots are): out of the way
  for (const e of [...S.bosses.inSystem(num)]) if (e !== boss) S.bosses.remove(e);
  for (let i = 0; i < 10; i++) { clock.t += 1000 / 60; server.step(); }

  if (process.argv.includes('--debug')) { const sh = bridge.get(pilots[0]); console.log('pilot ship', sh?.blueprint?.name, sh?.blueprint?.parts?.filter((p: any) => p.fn && p.fn !== 'hull').map((p: any) => p.fn + ':' + (p.weapon ?? p.model ?? p.id ?? '')).join(','), 'charge', bridge.chargeOf?.(pilots[0])); }
  // ---- its worst phase ----
  const brain: any = S.bosses.brainOf(boss);
  let stage = '';
  if (brain?.forceShed) {
    const last = 3;
    let n = 0;
    while (n < 400 && brain.stage < last) brain.forceShed(++n);
    stage = `stage ${brain.stage} (devBoss shed ${n})`;
    // Enraged (its last phase: what a fight's last 15% looks like), without wrecking what its moves come out of
    const live = S.bosses.live.get(bossId);
    if (live && !process.argv.includes('--calm')) {
      live.phase = def.phases.length;
      const rage = Math.max(1, ...def.phases.map((p: any) => p.enrage ?? 1));
      live.rage = rage; bridge.setDamageScale(boss, def.damage * rage);
      stage += `, enraged ${rage}`;
    }
    // Let it blow the earlier stages away and settle
    for (let i = 0; i < 240; i++) { clock.t += 1000 / 60; server.step(); }
  } else {
    const at = Math.max(0.03, Math.min(...def.phases.map((p: any) => p.at)) - 0.03);
    const ship = bridge.get(boss);
    for (let pass = 0; pass < 20 && bridge.integrity(boss) >= at; pass++) {
      for (let i = 0; i < ship.hp.length && bridge.integrity(boss) >= at; i++) {
        const fn = ship.blueprint.parts[i].fn;
        if (fn === 'core' || ship.hp[i] <= 1) continue;
        S.bosses.onDamage(boss, bridge.hurt(boss, ship, i, ship.hp[i] * 0.3), pilots[0]);
      }
    }
    for (let i = 0; i < 5; i++) { clock.t += 1000 / 60; server.step(); }
    stage = `integrity ${(bridge.integrity(boss) * 100).toFixed(0)}%, phase ${S.bosses.live.get(bossId)?.phase}/${def.phases.length}`;
  }
  // The pilots' hits on it scaled down so the phase holds
  {
    const hurt = bridge.hurt.bind(bridge);
    bridge.hurt = (eid: number, ship: unknown, part: number, amount: number, ...rest: unknown[]) => hurt(eid, ship, part, eid === boss ? amount * BOSS_DMG : amount, ...rest);
  }

  const projQuery = bitecs.defineQuery([Projectile]);
  const times: number[] = [];
  const ticks = secs * 60, warm = WARM * 60;
  let peak = 0, sum = 0, bPeak = 0, bSum = 0, ePeak = 0, pPeak = 0, mPeak = 0, hostNear = 0;
  const pilotSet = new Set(pilots);
  const dbg = { calls: 0, firing: 0, kinds: '' };
  if (process.argv.includes('--debug')) {
    const fw = bridge.fireWeapons.bind(bridge);
    bridge.fireWeapons = (eid: number, ship: any, firing: boolean, ...a: unknown[]) => { if (pilotSet.has(eid)) { dbg.calls++; if (firing) dbg.firing++; dbg.kinds = ship.kind; } return fw(eid, ship, firing, ...a); };
    const sw = bridge.stepWeapons.bind(bridge);
    bridge.stepWeapons = (eid: number) => { const r = sw(eid); if (pilotSet.has(eid) && !r) dbg.kinds = 'stepWeapons false ' + bridge.bodies.get(eid)?.kind; return r; };
  }
  const spawned = { boss: 0, pilots: 0, other: 0 };
  {
    const sp = S.weapons.spawn.bind(S.weapons);
    S.weapons.spawn = (owner: number, ...a: unknown[]) => {
      const before = projQuery(S.world).length;
      const r = sp(owner, ...a);
      if (on) { const k = owner === boss ? 'boss' : pilotSet.has(owner) ? 'pilots' : 'other'; spawned[k] += Math.max(1, projQuery(S.world).length - before); }
      return r;
    };
  }
  for (let t = 0; t < warm + ticks; t++) {
    clock.t += 1000 / 60;
    if (t === warm) { on = true; for (const k of Object.keys(spent)) { spent[k] = 0; calls[k] = 0; } }
    const alive = bridge.has(boss);
    pilots.forEach((pid, i) => {
      if (t % 30 === 0) { try { bridge.healAll(pid, 1); } catch { /* */ } }
      if (t % 600 === 0) S.ammo?.restock?.(conns[i], { report: false, quiet: true });
      const ph = t / 60 + i * 1.7;
      const ang = alive ? Math.atan2(Position.y[boss] - Position.y[pid], Position.x[boss] - Position.x[pid]) : ph;
      // Weaving round it at range
      Input.forward[pid] = Math.sin(ph * 0.9) > 0 ? 1 : 0;
      Input.left[pid] = 0; Input.right[pid] = 0;
      Input.strafeLeft[pid] = Math.sin(ph * 0.5) > 0.3 ? 1 : 0; Input.strafeRight[pid] = Math.sin(ph * 0.5) < -0.3 ? 1 : 0;
      Input.fireLeft[pid] = NOFIRE ? 0 : 1;
      Input.targetAngle[pid] = ang + argN('--aimoff', 0);
      if (process.argv.includes('--setrot')) Rotation.angle[pid] = ang;
      // Leashed: never drifts off past 3200 of the lair
      const dx = Position.x[pid] - lair.x, dy = Position.y[pid] - lair.y;
      if (dx * dx + dy * dy > 3200 * 3200) { const p = spot(i); S.ships.teleport?.(pid, p.x, p.y); }
    });
    const s = performance.now();
    server.step();
    const dt = performance.now() - s;
    if (process.argv.includes('--debug') && t % 120 === 0) {
      const pid = pilots[0], sh = bridge.get(pid);
      console.log(`t${t} fire ${Input.fireLeft[pid]} jump ${bridge.isJumping?.(sh)} emp ${bridge.isEmped?.(pid)} shelter ${S.ships.host?.sheltered?.(pid)} charge ${JSON.stringify(bridge.chargeOf?.(pid))} dBoss ${Math.round(Math.hypot(Position.x[boss] - Position.x[pid], Position.y[boss] - Position.y[pid]))} fired ${bridge.fired.length} pilotProj ${projQuery(S.world).filter((p: number) => Projectile.ownerId[p] === pid).length} rot ${Rotation.angle[pid].toFixed(2)} tgt ${Input.targetAngle[pid].toFixed(2)} pose ${JSON.stringify(bridge.pose?.(pid))} win ${JSON.stringify(sh?.derived?.weapons?.slice(0,2).map((w: any) => ({ k: w.kind, win: !!w.window, dir: w.dir, en: w.energy, cd: w.cooldown ?? w.rate })))} aim ${Array.from(sh?.aim ?? []).slice(0,8).map((x: any) => (+x).toFixed(2))} energyDerived ${JSON.stringify(sh?.derived?.energy)?.slice(0,200)} dbg ${JSON.stringify(dbg)} wpns ${sh?.derived?.weapons?.length} energy ${sh?.derived?.weapons?.[0]?.energy}`);
    }
    if (t >= warm) {
      times.push(dt);
      if ((t - warm) % 60 === 59) { perSecond.push(secBytes); secBytes = 0; }
      let n = 0, nb = 0, ne = 0, np = 0;
      for (const p of projQuery(S.world)) {
        if (InSystem.systemId[p] !== num) continue;
        n++;
        const o = Projectile.ownerId[p];
        if (o === boss) nb++; else if (pilotSet.has(o)) np++; else ne++;
      }
      peak = Math.max(peak, n); sum += n; bPeak = Math.max(bPeak, nb); bSum += nb; ePeak = Math.max(ePeak, ne); pPeak = Math.max(pPeak, np);
      const mobs = S.mobs.inSystem ? [...S.mobs.inSystem(num)].length : 0;
      mPeak = Math.max(mPeak, mobs);
      if (t % 60 === 0) hostNear = Math.max(hostNear, [...bridge.bodies.keys()].filter((e: number) => InSystem.systemId[e] === num && server.enemies.factionOf(e) && Math.hypot(Position.x[e] - lair.x, Position.y[e] - lair.y) < 9000).length);
    }
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => +times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(3);
  const total = times.reduce((a, b) => a + b, 0);
  const parts: Result['parts'] = {};
  for (const [k, v] of Object.entries(spent).sort((a, b) => b[1] - a[1])) if (v / ticks >= 0.0005) parts[k] = { us: +(v / ticks * 1000).toFixed(1), calls: +(calls[k] / ticks).toFixed(1) };
  const r: Result = {
    boss: bossId, pilots: PILOTS, stage, ticks,
    tick: { mean: +(total / ticks).toFixed(3), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), worst: +times[times.length - 1].toFixed(2) },
    parts,
    proj: { spawnedPerS: { boss: +(spawned.boss / secs).toFixed(1), pilots: +(spawned.pilots / secs).toFixed(1), other: +(spawned.other / secs).toFixed(1) }, peak, mean: +(sum / ticks).toFixed(1), bossPeak: bPeak, bossMean: +(bSum / ticks).toFixed(1), escortPeak: ePeak, pilotPeak: pPeak, mobsPeak: mPeak, hostilesNear: hostNear },
    net: {
      kibPerPilotS: +(bytes / 1024 / secs).toFixed(2), projKibPerPilotS: +(projBytes / 1024 / secs).toFixed(2), projRowsPerPilotS: +(projRows / secs).toFixed(1),
      byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, +(v / 1024 / secs).toFixed(2)])),
      snapshotsPerS: +(snaps / secs).toFixed(1), peakKibPerPilotS1s: +(Math.max(0, ...perSecond) / 1024).toFixed(1),
    },
  };
  if (!quiet) {
    console.log(`\n== ${bossId} (${stage}), ${PILOTS} pilot(s), ${secs}s ==`);
    console.log(`tick ms: mean ${r.tick.mean} · p50 ${r.tick.p50} · p95 ${r.tick.p95} · p99 ${r.tick.p99} · worst ${r.tick.worst}`);
    console.log(`projectiles in system: peak ${peak} (boss ${bPeak}, escorts/NPCs ${ePeak}, pilots ${pPeak}) · mean ${r.proj.mean} (boss ${r.proj.bossMean}) · mobs peak ${mPeak} · hostiles near ${hostNear} · shots spawned/s ${JSON.stringify(r.proj.spawnedPerS)}`);
    console.log(`net to one pilot: ${r.net.kibPerPilotS} KiB/s (peak second ${r.net.peakKibPerPilotS1s}) · projectile rows ${r.net.projRowsPerPilotS}/s = ${r.net.projKibPerPilotS} KiB/s · ${JSON.stringify(r.net.byType)}`);
    console.log('part                                         µs/tick   calls/tick');
    for (const [k, v] of Object.entries(parts)) console.log(`${k.padEnd(44)} ${String(v.us).padStart(8)}   ${String(v.calls).padStart(8)}`);
  }
  S.stop?.();
  return r;
}

const out: Result[] = [];
if (SURVEY) {
  console.log('boss                       phase                              peak  boss  escort pilots mobs  tick mean/p99/worst');
  for (const id of Object.keys(allBosses)) {
    if (allBosses[id].arena) continue;
    try {
      const r = await run(id, 1, SECS, true);
      out.push(r);
      console.log(`${id.padEnd(26)} ${r.stage.padEnd(34)} ${String(r.proj.peak).padStart(4)} ${String(r.proj.bossPeak).padStart(5)} ${String(r.proj.escortPeak).padStart(6)} ${String(r.proj.pilotPeak).padStart(6)} ${String(r.proj.mobsPeak).padStart(4)}  ${r.tick.mean}/${r.tick.p99}/${r.tick.worst}`);
    } catch (e) { console.log(`${id}: ${(e as Error).message}`); }
  }
} else {
  const ids = argS('--boss', 'boss_pyreclast').split(',');
  const ps = argS('--pilots', '1,4,8').split(',').map(Number);
  for (const id of ids) for (const p of ps) out.push(await run(id, p, SECS));
}
const j = argS('--json', '');
if (j) writeFileSync(j, JSON.stringify(out, null, 1));
process.exit(0);
