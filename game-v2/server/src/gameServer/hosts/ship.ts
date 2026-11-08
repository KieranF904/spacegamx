/**
 * @contract server.gameserver.hosts.ship
 * owns:       the ShipHost the ship bridge calls back into
 * needs:      GameServer (type), ships/ShipBridge; npm: @space-game/common, bitecs
 * invariants: the ShipBridge api is unchanged — shipBridgeApi.json
 * extend:      a new callback is a member of createShipHost
 */

import { addEntity, removeEntity, addComponent, hasComponent } from 'bitecs';
import { Position, Velocity, Rotation, Radius, Player, InSystem, contactHurts, dhypot } from '@space-game/common';
import type { ShipHost } from '../../ships/ShipBridge.js';
import { partItemId, hazardFlight } from '@space-game/common';
import { stationQuery } from '../../game/Docking.js';
import type { GameServer } from '../../GameServer.js';

export function createShipHost(gs: GameServer): ShipHost {
  return {
    world: gs.world,
    getTick: () => gs.currentTick,
    systemTick: (eid) => (gs.clocks ? gs.clocks.tickOf(InSystem.systemId[eid]) : gs.currentTick),
    // (The tick's broadphase: ships are filed by their bounding circles as the tick began)
    shipsAlong: (num, x0, y0, x1, y1, pad) => {
      const out: number[] = [];
      for (const e of gs.spatialGrid.queryRay(num, x0, y0, x1, y1, pad)) if (e.type === 'player') out.push(e.id);
      return out;
    },
    createBody: () => {
      const eid = addEntity(gs.world);
      addComponent(gs.world, Position, eid);
      addComponent(gs.world, Velocity, eid);
      addComponent(gs.world, Rotation, eid);
      addComponent(gs.world, Radius, eid);
      addComponent(gs.world, InSystem, eid);
      InSystem.systemId[eid] = 0;
      return eid;
    },
    removeBody: (eid) => {
      gs.pendingRemovedEntities.add(eid);
      removeEntity(gs.world, eid);
    },
    terrainAt: (eid) => gs.terrainOf(InSystem.systemId[eid]),
    // (Only pilots' splash and beams hurt mobs: a boss's own shells pass through its drones)
    splashMobs: (num, x, y, radius, damage, source) => { if (source >= 0 && hasComponent(gs.world, Player, source)) gs.mobs.splash(num, x, y, radius, damage); },
    beamMobs: (num, x0, y0, x1, y1, width, damage, source) => { if (source >= 0 && hasComponent(gs.world, Player, source)) gs.mobs.beam(num, x0, y0, x1, y1, width, damage); },
    arcHop: (num, x, y, fx, fy) => gs.broadcastToSystem(num, { type: 'detonation', kind: 'tesla_arc', x: Math.round(x), y: Math.round(y), radius: 30, from: [Math.round(fx), Math.round(fy)] }),
    fireBaseShot: (ownerEid, x, y, angle, damageScale, shape) => {
      const ids: number[] = [];
      gs.weapons.spawn(ownerEid, shape?.kind ?? 'cannon', x, y, angle, damageScale,
        { speedScale: shape?.speedScale ?? 1, sizeScale: shape?.sizeScale ?? 1, turret: shape?.turret ?? false, target: shape?.target, seed: shape?.seed, mods: shape?.mods, dry: shape?.dry, ammoMods: shape?.ammoMods, reach: shape?.reach, grade: shape?.grade, size: shape?.size, model: shape?.model, gun: shape?.gun }, ids);
      return ids;
    },
    shotVs: (proj) => gs.weapons.vsOf(proj),
    hazardScale: (eid) => gs.hazards.shieldScale(eid),
    partLost: (eid, uid) => { const pc = gs.pilots.connOf(eid); if (pc) gs.hangar.gemsLost(pc, uid); },
    spendAmmo: (eid, kind, free) => { const pc = gs.pilots.connOf(eid); return pc ? gs.ammo.spend(pc, kind, free) : { scale: 1, dry: false }; },
    beamAsteroid: (eid, x, y, angle, range, damage, kind) => gs.beamAsteroid(eid, x, y, angle, range, damage, kind),
    notifyDamage: (targetEid, amount, sourceEid, glancing, shown) => {
      gs.combat.note(targetEid, sourceEid, gs.currentTick);
      gs.bossDev?.onDamage(targetEid, amount, sourceEid);
      gs.recovery?.hurt(targetEid, sourceEid);
      gs.bosses?.onDamage(targetEid, amount, sourceEid, !!glancing);
      gs.dens?.onDamage(targetEid, amount, sourceEid);
      gs.range?.onDamage(targetEid, amount);
      // (Summed per target and source until the next snapshot, net/snapshot/Outbox.ts flushDamage)
      // (a shell hit's sum is of its numbers, as a client works them out: tuning.ts damageUnits)
      gs.net.addDamage(InSystem.systemId[targetEid], targetEid, shown ?? amount, sourceEid, !!glancing);
    },
    // (A shell's hit on a ship: confirmed hits tell clients their own way, net/hits/HitLedger.ts)
    notifyProjectileHit: (proj, x, y, hit) => gs.hits.shellHit(proj, x, y, hit),
    onShipDestroyed: (eid, lastHitBy, ship) => {
      gs.enemies.onDestroyed(eid, lastHitBy, ship);
      gs.sieges?.onDestroyed(eid, lastHitBy);
      // A ward (freighter, pylon, bastion, turret) shot down: forget it before its entity number is reused
      if (gs.wards.delete(eid)) { gs.enemies.removeWard(eid); gs.ships.setDamageScale(eid, 1); }
      gs.derelictsMod.onPilotlessShipDestroyed(eid, lastHitBy);
    },
    notifyPartDestroyed: (e) => {
      const r = (v: number) => Math.round(v * 10) / 10;
      gs.broadcastNear(e.systemId, e.x, e.y, {
        type: 'partDestroyed', bodyId: e.bodyId, part: e.part, fn: e.fn, how: e.how,
        x: r(e.x), y: r(e.y), vx: r(e.vx), vy: r(e.vy), size: r(e.size),
      });
    },
    notifyContact: (e) => {
      const r = (v: number) => Math.round(v * 100) / 100;
      const msg = { type: 'contact' as const, x: r(e.x), y: r(e.y), nx: r(e.nx), ny: r(e.ny), speed: r(e.speed) };
      // (Every client finds contact pairs itself and draws those sparks itself: it's handed the rest with its snapshot)
      gs.replication.noteContactFx(e.tick, e.systemId, e.a, e.b, msg);
    },
    payBankRebuild: (eid, part) => gs.pilots.bankRebuild(eid, part),
    payBankRepair: (eid, part, missing) => gs.pilots.bankRepair(eid, part, missing),
    isClaimed: (eid, uid) => gs.pilots.isClaimed(eid, uid),
    canDamage: (a, b) => gs.canDamage(a, b),
    contactHurts: (a, b) => contactHurts(gs.enemies.factionOf(a), gs.enemies.factionOf(b)),
    // --- Support weapons (common/src/ships/features/support/support.ts) ---
    canHeal: (a, b) => gs.canHeal(a, b),
    onHeal: (healer, target, hp) => gs.support.note(healer, target, hp, gs.currentTick),
    // (an AI pilot's guns, while its body flies it on clients: not a boss's, whose brain decides its own)
    gunsRan: (eid, from, bodied, fire, aim, aimDist) => gs.gunNet?.pilotless(eid, from, bodied && gs.enemies.aiBodyOn(eid), fire, aim, aimDist),
    pdThreats: (eid, x, y, range, out) => gs.weapons.threats(InSystem.systemId[eid], x, y, range, (owner) => owner !== eid && gs.canDamage(owner, eid), out),
    intercept: (eid, part, proj, fx, fy) => {
      const x = Position.x[proj], y = Position.y[proj], sys = InSystem.systemId[proj];
      const down = gs.weapons.intercept(proj);
      gs.broadcastNear(sys, x, y, { type: 'intercept', bodyId: eid, part, proj, x: Math.round(x), y: Math.round(y), fx: Math.round(fx), fy: Math.round(fy), down });
      return down;
    },
    // --- end support weapons ---
    invulnerable: (eid) => (gs.admin?.isGod(eid) ?? false) || gs.dockedShips.has(eid) || gs.personCraft.has(eid) || !!gs.bosses?.invulnerable(eid),
    takenScale: (eid) => gs.bosses?.taken(eid) ?? 1,
    stageCover: (eid) => gs.bosses?.stageCover(eid),
    baneFaction: (eid) => { const e = gs.enemies?.info(eid); return e && !e.boss ? e.faction : undefined; },
    sheltered: (eid) => gs.dockedShips.has(eid),
    mineBeam: (eid, x, y, angle, range, damage, material, gas, full) => gs.mineBeam(eid, x, y, angle, range, damage, material, gas, full),
    nearRepairSite: (eid) => {
      const range = gs.ships.tuning.repair?.range ?? 0;
      for (const st of stationQuery(gs.world)) {
        if (InSystem.systemId[st] !== InSystem.systemId[eid]) continue;
        const d = dhypot(Position.x[st] - Position.x[eid], Position.y[st] - Position.y[eid]);
        if (d < Radius.value[st] + range) return true;
      }
      return false;
    },
    gravityAt: (eid) => gs.gameData.getSystemByNum(InSystem.systemId[eid])?.centralBody?.gravity ?? null,
    hazardFlight: (eid, d, x, y) => {
      const sys = gs.gameData.getSystemByNum(InSystem.systemId[eid]);
      return sys?.hazardRatings ? hazardFlight(gs.gameData.hazardRules, sys, d, x, y) : undefined;
    },
    partValue: (part) => gs.econ.items.get(partItemId(part))?.value ?? 20,
    cargoMass: (eid) => gs.pilots.cargoMass(eid),
    featureCargo: (eid) => gs.features?.cargoMass(eid) ?? 0,
    shipRebuilt: (eid) => gs.features?.onShipRebuilt(eid),
    shieldBroken: (eid) => gs.features?.onShieldBreak(eid),
    shipForgotten: (eid) => gs.features?.onLeave(eid),
    jumpFields: (eid) => gs.replicaEnv(InSystem.systemId[eid]),
  };
}
