/** The Point Defence Turret's tick (a weapon role of the support feature: ./index.ts). Moved from bridge/weapons.ts. */
import { pointDefenceOf, stepPointDefenceAim, wrapPi, isOpen, shipPointToWorld, type ShipState, type WeaponInfo, type WeaponTuning } from '@space-game/common';
import type { WeaponBridge } from '../../bridge/core.js';

/**
 * Point-defence turrets: each turns to the nearest shot in reach it can bring to bear on (staying on the one it's on
 * while it can), and fires when it's on it and loaded, each hit instant. Quiet mid-jump, EMP'd or inside a station,
 * when they turn back to rest.
 */
export function pointDefence(b: WeaponBridge, eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, def: (w: WeaponInfo) => WeaponTuning): void {
  let listed = false, on = b.pdOn.get(eid);
  const quiet = b.isJumping(ship) || b.isEmped(eid) || !!b.host.sheltered?.(eid) || !b.host.pdThreats || !b.host.intercept;
  for (const w of ship.derived.weapons) {
    const d = def(w);
    if (!d.pointDefence || !w.window) continue;
    const pd = pointDefenceOf(d);
    if (!listed && !quiet) {
      b.host.pdThreats!(eid, pose.x, pose.y, pd.range + ship.derived.radius, b.pdList);
      listed = true;
    }
    const win = w.window;
    const [px, py] = shipPointToWorld(ship, pose, win.pivot, b.tuning.cellSize);
    const reach = pd.range;
    // (Local angle to a point, and whether it can fire that way: in its arc, and not through its own hull)
    const local = (tx: number, ty: number) => Math.atan2(ty - py, tx - px) - (pose.angle + Math.PI / 2);
    const bears = (a: number) => { const off = wrapPi(a - win.center); return (win.half >= Math.PI - 1e-9 || Math.abs(off) <= win.half) && isOpen(win, off); };
    let pick: { id: number; x: number; y: number } | null = null;
    if (!quiet && b.pdList.length) {
      const was = on?.get(w.part);
      for (const t of b.pdList) {
        if (Math.hypot(t.x - px, t.y - py) > reach || !bears(local(t.x, t.y))) continue;
        if (t.id === was) { pick = t; break; }
        if (!pick) pick = t;
      }
    }
    if (pick) { if (!on) b.pdOn.set(eid, (on = new Map())); on.set(w.part, pick.id); } else on?.delete(w.part);
    const res = stepPointDefenceAim(win, ship.aim[w.part], pick ? local(pick.x, pick.y) : undefined, b.tuning, pd.slew);
    ship.aim[w.part] = res.offset;
    if (!pick || !res.canFire || ship.cooldown[w.part] > 0) continue;
    // From its barrel's tip, instantly: one of the shot's hits
    const a = win.center + res.offset;
    const [mx, my] = shipPointToWorld(ship, pose, [win.pivot[0] + Math.cos(a) * win.barrel, win.pivot[1] + Math.sin(a) * win.barrel], b.tuning.cellSize);
    const cd = ship.cooldown[w.part];
    ship.cooldown[w.part] = (cd > -1 ? cd : 0) + w.interval;
    const target = pick.id;
    if (b.host.intercept!(eid, w.part, target, mx, my)) {
      const i = b.pdList.findIndex((t) => t.id === target);
      if (i >= 0) b.pdList.splice(i, 1);
      on?.delete(w.part);
    }
    b.lastFired.set(eid, b.host.getTick());
  }
  if (on && !on.size) b.pdOn.delete(eid);
}
