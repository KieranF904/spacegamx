/**
 * @contract client.ship.messages
 * owns:       routing the server messages a ship client reacts to (hits, damage, bosses, scans, ship sync, system info, docking) to the pieces that draw or track them
 * needs:      ShipMessageHost (state, store, fx getters, debris, away, selfHits, hits, own, causes, moves, flow, turrets, dock, jump, strike)
 * invariants: returns false for messages the game also draws itself — client/src/app/serverMessages.test.ts
 * extend:     a new ship server message is one more case below
 */

import type { ServerMessage } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../../state/GameState';
import type { Renderer } from '../../rendering/Renderer';
import { clearBossLives } from '../bossLife';
import type { ShipStore } from '../ShipStore';
import type { ShipRenderer } from '../ShipRenderer';
import type { DamageFx } from '../DamageFx';
import type { BossFx } from '../BossFx';
import type { MiningBeamFx } from '../MiningBeamFx';
import type { ScannerFx } from '../ScannerFx';
import type { DebrisSplits } from '../debris/DebrisSplits';
import type { ShipMemory } from '../cells/ShipMemory';
import type { SelfHits } from '../hits/SelfHits';
import type { ConfirmedHits } from '../hits/ConfirmedHits';
import type { OwnTick } from '../own/OwnTick';
import type { ShipCauses } from '../causes/ShipCauses';
import type { MoveRunner } from '../bodies/MoveRunner';
import type { HitFlow } from '../hits/HitFlow';
import type { TurretVisuals } from '../guns/TurretVisuals';
import type { DockControl } from '../dock/DockControl';
import type { JumpControl } from '../jump/JumpControl';
import type { StrikeFx } from '../hits/StrikeFx';
import { fillHull } from '../hits/fillHull';

