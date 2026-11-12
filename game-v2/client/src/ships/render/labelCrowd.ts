/**
 * @contract client.ship.render.label-crowd
 * owns:       which ships' name labels show when ships bunch up: a label another's would lie over is put away (its
 *             health bar stays, small), but for the ship nearest the cursor and the ones always named (a boss, an elite)
 * needs:      nothing (pure: the labels' places in the world and the tag scale they are drawn at)
 * invariants: a ship on its own keeps its name; in a bunch only the ship under the cursor and the pinned ones are named;
 *             what shows eases in and out, never blinks — client/src/ships/render/labelCrowd.test.ts
 * extend:     a new reason to always name a ship is `pinned` at its add()
 *
 * Worked a frame behind: the labels placed this frame decide what shows the next (one pass over the ships, no second).
 */

/** A label's footprint at tag scale 1, in world units: half its width, and its height with the bar under it */
export const LABEL_HALF_W = 75, LABEL_H = 44;
/** How near the cursor (at tag scale 1, world units) a bunched ship is named */
export const FOCUS_REACH = 110;
/** Seconds a name takes to come or go */
const EASE = 0.15;

interface Spot { eid: number; x: number; y: number; pinned: boolean }

export class LabelCrowd {
  private spots: Spot[] = [];
  private used = 0;
  /** How much of each ship's name shows (0..1), eased */
  private shown = new Map<number, number>();
  private want = new Map<number, number>();

  /** A frame's labels start */
  begin(): void {
    this.used = 0;
  }

  /** A label placed this frame (x, y: the ship, in the world); returns how much of its name shows (0..1) */
  add(eid: number, x: number, y: number, pinned: boolean): number {
    const s = this.spots[this.used] ?? (this.spots[this.used] = { eid: 0, x: 0, y: 0, pinned: false });
    this.used++;
    s.eid = eid; s.x = x; s.y = y; s.pinned = pinned;
    return this.shown.get(eid) ?? 1;
  }

  /**
   * The frame's labels are all placed: work out what shows next frame. `k`: the tag scale they are drawn at; `ang`: the
   * camera's roll (labels are upright on screen); `focus`: the cursor in the world (null: none)
   */
  end(dt: number, k: number, ang: number, focus: { x: number; y: number } | null): void {
    const n = this.used, sp = this.spots, c = Math.cos(ang), sn = Math.sin(ang);
    const hw = LABEL_HALF_W * 2 * k, hh = LABEL_H * k;
    // (the ship nearest the cursor, if near enough)
    let near = -1, best = (FOCUS_REACH * k) ** 2;
    if (focus) for (let i = 0; i < n; i++) {
      const d = (sp[i].x - focus.x) ** 2 + (sp[i].y - focus.y) ** 2;
      if (d < best) { best = d; near = sp[i].eid; }
    }
    this.want.clear();
    for (let i = 0; i < n; i++) {
      const a = sp[i];
      let crowded = false;
      if (!a.pinned && a.eid !== near) for (let j = 0; j < n && !crowded; j++) {
        if (j === i) continue;
        const dx = sp[j].x - a.x, dy = sp[j].y - a.y;
        // (across and down the screen)
        crowded = Math.abs(dx * c + dy * sn) < hw && Math.abs(dy * c - dx * sn) < hh;
      }
      this.want.set(a.eid, crowded ? 0 : 1);
    }
    const step = EASE > 0 ? dt / EASE : 1;
    for (const eid of this.shown.keys()) if (!this.want.has(eid)) this.shown.delete(eid);
    for (const [eid, w] of this.want) {
      const v = this.shown.get(eid);
      // (a ship just come into view starts as it should be: no name fading out of a bunch it arrived in)
      this.shown.set(eid, v === undefined ? w : w > v ? Math.min(w, v + step) : Math.max(w, v - step));
    }
  }
}
