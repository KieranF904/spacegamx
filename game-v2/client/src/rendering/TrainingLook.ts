/**
 * @contract client.rendering.training-look
 * owns:       how a training-yard body is drawn in place of its batch rock: a practice drone (a small hexagonal craft),
 *             or a ghost (a faded grey outline of a drone or a rock whose lesson this pilot has done)
 * needs:      pixi Graphics, common getAsteroidPolygon
 * invariants: which look a body gets is decided by lookFor — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new look is a member of TrainingLook (tutorialModel.ts) and a case here; Renderer.setTrainingLook applies it
 */

import { Container, Graphics } from 'pixi.js';
import { getAsteroidPolygon } from '@space-game/common';
import type { TrainingLook } from '../ui/tutorial/tutorialModel';

export const TRAINING_LABEL = 'trainingLook';

const GHOST = 0x9aa5b8;

/** The graphics for one look, centred on the body, `size` its radius */
export function drawTrainingLook(look: TrainingLook, id: number, size: number): Container {
  const g = new Graphics();
  g.label = TRAINING_LABEL;
  if (look === 'rockGhost') {
    const poly = getAsteroidPolygon(id, 0, 0, size).flatMap((v) => [v.x, v.y]);
    g.poly(poly).fill({ color: GHOST, alpha: 0.14 }).stroke({ width: Math.max(1.5, size * 0.03), color: GHOST, alpha: 0.5 });
    return g;
  }
  const ghost = look === 'droneGhost';
  const hex: number[] = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; hex.push(Math.cos(a) * size, Math.sin(a) * size); }
  if (ghost) {
    g.poly(hex).fill({ color: GHOST, alpha: 0.12 }).stroke({ width: 2, color: GHOST, alpha: 0.5 });
    g.circle(0, 0, size * 0.35).stroke({ width: 1.5, color: GHOST, alpha: 0.4 });
    return g;
  }
  g.poly(hex).fill({ color: 0x2a3446 }).stroke({ width: 3, color: 0xfbbf24, alpha: 0.95 });
  g.circle(0, 0, size * 0.62).stroke({ width: 2, color: 0x7dd3fc, alpha: 0.7 });
  g.circle(0, 0, size * 0.3).fill({ color: 0xfbbf24 });
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + Math.PI / 6; g.circle(Math.cos(a) * size * 0.8, Math.sin(a) * size * 0.8, size * 0.09).fill({ color: 0x7dd3fc }); }
  return g;
}
