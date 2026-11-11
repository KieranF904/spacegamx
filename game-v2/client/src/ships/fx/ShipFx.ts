/**
 * @contract client.ship.fx
 * owns:       the ship effect layers (jump, mining beams, charge tells, scanner, damage, bosses, incoming warning), built on the renderer and wired to sounds
 * needs:      ShipFxHost (state, store, tuning, econ, localAim, miningHeld, hangarOpen, sound, jump, ownBeams, chargeTells, strike), Renderer layers; npm: @space-game/common
 * invariants: what glows is added as a bloom source — client/src/ships/fx/ShipFx.test.ts
 *             the local jump charge sound is cut on abort — client/src/ships/fx/ShipFx.test.ts
 * extend:     a new effect layer is one more field and one more line in init
 */

import { rightFiresGuns, gradeOf, type ShipTuning, type JumpTuning } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import type { QualityProfile } from '../../settings/quality';
import type { PilotState } from '../../econ/clientEcon';
import { IncomingWarning } from '../../ui/IncomingWarning';
import { groupSelection } from '../weaponGroups/selection';
import type { ShipStore } from '../ShipStore';
import type { ShipRenderer } from '../ShipRenderer';
import type { StrikeFx } from '../hits/StrikeFx';
import { JumpFx } from '../JumpFx';
import { BossFx } from '../BossFx';
import { DamageFx } from '../DamageFx';
import { MiningBeamFx } from '../MiningBeamFx';
import { ScannerFx } from '../ScannerFx';
import { ChargeFx } from '../ChargeFx';

/** A pulse laser's sound by its grade, Mk I-V: subtle, and centred low (the wide Mk IV deepest, the x-ray Mk V a touch brighter) */
const PULSE_GRADE_PITCH = [0.98, 0.94, 1.01, 0.9, 1.04];

export interface ShipFxHost {
  readonly state: GameState;
  readonly store: ShipStore;
  readonly tuning: ShipTuning;
  readonly econ: PilotState['econ'];
  readonly jump: JumpTuning;
  /** Your held beams on the newest tick drawn (OwnPresent.ownBeams) */
  readonly ownBeams: Set<number>;
  /** Others' charge guns charging now (FireShells.chargeTells) */
  readonly chargeTells: Map<number, number>;
  readonly strike: StrikeFx;
  localAim(): { angle: number; dist: number };
  miningHeld?(): boolean;
  hangarOpen(): boolean;
  sound?(id: string, at?: { x: number; y: number }, volume?: number, pitch?: number): (() => void) | null;
}

export class ShipFx {
  constructor(private readonly h: ShipFxHost) {}
  jumpFx: JumpFx | null = null;
  /** Bosses' warnings and beams */
  bossFx: BossFx | null = null;
  damageFx: DamageFx | null = null;
  beamFx: MiningBeamFx | null = null;
  /** Charge guns' tells (Longbarrel's sight line, Blackout's darkening) */
  chargeFx: ChargeFx | null = null;
  scannerFx: ScannerFx | null = null;
  zoom: () => number = () => 1;
  /** The local jump charge sound, so an abort can cut it */
  chargeSound: (() => void) | null = null;
  incomingUI: IncomingWarning | null = null;
  /** The graphics tier's effect settings (kept for the effects made at init) */
  quality: Pick<QualityProfile, 'particles' | 'effectCap'> = { particles: 1, effectCap: Infinity };
  setQuality(q: QualityProfile): void {
    this.quality = q;
    this.damageFx?.setQuality(q.particles, q.effectCap);
  }

