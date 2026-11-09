/**
 * @contract client.render.camera-step
 * owns:       Renderer's per-frame camera: pan limits, roll onto the helm heading, follow smoothing, screen shake
 * needs:      Renderer (its fields, as the first argument), cameraView, PanControl
 * invariants: behaviour is the one it had inside Renderer — none pinned
 * extend:     camera maths lives in cameraView.ts; this is the per-frame application of it
 */

import { cameraView, helmFollow, MAX_VIEW_SPIN, NORTH_RETURN_RATE, screenToWorldDir, smoothAngle, worldToScreenDir } from '../cameraView';
import type { Renderer } from '../Renderer';

/** A panned view (middle mouse) keeps your ship at least this fraction of the screen in from every edge */
const PAN_MARGIN = 0.1;

export function updateCamera(rend: Renderer, dt: number): void {
  const playerPos = rend.cameraTarget?.() ?? rend.state.getPlayerPosition();
  // Your own ship (not the admin free camera or someone watched): the view may sit off it, as far as keeps the ship a margin inside every edge
  const own = !rend.cameraTarget;
  const maxX = Math.max(0, (0.5 - PAN_MARGIN) * rend.app.screen.width / rend.cameraZoom);
  const maxY = Math.max(0, (0.5 - PAN_MARGIN) * rend.app.screen.height / rend.cameraZoom);
  rend.panCtl.pan.x = Math.max(-maxX, Math.min(maxX, rend.panCtl.pan.x));
  rend.panCtl.pan.y = Math.max(-maxY, Math.min(maxY, rend.panCtl.pan.y));
  // The roll: onto the heading in helm, back to north-up out of it (gentle, and the same at any frame rate)
  // (Not on a free camera or someone else's ship)
  const heading = own ? rend.cameraHeading : null;
  rend.helmTime = heading === null ? 0 : rend.helmTime + dt;
  const roll = heading === null ? { rate: NORTH_RETURN_RATE, maxSpin: MAX_VIEW_SPIN } : helmFollow(rend.helmTime);
  if (rend.cameraSnap) { rend.panCtl.pan.x = rend.panCtl.pan.y = 0; rend.cameraAngle = heading ?? 0; }
  rend.cameraAngle = smoothAngle(rend.cameraAngle, heading ?? 0, roll.rate, Math.min(0.1, dt), roll.maxSpin);
  if (heading === null && Math.abs(rend.cameraAngle) < 1e-4) rend.cameraAngle = 0;
  cameraView.angle = rend.cameraAngle;
  const pw = own ? screenToWorldDir(rend.panCtl.pan.x, rend.panCtl.pan.y, rend.cameraAngle) : { x: 0, y: 0 };
  const tx = playerPos.x + pw.x, ty = playerPos.y + pw.y;

  // Smooth camera follow (tighter mid-jump, or the ship would leave the screen; a slow drift while dead).
  // cameraFollow is the catch-up per 60 Hz frame, so it's the same at any frame rate.
  const follow = rend.death.active ? rend.cameraFollow * 0.12 : rend.cameraFollow;
  const lerpFactor = rend.cameraSnap ? 1 : 1 - Math.pow(1 - Math.min(1, follow), Math.min(0.1, dt) * 60);
  rend.cameraSnap = false;
  rend.cameraX += (tx - rend.cameraX) * lerpFactor;
  rend.cameraY += (ty - rend.cameraY) * lerpFactor;
  if (own) {
    // However fast the ship goes (a jump's burn), it never slips past the margin (along the screen's axes)
    const d = worldToScreenDir(rend.cameraX - playerPos.x, rend.cameraY - playerPos.y, rend.cameraAngle);
    const c = screenToWorldDir(Math.max(-maxX, Math.min(maxX, d.x)), Math.max(-maxY, Math.min(maxY, d.y)), rend.cameraAngle);
    rend.cameraX = playerPos.x + c.x;
    rend.cameraY = playerPos.y + c.y;
  }
  const off = own && Math.hypot(rend.panCtl.pan.x, rend.panCtl.pan.y) * rend.cameraZoom > 24;
  rend.panCtl.showRecenter(off);

  // Apply camera transform to world container with screen shake: the camera's point sits at the
  // screen's centre (plus the shake), and the shake's roll turns about it
  const shake = rend.state.screenShake;
  rend.worldContainer.pivot.set(rend.cameraX, rend.cameraY);
  rend.worldContainer.x = rend.app.screen.width / 2 + (shake.offsetX || 0) * rend.shakeScale;
  rend.worldContainer.y = rend.app.screen.height / 2 + (shake.offsetY || 0) * rend.shakeScale;
  rend.worldContainer.rotation = (shake.rotation || 0) * rend.shakeScale - rend.cameraAngle;
  rend.worldContainer.scale.set(rend.cameraZoom);
}