export interface ShipMessageHost {
  readonly state: GameState;
  readonly store: ShipStore;
  readonly debris: DebrisSplits;
  readonly away: ShipMemory<InterpolatedEntity>;
  readonly selfHits: SelfHits;
  readonly hits: ConfirmedHits;
  readonly own: OwnTick;
  readonly causes: ShipCauses;
  readonly moves: MoveRunner;
  readonly flow: HitFlow;
  readonly turrets: TurretVisuals;
  readonly dock: DockControl;
  readonly jump: JumpControl;
  readonly strike: StrikeFx;
  scene(): Renderer | null;
  renderer(): ShipRenderer | null;
  damageFx(): DamageFx | null;
  bossFx(): BossFx | null;
  beamFx(): MiningBeamFx | null;
  scannerFx(): ScannerFx | null;
  showMessage(text: string, color?: string): void;
  toast?(text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  sound?(id: string, at?: { x: number; y: number }, volume?: number, pitch?: number): (() => void) | null;
}

/** Returns true when the message was a ship message. */
export function handleShipMessage(h: ShipMessageHost, msg: ServerMessage): boolean {
  switch (msg.type) {
    case 'debrisSplit':
      h.debris.onSplit(msg);
      return true;
    case 'cells':
      h.away.onCells(msg);
      return true;
    case 'shipSync':
      h.debris.onSync(msg);
      h.selfHits.onSync(msg.id, h.store.keepsBefore(msg));
      h.own.beforeSync(msg.id);
      h.causes.beforeSync(msg.id);
      for (const part of h.store.onSync(msg)) h.damageFx()?.onPartRestored(msg.id, part);
      fillHull(h.store, h.state.entities, msg.id);
      return true;
    case 'partDestroyed':
      h.damageFx()?.onPartDestroyed(msg);
      return true;
    case 'contact':
      h.damageFx()?.onContact(msg);
      return true;
    case 'detonation':
      h.damageFx()?.onDetonation(msg.kind, msg.x, msg.y, msg.radius, msg.from);
      return true;
    case 'intercept':
      // Point defence fired (support.ts): its tracer and the shot popping; the shell's own tracer stops there; the turret turns to it
      h.damageFx()?.onIntercept(msg);
      if (msg.down) h.scene()?.showProjectileHit(msg.proj, msg.x, msg.y);
      h.turrets.noteIntercept(msg.bodyId, msg.part, msg.x, msg.y);
      return true;
    case 'stationFire':
      const shot = h.scene()?.stationFire(msg.station, msg.turret ?? 0, msg.target);
      // (A laser turret's shot is a pulse, as a pulse laser's: MiningBeamFx)
      const beam = h.beamFx();
      if (shot?.weapon === 'laser' && beam) beam.stationPulse(shot.x, shot.y, msg.target, msg.station);
      else if (shot) h.damageFx()?.onStationFire(shot, msg.target);
      return true;
    case 'ignite':
      h.damageFx()?.onIgnite(msg.bodyId, msg.part, msg.ticks);
      return true;
    case 'bossCharge':
      h.damageFx()?.onBossCharge(msg.bodyId, msg.kind, msg.ticks);
      return true;
    case 'bossTelegraph':
      h.bossFx()?.onTelegraph(msg);
      return true;
    case 'bossPhase':
      // Its second stage: the frame under its plates glows white-hot
      h.renderer()?.setHeat(msg.bodyId, msg.phase >= 2 ? 1 : 0);
      return false; // the game shows its line too
    case 'bossBeam':
      h.bossFx()?.onBeam(msg);
      return true;
    case 'bossWindow':
      // Its exposed pieces blaze while its window runs (drawn from this message alone)
      h.bossFx()?.onWindow(msg);
      return false; // the game shows the meter too
    case 'bossBlow':
      h.renderer()?.blow(msg.bodyId, msg.part);
      return true;
    case 'bossDefeated':
      h.damageFx()?.onBossDefeated(msg.x, msg.y);
      return false; // the game shows the card too
    case 'damage':
      h.renderer()?.hit(msg.targetId, msg.amount);
      return false; // the game shows the number and the HUD's indicator
    case 'effect':
      if (msg.effectType === 12) h.damageFx()?.shieldReform(msg.x, msg.y); // EffectType.ShieldFlash
      return false; // the game draws its own
    case 'projectileHit':
      // (Told the old way: a hit found here for this shell wasn't one)
      if (h.selfHits.on && !h.flow.handingOut) { h.hits.oldWay(msg.id); h.selfHits.drop(msg.id); }
      // (a shell it doesn't have: one a body's move fired, made here: the one there goes)
      if (!h.state.entities.has(msg.id)) h.moves.struck(msg.x, msg.y, h.flow.snapTick);
      // (A shell drawn here shows its hit where it's seen to strike, struckFx; the server's only confirms it)
      if (!h.scene()?.drawsShell(msg.id)) h.strike.struck(msg.id, msg.x, msg.y, h.state.entities.get(msg.id)?.data?.[0] ?? -1);
      return false; // the game stops the tracer and throws the sparks
    case 'scanPulse':
      h.scannerFx()?.pulse(msg.seconds);
      h.sound?.('scan_ping');
      return true;
    case 'shipHp':
      h.flow.findHits();
      h.store.onHp(msg);
      fillHull(h.store, h.state.entities, msg.id);
      return true;
    case 'shipHps':
      h.flow.findHits();
      h.store.onHps(msg);
      for (const [id] of msg.ships) fillHull(h.store, h.state.entities, id);
      return true;
    case 'systemInfo':
      h.jump.onSystemInfo(msg);
      // (Another system: no lair boss of the last one is rising or sinking here)
      clearBossLives();
      return false; // the game also handles it
    case 'dockResult':
      h.dock.onDockResult(msg);
      return true;
    case 'shipEditResult':
      if (msg.ok) h.showMessage('Design saved', '#4ade80');
      else {
        h.showMessage(`Not saved: ${msg.errors.join('; ')}`, '#f87171');
        h.toast?.(`Not saved: ${msg.errors[0]}`, 'bad');
      }
      h.sound?.(msg.ok ? 'level_up' : 'error');
      return true;
    case 'snapshot':
      for (const id of msg.removed) h.store.remove(id);
      h.away.onSnapshot(msg.tick, msg.removed);
      h.hits.forget(msg.removed);
      h.selfHits.onRemoved(msg.removed);
      return false;
  }
  return false;
}
