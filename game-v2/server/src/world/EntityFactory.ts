/**
 * Entity Factory - Creates ECS entities from data definitions
 * Central place for spawning all game entities
 */

import { IWorld, addEntity, addComponent } from 'bitecs';
import {
  Position,
  Velocity,
  Rotation,
  Radius,
  Health,
  Lifetime,
  Player,
  Input,
  Boost,
  Equipment,
  Inventory,
  WeaponState,
  Enemy,
  AI,
  Asteroid,
  Projectile,
  Bullet,
  Laser,
  Missile,
  Pulse,
  Mine,
  Station,
  DroppedItem,
  NetworkSync,
  OwnedBy,
  WeaponType,
  AIBehavior,
  AIState,
  weaponRegistry,
  enemyRegistry,
  asteroidRegistry,
  WeaponDefinition,
  EnemyDefinition,
  AsteroidDefinition,
} from '@space-game/common';

// === Weapon Type Mapping ===
const weaponTypeMap: Record<string, number> = {
  cannon: WeaponType.Cannon,
  laser: WeaponType.Laser,
  scatter: WeaponType.Scatter,
  missile: WeaponType.Missile,
  pulse: WeaponType.Pulse,
  mine: WeaponType.Mine,
  mining: WeaponType.Mining,
  warp: WeaponType.Warp,
};

// === AI Behavior Mapping ===
const aiBehaviorMap: Record<string, number> = {
  chase: AIBehavior.Aggressive,
  orbit: AIBehavior.Flanker,
  stationary: AIBehavior.Territorial,
  patrol: AIBehavior.Territorial,
  flee: AIBehavior.Territorial,
  swarm: AIBehavior.Swarm,
};

/**
 * Entity Factory
 */
export class EntityFactory {
  private world: IWorld;

  constructor(world: IWorld) {
    this.world = world;
  }

  // === Player Creation ===

  createPlayer(clientId: number, x: number, y: number): number {
    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = 0;

    addComponent(this.world, Radius, eid);
    Radius.value[eid] = 20;

    addComponent(this.world, Health, eid);
    Health.current[eid] = 100;
    Health.max[eid] = 100;
    Health.regenRate[eid] = 0.5;
    Health.regenDelay[eid] = 180;
    Health.lastDamageTick[eid] = 0;

    addComponent(this.world, Player, eid);
    Player.clientId[eid] = clientId;
    Player.level[eid] = 1;
    Player.xp[eid] = 0;
    Player.credits[eid] = 100;
    Player.systemId[eid] = 0;

    addComponent(this.world, Input, eid);
    addComponent(this.world, Boost, eid);
    Boost.fuel[eid] = 100;
    Boost.maxFuel[eid] = 100;
    Boost.drainRate[eid] = 1;
    Boost.regenRate[eid] = 0.5;
    Boost.regenDelay[eid] = 60;
    Boost.lastUseTick[eid] = 0;

    addComponent(this.world, Equipment, eid);
    Equipment.leftWeapon[eid] = weaponRegistry.getNumericId('blaster_mk1');
    Equipment.rightWeapon[eid] = weaponRegistry.getNumericId('laser_mk1');
    Equipment.booster[eid] = 0;
    Equipment.cockpit[eid] = 0;

    addComponent(this.world, Inventory, eid);
    addComponent(this.world, WeaponState, eid);
    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 1;

    return eid;
  }

  // === Enemy Creation ===

  createEnemy(definitionId: string, x: number, y: number): number {
    const def = enemyRegistry.get(definitionId);
    if (!def) {
      console.error(`[EntityFactory] Unknown enemy definition: ${definitionId}`);
      return -1;
    }

    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = Math.random() * Math.PI * 2;

    addComponent(this.world, Radius, eid);
    Radius.value[eid] = def.radius;

    addComponent(this.world, Health, eid);
    Health.current[eid] = def.health;
    Health.max[eid] = def.maxHealth;
    Health.regenRate[eid] = 0;
    Health.regenDelay[eid] = 0;

    addComponent(this.world, Enemy, eid);
    Enemy.typeId[eid] = enemyRegistry.getNumericId(definitionId);
    Enemy.xpValue[eid] = def.drops.xp;

    addComponent(this.world, AI, eid);
    AI.behaviorType[eid] = aiBehaviorMap[def.movement.type] ?? AIBehavior.Aggressive;
    AI.state[eid] = AIState.Idle;
    AI.targetId[eid] = 0;
    AI.stateTimer[eid] = 0;
    AI.attackCooldown[eid] = 0;
    AI.homeX[eid] = x;
    AI.homeY[eid] = y;
    AI.aggroRange[eid] = def.aggro.range;
    AI.deaggroRange[eid] = def.aggro.deAggroRange;

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    return eid;
  }

  createEnemyFromDef(def: EnemyDefinition, x: number, y: number): number {
    return this.createEnemy(def.id, x, y);
  }

  // === Asteroid Creation ===

  createAsteroid(definitionId: string, x: number, y: number, size?: number): number {
    const def = asteroidRegistry.get(definitionId);
    if (!def) {
      console.error(`[EntityFactory] Unknown asteroid definition: ${definitionId}`);
      return -1;
    }

    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = Math.random() * Math.PI * 2;

    // Size
    const actualSize = size ?? asteroidRegistry.generateSize(definitionId);
    
    addComponent(this.world, Radius, eid);
    Radius.value[eid] = actualSize;

    // Calculate health based on size
    const hp = asteroidRegistry.calculateHealth(definitionId, actualSize);

    addComponent(this.world, Asteroid, eid);
    Asteroid.size[eid] = actualSize;
    Asteroid.hp[eid] = hp;
    Asteroid.maxHp[eid] = hp;
    Asteroid.resourceType[eid] = 0; // Will be set based on definition
    Asteroid.resourceAmount[eid] = 0; // Calculated on destruction

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

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 3;

    return eid;
  }

