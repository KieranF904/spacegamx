/**
 * AI System - Handles enemy AI behavior using data-driven definitions
 */

import { IWorld, defineQuery, hasComponent } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import {
  Position,
  Velocity,
  Rotation,
  Health,
  Player,
  Enemy,
  AI,
  AIState,
  enemyRegistry,
} from '@space-game/common';

// Define queries
const enemyQuery = defineQuery([Position, Velocity, Rotation, Enemy, AI, Health]);
const playerQuery = defineQuery([Position, Player, Health]);

export class AISystem extends BaseSystem {
  name = 'AISystem';
  priority = SystemPriority.AI;

  private currentTick = 0;

  update(world: IWorld, tick: number, deltaMs: number): void {
    this.currentTick = tick;
    
    const enemies = enemyQuery(world);
    const players = playerQuery(world);

    for (const eid of enemies) {
      this.updateEnemy(world, eid, players);
    }
  }

  private updateEnemy(world: IWorld, eid: number, players: readonly number[]): void {
    const typeId = Enemy.typeId[eid];
    const defId = enemyRegistry.getStringId(typeId);
    if (!defId) return;
    
    const def = enemyRegistry.get(defId);
    if (!def) return;

    const state = AI.state[eid];
    const targetId = AI.targetId[eid];

    // Find nearest player
    const nearest = this.findNearestPlayer(eid, players);
    const distToNearest = nearest ? nearest.distance : Infinity;

    // State machine
    switch (state) {
      case AIState.Idle:
        this.handleIdleState(world, eid, def, nearest, distToNearest);
        break;
      case AIState.Chase:
        this.handleChasingState(world, eid, def, nearest, distToNearest);
        break;
      case AIState.Attack:
        this.handleAttackingState(world, eid, def, nearest, distToNearest);
        break;
      case AIState.Flee:
        this.handleFleeingState(world, eid, def, nearest, distToNearest);
        break;
      case AIState.Return:
        this.handleReturningState(world, eid, def);
        break;
    }

    // Apply movement based on definition
    this.applyMovement(world, eid, def);

    // Update state timer
    AI.stateTimer[eid]++;
  }

  private findNearestPlayer(
    eid: number,
    players: readonly number[]
  ): { id: number; distance: number; dx: number; dy: number } | null {
    let nearest: { id: number; distance: number; dx: number; dy: number } | null = null;
    const ex = Position.x[eid];
    const ey = Position.y[eid];

    for (const pid of players) {
      // Skip dead players
      if (Health.current[pid] <= 0) continue;

      const dx = Position.x[pid] - ex;
      const dy = Position.y[pid] - ey;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (!nearest || dist < nearest.distance) {
        nearest = { id: pid, distance: dist, dx, dy };
      }
    }

    return nearest;
  }

  private handleIdleState(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>,
    nearest: { id: number; distance: number; dx: number; dy: number } | null,
    distance: number
  ): void {
    if (!def) return;

    // Check if player is in aggro range
    if (nearest && distance <= def.aggro.range) {
      AI.state[eid] = AIState.Chase;
      AI.targetId[eid] = nearest.id;
      AI.stateTimer[eid] = 0;
    }
  }

  private handleChasingState(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>,
    nearest: { id: number; distance: number; dx: number; dy: number } | null,
    distance: number
  ): void {
    if (!def) return;

    // Check deaggro
    if (!nearest || distance > def.aggro.deAggroRange) {
      AI.state[eid] = AIState.Return;
      AI.targetId[eid] = 0;
      AI.stateTimer[eid] = 0;
      return;
    }

    // Update target to nearest
    AI.targetId[eid] = nearest.id;

    // Check if in attack range (use cooldown-based distance estimate)
    const attackRange = 300;
    if (distance <= attackRange) {
      AI.state[eid] = AIState.Attack;
      AI.stateTimer[eid] = 0;
    }

    // Move toward target
    if (nearest) {
      const angle = Math.atan2(nearest.dy, nearest.dx);
      const accel = def.movement.accel;
      
      Velocity.x[eid] += Math.cos(angle) * accel;
      Velocity.y[eid] += Math.sin(angle) * accel;
    }
  }

