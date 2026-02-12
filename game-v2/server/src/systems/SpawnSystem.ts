/**
 * Spawn System - Handles enemy and asteroid spawning using data-driven definitions
 */

import { IWorld, defineQuery, addEntity, addComponent } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import {
  Position,
  Velocity,
  Rotation,
  Radius,
  Health,
  Enemy,
  AI,
  Asteroid,
  InSystem,
  NetworkSync,
  AIState,
  enemyRegistry,
  asteroidRegistry,
} from '@space-game/common';

// Define queries
const enemyQuery = defineQuery([Enemy, InSystem]);
const asteroidQuery = defineQuery([Asteroid, InSystem]);

export interface SpawnConfig {
  systemId: number;
  enemyTypes: string[];
  maxEnemies: number;
  spawnInterval: number;
  spawnRadius: { min: number; max: number };
  centerX?: number;
  centerY?: number;
}

export class SpawnSystem extends BaseSystem {
  name = 'SpawnSystem';
  priority = SystemPriority.SPAWN;

  private spawnTimers = new Map<string, number>();
  private spawnConfigs: SpawnConfig[] = [];

  init(world: IWorld): void {
    console.log('[SpawnSystem] Initialized');
  }

  addSpawnConfig(config: SpawnConfig): void {
    this.spawnConfigs.push(config);
    
    // Initialize timers for each enemy type
    for (const enemyType of config.enemyTypes) {
      const key = `${config.systemId}_${enemyType}`;
      this.spawnTimers.set(key, 0);
    }
  }

  update(world: IWorld, tick: number, deltaMs: number): void {
    for (const config of this.spawnConfigs) {
      this.processSpawnConfig(world, tick, config);
    }
  }

  private processSpawnConfig(world: IWorld, tick: number, config: SpawnConfig): void {
    // Count current enemies in this system
    const enemies = enemyQuery(world);
    let currentCount = 0;
    
    for (const eid of enemies) {
      if (InSystem.systemId[eid] === config.systemId) {
        currentCount++;
      }
    }

    // Check if we can spawn more
    if (currentCount >= config.maxEnemies) return;

    // Process each enemy type
    for (const enemyType of config.enemyTypes) {
      const key = `${config.systemId}_${enemyType}`;
      const timer = this.spawnTimers.get(key) ?? 0;

      if (timer <= 0) {
        // Spawn an enemy
        const def = enemyRegistry.get(enemyType);
        if (def) {
          const { x, y } = this.getSpawnPosition(config);
          this.spawnEnemy(world, enemyType, x, y, config.systemId);
          
          // Reset timer with some randomness
          const variation = config.spawnInterval * 0.3;
          this.spawnTimers.set(key, config.spawnInterval + (Math.random() - 0.5) * variation);
        }
      } else {
        this.spawnTimers.set(key, timer - 1);
      }
    }
  }

  private getSpawnPosition(config: SpawnConfig): { x: number; y: number } {
    const centerX = config.centerX ?? 0;
    const centerY = config.centerY ?? 0;
    const { min, max } = config.spawnRadius;
    
    const angle = Math.random() * Math.PI * 2;
    const radius = min + Math.random() * (max - min);
    
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  }

  spawnEnemy(world: IWorld, definitionId: string, x: number, y: number, systemId: number): number {
    const def = enemyRegistry.get(definitionId);
    if (!def) {
      console.error(`[SpawnSystem] Unknown enemy: ${definitionId}`);
      return -1;
    }

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = Math.random() * Math.PI * 2;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.radius;

    addComponent(world, Health, eid);
    Health.current[eid] = def.health;
    Health.max[eid] = def.maxHealth;
    Health.regenRate[eid] = 0;
    Health.regenDelay[eid] = 0;

    addComponent(world, Enemy, eid);
    Enemy.typeId[eid] = enemyRegistry.getNumericId(definitionId);
    Enemy.xpValue[eid] = def.drops.xp;

    addComponent(world, AI, eid);
    AI.state[eid] = AIState.Idle;
    AI.targetId[eid] = 0;
    AI.stateTimer[eid] = 0;
    AI.attackCooldown[eid] = 0;
    AI.homeX[eid] = x;
    AI.homeY[eid] = y;
    AI.aggroRange[eid] = def.aggro.range;
    AI.deaggroRange[eid] = def.aggro.deAggroRange;

    addComponent(world, InSystem, eid);
    InSystem.systemId[eid] = systemId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    return eid;
  }

