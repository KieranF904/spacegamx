/**
 * Movement System - Handles player and entity movement
 * Applies input, physics, friction
 */

import { IWorld, defineQuery, hasComponent } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import {
  Position,
  Velocity,
  Rotation,
  Input,
  Player,
  Boost,
  Enemy,
  AI,
  Asteroid,
  EquipmentStats,
  ACCEL_BASE,
  FRICTION,
  TURN_SPEED,
  BOOST_FACTOR,
  WORLD_SIZE,
  getThrustDirection,
} from '@space-game/common';
import { enemyRegistry } from '@space-game/common';

// Define queries at module level
const playerQuery = defineQuery([Position, Velocity, Rotation, Input, Player, Boost]);
const enemyQuery = defineQuery([Position, Velocity, Rotation, Enemy, AI]);
const asteroidQuery = defineQuery([Position, Velocity, Rotation, Asteroid]);
const movableQuery = defineQuery([Position, Velocity]);

export class MovementSystem extends BaseSystem {
  name = 'MovementSystem';
  priority = SystemPriority.MOVEMENT;

  update(world: IWorld, tick: number, deltaMs: number): void {
    this.updatePlayers(world, tick);
    this.updateEnemies(world, tick);
    this.updateAsteroids(world, tick);
    this.applyVelocities(world);
  }

  private updatePlayers(world: IWorld, tick: number): void {
    const players = playerQuery(world);

    for (const eid of players) {
      // Get input
      const forward = Input.forward[eid];
      const backward = Input.backward[eid];
      const left = Input.left[eid];
      const right = Input.right[eid];
      const boost = Input.boost[eid];

      // Calculate thrust direction from input (WASD -> absolute direction)
      let thrustX = 0;
      let thrustY = 0;

      if (forward) thrustY -= 1;
      if (backward) thrustY += 1;
      if (left) thrustX -= 1;
      if (right) thrustX += 1;

      // Normalize diagonal movement
      const thrustMag = Math.sqrt(thrustX * thrustX + thrustY * thrustY);
      if (thrustMag > 0) {
        thrustX /= thrustMag;
        thrustY /= thrustMag;
      }

      // Get equipment bonuses
      const accelBonus = hasComponent(world, EquipmentStats, eid) ? EquipmentStats.accelBonus[eid] : 0;
      const turnBonus = hasComponent(world, EquipmentStats, eid) ? EquipmentStats.turnBonus[eid] : 0;
      const thrustMult = hasComponent(world, EquipmentStats, eid) ? EquipmentStats.thrustMultiplier[eid] : 1.0;
      
      // Calculate actual stats with equipment bonuses (using shared constants)
      const baseAccel = ACCEL_BASE + accelBonus;
      const turnSpeed = TURN_SPEED + turnBonus;

      // Apply boost
      let accel = baseAccel;
      let isBoosting = false;

      if (boost && Boost.fuel[eid] > 0 && thrustMag > 0) {
        accel *= BOOST_FACTOR * thrustMult;
        Boost.fuel[eid] -= Boost.drainRate[eid];
        Boost.lastUseTick[eid] = tick;
        isBoosting = true;
      }

      // Boost regen
      if (!isBoosting && tick - Boost.lastUseTick[eid] > Boost.regenDelay[eid]) {
        Boost.fuel[eid] = Math.min(Boost.maxFuel[eid], Boost.fuel[eid] + Boost.regenRate[eid]);
      }

      // Apply acceleration
      Velocity.x[eid] += thrustX * accel;
      Velocity.y[eid] += thrustY * accel;

      // Apply friction (using shared constant)
      Velocity.x[eid] *= FRICTION;
      Velocity.y[eid] *= FRICTION;

      // Update rotation to face movement direction (smooth)
      if (thrustMag > 0.1) {
        const targetAngle = Math.atan2(thrustY, thrustX);
        let currentAngle = Rotation.angle[eid];
        
        // Normalize angle difference
        let diff = targetAngle - currentAngle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        
        // Smooth rotation
        Rotation.angle[eid] += diff * turnSpeed * 2;
      } else {
        // Face aim direction when not moving
        const targetAngle = Input.targetAngle[eid];
        let diff = targetAngle - Rotation.angle[eid];
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        Rotation.angle[eid] += diff * turnSpeed;
      }
    }
  }