  /** Build every layer on the renderer's layers (after the ship renderer exists) */
  init(renderer: Renderer, shipRenderer: ShipRenderer): void {
    this.incomingUI = new IncomingWarning();
    renderer.lighting.addSource((L) => this.damageFx?.collectLights(L));
    this.jumpFx = new JumpFx(renderer.getShipLayer(), this.h.store, this.h.state, this.h.jump);
    this.beamFx = new MiningBeamFx(renderer.getEffectLayer(), this.h.store, this.h.state, this.h.tuning, () => {
      const aim = this.h.localAim();
      const ship = this.h.store.get(this.h.state.playerId);
      return { firing: !!this.h.miningHeld?.() && !!ship?.derived.miners.length && !rightFiresGuns(groupSelection.packed, true) && !this.h.hangarOpen(), aim: aim.angle, dist: aim.dist };
    });
    this.beamFx.ownBeams = () => this.h.ownBeams;
    // A held beam's burn throws impacts off what it lights (BeamLook.burn: the Cutter's, the Tesla's, the Searchlight's)
    this.beamFx.onBurn = (x, y, dx, dy, owner, burn) => renderer.beamBurn(x, y, dx, dy, owner, burn);
    // A pulse laser's pulse: its charge whine, the crack at its peak and its fading tail (pitched by its grade)
    this.beamFx.onPulse = (x, y, grade, own) => { this.h.sound?.('laser_pulse', own ? undefined : { x, y }, own ? 0.42 : 0.7, PULSE_GRADE_PITCH[Math.max(0, Math.min(4, grade - 1))]); };
    // A mining laser's pulse: a deep, soft throb, one a ship however many miners it has
    this.beamFx.onMiningPulse = (x, y, own) => { this.h.sound?.('mining_pulse', own ? undefined : { x, y }, own ? 0.5 : 0.6); };
    // ...and where it lands on rock, a mining strike (a roll for ore: nothing's sent for it)
    this.beamFx.onMiningStrike = (x, y, dx, dy, material, owner) => {
      renderer.miningStrike(x, y, dx, dy, material, 1.4);
      if (owner === this.h.state.playerId) this.h.strike.mineTick();
    };
    // Your own laser cutting rock: its work towards your next drop
    this.beamFx.onOwnCut = (rock, x, y, dps, dt, material) => {
      this.h.strike.miningProgress?.laser(rock, dps, dt, gradeOf(this.h.store.catalog.materials.get(material)), this.h.strike.systemTier(), material);
    };
    this.chargeFx = new ChargeFx(renderer.getEffectLayer(), this.h.store, this.h.state, this.h.tuning, this.h.chargeTells);
    renderer.addBloomSource(this.chargeFx.glowLayer);
    this.scannerFx = new ScannerFx(renderer.getEffectLayer(), this.h.store, this.h.state, this.h.econ);
    this.zoom = () => renderer.getZoom();
    this.damageFx = new DamageFx(renderer.getEffectLayer(), this.h.store, this.h.state,
      (id, at, volume) => { this.h.sound?.(id, at, volume); }, this.h.tuning.repair?.range ?? 0);
    this.damageFx.setQuality(this.quality.particles, this.quality.effectCap);
    this.bossFx = new BossFx(renderer.getEffectLayer(), this.h.state, (id, at, volume, pitch) => this.h.sound?.(id, at, volume, pitch) ?? null);
    this.bossFx.partsAt = (id, byStage) => shipRenderer.exposedAt(id, byStage) ?? [];
    // What glows gets bloom
    for (const c of [...shipRenderer.glowLayers(), this.damageFx.glowLayer, this.beamFx.glowLayer, this.bossFx.glowLayer]) renderer.addBloomSource(c);
    this.jumpFx.onPhase = (id, prev, next, x, y) => {
      const local = id === this.h.state.playerId;
      const at = local ? undefined : { x, y };
      if (next === 'charging' && prev === 'ready') {
        const stop = this.h.sound?.('jump_charge', at) ?? null;
        if (local) this.chargeSound = stop;
      } else if (prev === 'charging' && next === 'ready') {
        if (local) { this.chargeSound?.(); this.chargeSound = null; }
      } else if (next === 'burn') {
        if (local) this.chargeSound = null;
        this.h.sound?.('jump_launch', at);
      } else if (prev === 'burn') {
        this.h.sound?.('jump_arrive', at);
      } else if (local && prev === 'cooldown' && next === 'ready') {
        this.h.sound?.('jump_ready', undefined, 0.8);
      }
    };
  }
}
