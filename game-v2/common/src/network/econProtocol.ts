/**
 * @contract protocol.econ
 * owns:       the player-economy messages: profile and its deltas, cargo and storage, loot, item actions, quests and
 *             builds; every action is a request the server checks
 * needs:      type-only imports of econ/stacks, econ/quests and other econ shapes
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set (a type with no entry in the
 *             client table fails) — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its
 *             handler (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * Messages for the player economy: profile, cargo and storage, loot, item
 * actions. Every action is a request; the server checks it (docked? room?
 * owned?) and answers with the new state, never trusting the client.
 */

import type { Stack, Bag } from '../econ/stacks.js';
import type { QuestView, QuestLead, BuildView, RewardView } from '../econ/quests.js';
import type { PersonView, TalkView } from '../econ/dialogue.js';
import type { CodexView } from '../econ/codex.js';
import type { Blueprint } from '../ships/types.js';

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** The pilot's progress (on login and whenever it changes) */
import type { Outpost } from '../econ/outpost.js';

export interface ServerProfileMessage {
  type: 'profile';
  guest: boolean;
  credits: number;
  xp: number;
  level: number;
  /** XP at the start of this level and at the next */
  xpLevel: number;
  xpNext: number;
  skillPoints: number;
  skills: Record<string, number>;
  plans: string[];
  recipes: string[];
  licences: string[];
  home: string;
  homeName: string;
  /** Quick bar slots (keys 1-5): item ids or null */
  quickbar: (string | null)[];
  /** Rebuild loan owed (repaid from a share of credits earned) */
  debt?: number;
  /** Ammunition: rounds left in each opened crate (by crate item), and which crate each gun opens first */
  ammo?: Record<string, number>;
  ammoPrefer?: Record<string, string>;
  /** The ship you fly's ammunition loadout: crates to carry (kept aboard by the storage controls, and opened first) */
  loadout?: Record<string, number>;
  /** Your station (econ/outpost.ts), and the server's clock (for its build) */
  outpost?: Outpost | null;
  now?: number;
}

/**
 * The profile again, but only what changed since the last one sent: the numbers that move with play have fields of their
 * own (XP, level, credits...), every other changed field of the profile is in `o` (whole, by name). Absent: unchanged.
 * The client lays it over the profile it holds (applyProfileDelta); the full message goes on join and whenever the
 * server has nothing to diff against.
 */
export interface ServerProfileDeltaMessage {
  type: 'profileDelta';
  xp?: number;
  level?: number;
  credits?: number;
  xpLevel?: number;
  xpNext?: number;
  skillPoints?: number;
  debt?: number;
  o?: Partial<Omit<ServerProfileMessage, 'type'>>;
}

/** The fields that have a slot of their own in a profileDelta (the rest go in `o`) */
export const PROFILE_DELTA_FIELDS = ['xp', 'level', 'credits', 'xpLevel', 'xpNext', 'skillPoints', 'debt'] as const;

/** The profile with a delta laid over it (a new object; `now` and the rest stay as they were) */
export function applyProfileDelta(p: ServerProfileMessage, d: ServerProfileDeltaMessage): ServerProfileMessage {
  const out: ServerProfileMessage = { ...p, ...d.o };
  for (const k of PROFILE_DELTA_FIELDS) if (d[k] !== undefined) out[k] = d[k] as number;
  return out;
}

/** What changed from `prev` to `next` (full messages) as a delta, or null: nothing did. The clock (`now`) is not compared. */
export function diffProfile(prev: ServerProfileMessage, next: ServerProfileMessage): ServerProfileDeltaMessage | null {
  const d: ServerProfileDeltaMessage = { type: 'profileDelta' };
  const own = new Set<string>(PROFILE_DELTA_FIELDS);
  const o: Record<string, unknown> = {};
  let any = false;
  for (const k of Object.keys(next) as (keyof ServerProfileMessage)[]) {
    if (k === 'type' || k === 'now') continue;
    const a = prev[k], b = next[k];
    if (b === undefined || a === b || JSON.stringify(a) === JSON.stringify(b)) continue;
    any = true;
    if (own.has(k) && typeof b === 'number') (d as unknown as Record<string, number>)[k] = b;
    else o[k] = b;
  }
  if (!any) return null;
  if (Object.keys(o).length) d.o = o as ServerProfileDeltaMessage['o'];
  return d;
}

