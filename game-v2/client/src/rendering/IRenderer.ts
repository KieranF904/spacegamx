/**
 * Renderer Interface - Abstraction layer for swappable rendering backends
 * Game logic should only interact with this interface, never directly with PixiJS/WebGL
 */

import { EntityType } from '@space-game/common';

export enum ParticleType {
  Explosion,
  Spark,
  Smoke,
  Trail,
  Debris,
}

export interface EntityRenderData {
  x: number;
  y: number;
  rotation?: number;
  vx?: number;
  vy?: number;
  hp?: number;
  maxHp?: number;
  data?: number[];
}

export interface SystemVisuals {
  starHue: number;
  starRadius: number;
  hasNebula?: boolean;
  nebulaHue?: number;
  sunStyle?: string;
  sunStyleParams?: Record<string, number>;
  coronaStyle?: string;
  coronaStyleParams?: Record<string, number>;
}

export interface IRenderer {
  // Lifecycle
  init(canvas: HTMLCanvasElement): Promise<void>;
  destroy(): void;
  resize(width: number, height: number): void;
  
  // Camera control
  setCamera(x: number, y: number, zoom: number): void;
  getCamera(): { x: number; y: number; zoom: number };
  
  // System/environment
  setSystemVisuals(visuals: SystemVisuals): void;
  
  // Entity management (game doesn't know HOW, just WHAT)
  createEntity(id: number, type: EntityType, data?: number[]): void;
  updateEntity(id: number, renderData: EntityRenderData): void;
  removeEntity(id: number): void;
  
  // Effects
  spawnParticles(x: number, y: number, type: ParticleType, count: number, color?: number): void;
  addDamageNumber(x: number, y: number, amount: number, critical?: boolean): void;
  addTrailPoint(entityId: number, x: number, y: number): void;
  
  // Death screen
  showDeathScreen(killerName?: string): void;
  hideDeathScreen(): void;
  
  // Main render loop
  render(delta: number): void;
  
  // Accessors
  getScreenSize(): { width: number; height: number };
  worldToScreen(worldX: number, worldY: number): { x: number; y: number };
  screenToWorld(screenX: number, screenY: number): { x: number; y: number };
}