  private handleAttackingState(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>,
    nearest: { id: number; distance: number; dx: number; dy: number } | null,
    distance: number
  ): void {
    if (!def) return;

    const attackRange = 300;

    // Check if target out of range
    if (!nearest || distance > attackRange * 1.2) {
      AI.state[eid] = AIState.Chase;
      AI.stateTimer[eid] = 0;
      return;
    }

    // Check deaggro
    if (distance > def.aggro.deAggroRange) {
      AI.state[eid] = AIState.Return;
      AI.targetId[eid] = 0;
      AI.stateTimer[eid] = 0;
      return;
    }

    // Try to attack
    if (AI.attackCooldown[eid] <= 0) {
      // Attack handled elsewhere - just set cooldown
      AI.attackCooldown[eid] = def.weapon?.cooldown ?? 60;
    } else {
      AI.attackCooldown[eid]--;
    }

    // Movement based on type
    if (def.movement.type === 'orbit' && nearest) {
      this.orbitTarget(eid, nearest, def.movement.orbitDistance ?? 400, def.movement.orbitSpeed ?? 0.02);
    } else if (def.movement.type === 'stationary') {
      // Stay still
      Velocity.x[eid] *= 0.9;
      Velocity.y[eid] *= 0.9;
    }
  }

  private handleFleeingState(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>,
    nearest: { id: number; distance: number; dx: number; dy: number } | null,
    distance: number
  ): void {
    if (!def) return;

    // Flee from target
    if (nearest && distance < 500) {
      const angle = Math.atan2(nearest.dy, nearest.dx);
      const accel = def.movement.accel;
      
      // Move away
      Velocity.x[eid] -= Math.cos(angle) * accel;
      Velocity.y[eid] -= Math.sin(angle) * accel;
    }

    // If far enough, return to idle
    if (!nearest || distance > 700) {
      AI.state[eid] = AIState.Return;
      AI.stateTimer[eid] = 0;
    }
  }

  private handleReturningState(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>
  ): void {
    if (!def) return;

    const homeX = AI.homeX[eid];
    const homeY = AI.homeY[eid];
    const dx = homeX - Position.x[eid];
    const dy = homeY - Position.y[eid];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 50) {
      AI.state[eid] = AIState.Idle;
      AI.stateTimer[eid] = 0;
      return;
    }

    // Move toward home
    const angle = Math.atan2(dy, dx);
    const accel = def.movement.accel;
    
    Velocity.x[eid] += Math.cos(angle) * accel;
    Velocity.y[eid] += Math.sin(angle) * accel;
  }

  private orbitTarget(
    eid: number,
    target: { id: number; distance: number; dx: number; dy: number },
    orbitDist: number,
    orbitSpeed: number
  ): void {
    const dist = target.distance;
    
    // Move toward/away from orbit distance
    if (dist > orbitDist + 50) {
      const angle = Math.atan2(target.dy, target.dx);
      Velocity.x[eid] += Math.cos(angle) * 0.1;
      Velocity.y[eid] += Math.sin(angle) * 0.1;
    } else if (dist < orbitDist - 50) {
      const angle = Math.atan2(target.dy, target.dx);
      Velocity.x[eid] -= Math.cos(angle) * 0.1;
      Velocity.y[eid] -= Math.sin(angle) * 0.1;
    }
    
    // Orbit perpendicular
    const perpAngle = Math.atan2(target.dy, target.dx) + Math.PI / 2;
    Velocity.x[eid] += Math.cos(perpAngle) * orbitSpeed;
    Velocity.y[eid] += Math.sin(perpAngle) * orbitSpeed;
  }

  private applyMovement(
    world: IWorld,
    eid: number,
    def: ReturnType<typeof enemyRegistry.get>
  ): void {
    if (!def) return;

    // Clamp speed
    const speed = Math.sqrt(Velocity.x[eid] ** 2 + Velocity.y[eid] ** 2);
    if (speed > def.movement.speed) {
      Velocity.x[eid] = (Velocity.x[eid] / speed) * def.movement.speed;
      Velocity.y[eid] = (Velocity.y[eid] / speed) * def.movement.speed;
    }

    // Apply friction
    Velocity.x[eid] *= def.movement.friction;
    Velocity.y[eid] *= def.movement.friction;

    // Apply velocity to position
    Position.x[eid] += Velocity.x[eid];
    Position.y[eid] += Velocity.y[eid];

    // Face movement direction
    if (speed > 0.5) {
      const targetAngle = Math.atan2(Velocity.y[eid], Velocity.x[eid]);
      let diff = targetAngle - Rotation.angle[eid];
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      Rotation.angle[eid] += diff * def.movement.turnRate;
    }
  }
}
