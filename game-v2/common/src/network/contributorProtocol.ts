/**
 * Contributor notes (world/contributorNotes.ts): contributors and admins pin
 * notes and shapes to the map. Every op is checked on the server
 * (server/src/game/ContributorNotes.ts): rank, ownership, limits, rate.
 */

import type { ContributorNote, NoteDraft, NoteStatus } from '../world/contributorNotes.js';

export type ClientContribMessage =
  /** The overlay on (notes for `system` come back, and changes to any note while it stays on) or off */
  | { type: 'contrib'; op: 'overlay'; on: boolean; system?: string }
  /** The notes in a system ('*': every system) */
  | { type: 'contrib'; op: 'list'; system: string }
  | { type: 'contrib'; op: 'create'; note: NoteDraft }
  /** Your own notes (admins: anyone's) */
  | { type: 'contrib'; op: 'update'; id: string; note: NoteDraft }
  | { type: 'contrib'; op: 'delete'; id: string }
  /** Clearing up: several at once, as one change (those you may delete; the rest are left) */
  | { type: 'contrib'; op: 'deleteMany'; ids: string[] }
  /** Open, done or won't do (the author or an admin) */
  | { type: 'contrib'; op: 'status'; id: string; status: NoteStatus; resolution?: string };

/** You were made a contributor (or aren't one any more) while signed in */
export interface ServerContribRankMessage { type: 'contribRank'; on: boolean }
/** The notes in a system (answering overlay or list) */
export interface ServerContribNotesMessage { type: 'contribNotes'; system: string; notes: ContributorNote[] }
/** A note was made or changed */
export interface ServerContribNoteMessage { type: 'contribNote'; note: ContributorNote }
export interface ServerContribNoteGoneMessage { type: 'contribNoteGone'; id: string }
/** How your last op went (`id`: the note it made or changed) */
export interface ServerContribResultMessage { type: 'contribResult'; ok: boolean; text: string; id?: string }

export type ContribServerMessage = ServerContribRankMessage | ServerContribNotesMessage | ServerContribNoteMessage | ServerContribNoteGoneMessage | ServerContribResultMessage;
