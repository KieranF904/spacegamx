/**
 * @contract client.state.guide-marks
 * owns:       the world spots the lesson wants shown on the system map and the minimap (the training yard's "Jump here" ring): the
 *             lesson UI writes the list each frame, the map layer and the radar read it
 * needs:      nothing
 * invariants: empty unless a lesson step is pointing at a spot — none pinned
 * extend:     a new kind of spot is a field on GuideMark and a case in the map layer (ui/systemMap/layersGuides.ts)
 */

/** A spot in the current system, with the size of the area that counts and the words to show on it */
export interface GuideMark { x: number; y: number; radius: number; label: string }

let marks: readonly GuideMark[] = [];

/** The lesson UI says which spots are on now (a new list each time; empty: none) */
export function setGuideMarks(next: readonly GuideMark[]): void { marks = next; }

/** The spots on now */
export function guideMarks(): readonly GuideMark[] { return marks; }
