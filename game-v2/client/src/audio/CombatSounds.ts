/**
 * Combat sounds heard as their visuals are drawn, on the same timeline (WeaponFx is the one place shells and their
 * impacts are drawn, and it tells this):
 *
 *   shot     a shell's muzzle flash going off on its timeline (WeaponFx.fly): your own as the predicted step fired it
 *            (ShipClient.presentOwn -> WeaponFx.predict), another ship's as the PT timeline draws it ahead
 *            (shellsKind -> WeaponFx.predict), anything else as its row or fire event is first drawn. The server's copy
 *            of a shell drawn ahead takes that shell over (WeaponFx.claim / adopt: `renamed`), so it is never heard twice.
 *   impact   an impact drawn (WeaponFx.impactAt): a strike at a drawn surface, a told hit landing as the shell gets
 *            there, a hit on a shell never drawn. A told hit on a shell already drawn striking draws nothing, and so is
 *            not heard again. A raised shield's bubble there: shield_hit instead of hit.
 *
 * Throttled as before: one sound a gun's volley a frame (a fan of shells from one ship heard once), and a few shots and
 * impacts a frame at most, so a pack can't machine-gun a sample. Nothing already flying on arrival in a system is heard
 * (the settle window: `frame(settled)`).
 *
 * Shells drawn ahead for another ship can be taken back (the PT timeline: `retracted`). One taken back before its flash
 * is drawn is never heard (it never flashes). One taken back after it was heard is not un-heard: measured (C3, 100 ms
 * netSim, bots and drones), every retract came after the sound, a median 16 frames later (the snapshot confirming its
 * tick drew it otherwise: mostly the same shot from a slightly different pose), so holding the sound a frame or two
 * would only make every shot late and catch none. Instead the shot drawn again for it (the PT timeline's redraw, or the
 * snapshot's own shell, same owner and kind, its fire tick within a tick) isn't heard a second time (`redrawn` stat).
 */
import { hasOwnShotSound, shotSoundFor } from './weaponSounds';

/** A kind's cannon heard by its kind's sound: its grade (Mk I-V) nudges the pitch, heavier marks deeper */
export const CANNON_GRADE_PITCH = [1, 0.86, 1.14, 1.06, 0.8];
/** Shots and impacts heard a frame at most */
const MAX_SHOTS = 4, MAX_IMPACTS = 4;
/** A second impact for one shell this close (world units) within this many frames is the same hit drawn twice */
const IMPACT_SAME_DIST = 48, IMPACT_SAME_FRAMES = 6;
/** Shell ids heard are kept this many frames (a shell's flight is far shorter): a late rename or row still finds them */
const HEARD_FRAMES = 1200;
/** A shot heard then taken back is redrawn (re-posed, or the snapshot's own shell) within this many frames, if at all */
const REDRAW_FRAMES = 90;

/** A shell whose flash was just drawn */
export interface ShotHeard {
  /** Its id in WeaponFx (negative while drawn ahead, the server's once its copy takes it over) */
  id: number;
  spawnTick: number;
  owner: number;
  /** Projectile type (data[0]) */
  type: number;
  /** Its gun's grade, Mk I-V */
  grade: number;
  /** Its gun's model, where known */
  model?: string;
  turret: boolean;
  x: number;
  y: number;
  /** Drawn ahead for another ship (the PT timeline): it may yet be taken back */
  ahead: boolean;
}

/** An impact just drawn */
export interface ImpactHeard {
  /** Its shell's id (-1: none known) */
  shell: number;
  owner: number;
  x: number;
  y: number;
}

/** What WeaponFx tells (rendering/weapons/WeaponFx.ts `sounds`) */
export interface CombatSoundFeed {
  shot(s: ShotHeard): void;
  impact(h: ImpactHeard): void;
  /** A shell took another id (the server's copy took over one drawn ahead) */
  renamed(from: number, to: number): void;
  /** A shell drawn ahead was taken back */
  retracted(id: number): void;
}

export interface CombatSoundsHost {
  play(id: string, x: number, y: number, volume: number, pitch: number): void;
  /** Is a raised shield's bubble at (x, y)? (DamageFx.bubbleAt) */
  shieldAt?(x: number, y: number): boolean;
  /** The shot's sample (default: weaponSounds.shotSoundFor) */
  shotSound?(model: string | undefined, type: number, turret: boolean): string;
  random?(): number;
}

/** Counters (tests, the dev console's window.__game.combatSounds.stats) */
export interface CombatSoundStats {
  shots: number; impacts: number; volleyMerged: number; capped: number; dupShots: number; dupImpacts: number; unsettled: number;
  /** Shots heard, then taken back */
  retractedHeard: number;
  /** ...and drawn again for them, not heard again */
  redrawn: number;
}

