/**
 * @contract client.ship.strike-fx
 * owns:       where a shell is seen to strike: shield ripples, plain-hit looks, mining strikes on rock and the progress ring towards your next drop
 * needs:      StrikeFxHost (state, store, scene, damageFx, shellModel, sound), MiningProgress, common gunShell
 * invariants: a hit that cannot mine shows plain sparks — client/src/ships/hits/StrikeFx.test.ts
 *             only your own working hits tick and add progress — client/src/ships/hits/StrikeFx.test.ts
 * extend:     a new hit look is one more branch in struck()
 */

import { EntityType, EffectType, WEAPON_KIND_TYPE, gunShell, type MiningTable } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import type { ShipStore } from '../ShipStore';
import type { DamageFx } from '../DamageFx';
import { PLAIN_HIT_LOOKS } from '../DamageFx';
import { MiningProgress } from '../MiningProgress';
import { shapedStruck } from '../features/zoneshield';
import { strikeRolls } from '../../rendering/weapons/MiningStrikeFx';
import { rockMaterial } from '../../rendering/rocks/RockMaterials';
import { isTrainingBody } from '../../state/trainingBodies';
import factionsData from '../../../../data/factions.json';
import miningTable from '../../../../data/mining.json';

/** Your working hits on rock tick at most this often (seconds) */
const MINE_TICK_EVERY = 0.16;
/** A shell's weapon kind from its snapshot weapon type (WEAPON_KIND_TYPE turned round) */
const KIND_OF_TYPE = new Map(Object.entries(WEAPON_KIND_TYPE).map(([k, t]) => [t, k]));

export interface StrikeFxHost {
  readonly state: GameState;
  readonly store: ShipStore;
  scene(): Renderer | null;
  damageFx(): DamageFx | null;
  /** The gun model a shell was fired with, where known (FireShells.shellInfo's look) */
  shellModel(id: number): string | undefined;
  sound?(id: string, at?: { x: number; y: number }, volume?: number, pitch?: number): (() => void) | null;
}

export class StrikeFx {
  constructor(private readonly h: StrikeFxHost) {}
  /** Your mining progress (MiningProgress), and when its tick last sounded (seconds) */
  miningProgress: MiningProgress | null = null;
  private mineTickAt = 0;

  /** Your mining progress ring, drawn on the effect layer (init) */
  init(layer: ConstructorParameters<typeof MiningProgress>[0]): void {
    // (Each rock's public mining seed and composition, as its entity has them: your drops on it step from those)
    this.miningProgress = new MiningProgress(layer, miningTable as unknown as MiningTable, () => performance.now() / 1000, (id) => {
      const e = this.h.state.entities.get(id);
      return e?.mineSeed !== undefined && e.composition ? { seed: e.mineSeed, composition: e.composition } : undefined;
    });
  }

  /**
   * A shell's hit, where it's seen to strike (WeaponFx.onStruck), or where the server says for one not drawn here: a
   * raised shield's ripple and plating's sparks there, and the hit look a shell with no detonation of its own has; on
   * a rock (`target`, as drawn here), its mining strike or sparks, which the server no longer sends (GameServer.hurtAsteroid).
   * Every hit's sound is its drawn impact's (WeaponFx.impactAt -> audio/CombatSounds.ts)
   */
  struck(id: number, x: number, y: number, type: number, target = -1, owner = -1): void {
    // (a shaped shield ripples where it was struck, features/zoneshield; the bubble only if no such shield was)
    if (!shapedStruck(x, y)) this.h.damageFx()?.shieldHit(x, y, this.h.shellModel(id));
    // (A shell with a look of its own that no detonation tells now: a Prism's shards, DamageFx PLAIN_HIT_LOOKS)
    const kind = KIND_OF_TYPE.get(type);
    if (kind && PLAIN_HIT_LOOKS.has(kind)) this.h.damageFx()?.onDetonation(kind, x, y, 40);
    const rockAt = target >= 0 ? this.h.state.entities.get(target) : undefined;
    if (rockAt?.type === EntityType.Asteroid) {
      // A hit that mines rolls for ore on the server (Mining.extract): a mining strike, rock dust and grit off the face
      // (nothing's sent for it, so it plays whatever the roll); one that can't mine there, a shell's plain sparks
      // (a training drone yields nothing: a shell's plain sparks, never a mining strike, state/trainingBodies.ts)
      if (!isTrainingBody(target) && strikeRolls(kind, rockAt.composition?.hardness)) {
        this.h.scene()?.miningStrike(x, y, x - rockAt.renderX, y - rockAt.renderY, rockMaterial(rockAt.composition));
        // Your own: the work it did towards your next drop (MiningProgress), and a light tick
        if (owner === this.h.state.playerId && this.miningProgress) {
          this.miningProgress.shell(target, kind, this.ownShellDamage(type), this.systemTier());
          this.mineTick();
        }
      } else this.h.scene()?.showEffect(EffectType.LaserHit, x, y, [this.shellDamage(id), 30]);
      // (its sound is the impact's, heard as WeaponFx draws it: audio/CombatSounds.ts)
    }
  }

  /** What your own shell of snapshot `type` hits with: your first gun of its kind's (a rock's work: MiningProgress) */
  private ownShellDamage(type: number): number {
    const ship = this.h.store.get(this.h.state.playerId), kind = KIND_OF_TYPE.get(type);
    const w = ship?.derived.weapons.find((x) => x.kind === kind);
    const sh = ship && w ? gunShell(this.h.store.tuning, ship, w.part) : null;
    return sh ? (sh.def.damage ?? 14) * sh.strength : 14;
  }

  /** The system's rock tier (its Mk: the server's MiningHost.rockTier, from factions.json spawns) */
  systemTier(): number {
    return (factionsData as { spawns?: Record<string, { grade?: number }> }).spawns?.[this.h.state.systemId]?.grade || 1;
  }

  /** A light, gritty tick for a working hit of yours on rock: at most one every MINE_TICK_EVERY */
  mineTick(): void {
    const t = performance.now() / 1000;
    if (t - this.mineTickAt < MINE_TICK_EVERY) return;
    this.mineTickAt = t;
    this.h.sound?.('mine_tick', undefined, 0.32);
  }

  /** About what a shell hits with (a rock's sparks are sized by it), from its gun where known */
  private shellDamage(id: number): number {
    const d = this.h.state.entities.get(id)?.data, ship = d ? this.h.store.get(d[6]) : undefined;
    const sh = ship && (d![10] ?? -1) >= 0 ? gunShell(this.h.store.tuning, ship, d![10]) : null;
    return sh ? Math.round((sh.def.damage ?? 14) * sh.strength * 10) / 10 : 10;
  }
}
