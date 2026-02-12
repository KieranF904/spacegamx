/**
 * Weapon System - Handles weapon firing, cooldowns, and projectile spawning
 * Data-driven using weapon definitions from registry
 */

import { IWorld, defineQuery, hasComponent, addEntity, addComponent } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import {
  Position,
  Velocity,
  Rotation,
  Radius,
  Input,
  Player,
  Equipment,
  WeaponState,
  Projectile,
  Bullet,
  Laser,
  Missile,
  Pulse,
  Mine,
  MiningShot,
  WarpProjectile,
  Lifetime,
  OwnedBy,
  NetworkSync,
  WeaponType,
  weaponRegistry,
  Enemy,
  Asteroid,
  Health,
} from '@space-game/common';

// Define queries
const playerQuery = defineQuery([Position, Velocity, Rotation, Input, Player, Equipment, WeaponState]);
const enemyQuery = defineQuery([Position, Radius, Enemy, Health]);
const asteroidQuery = defineQuery([Position, Asteroid]);

// Weapon type mapping
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

export interface WeaponEffect {
  type: 'bullet' | 'laser' | 'missile' | 'pulse' | 'mine' | 'scatter' | 'warp' | 'mining';
  x: number;
  y: number;
  angle: number;
  ownerId: number;
  weaponId?: string;
  // Laser-specific
  endX?: number;
  endY?: number;
  hitEntityId?: number;
}

export interface LaserDamageEvent {
  ownerId: number;
  targetId: number;
  damage: number;
  hitX: number;
  hitY: number;
}

export class WeaponSystem extends BaseSystem {
  name = 'WeaponSystem';
  priority = SystemPriority.WEAPON;

  private world: IWorld | null = null;
  private currentTick = 0;
  
  // Events emitted for effects
  private pendingEffects: WeaponEffect[] = [];
  private pendingLaserDamage: LaserDamageEvent[] = [];

  init(world: IWorld): void {
    this.world = world;
  }

  update(world: IWorld, tick: number, deltaMs: number): void {
    this.world = world;
    this.currentTick = tick;
    this.pendingEffects = [];

    const players = playerQuery(world);
    
    for (const eid of players) {
      this.processPlayerWeapons(world, eid);
    }
  }

  private processPlayerWeapons(world: IWorld, eid: number): void {
    const fireLeft = Input.fireLeft[eid];
    const fireRight = Input.fireRight[eid];
    
    // Track previous fire state for release detection
    const wasChargingLeft = WeaponState.leftCharging[eid];
    const wasChargingRight = WeaponState.rightCharging[eid];
    
    // Left weapon
    const leftWeaponNum = Equipment.leftWeapon[eid];
    const leftWeaponId = weaponRegistry.getStringId(leftWeaponNum);
    if (leftWeaponId) {
      const leftDef = weaponRegistry.get(leftWeaponId);
      // Charge weapons fire on release, others fire while held
      if (leftDef?.charge && (leftDef.type === 'missile' || leftDef.type === 'pulse')) {
        // Release detection for charge weapons
        if (!fireLeft && wasChargingLeft) {
          this.tryFireChargeWeapon(world, eid, leftWeaponId, 'left');
        }
      } else if (fireLeft) {
        this.tryFireWeapon(world, eid, leftWeaponId, 'left');
      }
    }
    
    // Right weapon
    const rightWeaponNum = Equipment.rightWeapon[eid];
    const rightWeaponId = weaponRegistry.getStringId(rightWeaponNum);
    if (rightWeaponId) {
      const rightDef = weaponRegistry.get(rightWeaponId);
      // Charge weapons fire on release, others fire while held
      if (rightDef?.charge && (rightDef.type === 'missile' || rightDef.type === 'pulse')) {
        // Release detection for charge weapons
        if (!fireRight && wasChargingRight) {
          this.tryFireChargeWeapon(world, eid, rightWeaponId, 'right');
        }
      } else if (fireRight) {
        this.tryFireWeapon(world, eid, rightWeaponId, 'right');
      }
    }

    // Update charge states and charging flags
    this.updateChargeState(world, eid, 'left', !!fireLeft);
    this.updateChargeState(world, eid, 'right', !!fireRight);
    WeaponState.leftCharging[eid] = fireLeft ? 1 : 0;
    WeaponState.rightCharging[eid] = fireRight ? 1 : 0;
  }