  private updateEnemies(world: IWorld, tick: number): void {
    const enemies = enemyQuery(world);

    for (const eid of enemies) {
      const typeId = Enemy.typeId[eid];
      const defId = enemyRegistry.getStringId(typeId);
      if (!defId) continue;
      
      const def = enemyRegistry.get(defId);
      if (!def) continue;

      const movement = def.movement;
      const targetId = AI.targetId[eid];
      const state = AI.state[eid];

      // Get target position if chasing
      let targetX = AI.homeX[eid];
      let targetY = AI.homeY[eid];
      
      if (targetId > 0 && hasComponent(world, Position, targetId)) {
        targetX = Position.x[targetId];
        targetY = Position.y[targetId];
      }

      const dx = targetX - Position.x[eid];
      const dy = targetY - Position.y[eid];
      const dist = Math.sqrt(dx * dx + dy * dy);

      switch (movement.type) {
        case 'chase':
          if (dist > 50) {
            const angle = Math.atan2(dy, dx);
            Velocity.x[eid] += Math.cos(angle) * movement.accel;
            Velocity.y[eid] += Math.sin(angle) * movement.accel;
          }
          break;

        case 'orbit':
          if (targetId > 0) {
            const orbitDist = movement.orbitDistance ?? 400;
            const orbitSpeed = movement.orbitSpeed ?? 0.02;
            
            // Move toward orbit distance
            if (dist > orbitDist + 50) {
              const angle = Math.atan2(dy, dx);
              Velocity.x[eid] += Math.cos(angle) * movement.accel;
              Velocity.y[eid] += Math.sin(angle) * movement.accel;
            } else if (dist < orbitDist - 50) {
              const angle = Math.atan2(dy, dx);
              Velocity.x[eid] -= Math.cos(angle) * movement.accel;
              Velocity.y[eid] -= Math.sin(angle) * movement.accel;
            }
            
            // Orbit perpendicular
            const perpAngle = Math.atan2(dy, dx) + Math.PI / 2;
            Velocity.x[eid] += Math.cos(perpAngle) * orbitSpeed * movement.speed;
            Velocity.y[eid] += Math.sin(perpAngle) * orbitSpeed * movement.speed;
          }
          break;

        case 'patrol':
          // Return to home if too far
          if (dist > (movement.patrolRadius ?? 500)) {
            const angle = Math.atan2(dy, dx);
            Velocity.x[eid] += Math.cos(angle) * movement.accel;
            Velocity.y[eid] += Math.sin(angle) * movement.accel;
          }
          break;

        case 'stationary':
          // Don't move
          Velocity.x[eid] *= 0.9;
          Velocity.y[eid] *= 0.9;
          break;

        case 'flee':
          if (targetId > 0 && dist < 500) {
            const angle = Math.atan2(dy, dx);
            Velocity.x[eid] -= Math.cos(angle) * movement.accel;
            Velocity.y[eid] -= Math.sin(angle) * movement.accel;
          }
          break;

        case 'swarm':
          // Chase but with separation
          if (dist > 100) {
            const angle = Math.atan2(dy, dx);
            Velocity.x[eid] += Math.cos(angle) * movement.accel;
            Velocity.y[eid] += Math.sin(angle) * movement.accel;
          }
          // Separation handled in collision system
          break;
      }

      // Clamp speed
      const speed = Math.sqrt(Velocity.x[eid] ** 2 + Velocity.y[eid] ** 2);
      if (speed > movement.speed) {
        Velocity.x[eid] = (Velocity.x[eid] / speed) * movement.speed;
        Velocity.y[eid] = (Velocity.y[eid] / speed) * movement.speed;
      }

      // Apply friction
      Velocity.x[eid] *= movement.friction;
      Velocity.y[eid] *= movement.friction;

      // Face movement direction
      if (speed > 0.5) {
        const targetAngle = Math.atan2(Velocity.y[eid], Velocity.x[eid]);
        let diff = targetAngle - Rotation.angle[eid];
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        Rotation.angle[eid] += diff * movement.turnRate;
      }
    }
  }

  private updateAsteroids(world: IWorld, tick: number): void {
    const asteroids = asteroidQuery(world);

    for (const eid of asteroids) {
      // Apply rotation (spin)
      Rotation.angle[eid] += Asteroid.wobblePhase[eid];

      // Small velocity decay for drifting asteroids
      Velocity.x[eid] *= 0.9999;
      Velocity.y[eid] *= 0.9999;
    }
  }

  private applyVelocities(world: IWorld): void {
    const entities = movableQuery(world);

    for (const eid of entities) {
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }
}