/** Cargo and storage (storage is shared between stations, reachable while docked) */
export interface ServerItemsMessage {
  type: 'items';
  cargo: Stack[];
  storage: Stack[];
  cargoCapacity: number;
  credits: number;
  /** Close enough to a station to reach storage */
  atStation: boolean;
}

/** Items gained (floating pickup text) */
export interface ServerLootMessage2 {
  type: 'gained';
  items: Bag;
  credits?: number;
  xp?: number;
  /** Where to show it (world), or at the player when absent */
  x?: number;
  y?: number;
  /** Why: 'loot', 'mined', 'quest', 'crafted', 'salvage' */
  source?: string;
}

/** A short notice for the player (styled by kind) */
export interface ServerToastMessage {
  type: 'toast';
  text: string;
  kind: 'info' | 'good' | 'warn' | 'bad';
}

/**
 * Your wreck: where it lies and how long it's kept for you (seconds), with a
 * count of what's in it; `gone` once you've recovered it or it's lost.
 */
export interface ServerWreckMessage {
  type: 'wreck';
  system?: string;
  x?: number;
  y?: number;
  /** Seconds it is still yours alone */
  seconds?: number;
  /** Seconds after that anyone may loot it, before it's gone */
  open?: number;
  items?: number;
  gone?: boolean;
}

/** A ship the pilot may respawn in (docs/design/death-rework-2026-11.md): the starter, or one of theirs that qualifies */
export interface BackupOption {
  /** Its hangar slot; -1: the free starter */
  slot: number;
  name: string;
  /** Parts standing of its design */
  built: number;
  parts: number;
}

/** Your ship was lost: the backups you may respawn in (the starter always first). Sent at the death */
export interface ServerBackupsMessage {
  type: 'backups';
  options: BackupOption[];
  /** The design that was lost, now a plan in the hangar (absent: the starter, which leaves none) */
  lost?: string;
}

/** A scanner charge went off: show asteroid contents for a while */
export interface ServerScanPulseMessage {
  type: 'scanPulse';
  seconds: number;
}

