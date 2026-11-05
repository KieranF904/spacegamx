/**
 * The Pyreclast (its cavern under Ashfall): a hulk the size of a station, the meta boss (docs/bosses/rework-2026-11.md
 * sections 5, 6 and 15). Three stages (staged.ts), each an attack phase: its signature moves chained back to back (a
 * short beat between them), then one short window (fightRules.ts: x2 up to a cap, a crack if the cap fills early; its
 * first 1 s a rest), then the phase again; nothing scaled by how many pilots there are. Every move has a light tell
 * (always the same one) and one dodge rule that always works. Between moves and in its window it keeps up a light
 * threat (`harassShot`: a glint and one fast spark at where you were), and pilots draw personal attacks of their own.
 *
 * Its limbs (PieceDef `limb`: armour 5 against its body's 3, never what a stage is beaten by) each work an attack:
 * break one and that attack weakens or goes (a turret one fewer fan, both scythes no sweep...).
 *
 * Stage one, the fortress (carapace and wings): slow, holding off. Phase: barrage, broadside, scythe.
 *   barrage      its wing turrets glow two at a time from opposite sides, clockwise: each throws a fan of three slow
 *                magma balls at where you ARE, the fans crossing on you. Rule: keep moving sideways
 *   broadside    it rolls side-on, that wing's turrets swing together and red lanes are drawn; fast shells only down
 *                the lanes; then it follows you round a little and fires a second salvo. Rule: get off that side, over
 *                its nose or tail
 *   scythe       a scythe's root glows and the blade draws back: it sweeps that side from 900 to 3,400 off its hull,
 *                nose to tail and back. Rule: get in close
 * Stage two, the hunter (its body): lighter, closer, its vents burning anything near them (always). Phase: mortar,
 * dash, lance, mortar.
 *   mortar       its mortar beds thump twice: a lane of shells along your line of flight, walls either side and a cap
 *                ahead. Rule: reverse out the way you came
 *   dash         its coils crackle; five dashes round you, each streaked 0.9 s before; the last overshoots. Rule: never
 *                sit on a streak
 *   lance        the prow lance hums and draws a line, burns down it, sweeps across its front towards the side it
 *                first glowed on, and straight back. Rule: get behind it
 * Stage three, the heart: small and quick. Phase: crystal, ring, swarm, then its vent (its window).
 *   crystal      (it darts once first) seven beams in a set order, each a white line 0.9 s before. Rule: never sit on a
 *                white line
 *   ring         side-on to you, its core flares twice: five rings of fast sparks out to the vault's walls, the two
 *                gaps always at its nose and tail as it turns. Rule: stay on its nose-to-tail line
 *   swarm        a hiss, its seams glow: eight seekers in two waves, shared among pilots. Rule: turn hard across them
 *   vent         it goes still and its vents blaze: its window, and anything within 700 of a vent burns. Rule: stay
 *                out of the heat, or wear heat plating. Its vents can't be broken while open
 *
 * Its window is drawn by clients from the window alone (BossFx: bosses.json `exposed`). Personal attacks (one pilot
 * each, pure luck a beat; held only in a window's rest beat and a stagger): magma lob, ember drone, flak burst (stage
 * one), lob and synapse mark (two), spark fan and lob (three); each from a limb, so a broken limb takes it out of the pool.
 *
 * Its moves are common bodies/moves/pyreclast.ts (the same on every client running its body); this is its brain: what
 * it picks and when, and its vents' heat.
 */

import {
  Position, dhypot, rayTerrain, windowOpen, wantFace, PYRECLAST_PERSONAL, PYRECLAST_HEAT_REACH, PYRECLAST_VENT_TICKS,
  type WindowSpec, type PyreclastMoves,
} from '@space-game/common';
import { bodyFrame, pose } from './kit.js';
import type { BrainHost } from './kit.js';
import { StagedBrain } from './staged.js';

/**
 * Its attack phases' windows (docs section 15), by stage: one a phase, 5 s for its fortress and its hunter, and 6 s
 * for its heart, whose window is its vents blazing (VENT_W)
 */
export const PYRECLAST_EXPOSURE: WindowSpec[] = [{ ticks: 300, cap: 4200 }, { ticks: 300, cap: 4200 }, { ticks: PYRECLAST_VENT_TICKS, cap: 5400 }];
const VENT_W = PYRECLAST_EXPOSURE[2];
/** Its signature moves (what counts as one: fightRules.ts), each with its stage's window */
export const PYRECLAST_SIGNATURE: Record<string, WindowSpec> = {
  barrage: PYRECLAST_EXPOSURE[0], broadside: PYRECLAST_EXPOSURE[0], scythe: PYRECLAST_EXPOSURE[0],
  mortar: PYRECLAST_EXPOSURE[1], dash: PYRECLAST_EXPOSURE[1], lance: PYRECLAST_EXPOSURE[1],
  crystal: VENT_W, ring: VENT_W, swarm: VENT_W, vent: VENT_W,
};
/** Its phases: the moves chained in order (the heart's ends in its vent: its window), by stage */
export const PYRECLAST_LOOP = [['barrage', 'broadside', 'scythe'], ['mortar', 'dash', 'lance', 'mortar'], ['crystal', 'ring', 'swarm', 'vent']];
export { PYRECLAST_PERSONAL };
/** The beat between two chained moves, and its rest after a window (ticks), by stage: shorter each stage */
const CHAIN = [30, 24, 18], REST = [30, 24, 18];
/** Its light threat between moves and in its windows: a harassing shot every this many ticks, by stage */
const HARASS = [90, 80, 70];
/** Heat (dps, x the boss's damage scale): its body's vents always (stage two), its heart's open (the vent window) */
const HEAT_S2 = 28, HEAT_OPEN = 57, HEAT_REACH = PYRECLAST_HEAT_REACH;