  private tryFireChargeWeapon(
    world: IWorld,
    eid: number,
    weaponId: string,
    slot: 'left' | 'right'
  ): void {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.charge) return;

    // Check cooldown
    const cooldownProp = slot === 'left' ? 'leftCooldown' : 'rightCooldown';
    if (WeaponState[cooldownProp][eid] > 0) {
      return;
    }

    // Get charge level
    const chargeProp = slot === 'left' ? 'leftCharge' : 'rightCharge';
    const chargeLevel = WeaponState[chargeProp][eid];
    
    // Check minimum charge
    const minCharge = def.charge.minChargeToFire ?? 0;
    if (chargeLevel < minCharge) {
      WeaponState[chargeProp][eid] = 0; // Reset charge
      return;
    }

    const x = Position.x[eid];
    const y = Position.y[eid];
    const angle = Input.targetAngle[eid];
    const vx = Velocity.x[eid];
    const vy = Velocity.y[eid];

    if (def.type === 'missile') {
      this.fireChargedMissiles(world, eid, weaponId, x, y, angle, vx, vy, chargeLevel, def.charge.maxTicks);
    } else if (def.type === 'pulse') {
      this.firePulse(world, eid, weaponId, x, y, angle, slot);
    }

    // Set cooldown and reset charge
    WeaponState[cooldownProp][eid] = def.cooldown;
    WeaponState[chargeProp][eid] = 0;
  }

  private fireChargedMissiles(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number,
    chargeLevel: number,
    maxCharge: number
  ): number[] {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return [];

    // Calculate number of missiles based on charge and tier
    // Tier 1: 1-3 missiles, Tier 2: 1-5 missiles, Tier 3: 1-8 missiles
    const maxMissiles = def.tier === 1 ? 3 : def.tier === 2 ? 5 : 8;
    const chargeRatio = chargeLevel / maxCharge;
    const missileCount = Math.max(1, Math.floor(chargeRatio * maxMissiles));
    
    const missiles: number[] = [];
    const spreadAngle = Math.PI / 8; // Spread missiles in a small arc
    
    for (let i = 0; i < missileCount; i++) {
      // Calculate angle offset for spread
      let missileAngle = angle;
      if (missileCount > 1) {
        const offset = (i / (missileCount - 1) - 0.5) * spreadAngle;
        missileAngle = angle + offset;
      }
      
      // Slight position offset for visual separation
      const offsetDist = 10;
      const offsetAngle = missileAngle + Math.PI / 2;
      const px = x + Math.cos(offsetAngle) * (i - missileCount / 2) * offsetDist;
      const py = y + Math.sin(offsetAngle) * (i - missileCount / 2) * offsetDist;
      
      const eid = this.fireSingleMissile(world, ownerId, weaponId, px, py, missileAngle, inheritVx, inheritVy);
      if (eid >= 0) {
        missiles.push(eid);
      }
    }

    return missiles;
  }

  private fireSingleMissile(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return -1;

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage;
    Projectile.weaponType[eid] = WeaponType.Missile;
    Projectile.tier[eid] = def.tier;

    addComponent(world, Missile, eid);
    Missile.targetId[eid] = 0;
    Missile.turnRate[eid] = def.homing?.turnRate ?? 0.07;
    Missile.fuel[eid] = def.homing?.fuel ?? 360;
    Missile.armed[eid] = 0;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    this.pendingEffects.push({
      type: 'missile',
      x, y, angle,
      ownerId,
      weaponId,
    });

    return eid;
  }

  private tryFireWeapon(
    world: IWorld,
    eid: number,
    weaponId: string,
    slot: 'left' | 'right'
  ): void {
    const def = weaponRegistry.get(weaponId);
    if (!def) return;

    // Check cooldown
    const cooldownProp = slot === 'left' ? 'leftCooldown' : 'rightCooldown';
    if (WeaponState[cooldownProp][eid] > 0) {
      WeaponState[cooldownProp][eid]--;
      return;
    }

    // Fire weapon
    const x = Position.x[eid];
    const y = Position.y[eid];
    const angle = Input.targetAngle[eid]; // Fire toward mouse
    const vx = Velocity.x[eid];
    const vy = Velocity.y[eid];

    switch (def.type) {
      case 'cannon':
        this.fireBullet(world, eid, weaponId, x, y, angle, vx, vy);
        break;
      case 'scatter':
        this.fireScatter(world, eid, weaponId, x, y, angle, vx, vy);
        break;
      case 'missile':
        this.fireMissile(world, eid, weaponId, x, y, angle, vx, vy);
        break;
      case 'pulse':
        this.firePulse(world, eid, weaponId, x, y, angle, slot);
        break;
      case 'mine':
        this.deployMine(world, eid, weaponId, x, y);
        break;
      case 'laser':
        // Lasers are continuous, handled differently
        this.fireLaser(world, eid, weaponId, x, y, angle, slot);
        break;
      case 'mining':
        this.fireMiningShot(world, eid, weaponId, x, y, angle, vx, vy);
        break;
      case 'warp':
        this.fireWarpShot(world, eid, weaponId, x, y, angle, vx, vy);
        break;
    }

    // Set cooldown
    WeaponState[cooldownProp][eid] = def.cooldown;
  }

  private fireBullet(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return -1;

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage;
    Projectile.weaponType[eid] = weaponTypeMap[def.type] ?? WeaponType.Cannon;
    Projectile.tier[eid] = def.tier;

    addComponent(world, Bullet, eid);
    Bullet.speed[eid] = speed;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    this.pendingEffects.push({
      type: 'bullet',
      x, y, angle,
      ownerId,
      weaponId,
    });

    return eid;
  }

  private fireScatter(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    baseAngle: number,
    inheritVx: number,
    inheritVy: number
  ): number[] {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.scatter) return [];

    const projectiles: number[] = [];
    const count = def.scatter.projectileCount;
    const spread = def.scatter.spreadAngle;
    const startAngle = baseAngle - spread / 2;
    const angleStep = count > 1 ? spread / (count - 1) : 0;

    for (let i = 0; i < count; i++) {
      const angle = startAngle + angleStep * i;
      const speedMult = 1 + (Math.random() - 0.5) * 2 * (def.scatter.speedVariance ?? 0);
      
      const eid = this.fireBullet(world, ownerId, weaponId, x, y, angle, inheritVx, inheritVy);
      if (eid >= 0) {
        Velocity.x[eid] *= speedMult;
        Velocity.y[eid] *= speedMult;
        projectiles.push(eid);
      }
    }

    this.pendingEffects.push({
      type: 'scatter',
      x, y, angle: baseAngle,
      ownerId,
      weaponId,
    });

    return projectiles;
  }

  private fireMissile(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return -1;

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage;
    Projectile.weaponType[eid] = WeaponType.Missile;
    Projectile.tier[eid] = def.tier;

    addComponent(world, Missile, eid);
    Missile.targetId[eid] = 0; // Will be set by homing system
    Missile.turnRate[eid] = def.homing?.turnRate ?? 0.07;
    Missile.fuel[eid] = def.homing?.fuel ?? 360;
    Missile.armed[eid] = 0;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    this.pendingEffects.push({
      type: 'missile',
      x, y, angle,
      ownerId,
      weaponId,
    });

    return eid;
  }

  private firePulse(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    slot: 'left' | 'right'
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return -1;

    // Get charge level
    const chargeProp = slot === 'left' ? 'leftCharge' : 'rightCharge';
    const chargeLevel = WeaponState[chargeProp][ownerId] / (def.charge?.maxTicks ?? 60);

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed;
    Velocity.y[eid] = Math.sin(angle) * speed;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    // Size based on charge
    const baseSizeMult = 1 + chargeLevel * ((def.charge?.sizeMultiplier ?? 2) - 1);
    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius * baseSizeMult;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    // Damage based on charge
    const damageMult = 1 + chargeLevel * ((def.charge?.damageMultiplier ?? 3) - 1);
    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage * damageMult;
    Projectile.weaponType[eid] = WeaponType.Pulse;
    Projectile.tier[eid] = def.tier;

    addComponent(world, Pulse, eid);
    Pulse.chargeLevel[eid] = chargeLevel;
    Pulse.splashRadius[eid] = def.splash?.radius ?? 200;
    Pulse.growing[eid] = 1;
    Pulse.growTimer[eid] = 0;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    // Reset charge
    WeaponState[chargeProp][ownerId] = 0;

    this.pendingEffects.push({
      type: 'pulse',
      x, y, angle,
      ownerId,
      weaponId,
    });

    return eid;
  }

  // Track active mines per player per slot
  private playerMines: Map<number, Map<string, number[]>> = new Map();

  private deployMine(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.mine) return -1;

    // Get or create mine tracking for this player
    if (!this.playerMines.has(ownerId)) {
      this.playerMines.set(ownerId, new Map());
    }
    const playerMineSlots = this.playerMines.get(ownerId)!;
    
    if (!playerMineSlots.has(weaponId)) {
      playerMineSlots.set(weaponId, []);
    }
    const mines = playerMineSlots.get(weaponId)!;
    
    // Check max mines - if at max, detonate oldest armed mine
    const maxMines = def.mine.maxCount ?? 3;
    if (mines.length >= maxMines) {
      // Find and detonate oldest armed mine
      for (let i = 0; i < mines.length; i++) {
        const mineEid = mines[i];
        if (hasComponent(world, Mine, mineEid) && Mine.armed[mineEid]) {
          this.pendingMineDetonations.push(mineEid);
          mines.splice(i, 1);
          break;
        }
      }
      
      // If we still have max mines (none were armed), detonate oldest anyway
      if (mines.length >= maxMines) {
        const oldestMine = mines.shift()!;
        if (hasComponent(world, Mine, oldestMine)) {
          this.pendingMineDetonations.push(oldestMine);
        }
      }
    }

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = 0;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.mine.lifetime;

    addComponent(world, Mine, eid);
    Mine.ownerId[eid] = ownerId;
    Mine.armTimer[eid] = def.mine.armTime;
    Mine.armed[eid] = 0;
    Mine.splashRadius[eid] = def.splash?.radius ?? 400;
    Mine.damage[eid] = def.damage;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;
    
    // Track this mine
    mines.push(eid);

    this.pendingEffects.push({
      type: 'mine',
      x, y, angle: 0,
      ownerId,
      weaponId,
    });

    return eid;
  }

  private fireMiningShot(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile || !def.mining) return -1;

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    // Mining shots are slow
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = def.damage;
    Projectile.weaponType[eid] = WeaponType.Mining;
    Projectile.tier[eid] = def.tier;

    addComponent(world, MiningShot, eid);
    MiningShot.attachedToId[eid] = 0; // Not attached yet
    MiningShot.dotDuration[eid] = def.mining.dotDuration;
    MiningShot.dotInterval[eid] = def.mining.dotInterval;
    MiningShot.dotTimer[eid] = def.mining.dotInterval;
    MiningShot.dotDamage[eid] = def.damage * def.mining.dotFactor;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    return eid;
  }

  private fireWarpShot(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    inheritVx: number,
    inheritVy: number
  ): number {
    const def = weaponRegistry.get(weaponId);
    if (!def || !def.projectile) return -1;

    const eid = addEntity(world);

    addComponent(world, Position, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;

    addComponent(world, Velocity, eid);
    // Warp shots are slower moving projectiles
    const speed = def.projectile.speed;
    Velocity.x[eid] = Math.cos(angle) * speed + inheritVx * def.projectile.inheritVelocity;
    Velocity.y[eid] = Math.sin(angle) * speed + inheritVy * def.projectile.inheritVelocity;

    addComponent(world, Rotation, eid);
    Rotation.angle[eid] = angle;

    addComponent(world, Radius, eid);
    Radius.value[eid] = def.projectile.radius;

    addComponent(world, Lifetime, eid);
    Lifetime.remaining[eid] = def.projectile.lifetime;

    addComponent(world, Projectile, eid);
    Projectile.ownerId[eid] = ownerId;
    Projectile.damage[eid] = 0; // Warp doesn't do damage directly
    Projectile.weaponType[eid] = WeaponType.Warp;
    Projectile.tier[eid] = def.tier;

    addComponent(world, WarpProjectile, eid);
    WarpProjectile.ownerId[eid] = ownerId;
    WarpProjectile.activationTimer[eid] = 60; // 1 second to activate
    WarpProjectile.warpSpeed[eid] = def.warp?.launchSpeed ?? 800;

    addComponent(world, OwnedBy, eid);
    OwnedBy.ownerId[eid] = ownerId;

    addComponent(world, NetworkSync, eid);
    NetworkSync.priority[eid] = 2;

    this.pendingEffects.push({
      type: 'warp',
      x, y, angle,
      ownerId,
    });

    return eid;
  }
  
  // Public getter for pending mine detonations
  private pendingMineDetonations: number[] = [];
  
  getPendingMineDetonations(): number[] {
    return this.pendingMineDetonations;
  }
  
  clearMineDetonations(): void {
    this.pendingMineDetonations = [];
  }
  
  // Called when a mine is destroyed (by explosion or lifetime)
  removeMineFromTracking(mineEid: number): void {
    for (const [playerId, slots] of this.playerMines) {
      for (const [weaponId, mines] of slots) {
        const idx = mines.indexOf(mineEid);
        if (idx !== -1) {
          mines.splice(idx, 1);
          return;
        }
      }
    }
  }

  private fireLaser(
    world: IWorld,
    ownerId: number,
    weaponId: string,
    x: number,
    y: number,
    angle: number,
    slot: 'left' | 'right'
  ): void {
    const def = weaponRegistry.get(weaponId);
    if (!def) return;
    
    // Get laser config (use defaults if not defined)
    const laserConfig = def.laser;
    const range = laserConfig?.range ?? 3000;
    const maxDamage = laserConfig?.damageMax ?? (def.damage * 2);
    const tickCooldown = laserConfig?.tickCooldown ?? 6;
    
    // Check laser damage cooldown (prevent rapid damage)
    const laserCooldownProp = slot === 'left' ? 'leftCooldown' : 'rightCooldown';
    const canDamage = WeaponState[laserCooldownProp][ownerId] <= 0;
    
    // Calculate end point
    const endX = x + Math.cos(angle) * range;
    const endY = y + Math.sin(angle) * range;
    
    // Find closest entity hit by the laser ray
    let closestHit: { eid: number; dist: number; x: number; y: number } | null = null;
    
    // Check enemies
    for (const eid of enemyQuery(world)) {
      const ex = Position.x[eid];
      const ey = Position.y[eid];
      const radius = Radius.value[eid] || 30;
      
      const hit = this.rayCircleIntersection(x, y, angle, range, ex, ey, radius);
      if (hit && (!closestHit || hit.dist < closestHit.dist)) {
        closestHit = { eid, dist: hit.dist, x: hit.x, y: hit.y };
      }
    }
    
    // Check asteroids
    for (const eid of asteroidQuery(world)) {
      const ax = Position.x[eid];
      const ay = Position.y[eid];
      const size = Asteroid.size[eid] || 50;
      const radius = size * 0.8; // Approximate asteroid hitbox
      
      const hit = this.rayCircleIntersection(x, y, angle, range, ax, ay, radius);
      if (hit && (!closestHit || hit.dist < closestHit.dist)) {
        closestHit = { eid, dist: hit.dist, x: hit.x, y: hit.y };
      }
    }
    
    // Calculate actual end point (either hit point or max range)
    let actualEndX = endX;
    let actualEndY = endY;
    let hitEntityId = 0;
    
    if (closestHit) {
      actualEndX = closestHit.x;
      actualEndY = closestHit.y;
      hitEntityId = closestHit.eid;
      
      // Apply damage with distance falloff
      if (canDamage) {
        const distRatio = closestHit.dist / range;
        const damageFalloff = Math.max(0, 1 - distRatio);
        const damage = (maxDamage / 10) * damageFalloff; // Per-tick damage
        
        this.pendingLaserDamage.push({
          ownerId,
          targetId: closestHit.eid,
          damage,
          hitX: closestHit.x,
          hitY: closestHit.y,
        });
        
        // Set damage cooldown
        WeaponState[laserCooldownProp][ownerId] = tickCooldown;
      }
    }
    
    // Update laser state for player (use any cast as fields are dynamically named)
    if (slot === 'left') {
      (WeaponState as any).leftLaserActive[ownerId] = 1;
      (WeaponState as any).leftLaserEndX[ownerId] = actualEndX;
      (WeaponState as any).leftLaserEndY[ownerId] = actualEndY;
      (WeaponState as any).leftLaserHitId[ownerId] = hitEntityId;
    } else {
      (WeaponState as any).rightLaserActive[ownerId] = 1;
      (WeaponState as any).rightLaserEndX[ownerId] = actualEndX;
      (WeaponState as any).rightLaserEndY[ownerId] = actualEndY;
      (WeaponState as any).rightLaserHitId[ownerId] = hitEntityId;
    }
    
    // Emit effect for client rendering
    this.pendingEffects.push({
      type: 'laser',
      x, y, angle,
      ownerId,
      weaponId,
      endX: actualEndX,
      endY: actualEndY,
      hitEntityId,
    });
  }
  
  /**
   * Ray-circle intersection test
   * Returns the closest intersection point or null if no hit
   */
  private rayCircleIntersection(
    rayX: number, rayY: number, rayAngle: number, rayLength: number,
    circleX: number, circleY: number, circleRadius: number
  ): { dist: number; x: number; y: number } | null {
    // Direction vector
    const dx = Math.cos(rayAngle);
    const dy = Math.sin(rayAngle);
    
    // Vector from ray origin to circle center
    const fx = rayX - circleX;
    const fy = rayY - circleY;
    
    // Quadratic coefficients
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - circleRadius * circleRadius;
    
    const discriminant = b * b - 4 * a * c;
    
    if (discriminant < 0) {
      return null; // No intersection
    }
    
    const sqrtDisc = Math.sqrt(discriminant);
    let t = (-b - sqrtDisc) / (2 * a);
    
    // If first intersection is behind ray, try the second
    if (t < 0) {
      t = (-b + sqrtDisc) / (2 * a);
    }
    
    // Check if intersection is within ray length and in front
    if (t >= 0 && t <= rayLength) {
      return {
        dist: t,
        x: rayX + dx * t,
        y: rayY + dy * t,
      };
    }
    
    return null;
  }

  private updateChargeState(
    world: IWorld,
    eid: number,
    slot: 'left' | 'right',
    isHeld: boolean
  ): void {
    const weaponNum = slot === 'left' ? Equipment.leftWeapon[eid] : Equipment.rightWeapon[eid];
    const weaponId = weaponRegistry.getStringId(weaponNum);
    if (!weaponId) return;

    const def = weaponRegistry.get(weaponId);
    if (!def || !def.charge) return;

    const chargeProp = slot === 'left' ? 'leftCharge' : 'rightCharge';
    
    if (isHeld) {
      // Build charge
      WeaponState[chargeProp][eid] = Math.min(
        def.charge.maxTicks,
        WeaponState[chargeProp][eid] + 1
      );
    } else {
      // Decay charge when not held
      WeaponState[chargeProp][eid] = Math.max(
        0,
        WeaponState[chargeProp][eid] - 1
      );
    }
  }

  // === Public API ===

  getPendingEffects(): WeaponEffect[] {
    return this.pendingEffects;
  }

  clearEffects(): void {
    this.pendingEffects = [];
  }
}