/** The rebuild bill for your ship's missing parts, and what you can't yet pay */
export interface ServerRebuildStatusMessage {
  type: 'rebuild';
  /** Missing parts still to rebuild */
  missing: number;
  /** Minerals the next part needs */
  next: Bag;
  /** Minerals short for the next part (the station sells them, for `credits`) */
  short: Bag;
  /** Credits the station charges for the minerals that are short */
  credits: number;
  /** Can't pay even that: the station lends the rest (repaid from what you earn) */
  aid: boolean;
  /** Rebuild loan owed */
  debt: number;
  /** Pilots under this level rebuild for free */
  freeBelowLevel: number;
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** Move items between cargo and storage (at a station) */
export interface ClientItemMoveMessage {
  type: 'itemMove';
  id: string;
  n: number;
  to: 'cargo' | 'storage';
}

/** A quick storage control (at a station): sweep the hold's ore, loot, everything but ammunition/utility/job items, or everything (econ/loadout.ts) */
export interface ClientItemStoreMessage {
  type: 'itemStore';
  what: 'ores' | 'loot' | 'safe' | 'all';
}

/** Top the hold up from storage to the loadout of the ship you fly (at a station) */
export interface ClientRestockLoadoutMessage { type: 'restockLoadout' }

/** A hangar slot's ammunition loadout: crates to carry by item (0: none), and the crate each gun kind opens first */
export interface ClientSlotLoadoutMessage { type: 'slotLoadout'; slot: number; load: Record<string, number>; first?: Record<string, string> }

/** Dump cargo into space as a loot pod */
export interface ClientItemJettisonMessage {
  type: 'itemJettison';
  id: string;
  n: number;
}

/** Use a consumable */
export interface ClientItemUseMessage {
  type: 'itemUse';
  id: string;
}

export type EconServerMessage = ServerProfileMessage | ServerProfileDeltaMessage | ServerItemsMessage | ServerLootMessage2 | ServerToastMessage | ServerWreckMessage | ServerBackupsMessage | ServerRebuildStatusMessage | ServerStationMessage | ServerScanPulseMessage
  | ServerQuestsMessage | ServerQuestBoardMessage | ServerQuestStepMessage | ServerHangarMessage | ServerTalkMessage | ServerPeopleMessage | ServerCodexMessage;
export type EconClientMessage = ClientItemMoveMessage | ClientItemStoreMessage | ClientRestockLoadoutMessage | ClientSlotLoadoutMessage | ClientItemJettisonMessage | ClientItemUseMessage
  | ClientStationOpenMessage | ClientRefineMessage | ClientCraftMessage | ClientGemCutMessage | ClientGemSocketMessage | ClientGemUnsocketMessage | ClientAmmoPreferMessage | ClientOutpostCharterMessage | ClientOutpostUpgradeMessage | ClientDesignSaveMessage | ClientDesignDeleteMessage | ClientDevStationMessage | ClientFabOrderMessage | ClientFabOrderCancelMessage | ClientMarketSellMessage | ClientMarketBuyMessage
  | ClientQuestBoardMessage | ClientQuestAcceptMessage | ClientQuestAbandonMessage | ClientQuestSeenMessage | ClientCodexReadMessage | ClientSkillUpMessage | ClientTalkMessage
  | ClientSlotSaveMessage | ClientSlotFlyMessage | ClientSlotClearMessage | ClientSlotBuildMessage | ClientSlotOrderMessage | ClientJobMessage | ClientMarketSellAllMessage | ClientQuickbarSetMessage
  | ClientScrapItemMessage;

/** Put an item on a quick bar slot (null clears it) */
export interface ClientQuickbarSetMessage { type: 'quickbarSet'; slot: number; id: string | null }

// ---------------------------------------------------------------------------
// Hangar slots
// ---------------------------------------------------------------------------

export interface HangarSlotView {
  blueprint: Blueprint;
  /** Parts not built yet (uids) */
  ghosts: number[];
  /** Built parts that were destroyed (uids): the station rebuilds them */
  wrecked: number[];
  plan?: string;
  /** Lost in battle: being rebuilt from its salvage; can't be flown until whole */
  lost?: boolean;
  /** On order: the hangar refines, fabricates and fits what it needs */
  auto?: boolean;
  /** On order but held */
  paused?: boolean;
  /** Order priority (lower first) */
  rank?: number;
  /** Its ammunition loadout as it stands (crate → count; econ/loadout.ts), and each gun kind's first crate */
  loadout?: Record<string, number>;
  first?: Record<string, string>;
}

/** A refinery or fabricator job as the client sees it */
export interface JobView {
  id: number; recipe: string; station: string; out: Bag; count: number; done: number; unitMs: number; startedAt: number; readyAt: number;
  /** The ship it's for (hangar orders), and its slot */
  for?: string;
  slot?: number;
  paused?: boolean;
  /** Progress of its current run while held (ms) */
  heldMs?: number;
}

/** Your hangar: every slot's design and progress, and your fabricator jobs */
export interface ServerHangarMessage {
  type: 'hangar';
  slots: (HangarSlotView | null)[];
  /** The slot you're flying */
  active: number;
  jobs: JobView[];
  /** Server clock (ms), for job progress */
  now: number;
  /** Saved designs, by slot (null: empty), as many as the pilot has slots */
  designs?: (Blueprint | null)[];
  /** The pilot's build-point budget (unlocks complexity): what a ship of theirs may cost */
  budget?: number;
  /** Fabrication orders: what, how many made, and what each is waiting for */
  orders?: { id: number; item: string; n: number; made: number; waiting: string }[];
  /** Free build is on for you (dev servers, admins: AdminTools `freebuild`): any part places, and saves take nothing */
  freeBuild?: boolean;
}

/** Save a design to a slot (the active slot refits the ship you fly). Parts you don't have become ghosts. */
export interface ClientSlotSaveMessage { type: 'slotSave'; slot: number; blueprint: Blueprint; plan?: string }
/** Fly the ship in this slot (at a station) */
export interface ClientSlotFlyMessage { type: 'slotFly'; slot: number }
/** Scrap a slot you're not flying: its built parts break down to salvage (econ/salvage.ts) */
export interface ClientSlotClearMessage { type: 'slotClear'; slot: number }
/** Scrap modules from storage into salvage (70% of their minerals as ore, their components in full) */
export interface ClientScrapItemMessage { type: 'scrapItem'; id: string; n: number }
/** Put a slot on order: the hangar refines, fabricates and fits what it needs until it's whole */
export interface ClientSlotBuildMessage { type: 'slotBuild'; slot: number; timed?: boolean }
/** A slot's order: hold it, carry on, call it off (its queued jobs refunded), or work it first */
export interface ClientSlotOrderMessage { type: 'slotOrder'; slot: number; action: 'pause' | 'resume' | 'cancel' | 'top' }
/** A refinery or fabricator job: hold it, carry on, call it off (unfinished runs refunded), or move it to the front of its queue */
export interface ClientJobMessage { type: 'job'; id: number; action: 'pause' | 'resume' | 'cancel' | 'top' }
/** Sell every raw mineral in your hold */
export interface ClientMarketSellAllMessage { type: 'marketSellAll' }

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

/** Your quest log (whenever it changes) */
export interface ServerQuestsMessage {
  type: 'quests';
  active: QuestView[];
  /** Story and chain quests finished */
  done: number;
  /** Jobs you've heard about and haven't taken */
  leads: QuestLead[];
  /** Jobs you've finished (not bounties), oldest first */
  finished: { id: string; name: string; chain: string; outro?: string }[];
  /** Jobs not yet found, by system name */
  hidden?: Record<string, number>;
  /** Structures you're building or have built (drawn for you alone) */
  builds?: BuildView[];
  reputation: Record<string, number>;
  reputations: Record<string, { name: string; description: string }>;
}

/** The jobs a station offers you (when you open its contracts) */
export interface ServerQuestBoardMessage {
  type: 'questBoard';
  station: string;
  stationName: string;
  offers: QuestView[];
  /** Next in a chain, once you're experienced enough */
  locked: { name: string; level: number; chain: string }[];
  /** Bounties change in this many ms */
  refreshIn: number;
}

/** A conversation (econ/dialogue.ts): what it shows now, or null when it's over */
export interface ServerTalkMessage {
  type: 'talk';
  view: TalkView | null;
}

/** The people in your system: where they are and whether they want you (on arrival and whenever that changes) */
export interface ServerPeopleMessage {
  type: 'people';
  people: PersonView[];
}

/**
 * Records found (econ/codex.ts): every one on login (`all`), then each new
 * one as it's found. `fresh`: those not opened yet (always the whole list).
 */
export interface ServerCodexMessage {
  type: 'codex';
  entries: CodexView[];
  fresh: string[];
  all?: boolean;
}

/**
 * A quest moved on to its next step. A finished job (not a generated bounty or operation: those stay a toast) comes as the same
 * message with `done` set and no step text: its name, the giver's outro and what it paid, for the reward screen
 */
export interface ServerQuestStepMessage {
  type: 'questStep';
  id: string;
  text: string;
  done?: { name: string; chain: string; outro?: string; giver?: string; rewards: RewardView };
}

/** Ask for the board of the station you're at */
export interface ClientQuestBoardMessage { type: 'questBoard' }
export interface ClientQuestAcceptMessage { type: 'questAccept'; id: string }
export interface ClientQuestAbandonMessage { type: 'questAbandon'; id: string }
/** The quest log was looked at: clear what's marked new */
export interface ClientQuestSeenMessage { type: 'questSeen' }
/** A record was opened in the log: no longer new */
export interface ClientCodexReadMessage { type: 'codexRead'; id: string }
/** Start talking to someone (`person`), answer (`n`, `choice`) or walk away (`n`, `close`) */
export interface ClientTalkMessage { type: 'talk'; person?: string; n?: number; choice?: number; close?: boolean }
/** Spend a skill point */
export interface ClientSkillUpMessage { type: 'skillUp'; skill: string }

// ---------------------------------------------------------------------------
// Station services
// ---------------------------------------------------------------------------

/** The station you're at: what it offers, its market and your fabricator jobs */
export interface ServerStationMessage {
  type: 'station';
  id: string;
  name: string;
  services: string[];
  note?: string;
  /** Items the market sells */
  sells: string[];
  /** Price multipliers for items it pays more (or less) for: standing demand × this market cycle's shift */
  demand: Record<string, number>;
  /** Units of each item sold here lately (prices sag until the market recovers) */
  sat?: Record<string, number>;
  /** This cycle: goods the station wants badly, and goods it's glutted with */
  wanted?: string[];
  glut?: string[];
  /** ms until the market cycle turns */
  cycleEndsIn?: number;
  /** Your fabricator jobs (all stations), wall-clock ms */
  jobs: (JobView & { stationName: string })[];
  /** Server clock now (ms) so the client can show progress */
  now: number;
  queueSlots: number;
}

/** Open the station screen (near a station): the server answers with `station` */
export interface ClientStationOpenMessage { type: 'stationOpen' }
/** Refine ore: `batches` runs of a refining recipe */
export interface ClientRefineMessage { type: 'refine'; recipe: string; batches: number }
/** Fabricate: `n` runs of a recipe (instant ones finish at once, others queue) */
export interface ClientCraftMessage { type: 'craft'; recipe: string; n: number }
/** Cut a gem (econ/gems.ts) at the station's fabricator */
export interface ClientGemCutMessage { type: 'gemCut'; gem: string; level: number }
/** Put a cut gem from storage or cargo into a weapon part's socket (`uid`) on a hangar slot's ship; taking one out destroys it */
export interface ClientGemSocketMessage { type: 'gemSocket'; slot: number; uid: number; gem: string }
export interface ClientGemUnsocketMessage { type: 'gemUnsocket'; slot: number; uid: number; index: number }
/** Save a design into a design slot (any time: it's only a blueprint), or empty one */
export interface ClientDesignSaveMessage { type: 'designSave'; slot: number; blueprint: Blueprint }
export interface ClientDesignDeleteMessage { type: 'designDelete'; slot: number }
/** Your station: charter it at a site (docked at the site's station), or build the next tier of a track */
export interface ClientOutpostCharterMessage { type: 'outpostCharter'; site: string }
export interface ClientOutpostUpgradeMessage { type: 'outpostUpgrade'; track: string }
/** Order `n` of an item: what it's short of is refined as ore comes in, then it's fabricated (or call an order off) */
export interface ClientFabOrderMessage { type: 'fabOrder'; item: string; n: number }
export interface ClientFabOrderCancelMessage { type: 'fabOrderCancel'; id: number }
/** Dev (or an admin): a station of your own at Sol's site, every track at `tier`, and in you go */
export interface ClientDevStationMessage { type: 'devStation'; tier?: number }
/** Open this kind of ammunition crate first, for the gun it's for */
export interface ClientAmmoPreferMessage { type: 'ammoPrefer'; item: string }
/** Sell to this station's market */
export interface ClientMarketSellMessage { type: 'marketSell'; id: string; n: number }
/** Buy from this station's market (into storage) */
export interface ClientMarketBuyMessage { type: 'marketBuy'; id: string; n: number }