/** Its brain: what it picks and when, and its vents' heat (its moves are common bodies/moves/pyreclast.ts) */
export class PyreclastBrain extends StagedBrain {
  /** Its heart's vents, held whole while they're open (they can't be broken venting), and when the next heat pulse is */
  private ventHp = new Map<number, number>();
  private nextHeat = 0;
  private nextVentLook = 0;
  /** The last signature move done (whose window is running), and the heading it holds in that window */
  private lastMove = '';
  private windowAt = -1;
  private windowFace = 0;

  constructor(host: BrainHost) {
    super(host, {
      loop: PYRECLAST_LOOP, rest: REST, haste: [1, 1, 1], chain: CHAIN, harass: HARASS,
      signature: PYRECLAST_SIGNATURE, exposure: PYRECLAST_EXPOSURE, personal: PYRECLAST_PERSONAL,
    }, 'pyreclast');
  }

  private get pm(): PyreclastMoves {
    return this.mv as PyreclastMoves;
  }

  protected onStop(): void {
    this.ventHp.clear();
    this.lastMove = '';
  }

  /** Its window's hold, its vents' heat (the server's: burns are damage), its stage-two vents' look now and then */
  protected passives(now: number): void {
    this.lockVents(now);
    const w = this.fight.window;
    // In its window it shows its recovery: it holds where it is, as it faced when it opened (a crack's stagger: staged.ts holds it too)
    if (!this.move && w && now >= w.at && now < w.at + w.ticks) {
      if (this.windowAt !== w.at) { this.windowAt = w.at; this.windowFace = pose(this.view.eid).angle; }
      this.mv.want = wantFace(this.windowFace);
    }
    if (now < this.nextHeat) return;
    this.nextHeat = now + 30;
    if (this.stage === 2) {
      // Its body's vents burn anything near them, always
      const vents = this.pm.vents();
      for (const v of vents) this.heat(v, HEAT_S2);
      if (vents.length && now >= this.nextVentLook) {
        // (its look, from its own timer: always from the server)
        this.nextVentLook = now + 600;
        for (const v of vents) { const at = bodyFrame(this.host, this.view.eid, this.ship, v); this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'vent', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: HEAT_REACH, ticks: 600 }); }
      }
    } else if (this.stage === 3 && this.venting(now)) {
      for (const v of this.pm.vents()) this.heat(v, HEAT_OPEN);
    }
  }

  /** Its vent window open (the heart's vents blazing) */
  private venting(now: number): boolean {
    return this.lastMove === 'vent' && windowOpen(this.fight.window, now);
  }

  /** Every pilot within HEAT_REACH of a vent catches fire (thermal: heat plating shrugs most of it off) */
  private heat(vent: number, dps: number): void {
    const m = this.mount(vent);
    for (const q of this.host.players(this.view.systemNum)) {
      if (dhypot(Position.x[q] - m.x, Position.y[q] - m.y) > HEAT_REACH || this.walled(m.x, m.y, q)) continue;
      const part = this.host.ships.ignite(q, m.x, m.y, dps * this.view.damage, 45, 1.2, this.view.eid, { type: 'thermal', pen: 3 });
      if (part >= 0) { this.host.send(this.view.systemNum, { type: 'ignite', bodyId: q, part, ticks: 45 }); this.host.hint?.(q, 'burning'); }
    }
  }

  /** Rock (or an arena's barrier) between a point and a pilot: burns don't reach through it */
  private walled(x: number, y: number, q: number): boolean {
    const t = this.host.terrain?.(this.view.systemNum);
    return !!t && rayTerrain(t, x, y, Position.x[q], Position.y[q]) < 1;
  }

  /** Its heart's vents can't be broken while they're open (shielded by their own heat): held whole until they close */
  private lockVents(now: number): void {
    if (!this.venting(now)) { if (this.ventHp.size) this.ventHp.clear(); return; }
    for (const v of this.pm.vents()) {
      const was = this.ventHp.get(v);
      if (was === undefined) this.ventHp.set(v, this.ship.hp[v]);
      else if (this.ship.hp[v] < was) { this.ship.hp[v] = was; this.ship.rebuildHp[v] = was; }
    }
  }

  /** A signature move done: remember which (its window's look: the vent's heat) */
  orders(...args: Parameters<StagedBrain['orders']>): ReturnType<StagedBrain['orders']> {
    const before = this.moveName;
    const out = super.orders(...args);
    if (before && !this.moveName && this.fight.isSignature(before)) this.lastMove = before;
    return out;
  }

  idle(): boolean {
    return super.idle() && (!this.view || !this.pm.busy());
  }
}
