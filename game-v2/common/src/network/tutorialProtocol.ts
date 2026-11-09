/**
 * @contract protocol.tutorial
 * owns:       the training yard's messages: leave (skip or graduate), report (an acknowledgement or an opened panel), and
 *             the pilot's own tutorial state
 * needs:      type-only import of tutorial/types (TutorialPanel)
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its handler
 *             (server/src/net/handlers/modules.ts) or its entry in client/src/app/serverMessages.ts, and the golden pins
 */

import type { TutorialPanel } from '../tutorial/types.js';

// ============================================ client -> server

/** Leave training now (skip at any step, or the graduate step's button): the server grants the starter pack and moves the pilot to Sol. The client confirms with the pilot first */
export interface ClientTutorialLeaveMessage { type: 'tutorialLeave' }

/**
 * Something only the client can see happened in the lesson: the Continue button (`ack`, with the step it was shown on) or a
 * panel it opened. The server checks the panel is a known one and the step is the pilot's current one
 */
export interface ClientTutorialReportMessage { type: 'tutorialReport'; kind: 'ack' | 'panel'; step?: string; panel?: TutorialPanel }

export type TutorialClientMessage = ClientTutorialLeaveMessage | ClientTutorialReportMessage;

// ============================================ server -> client

/**
 * This pilot's tutorial state: sent on join and whenever it changes, to that pilot alone. `step` is '' once `left`.
 * `broken`: the training objects this pilot has broken (drawn ghosted, with those of the steps in `done`).
 * `passed`: the rings of the current step this pilot has flown through this visit (the card's counter, the lit rings). The steps and
 * the objects themselves are in data/tutorial.json, which the client bundles
 */
export interface ServerTutorialStateMessage { type: 'tutorialState'; step: string; done: string[]; left: boolean; broken: string[]; passed: string[] }

export type TutorialServerMessage = ServerTutorialStateMessage;