export class CombatSounds implements CombatSoundFeed {
  readonly stats: CombatSoundStats = { shots: 0, impacts: 0, volleyMerged: 0, capped: 0, dupShots: 0, dupImpacts: 0, unsettled: 0, retractedHeard: 0, redrawn: 0 };
  /** Frames counted (frame()) */
  private n = 0;
  private settled = false;
  /** Shell ids heard: their spawn tick, owner and kind, and the frame they were heard on */
  private readonly heard = new Map<number, { tick: number; owner: number; type: number; at: number }>();
  /** Shots heard and then taken back, waiting for the shot drawn again for each (REDRAW_FRAMES) */
  private taken: { owner: number; type: number; tick: number; at: number }[] = [];
  /** This frame's shot volleys and impact sources (owner:sound), and counts */
  private readonly volleys = new Set<string>();
  private readonly hits = new Set<string>();
  private shots = 0;
  private impacts = 0;
  /** Recent impacts by shell (the frame and place) */
  private readonly recent = new Map<number, { at: number; x: number; y: number }>();
  constructor(private readonly host: CombatSoundsHost) {}

  /** A new frame (before or after the frame's drawing: once a frame). `settled`: past the arrival window */
  frame(settled: boolean): void {
    this.n++;
    this.settled = settled;
    this.volleys.clear();
    this.hits.clear();
    this.shots = 0;
    this.impacts = 0;
    if (this.taken.length && this.n - this.taken[0].at > REDRAW_FRAMES) this.taken = this.taken.filter((x) => this.n - x.at <= REDRAW_FRAMES);
    if ((this.n & 63) === 0) {
      for (const [id, h] of this.heard) if (this.n - h.at > HEARD_FRAMES) this.heard.delete(id);
      for (const [id, h] of this.recent) if (this.n - h.at > IMPACT_SAME_FRAMES) this.recent.delete(id);
    }
  }

  shot(s: ShotHeard): void {
    const had = this.heard.get(s.id);
    if (had && had.tick === s.spawnTick) { this.stats.dupShots++; return; }
    this.heard.set(s.id, { tick: s.spawnTick, owner: s.owner, type: s.type, at: this.n });
    if (!this.settled) { this.stats.unsettled++; return; }
    // (drawn again for one heard and taken back: the nearest fire tick's)
    if (this.taken.length) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < this.taken.length; i++) {
        const x = this.taken[i], d = Math.abs(x.tick - s.spawnTick);
        if (x.owner === s.owner && x.type === s.type && d <= 1 && d < bd) { best = i; bd = d; }
      }
      if (best >= 0) { this.taken.splice(best, 1); this.stats.redrawn++; return; }
    }
    this.emit(s);
  }

  private emit(s: ShotHeard): void {
    const id = (this.host.shotSound ?? shotSoundFor)(s.model, s.type, s.turret);
    if (!id) return;
    const volley = `${s.owner}:${id}`;
    if (this.volleys.has(volley)) { this.stats.volleyMerged++; return; }
    if (this.shots >= MAX_SHOTS) { this.stats.capped++; return; }
    this.volleys.add(volley);
    this.shots++;
    this.stats.shots++;
    const pitch = s.type === 1 && !hasOwnShotSound(s.model) ? CANNON_GRADE_PITCH[Math.max(0, Math.min(4, (s.grade || 1) - 1))] : 1;
    this.host.play(id, s.x, s.y, 0.8, pitch);
  }

  impact(h: ImpactHeard): void {
    if (h.shell >= 0) {
      const r = this.recent.get(h.shell);
      if (r && this.n - r.at <= IMPACT_SAME_FRAMES && Math.hypot(r.x - h.x, r.y - h.y) < IMPACT_SAME_DIST) { this.stats.dupImpacts++; return; }
      this.recent.set(h.shell, { at: this.n, x: h.x, y: h.y });
    }
    const shield = this.host.shieldAt?.(h.x, h.y) ?? false;
    const id = shield ? 'shield_hit' : 'hit';
    const key = `${h.owner}:${id}`;
    if (this.hits.has(key)) { this.stats.volleyMerged++; return; }
    if (this.impacts >= MAX_IMPACTS) { this.stats.capped++; return; }
    this.hits.add(key);
    this.impacts++;
    this.stats.impacts++;
    const rnd = this.host.random ?? Math.random;
    this.host.play(id, h.x, h.y, shield ? 0.6 : 0.7, 0.85 + rnd() * 0.3);
  }

  renamed(from: number, to: number): void {
    const h = this.heard.get(from);
    if (h) { this.heard.delete(from); this.heard.set(to, h); }
    const r = this.recent.get(from);
    if (r) { this.recent.delete(from); this.recent.set(to, r); }
  }

  retracted(id: number): void {
    const h = this.heard.get(id);
    if (!h) return;
    this.heard.delete(id);
    this.stats.retractedHeard++;
    this.taken.push({ owner: h.owner, type: h.type, tick: h.tick, at: this.n });
  }
}
