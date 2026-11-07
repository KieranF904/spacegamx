/**
 * Docking Clamps on this client (common ships/features/clamp/clamp.ts; docs/design/groups-mines-docking.md 3): the
 * links it was told (clampLink, clampBreak: the replica set steps the pairs from them, network/replication.ts), the
 * other pilot's waiting press (clampAsk), its own press waiting for theirs, and the prompt: worked out here every frame
 * from the drawn ships (clampLinedUp at CLAMP.promptSlack), so it needs no message.
 */
import {
  CLAMP, clampWorld, clampFit, clampLinedUp, type ClampBody, type ClampInfo, type ShipState,
  type ServerClampAskMessage, type ServerClampLinkMessage, type ServerClampBreakMessage,
} from '@space-game/common';

type Clamp = ClampInfo['clamps'][number];

/** A ship as the prompt reads it: its structure and drawn pose */
export interface PromptShip { id: number; ship: ShipState; body: ClampBody }

/** The best clamps to dock on, lined up at the prompt's slack: theirs and ours */
export interface ClampPrompt { with: number; clamp: number; theirs: number }

/** How far apart two ships can be for the prompt to look at them at all (world units, centre to centre) */
const NEAR = 2000;

/**
 * The prompt: of every pair of same-size clamps (ours, another pilot's), the one lined up best at the prompt's slack
 * (null: none). Pure: the same numbers the server's lock reads, with the drawn poses
 */
export function findPrompt(self: PromptShip, others: Iterable<PromptShip>, cellSize: number, slack: number = CLAMP.promptSlack): ClampPrompt | null {
  const mine = self.ship.derived.fx?.clamp?.clamps;
  if (!mine?.length) return null;
  let best: ClampPrompt | null = null, bestScore = Infinity;
  for (const o of others) {
    if (o.id === self.id) continue;
    const theirs = o.ship.derived.fx?.clamp?.clamps;
    if (!theirs?.length) continue;
    if (Math.abs(o.body.x - self.body.x) > NEAR || Math.abs(o.body.y - self.body.y) > NEAR) continue;
    for (const a of mine) {
      const wa = clampWorld(a, self.ship.derived.com, cellSize, self.body);
      for (const b of theirs) {
        if (a.size !== b.size) continue;
        const fit = clampFit(wa, clampWorld(b, o.ship.derived.com, cellSize, o.body));
        if (!clampLinedUp(fit, self.body, o.body, slack)) continue;
        const score = Math.abs(fit.gap) + fit.lateral;
        if (score < bestScore) { bestScore = score; best = { with: o.id, clamp: a.uid, theirs: b.uid }; }
      }
    }
  }
  return best;
}

/** The link this client was told of, as the HUD wants it */
export interface ClampLinkView { leader: number; follower: number; lc: number; fc: number; tick: number }

/** What this client knows of the clamps (one per client: its pilot's) */
export class ClampView {
  /** Open links by leader (every pair this client holds: the glow) */
  readonly links = new Map<number, ClampLinkView>();
  /** The other pilot's press waiting for ours: who, what, and until when (performance.now ms) */
  ask: { from: number; what: 'dock' | 'swap'; until: number } | null = null;
  /** Our own press waiting for theirs */
  waiting: { with: number; what: 'dock' | 'swap'; until: number } | null = null;
  /** The prompt as last worked out (indicator: once a frame) */
  prompt: ClampPrompt | null = null;
  /** A line to show once (a break of our link) */
  notice: string | null = null;

  /** The link a ship is in (undefined: none) */
  linkOf(id: number): ClampLinkView | undefined {
    for (const k of this.links.values()) if (k.leader === id || k.follower === id) return k;
    return undefined;
  }

  onAsk(m: ServerClampAskMessage, now: number): void {
    this.ask = { from: m.from, what: m.what, until: now + (CLAMP.pressWindow / 60) * 1000 };
  }

  onLink(m: ServerClampLinkMessage, self: number): void {
    for (const [k, v] of this.links) if (v.leader === m.leader || v.follower === m.leader || v.leader === m.follower || v.follower === m.follower) this.links.delete(k);
    this.links.set(m.leader, { leader: m.leader, follower: m.follower, lc: m.lc, fc: m.fc, tick: m.tick });
    if (m.leader === self || m.follower === self) { this.ask = null; this.waiting = null; }
  }

  onBreak(m: ServerClampBreakMessage, self: number, why: (w: ServerClampBreakMessage['why']) => string): void {
    const k = this.links.get(m.a) ?? this.links.get(m.b);
    if (k && ((k.leader === m.a && k.follower === m.b) || (k.leader === m.b && k.follower === m.a))) this.links.delete(k.leader);
    if (m.a === self || m.b === self) { this.ask = null; this.waiting = null; this.notice = why(m.why); }
  }

  /** Expired presses go (each frame) */
  expire(now: number): void {
    if (this.ask && this.ask.until < now) this.ask = null;
    if (this.waiting && this.waiting.until < now) this.waiting = null;
  }

  clear(): void {
    this.links.clear();
    this.ask = this.waiting = this.prompt = null;
    this.notice = null;
  }
}

/** The one view (its pilot's): the feature, the server messages and the drawing share it */
export const clampView = new ClampView();

/** Why a link broke, as the pilot is told it */
export function breakText(why: ServerClampBreakMessage['why']): string {
  switch (why) {
    case 'undock': return 'Undocked';
    case 'death': return 'Undocked: a ship was destroyed';
    case 'gone': return 'Undocked: the other ship left';
    case 'jump': return 'Undocked to jump';
    case 'station': return 'Undocked at the station';
    case 'part': return 'Undocked: a clamp was lost';
  }
}

export type { Clamp };
