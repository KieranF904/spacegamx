/**
 * @contract client.app.scene-sounds
 * owns:       sounds driven by what is on screen: engine and boost loops, held beams, the event-horizon alarm, the music's mood and dread
 * needs:      SceneSoundsHost (state, audio, input, ship client, combat sounds, music place, objectives, world queries), weaponSounds
 * invariants: shots and impacts are not heard here, they are heard as WeaponFx draws them (CombatSounds) — client/src/app/appInvariants.test.ts
 *             a beam lighting is heard once — client/src/app/appInvariants.test.ts
 * extend:     a new screen-driven sound is one more line in update()
 */

import type { BeamSource, AudioManager } from '../audio/AudioManager';
import { beamLightSound, beamLoopFor } from '../audio/weaponSounds';
import type { CombatSounds } from '../audio/CombatSounds';
import type { MusicPlaceTracker } from '../audio/musicPlace';
import type { InputManager } from '../input/InputManager';
import type { ShipClient } from '../ships/ShipClient';
import type { GameState } from '../state/GameState';
import type { ObjectiveBanner } from '../ui/ObjectiveBanner';
import type { WorldQueries } from './worldQueries';

/** What the scene sounds read from the game */
export interface SceneSoundsHost {
  readonly state: GameState;
  readonly audio: AudioManager;
  readonly input: InputManager;
  readonly shipClient: ShipClient;
  readonly combatSounds: CombatSounds;
  readonly musicPlace: MusicPlaceTracker;
  readonly objectives: ObjectiveBanner;
  readonly world: WorldQueries;
  readonly loggedIn: boolean;
  readonly menuOpen: boolean;
  readonly stationOpen: boolean;
  readonly bossId: string | null;
  readonly systemArrivedAt: number;
  updateZone(): void;
}

export class SceneSounds {
  private lastAlarm = 0;

  constructor(private h: SceneSoundsHost) {}

  /**
   * Sounds driven by what's on screen: the engine and boost loops, held beams, the event-horizon alarm, and the music's
   * mood. Shots and impacts are heard as WeaponFx draws them, this frame's drawing just after this (audio/CombatSounds.ts)
   */
  update(now: number): void {
    const h = this.h;
    const me = h.state.entities.get(h.state.playerId);
    // (don't play every shell already flying on arrival)
    h.combatSounds.frame(now - h.systemArrivedAt > 1500);

    const flying = h.loggedIn && !!me && !h.shipClient.hangarOpen && !h.menuOpen;
    const thrusting = flying && ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some((k) => h.input.isKeyDown(k));
    const boosting = thrusting && h.state.boostFuel > 0 && (h.input.isKeyDown('ShiftLeft') || h.input.isKeyDown('ShiftRight'));
    const speed = me ? Math.hypot(me.vx, me.vy) : 0;
    h.audio.setLoop('engine', flying ? (thrusting ? 1 : 0.25) : 0, 0.8 + Math.min(0.5, speed / 30));
    h.audio.setLoop('boost', boosting ? 1 : 0, 1 + Math.min(0.3, speed / 60));
    // (Mining lasers pulse, each pulse its own sound: ShipClient's beamFx.onMiningPulse)
    this.beamSounds(flying);

    if (h.shipClient.horizonDanger() > 0.35 && now - this.lastAlarm > 900) {
      this.lastAlarm = now;
      h.audio.playUI('warning', 0.6);
    }
    // The music follows the system, the area you're in, docking, a boss's arena or fight (audio/musicPlace.ts)
    h.audio.setMusicPlace(h.musicPlace.update({
      systemId: h.state.systemId || 'sol', sys: h.world.currentSystem(), x: me?.renderX, y: me?.renderY,
      tick: h.state.getRawServerTick(), docked: h.stationOpen, boss: h.bossId,
    }), now);
    // Nearing a boss's lair (a surface's or pocket's dread point), the music turns ominous
    const dread = h.world.currentSystem()?.surface?.dread ?? h.world.currentSystem()?.pocket?.dread;
    const d = dread && me ? Math.hypot(me.renderX - dread.x, me.renderY - dread.y) : Infinity;
    h.audio.setDread(dread ? Math.max(0, Math.min(1, (dread.from - d) / Math.max(1, dread.from - dread.full))) : 0);
    h.updateZone();
    h.objectives.update(h.state.systemId);
    const wayIn = flying ? h.world.pocketWayIn() : null;
    h.shipClient.setPlanetHint(wayIn ?? (flying ? h.world.planetBelow() : null), wayIn ? 'Enter' : undefined);
  }

  /** Held beams lit last frame (ship * 256 + part), so a beam lighting is heard once */
  private beamsLit = new Set<number>();
  private beamsNow = new Set<number>();
  private readonly beamSources: BeamSource[] = [];

  /**
   * Held beams, every ship's, heard as they're drawn (MiningBeamFx.litBeams): each its model's loop (weaponSounds
   * beamLoopFor), and as one lights its model's ignition, if it has one (the Lance's)
   */
  private beamSounds(flying: boolean): void {
    const h = this.h;
    const src = this.beamSources, now = this.beamsNow;
    src.length = 0;
    now.clear();
    if (flying) {
      for (const b of h.shipClient.litBeams()) {
        const key = b.owner * 256 + b.part;
        now.add(key);
        const loop = beamLoopFor(b.model, b.kind);
        if (loop) src.push({ loop, x: b.x, y: b.y, own: b.own });
        if (this.beamsLit.has(key)) continue;
        const light = beamLightSound(b.model);
        if (light) { if (b.own) h.audio.playUI(light, 0.6); else h.audio.play(light, b.x, b.y, { volume: 0.8 }); }
      }
    }
    h.audio.setBeams(src);
    this.beamsNow = this.beamsLit;
    this.beamsLit = now;
  }
}
