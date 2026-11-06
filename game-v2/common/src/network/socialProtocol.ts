/**
 * Messages for playing together and the wider world: parties, trading between
 * pilots, targets, pilot info cards, fleet operations, faction vendors and
 * market scans.
 */

import type { Bag } from '../econ/stacks.js';
import type { FriendsServerMessage, FriendsClientMessage } from './friendsProtocol.js';

export * from './friendsProtocol.js';

// ---------------------------------------------------------------------------
// Targets and info cards
// ---------------------------------------------------------------------------

/** Select a target (0 clears it): missiles lock on to it */
export interface ClientTargetMessage { type: 'target'; id: number }

/** Ask about another pilot (hovering over their ship) */
export interface ClientPilotInfoMessage { type: 'pilotInfo'; id: number }

export interface ServerPilotInfoMessage {
  type: 'pilotInfo';
  id: number;
  name: string;
  level: number;
  guest: boolean;
  /** The ship they fly, and how many parts it has */
  ship: string;
  parts: number;
  /** Hull left (%) */
  hull: number;
  /** Their best standing, e.g. "Trusted · Miners' Guild" */
  title: string;
  /** Party: its leader's name and size (absent: flying solo) */
  party?: { leader: string; size: number; mine: boolean };
  kills: number;
  /** Ribbons earned, and the rarest one's name */
  ribbons: number;
  topRibbon?: string;
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export interface PartyMemberView {
  name: string;
  eid: number;
  leader: boolean;
  level: number;
  ship: string;
  system: string;
  x: number;
  y: number;
  /** Hull % */
  hull: number;
  alive: boolean;
  /** Their wing bonus (1 = none) */
  wing: number;
}

/** Your party (id 0 and no members: flying solo) */
export interface ServerPartyMessage {
  type: 'party';
  id: number;
  leader: string;
  members: PartyMemberView[];
}

export interface ServerPartyInviteMessage { type: 'partyInvite'; from: string; size: number }

/** Invite by name or by ship (entity id) */
export interface ClientPartyInviteMessage { type: 'partyInvite'; name?: string; id?: number }
export interface ClientPartyRespondMessage { type: 'partyRespond'; accept: boolean }
export interface ClientPartyLeaveMessage { type: 'partyLeave' }
export interface ClientPartyKickMessage { type: 'partyKick'; name: string }
export interface ClientPartyPromoteMessage { type: 'partyPromote'; name: string }

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface TradeOfferView { items: Bag; credits: number }

export interface ServerTradeRequestMessage { type: 'tradeRequest'; from: string; id: number }

/** The trade window (open: false closes it) */
export interface ServerTradeMessage {
  type: 'trade';
  open: boolean;
  with: string;
  withId?: number;
  mine: TradeOfferView;
  theirs: TradeOfferView;
  myAccept: boolean;
  theirAccept: boolean;
}

export interface ClientTradeRequestMessage { type: 'tradeRequest'; id: number }
export interface ClientTradeRespondMessage { type: 'tradeRespond'; accept: boolean }
export interface ClientTradeOfferMessage { type: 'tradeOffer'; items: Bag; credits: number }
export interface ClientTradeAcceptMessage { type: 'tradeAccept' }
export interface ClientTradeCancelMessage { type: 'tradeCancel' }

// ---------------------------------------------------------------------------
// Operations (escorts, defences, uplinks: jobs that happen out in space)
// ---------------------------------------------------------------------------

export interface OpMarkerView {
  x: number;
  y: number;
  /** Zone radius (0 = just a point) */
  r: number;
  label: string;
  /** idle: waiting for someone, active: someone's there, done, danger: under attack */
  state: 'idle' | 'active' | 'done' | 'danger';
}

export interface OpView {
  /** The quest it belongs to */
  quest: string;
  kind: string;
  title: string;
  /** What's happening now ("Wave 2 of 4", "Hold both beacons") */
  text: string;
  /** 0..1 */
  progress: number;
  system: string;
  markers: OpMarkerView[];
  /** The ship you're protecting, with its hull % */
  ward?: { eid: number; name: string; hull: number };
  /** Seconds left (timed jobs) */
  timer?: number;
}

/** Your operations in progress (whenever they change, and a few times a second while running) */
export interface ServerOpsMessage { type: 'ops'; ops: OpView[] }

// ---------------------------------------------------------------------------
// Faction vendors
// ---------------------------------------------------------------------------

export interface VendorItemView {
  item: string;
  /** Price after your standing's discount */
  price: number;
  /** Rank needed to buy it */
  rank: number;
  rankName: string;
  locked: boolean;
}

export interface VendorView {
  faction: string;
  name: string;
  description: string;
  standing: number;
  rank: number;
  rankName: string;
  /** Standing for the next rank (absent at the top) */
  next?: number;
  nextName?: string;
  discount: number;
  stock: VendorItemView[];
}

/** The faction quartermasters at this station */
export interface ServerVendorsMessage { type: 'vendors'; station: string; vendors: VendorView[] }

export interface ClientVendorOpenMessage { type: 'vendorOpen' }
export interface ClientVendorBuyMessage { type: 'vendorBuy'; faction: string; item: string; n: number }

// ---------------------------------------------------------------------------
// Market scans (trade routes)
// ---------------------------------------------------------------------------

/** What other stations pay for things (the best few each) */
export interface ServerMarketScanMessage {
  type: 'marketScan';
  /** item → best offers elsewhere, highest first */
  best: Record<string, { station: string; name: string; system: string; price: number }[]>;
}

export interface ClientMarketScanMessage { type: 'marketScan'; items: string[] }

// ---------------------------------------------------------------------------
// Pings: mark a place (or a hostile) for your party
// ---------------------------------------------------------------------------

export type PingKind = 'here' | 'attack' | 'danger' | 'loot';

export interface ClientMapPingMessage { type: 'mapPing'; x: number; y: number; kind: PingKind; target?: number }

export interface ServerMapPingMessage { type: 'mapPing'; from: string; system: string; x: number; y: number; kind: PingKind; target?: number }

// ---------------------------------------------------------------------------
// Ribbons, rankings, galaxy news, shared designs
// ---------------------------------------------------------------------------

/** A ribbon was just earned (the popup) */
export interface ServerRibbonMessage { type: 'ribbon'; id: string; credits: number; xp: number }
/** Every ribbon's progress (the log's Ribbons tab) */
export interface ServerRibbonsMessage { type: 'ribbons'; progress: { id: string; value: number; earned: boolean }[] }
export interface ClientRibbonsMessage { type: 'ribbons' }

export interface RankRow { name: string; value: number }
export interface ServerRankingsMessage {
  type: 'rankings';
  /** ms until the weekly boards reset */
  weekEndsIn: number;
  boards: { key: string; label: string; weekly: RankRow[]; allTime: RankRow[]; you?: { weekly: number; allTime: number; weeklyRank: number; allTimeRank: number } }[];
}
export interface ClientRankingsMessage { type: 'rankings' }

/** Something worth everyone hearing about */
export interface ServerNewsMessage { type: 'news'; text: string; kind: 'boss' | 'fleet' | 'level' | 'ribbon' | 'hunt' | 'info'; at: number; old?: boolean }

/** Send a ship design to your party */
export interface ClientShareDesignMessage { type: 'shareDesign'; blueprint: import('../ships/types.js').Blueprint }
export interface ServerSharedDesignMessage { type: 'sharedDesign'; from: string; blueprint: import('../ships/types.js').Blueprint }

export type SocialServerMessage = ServerRibbonMessage | ServerRibbonsMessage | ServerRankingsMessage | ServerNewsMessage | ServerSharedDesignMessage | ServerMapPingMessage | ServerPilotInfoMessage | ServerPartyMessage | ServerPartyInviteMessage
  | ServerTradeRequestMessage | ServerTradeMessage | ServerOpsMessage | ServerVendorsMessage | ServerMarketScanMessage | FriendsServerMessage;

export type SocialClientMessage = ClientRibbonsMessage | ClientRankingsMessage | ClientShareDesignMessage | ClientMapPingMessage | ClientTargetMessage | ClientPilotInfoMessage
  | ClientPartyInviteMessage | ClientPartyRespondMessage | ClientPartyLeaveMessage | ClientPartyKickMessage | ClientPartyPromoteMessage
  | ClientTradeRequestMessage | ClientTradeRespondMessage | ClientTradeOfferMessage | ClientTradeAcceptMessage | ClientTradeCancelMessage
  | ClientVendorOpenMessage | ClientVendorBuyMessage | ClientMarketScanMessage | FriendsClientMessage;