  spawnAsteroid(world: IWorld, definitionId: string, x: number, y: number, systemId: number, size?: number): number {
    const def = asteroidRegistry.get(definitionId);
    if (!def) {
      console.error(`[SpawnSystem] Unknown asteroid: ${definitionId}`);
      return -1;
    }

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = Math.random() * Math.PI * 2;

    // Size
    const actualSize = size ?? asteroidRegistry.generateSize(definitionId);
    
    addComponent(world, Radius, eid);
    Radius.value[eid] = actualSize;

    // Calculate health based on size
    const hp = asteroidRegistry.calculateHealth(definitionId, actualSize);

    addComponent(world, Asteroid, eid);
    Asteroid.size[eid] = actualSize;
    Asteroid.hp[eid] = hp;
    Asteroid.maxHp[eid] = hp;
    Asteroid.resourceType[eid] = 0;
    Asteroid.resourceAmount[eid] = 0;

    // Orbital mechanics
    if (def.physics.orbit?.enabled) {
      const orbit = def.physics.orbit;
      const orbitRadius = orbit.radiusMin + Math.random() * (orbit.radiusMax - orbit.radiusMin);
      Asteroid.orbitType[eid] = 0;
      Asteroid.semiMajorAxis[eid] = orbitRadius;
      Asteroid.eccentricity[eid] = 0;
      Asteroid.argPeriapsis[eid] = Math.random() * Math.PI * 2;
      Asteroid.meanAnomaly0[eid] = Math.random() * Math.PI * 2;
      Asteroid.epochTick[eid] = 0;
    }

    // Drift
    if (def.physics.drift?.enabled) {
      const drift = def.physics.drift;
      const speed = drift.speedMin + Math.random() * (drift.speedMax - drift.speedMin);
      const angle = Math.random() * Math.PI * 2;
      Velocity.x[eid] = Math.cos(angle) * speed;
      Velocity.y[eid] = Math.sin(angle) * speed;
    }

    // Rotation
    const rotRange = def.physics.rotationSpeed.max - def.physics.rotationSpeed.min;
    Asteroid.wobblePhase[eid] = def.physics.rotationSpeed.min + Math.random() * rotRange;

    addComponent(world, InSystem, eid);
    InSystem.systemId[eid] = systemId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 3;

    return eid;
  }

  /**
   * Spawn an asteroid field
   */
  spawnAsteroidField(
    world: IWorld,
    fieldId: string,
    centerX: number,
    centerY: number,
    systemId: number
  ): number[] {
    const field = asteroidRegistry.getField(fieldId);
    if (!field) {
      console.error(`[SpawnSystem] Unknown field: ${fieldId}`);
      return [];
    }

    const asteroids: number[] = [];
    
    // Calculate total asteroids based on density and radius
    const area = Math.PI * field.radius * field.radius;
    const totalCount = Math.floor((area / 1000000) * field.density);
    
    // Calculate total weight for weighted random selection
    const totalWeight = field.asteroidTypes.reduce((sum, t) => sum + t.weight, 0);

    for (let i = 0; i < totalCount; i++) {
      // Select asteroid type based on weight
      let roll = Math.random() * totalWeight;
      let selectedType = field.asteroidTypes[0].id;
      
      for (const asteroidType of field.asteroidTypes) {
        roll -= asteroidType.weight;
        if (roll <= 0) {
          selectedType = asteroidType.id;
          break;
        }
      }
      
      // Random position in field
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * field.radius;
      const x = centerX + Math.cos(angle) * dist;
      const y = centerY + Math.sin(angle) * dist;

      const eid = this.spawnAsteroid(world, selectedType, x, y, systemId);
      if (eid >= 0) {
        asteroids.push(eid);
      }
    }

    return asteroids;
  }
}
