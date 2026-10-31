/**
 * Support credit (docs/design/build-archetypes.md §3, "Party rewards": support counts towards the reward share, else
 * Wardens won't exist). Who has been mending whom: a Repair Beam's mending is noted here (ShipBridge.repairBeam ->
 * GameServer onHeal), and a pilot who mended another within the window is that pilot's supporter:
 *   - an enemy the supported pilot kills pays its supporters nearby as it pays the killer's party (Enemies.onDestroyed)
 *   - a boss counts the supporters of everyone it credits among its winners (Bosses.onDestroyed)
 * The hook for anything else that should pay support (shields, tows, painting, later): `supporters(target, now)`.
 */

/** How long mending counts (ticks): 20 seconds */
export const SUPPORT_WINDOW_TICKS = 60 * 20;
/** Mending below this much HP in the window doesn't count (a beam brushed across someone) */
export const SUPPORT_MIN_HP = 15;

interface Rec { hp: number; first: number; last: number }

export class Support {
  /** target -> healer -> what they've mended (since `first`, the last at `last`) */
  private by = new Map<number, Map<number, Rec>>();
  /** All HP each healer has mended (for stats) */
  private totals = new Map<number, number>();

  /** `healer` mended `hp` of `target` at tick `now` */
  note(healer: number, target: number, hp: number, now: number): void {
    if (healer === target || !(hp > 0)) return;
    let m = this.by.get(target);
    if (!m) this.by.set(target, (m = new Map()));
    const r = m.get(healer);
    // (A gap longer than the window starts the count again)
    if (!r || now - r.last > SUPPORT_WINDOW_TICKS) m.set(healer, { hp, first: now, last: now });
    else { r.hp += hp; r.last = now; }
    this.totals.set(healer, (this.totals.get(healer) ?? 0) + hp);
  }

  /** Who has supported `target` within the window up to `now` (enough to count), most HP first */
  supporters(target: number, now: number, window = SUPPORT_WINDOW_TICKS): number[] {
    const m = this.by.get(target);
    if (!m) return [];
    const out: { eid: number; hp: number }[] = [];
    for (const [eid, r] of m) {
      if (now - r.last > window) { m.delete(eid); continue; }
      if (r.hp >= SUPPORT_MIN_HP) out.push({ eid, hp: r.hp });
    }
    if (!m.size) this.by.delete(target);
    return out.sort((a, b) => b.hp - a.hp || a.eid - b.eid).map((o) => o.eid);
  }

  /** All the HP a healer has mended */
  mended(healer: number): number {
    return this.totals.get(healer) ?? 0;
  }

  /** A ship gone (died, left): it supports and is supported no more */
  forget(eid: number): void {
    this.by.delete(eid);
    for (const m of this.by.values()) m.delete(eid);
    this.totals.delete(eid);
  }
}
