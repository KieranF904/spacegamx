/**
 * Where to draw the ship docked to yours: on yours, as drawn. Your own ship is drawn at its predicted tick and other
 * ships at the render tick behind it, so a docked partner drawn from its own replica trailed yours and snapped as its
 * corrections came in. Locked, its place is fixed by yours (the clamp offset: followerPose, or leaderPlace when you
 * are the follower), so it is drawn there, at your tick, rigidly attached. Drawing only: the replica's state is untouched.
 */
import { followerPose, leaderPlace, type ClampBody, type ClampLinkRec } from '@space-game/common';

export interface Place { x: number; y: number; angle: number }

const LEAD: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
const OUT: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };

/**
 * Ship `id` drawn on your own drawn ship `own` (into `out`), if `link` (your link at your draw tick) locks it to you.
 * False: not your partner
 */
export function dockedPlace(link: ClampLinkRec | null, self: number, id: number, own: Place, out: Place): boolean {
  if (!link) return false;
  if (link.leader === self && link.follower === id) {
    LEAD.x = own.x; LEAD.y = own.y; LEAD.angle = own.angle;
    followerPose(LEAD, link.offset, OUT);
    out.x = OUT.x; out.y = OUT.y; out.angle = OUT.angle;
    return true;
  }
  if (link.follower === self && link.leader === id) { leaderPlace(own, link.offset, out); return true; }
  return false;
}