  // === Projectile Creation ===

  createProjectile(
    ownerId: number,
    weaponDefId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number = 0,
    inheritVy: number = 0,
    chargeLevel: number = 0
  ): number {
    const def = weaponRegistry.get(weaponDefId);
    if (!def || !def.projectile) {
      console.error(`[EntityFactory] Invalid weapon for projectile: ${weaponDefId}`);
      return -1;
    }

    const eid = addEntity(this.world);

    // Base components
    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(this.world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(this.world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(this.world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage;
    Projectile.weaponType[eid] = weaponTypeMap[def.type] ?? WeaponType.Cannon;
    Projectile.tier[eid] = def.tier;

    addComponent(this.world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    // Type-specific components
    switch (def.type) {
      case 'cannon':
      case 'scatter':
        addComponent(this.world, Bullet, eid);
        Bullet.speed[eid] = speed;
        break;

      case 'missile':
        addComponent(this.world, Missile, eid);
        Missile.targetId[eid] = 0;
        Missile.turnRate[eid] = def.homing?.turnRate ?? 0.07;
        Missile.fuel[eid] = def.homing?.fuel ?? 360;
        Missile.armed[eid] = 0;
        break;

      case 'pulse':
        addComponent(this.world, Pulse, eid);
        Pulse.chargeLevel[eid] = chargeLevel;
        Pulse.splashRadius[eid] = def.splash?.radius ?? 200;
        Pulse.growing[eid] = 1;
        Pulse.growTimer[eid] = 0;
        // Increase radius based on charge
        if (def.charge && chargeLevel > 0) {
          Radius.value[eid] *= 1 + chargeLevel * (def.charge.sizeMultiplier - 1);
          Projectile.damage[eid] *= 1 + chargeLevel * (def.charge.damageMultiplier - 1);
        }
        break;
    }

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    return eid;
  }

  // === Mine Creation ===

  createMine(ownerId: number, weaponDefId: string, x: number, y: number): number {
    const def = weaponRegistry.get(weaponDefId);
    if (!def || !def.mine) {
      console.error(`[EntityFactory] Invalid weapon for mine: ${weaponDefId}`);
      return -1;
    }

    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = 0;

    addComponent(this.world, Lifetime, eid);
    Lifetime.remaining[eid] = def.mine.lifetime;

    addComponent(this.world, Mine, eid);
    Mine.ownerId[eid] = ownerId;
    Mine.armTimer[eid] = def.mine.armTime;
    Mine.armed[eid] = 0;
    Mine.splashRadius[eid] = def.splash?.radius ?? 400;
    Mine.damage[eid] = def.damage;

    addComponent(this.world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    return eid;
  }

  // === Dropped Item Creation ===

  createDroppedItem(itemId: number, x: number, y: number, stackCount: number = 1): number {
    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Velocity, eid);
    // Give it a small random velocity
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 2;
    Velocity.x[eid] = Math.cos(angle) * speed;
    Velocity.y[eid] = Math.sin(angle) * speed;

    addComponent(this.world, Lifetime, eid);
    Lifetime.remaining[eid] = 1800; // 30 seconds at 60 ticks/sec

    addComponent(this.world, DroppedItem, eid);
    DroppedItem.itemId[eid] = itemId;
    DroppedItem.stackCount[eid] = stackCount;

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 3;

    return eid;
  }

  // === Station Creation ===

  createStation(stationId: number, x: number, y: number, dockingRadius: number = 200): number {
    const eid = addEntity(this.world);

    addComponent(this.world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(this.world, Rotation, eid);
    Rotation.angle[eid] = 0;

    addComponent(this.world, Station, eid);
    Station.stationId[eid] = stationId;
    Station.dockingRadius[eid] = dockingRadius;

    addComponent(this.world, NetworkSync, eid);
    NetworkSync.priority[eid] = 4;

    return eid;
  }

  // === Utility ===

  /**
   * Spawn a scatter shot (multiple projectiles)
   */
  createScatterShot(
    ownerId: number,
    weaponDefId: string,
    x: number,
    y: number,
    baseAngle: number,
    inheritVx: number,
    inheritVy: number
  ): number[] {
    const def = weaponRegistry.get(weaponDefId);
    if (!def || !def.scatter) {
      return [];
    }

    const projectiles: number[] = [];
    const count = def.scatter.projectileCount;
    const spread = def.scatter.spreadAngle;
    const startAngle = baseAngle - spread / 2;
    const angleStep = spread / (count - 1);

    for (let i = 0; i < count; i++) {
      const angle = startAngle + angleStep * i;
      // Add speed variance
      const speedMult = 1 + (Math.random() - 0.5) * 2 * (def.scatter.speedVariance ?? 0);
      
      const eid = this.createProjectile(
        ownerId,
        weaponDefId,
        x,
        y,
        angle,
        inheritVx,
        inheritVy
      );

      if (eid >= 0) {
        // Apply speed variance
        Velocity.x[eid] *= speedMult;
        Velocity.y[eid] *= speedMult;
        projectiles.push(eid);
      }
    }

    return projectiles;
  }
}
