/**
 * @contract client.state.training-bodies
 * owns:       which asteroid entities are the training yard's practice drones, and whether each is inert for this pilot (a
 *             later step's, hidden, or one they are done with, ghosted): the lesson UI writes it, hit drawing and hover read it
 * needs:      nothing (a map of entity id -> look)
 * invariants: an inert body is never struck in this pilot's view (shells and beams pass, no spark, no hover card); a live
 *             drone shows plain sparks, never a mining strike — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new look is a member of TrainingLook (client/src/ui/tutorial/tutorialModel.ts)
 */

/** How this pilot sees a training body (the same values as tutorialModel's TrainingLook) */
type Look = 'drone' | 'droneGhost' | 'hidden';

const looks = new Map<number, Look>();

/** The lesson UI (TutorialUI) says how a body is seen now (null: not a training body any more) */
export function setTrainingBody(id: number, look: Look | null): void {
  if (look) looks.set(id, look);
  else looks.delete(id);
}

/** Forget them all (a new connection) */
export function clearTrainingBodies(): void { looks.clear(); }

/** Is this entity a training drone (any look)? It yields no ore and has no rock to describe */
export function isTrainingBody(id: number): boolean { return looks.size > 0 && looks.has(id); }

/**
 * Is this training body inert for this pilot: a later step's (not drawn) or one they are done with (ghosted)? Their
 * shots and beams pass it in their own view (the server counts nothing for them on it either)
 */
export function inertBody(id: number): boolean {
  if (!looks.size) return false;
  const l = looks.get(id);
  return l === 'hidden' || l === 'droneGhost';
}
