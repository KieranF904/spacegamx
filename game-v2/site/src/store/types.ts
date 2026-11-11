/**
 * The website's own data: posts, comments, suggestions (and their votes), the
 * shoutbox, and admin API tokens. Accounts are NOT here: the lobby keeps them
 * (server-browser/src/accounts), and rows here only point at an account by its
 * lobby id, with the name it had when it wrote (kept so a page needs no lookup).
 *
 * Implementations:
 *   - JsonSiteStore      (default: data/site/site.json; local dev)
 *   - PostgresSiteStore  (SITE_STORE_BACKEND=postgres + DATABASE_URL; tables in ../../schema.sql)
 *
 * Every method is async, because the Postgres one is.
 */

import type { PlanPart, ShipStats } from '../catalog/types.js';

export type PostStatus = 'draft' | 'published';

export interface Post {
  id: number;
  slug: string;
  title: string;
  /** One line for lists and feeds ('' : the first paragraph is used) */
  summary: string;
  /** Markdown */
  body: string;
  tags: string[];
  /** Image URL for lists and the page header (null: the first image in the body, if any) */
  cover: string | null;
  /** Also shown in the launcher's development news (text only: the feed carries no images) */
  launcher?: boolean;
  status: PostStatus;
  authorId: number | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  /** When it first went out (kept when unpublished and published again) */
  publishedAt: string | null;
}

export type PostInput = Pick<Post, 'slug' | 'title' | 'summary' | 'body' | 'tags' | 'cover' | 'launcher' | 'status'> & { authorId: number | null; authorName: string };
export type PostPatch = Partial<Pick<Post, 'slug' | 'title' | 'summary' | 'body' | 'tags' | 'cover' | 'launcher' | 'status'>>;

export interface Comment {
  id: number;
  postId: number;
  authorId: number | null;
  authorName: string;
  /** Markdown (the comment subset) */
  body: string;
  createdAt: string;
  /** Hidden by a moderator (kept, not shown) */
  hidden: boolean;
  /** The image of the post this is about (its src as rendered in the post), or null for the post as a whole */
  image: string | null;
}

export const SUGGESTION_STATUSES = ['open', 'planned', 'in_progress', 'done', 'declined'] as const;
export type SuggestionStatus = typeof SUGGESTION_STATUSES[number];

export interface Suggestion {
  id: number;
  title: string;
  body: string;
  authorId: number | null;
  authorName: string;
  createdAt: string;
  status: SuggestionStatus;
  /** The admin's answer (Markdown, comment subset) */
  reply: string | null;
  replyBy: string | null;
  repliedAt: string | null;
  hidden: boolean;
  votes: number;
}

export interface Shout {
  id: number;
  authorId: number;
  authorName: string;
  isAdmin: boolean;
  text: string;
  createdAt: string;
}

export interface ApiToken {
  id: number;
  name: string;
  /** sha256 of the token (the token itself is shown once, never kept) */
  hash: string;
  /** Its first characters, to tell tokens apart in the list */
  prefix: string;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A ship a pilot has shared (the gallery): the plan to draw, and totals the game worked out */
export interface SharedShip {
  id: number;
  ownerId: number;
  ownerName: string;
  name: string;
  plan: PlanPart[];
  stats: ShipStats;
  power: 'ports' | 'pool';
  /** Hidden by an admin (kept, not shown) */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}
export type ShipInput = Pick<SharedShip, 'ownerId' | 'ownerName' | 'name' | 'plan' | 'stats' | 'power'>;

export interface SiteStore {
  // Posts
  listPosts(opts: { status?: PostStatus | 'all'; tag?: string; limit?: number; offset?: number }): Promise<{ posts: Post[]; total: number }>;
  getPost(id: number): Promise<Post | null>;
  getPostBySlug(slug: string): Promise<Post | null>;
  /** Fails (null) if the slug is taken */
  createPost(input: PostInput): Promise<Post | null>;
  /** null: no such post, or the new slug is taken */
  updatePost(id: number, patch: PostPatch): Promise<Post | null>;
  deletePost(id: number): Promise<void>;
  allTags(): Promise<{ tag: string; count: number }[]>;

  // Comments
  listComments(postId: number, includeHidden?: boolean): Promise<Comment[]>;
  commentCounts(postIds: number[]): Promise<Map<number, number>>;
  recentComments(limit: number): Promise<Comment[]>;
  addComment(c: Omit<Comment, 'id' | 'createdAt' | 'hidden' | 'image'> & { image?: string | null }): Promise<Comment>;
  setCommentHidden(id: number, hidden: boolean): Promise<void>;
  deleteComment(id: number): Promise<void>;

  // Suggestions
  listSuggestions(opts: { sort: 'top' | 'new'; status?: SuggestionStatus; includeHidden?: boolean; limit?: number }): Promise<Suggestion[]>;
  getSuggestion(id: number): Promise<Suggestion | null>;
  addSuggestion(s: Pick<Suggestion, 'title' | 'body' | 'authorId' | 'authorName'>): Promise<Suggestion>;
  /** One vote per account: on or off; the new count (null: no such suggestion) */
  setVote(suggestionId: number, userId: number, on: boolean): Promise<number | null>;
  /** Which of these the account has voted for */
  votedBy(userId: number, ids: number[]): Promise<Set<number>>;
  setSuggestionStatus(id: number, status: SuggestionStatus, reply: string | null, by: string): Promise<void>;
  setSuggestionHidden(id: number, hidden: boolean): Promise<void>;
  deleteSuggestion(id: number): Promise<void>;
  suggestionCounts(): Promise<Record<SuggestionStatus, number>>;

  // Shoutbox (only the latest `keep` are kept)
  recentShouts(limit: number): Promise<Shout[]>;
  addShout(s: Omit<Shout, 'id' | 'createdAt'>, keep: number): Promise<Shout>;
  deleteShout(id: number): Promise<boolean>;

  // Admin API tokens
  createToken(t: Omit<ApiToken, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<ApiToken>;
  listTokens(): Promise<ApiToken[]>;
  findToken(hash: string): Promise<ApiToken | null>;
  touchToken(id: number): Promise<void>;
  revokeToken(id: number): Promise<void>;

  // Shared ships (the gallery): one per name per pilot, up to `cap` per pilot
  /** Adds the ship, or replaces the pilot's ship of that name; 'cap' if the pilot is at the limit with a new name */
  saveShip(s: ShipInput, cap: number): Promise<{ ship: SharedShip; created: boolean } | 'cap'>;
  listShips(opts: { ownerId?: number; includeHidden?: boolean; limit?: number }): Promise<SharedShip[]>;
  getShip(id: number): Promise<SharedShip | null>;
  deleteShip(id: number): Promise<boolean>;
  setShipHidden(id: number, hidden: boolean): Promise<void>;

  /** An account was deleted: its shouts, votes and shared ships go, its comments and suggestions stay, unsigned */
  forgetUser(userId: number): Promise<void>;

  close(): Promise<void>;
}
