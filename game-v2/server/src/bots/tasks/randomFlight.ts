/**
 * random-flight: a dev bot that just flies badly on purpose, to give the netcode something to chew on (prediction, corrections,
 * re-steps) without a person at the stick. It has no goal and keeps no trip stats.
 *
 * Every so often (the input-change interval) it picks one of: a sharp turn (a new heading, usually 60-180 degrees off), a
 * small bend, or a hard stop (brakes until it is still, then waits out the interval), with a boost burst thrown in on some
 * changes. The interval runs from calm (~4 s between changes) to twitchy (~0.2 s): the `twitch` option, 0..1 or the words
 * calm / mid / twitchy. Past `leash` from where it started it turns for home so it does not drift off the map.
 *
 * Options (`/bot spawn random-flight 1 client twitch=0.8 shoot=1 ...`): twitch, boost (chance a change adds a boost burst),
 * stop (chance a change is a hard stop), leash (units), seed, shoot (fire at the target while it is within `range`).
 * The target is set by the caller (`RandomFlight.target`): the Rockery tools point it at whoever spawned the bot.
 * Controls has no primary-fire field, so "fire" is `mine` (the right mouse button, the secondary/mining trigger).
 *
 * Everything is a function of the seed and the ticks, so a run repeats.
 */
import { mulberry32 } from '@space-game/common';
import { hold } from '../core/steering.js';
import { idle, type Controls, type Phase } from '../core/types.js';
import { num, str, type BotTask, type TaskCtx, type TaskDef, type TaskOpts } from './types.js';

export interface FlightOpts {
  /** 0 (calm) .. 1 (twitchy) */
  twitch: number;
  boost: number;
  stop: number;
  leash: number;
  seed: number;
  shoot: boolean;
  range: number;
}

const WORDS: Record<string, number> = { calm: 0.1, slow: 0.1, mid: 0.5, medium: 0.5, busy: 0.75, twitchy: 0.95, wild: 1 };

export function flightOpts(o: TaskOpts): FlightOpts {
  const w = str(o, 'twitch', '0.5');
  const twitch = w in WORDS ? WORDS[w] : Number.isFinite(Number(w)) ? Number(w) : 0.5;
  const on = (v: string) => v === '1' || v === 'true' || v === 'yes';
  return {
    twitch: Math.max(0, Math.min(1, twitch)),
    boost: Math.max(0, Math.min(1, num(o, 'boost', 0.3))),
    stop: Math.max(0, Math.min(1, num(o, 'stop', 0.15))),
    leash: num(o, 'leash', 6000),
    seed: num(o, 'seed', 1),
    shoot: on(str(o, 'shoot', '0')),
    range: num(o, 'range', 1400),
  };
}

/** Mean seconds between input changes for a twitch level: calm 4 s, twitchy 0.2 s (geometric between) */
export const changeSeconds = (twitch: number): number => 4 * Math.pow(0.2 / 4, Math.max(0, Math.min(1, twitch)));

/** A small seeded generator (mulberry32) */
export const rng = (seed: number): (() => number) => mulberry32((seed | 0) || 1);

type Mode = 'fly' | 'stop';
type Pt = { x: number; y: number };

export class RandomFlight implements BotTask {
  readonly name = 'random-flight';
  phase: Phase = 'travelOut';
  /** Whom to shoot at (shoot=1): a point, or null for nobody */
  target: (() => Pt | null) | null = null;
  /** Where home is now, if it moves (the Rockery's `near` bots: the player who asked); null: where it started */
  homeOf: (() => Pt | null) | null = null;
  /** Input changes made so far (the tests and the status line) */
  changes = 0;
  private r: () => number;
  private mode: Mode = 'fly';
  private heading = 0;
  private nextAt = -1;
  private boostUntil = 0;
  private home: Pt | null = null;
  private keys: Controls = idle();

  constructor(readonly o: FlightOpts) { this.r = rng(o.seed); }

  status(): string { return `${this.mode} heading ${Math.round((this.heading * 180) / Math.PI)} deg, ${this.changes} changes`; }

  step(c: TaskCtx): void {
    const d = c.driver, p = d.pose();
    if (!this.home) { this.home = { x: p.x, y: p.y }; this.heading = this.r() * Math.PI * 2; }
    const home = this.homeOf?.() ?? this.home;
    const away = Math.hypot(p.x - home.x, p.y - home.y);
    if (this.nextAt < 0 || c.tick >= this.nextAt) this.change(c, away > this.o.leash, p, home);
    const out = this.mode === 'stop' ? hold(p, this.keys) : this.fly();
    out.boost = this.mode === 'fly' && c.tick < this.boostUntil;
    const tgt = this.target?.() ?? null;
    const toTgt = tgt ? Math.hypot(tgt.x - p.x, tgt.y - p.y) : Infinity;
    if (this.o.shoot && tgt && toTgt <= this.o.range) {
      out.aim = Math.atan2(tgt.y - p.y, tgt.x - p.x);
      out.aimDist = toTgt;
      out.mine = true;
    } else {
      out.aim = this.mode === 'stop' ? p.angle : this.heading;
      out.aimDist = 400;
      out.mine = false;
    }
    this.keys = out;
    d.set(out);
  }

  /** Pick the next thing to do */
  private change(c: TaskCtx, outside: boolean, p: Pt, home: Pt): void {
    const r = this.r;
    this.changes++;
    const secs = changeSeconds(this.o.twitch) * (0.5 + r());
    this.nextAt = c.tick + Math.max(1, Math.round(secs * c.tickRate));
    if (outside) {
      this.mode = 'fly';
      this.heading = Math.atan2(home.y - p.y, home.x - p.x);
      return;
    }
    if (r() < this.o.stop) { this.mode = 'stop'; return; }
    this.mode = 'fly';
    // A sharp turn most of the time, a small bend otherwise
    const sharp = r() < 0.6;
    const turn = sharp ? (Math.PI / 3 + r() * (Math.PI * 2 / 3)) * (r() < 0.5 ? -1 : 1) : (r() - 0.5) * 0.9;
    this.heading += turn;
    if (r() < this.o.boost) this.boostUntil = c.tick + Math.round((0.4 + r() * 0.8) * c.tickRate);
  }

  /** The move keys for the heading (eight ways; screen y grows down, so forward is -y) */
  private fly(): Controls {
    const dx = Math.cos(this.heading), dy = Math.sin(this.heading), T = 0.38;
    const out = idle(this.heading);
    out.right = dx > T; out.left = dx < -T; out.backward = dy > T; out.forward = dy < -T;
    return out;
  }

  get stopped(): boolean { return this.mode === 'stop'; }
}

export const randomFlight: TaskDef = {
  name: 'random-flight',
  description: 'sharp turns, boost bursts and stops at a calm-to-twitchy rate (twitch=0..1|calm|mid|twitchy boost stop leash seed shoot=1 range)',
  ship: 'arrow',
  station: () => 'sol_station_central',
  create: (o) => new RandomFlight(flightOpts(o)),
};
