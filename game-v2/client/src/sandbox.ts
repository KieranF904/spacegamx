/**
 * Visual Sandbox - Modular dev tool with draggable windows
 * 
 * Features:
 * - Drag to pan, scroll to zoom (3x range)
 * - Tool picker (pan vs spawn mode)
 * - Draggable windows for each control category
 * - Comprehensive sliders for sun, glow, and stars
 * - Spawn only when explicitly selected
 * - Admin server connectivity for live server editing
 */

import { Application, Container, Graphics } from 'pixi.js';
import { BitBuffer, sunShaderDefs, generateStars } from '@space-game/common';
import { SunRenderer } from './rendering/SunRenderer';
import { GlowRenderer } from './rendering/GlowRenderer';
import { StarfieldRenderer } from './rendering/StarfieldRenderer';
import { NebulaRenderer } from './rendering/NebulaRenderer';
import { CoronaRaysRenderer } from './rendering/CoronaRaysRenderer';

// Simplex noise constants
const SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
const SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;
const SIMPLEX_GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];

// Star layer config
interface StarLayerConfig {
  zMin: number;
  zMax: number;
  minSize: number;
  maxSize: number;
  baseCount: number;
  minZoom: number;
  noiseScale: number;
  noiseSeed: number;
  noiseThreshold: number;
}

interface StarData {
  x: number;
  y: number;
  z: number;
  size: number;
  hue: number;
  phase: number;
  brightness: number;
}

const STAR_LAYERS: StarLayerConfig[] = [
  { zMin: 400, zMax: 800, minSize: 6.0, maxSize: 10.0, baseCount: 4, minZoom: 0, noiseScale: 0.00008, noiseSeed: 100, noiseThreshold: 0.5 },
  { zMin: 800, zMax: 1500, minSize: 4.0, maxSize: 7.0, baseCount: 8, minZoom: 0, noiseScale: 0.00015, noiseSeed: 200, noiseThreshold: 0.5 },
  { zMin: 900, zMax: 1500, minSize: 2.5, maxSize: 4.5, baseCount: 10, minZoom: 0, noiseScale: 0.0008, noiseSeed: 300, noiseThreshold: 0 },
  { zMin: 1500, zMax: 2200, minSize: 1.5, maxSize: 3.0, baseCount: 14, minZoom: 0.05, noiseScale: 0.001, noiseSeed: 400, noiseThreshold: 0 },
  { zMin: 2200, zMax: 3000, minSize: 1.0, maxSize: 2.0, baseCount: 20, minZoom: 0.15, noiseScale: 0.0015, noiseSeed: 500, noiseThreshold: 0 },
  { zMin: 3000, zMax: 4500, minSize: 0.6, maxSize: 1.2, baseCount: 28, minZoom: 0.3, noiseScale: 0.002, noiseSeed: 600, noiseThreshold: 0 },
];

interface TestEntity {
  id: number;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  graphic: Container;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  size: number;
  graphic: Graphics;
}

interface ElementParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  group?: string;
}

interface ElementColorDef {
  key: string;
  label: string;
  default: string;
}

interface ElementDefinition {
  id: string;
  name: string;
  category: string;
  params: ElementParamDef[];
  colors?: ElementColorDef[];
}

type EditorMode = 'system' | 'galaxy';

interface SystemNode {
  id: string;
  name: string;
  x: number;           // galaxy-space position
  y: number;
  boundaryRadius: number;
  color: string;       // hex color for the node
  elementsBase64: string;  // serialized element data
}

interface ElementInstance {
  id: number;
  defId: string;
  x: number;
  y: number;
  renderOrder: number;
  parentId?: number;
  parentOffsetX?: number;
  parentOffsetY?: number;
  rotation: number;
  params: Record<string, number>;
  stringParams: Record<string, string>;
  graphic: Graphics;
  hitRadius: number;
  lockToOrigin: boolean;
  sunRenderer?: SunRenderer;
  coronaRenderer?: CoronaRaysRenderer;
  glowRenderer?: GlowRenderer;
  nebulaRenderer?: NebulaRenderer;
  seed: number;
}

interface HistoryEntry {
  label: string;
  timestamp: number;
  changes: HistoryChangeSet;
}

interface ElementState {
  id: number;
  defId: string;
  x: number;
  y: number;
  rotation: number;
  lockToOrigin: boolean;
  seed: number;
  renderOrder: number;
  parentId?: number;
  parentOffsetX?: number;
  parentOffsetY?: number;
  params: Record<string, number>;
  stringParams: Record<string, string>;
}

interface HistoryChangeSet {
  created: ElementState[];
  deleted: ElementState[];
  updated: Array<{ before: ElementState; after: ElementState }>;
}

const ELEMENT_LIBRARY: ElementDefinition[] = [
  {
    id: 'sun',
    name: 'Sun',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 1400, step: 10, default: 600 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 40 },
      { key: 'variant', label: 'Variant', min: 1, max: 5, step: 1, default: 1 },
      { key: 'noiseScale', label: 'Noise Scale', min: 0.2, max: 3, step: 0.1, default: 1.2 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'detail_sun',
    name: 'Detail Sun',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 3000, step: 10, default: 1000, group: 'Core' },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 40, group: 'Core' },
      { key: 'octaves', label: 'Octaves', min: 1, max: 8, step: 1, default: 5, group: 'fBM' },
      { key: 'lacunarity', label: 'Lacunarity', min: 1, max: 4, step: 0.1, default: 2.0, group: 'fBM' },
      { key: 'gain', label: 'Gain', min: 0.1, max: 1, step: 0.05, default: 0.5, group: 'fBM' },
      { key: 'noiseScale', label: 'Noise Scale', min: 0.5, max: 10, step: 0.5, default: 4.0, group: 'fBM' },
      { key: 'animSpeed', label: 'Anim Speed', min: 0, max: 1, step: 0.01, default: 0.15, group: 'fBM' },
      { key: 'fbmContrast', label: 'Contrast', min: 0.5, max: 2.0, step: 0.1, default: 1.0, group: 'fBM' },
      { key: 'warpAmount', label: 'Warp Amount', min: 0, max: 2, step: 0.05, default: 0.4, group: 'Warp' },
      { key: 'warpScale', label: 'Warp Scale', min: 0.1, max: 2.0, step: 0.1, default: 0.5, group: 'Warp' },
      { key: 'turbulenceMix', label: 'Turbulence', min: 0, max: 1, step: 0.05, default: 0.3, group: 'Warp' },
      { key: 'plasmaIntensity', label: 'Plasma Intensity', min: 0, max: 1, step: 0.05, default: 0.3, group: 'Plasma' },
      { key: 'plasmaScale', label: 'Plasma Scale', min: 0.5, max: 8, step: 0.5, default: 3.0, group: 'Plasma' },
      { key: 'plasmaSpeed', label: 'Plasma Speed', min: 0.1, max: 3, step: 0.1, default: 1.0, group: 'Plasma' },
      { key: 'centerDarken', label: 'Darken Darks', min: 0, max: 2, step: 0.1, default: 0.5, group: 'Center' },
      { key: 'centerHighlight', label: 'Highlight Brights', min: 0, max: 2, step: 0.1, default: 0.5, group: 'Center' },
      { key: 'centerMidpoint', label: 'Midpoint', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Center' },
      { key: 'centerFalloff', label: 'Center Falloff', min: 0.5, max: 5, step: 0.25, default: 1.5, group: 'Center' },
      { key: 'innerDarkening', label: 'Inner Dark', min: 0, max: 1, step: 0.05, default: 0.0, group: 'Inside' },
      { key: 'whiteBalance', label: 'Warm/Cool', min: -1, max: 1, step: 0.1, default: 0.0, group: 'Inside' },
      { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.1, default: 1.0, group: 'Inside' },
      { key: 'edgeBrightness', label: 'Edge Brightness', min: 0.2, max: 2, step: 0.1, default: 1.0, group: 'Edge' },
      { key: 'edgeThickness', label: 'Edge Thickness', min: 0.01, max: 0.15, step: 0.01, default: 0.03, group: 'Edge' },
      { key: 'edgeSharpness', label: 'Edge Sharpness', min: 0.1, max: 1, step: 0.05, default: 0.5, group: 'Edge' },
      { key: 'limbDarkening', label: 'Limb Dark', min: 0, max: 1, step: 0.05, default: 0.5, group: 'Edge' },
    ],
    colors: [
      { key: 'darkColor', label: 'Dark', default: '#1a0500' },
      { key: 'midColor', label: 'Mid', default: '#661100' },
      { key: 'brightColor', label: 'Bright', default: '#ff6600' },
      { key: 'edgeColor', label: 'Edge', default: '#ffaa33' },
      { key: 'plasmaColor', label: 'Plasma', default: '#ff9933' },
      { key: 'centerColor', label: 'Center', default: '#ffe6cc' },
    ],
  },
  {
    id: 'detail_corona',
    name: 'Detail Corona (Solar Rays)',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius / Offset', min: -2000, max: 3000, step: 10, default: 1000, group: 'Core' },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 40, group: 'Core' },
      { key: 'coronaSize', label: 'Corona Size', min: 0.5, max: 4, step: 0.1, default: 2.0, group: 'Corona' },
      { key: 'coronaIntensity', label: 'Corona Intensity', min: 0, max: 2, step: 0.1, default: 0.8, group: 'Corona' },
      { key: 'rayCount', label: 'Ray Count', min: 3, max: 16, step: 1, default: 10, group: 'Rays' },
      { key: 'rayWidth', label: 'Ray Width', min: 0.02, max: 0.2, step: 0.01, default: 0.06, group: 'Rays' },
      { key: 'rayVariation', label: 'Intensity Noise', min: 0, max: 1, step: 0.05, default: 0.35, group: 'Rays' },
      { key: 'raySpeed', label: 'Ray Motion', min: 0, max: 1.5, step: 0.05, default: 0.35, group: 'Rays' },
      { key: 'rayTurbulence', label: 'Ray Turbulence', min: 0, max: 1, step: 0.05, default: 0.15, group: 'Rays' },
      { key: 'atmosphereInnerRadius', label: 'Atmo Inner', min: 0.2, max: 2.5, step: 0.05, default: 0.7, group: 'Atmosphere' },
      { key: 'atmosphereOuterRadius', label: 'Atmo Outer', min: 0.3, max: 4, step: 0.05, default: 2.2, group: 'Atmosphere' },
      { key: 'coronaInnerRadius', label: 'Corona Inner', min: 0.2, max: 2.5, step: 0.05, default: 1.0, group: 'Corona' },
      { key: 'coronaOuterRadius', label: 'Corona Outer', min: 0.3, max: 4, step: 0.05, default: 1.5, group: 'Corona' },
    ],
    colors: [
      { key: 'baseColor', label: 'Base', default: '#ffb366' },
      { key: 'tipColor', label: 'Tip', default: '#ffe0b0' },
    ],
  },
  {
    id: 'detail_atmosphere',
    name: 'Detail Atmosphere',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Sun Radius', min: 200, max: 3000, step: 10, default: 1000, group: 'Core' },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 40, group: 'Core' },
      { key: 'glowIntensity', label: 'Glow Intensity', min: 0, max: 1, step: 0.05, default: 0.6, group: 'Glow' },
      { key: 'glowSize', label: 'Glow Size', min: 0.01, max: 0.3, step: 0.01, default: 0.1, group: 'Glow' },
      { key: 'glowRadius', label: 'Glow Radius', min: 2000, max: 25000, step: 500, default: 8000, group: 'Glow' },
    ],
    colors: [
      { key: 'innerColor', label: 'Inner', default: '#ffbb66' },
      { key: 'outerColor', label: 'Outer', default: '#ff9966' },
    ],
  },
  {
    id: 'corona_soft',
    name: 'Corona (Soft Glow)',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 150, max: 1400, step: 10, default: 700 },
      { key: 'thickness', label: 'Thickness', min: 10, max: 120, step: 2, default: 40 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.5, step: 0.05, default: 0.85 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 45 },
      { key: 'flicker', label: 'Flicker', min: 0, max: 2, step: 0.05, default: 0.6 },
    ],
  },
  {
    id: 'corona_streams',
    name: 'Corona (Plasma Streams)',
    category: 'Star',
    params: [
      { key: 'radius', label: 'Radius', min: 150, max: 1600, step: 10, default: 780 },
      { key: 'streams', label: 'Streams', min: 4, max: 18, step: 1, default: 8 },
      { key: 'width', label: 'Width', min: 6, max: 60, step: 2, default: 20 },
      { key: 'speed', label: 'Speed', min: 0, max: 2.5, step: 0.05, default: 1.1 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.6, step: 0.05, default: 1.0 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 30 },
    ],
  },
  {
    id: 'ambient_glow',
    name: 'Ambient Glow',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 2000, step: 20, default: 900 },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1.2, step: 0.05, default: 0.5 },
      { key: 'falloff', label: 'Falloff', min: 0.2, max: 4, step: 0.1, default: 1.6 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 220 },
    ],
  },
  {
    id: 'nebula',
    name: 'Nebula Cloud',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 5000, step: 50, default: 1200, group: 'Shape' },
      { key: 'shapeScale', label: 'Shape Scale', min: 0.5, max: 100.0, step: 0.05, default: 3.0, group: 'Shape' },
      { key: 'intensity', label: 'Intensity', min: 0.0, max: 3.0, step: 0.05, default: 1.0, group: 'Visual' },
      { key: 'parallax', label: 'Parallax', min: -2.0, max: 2.0, step: 0.05, default: 0.0, group: 'Visual' },
      { key: 'animSpeed', label: 'Anim Speed', min: 0.0, max: 3.0, step: 0.05, default: 1.0, group: 'Animation' },
    ],
  },
  {
    id: 'black_hole',
    name: 'Black Hole',
    category: 'Anomaly',
    params: [
      { key: 'radius', label: 'Radius', min: 80, max: 700, step: 10, default: 260 },
      { key: 'disk', label: 'Disk Size', min: 20, max: 200, step: 5, default: 80 },
      { key: 'warp', label: 'Warp', min: 0, max: 1.5, step: 0.05, default: 0.7 },
      { key: 'glow', label: 'Glow', min: 0, max: 1.5, step: 0.05, default: 0.9 },
      { key: 'hue', label: 'Disk Hue', min: 0, max: 360, step: 1, default: 260 },
    ],
  },
  {
    id: 'wormhole',
    name: 'Wormhole',
    category: 'Anomaly',
    params: [
      { key: 'radius', label: 'Radius', min: 120, max: 800, step: 10, default: 320 },
      { key: 'rings', label: 'Rings', min: 4, max: 14, step: 1, default: 8 },
      { key: 'twist', label: 'Twist', min: 0, max: 1.5, step: 0.05, default: 0.8 },
      { key: 'intensity', label: 'Intensity', min: 0.2, max: 1.6, step: 0.05, default: 1.0 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 190 },
    ],
  },
  {
    id: 'aurora_arc',
    name: 'Aurora Arc',
    category: 'Atmosphere',
    params: [
      { key: 'radius', label: 'Radius', min: 160, max: 1000, step: 10, default: 420 },
      { key: 'length', label: 'Arc Length', min: 40, max: 300, step: 5, default: 160 },
      { key: 'thickness', label: 'Thickness', min: 6, max: 60, step: 2, default: 20 },
      { key: 'shimmer', label: 'Shimmer', min: 0, max: 1.5, step: 0.05, default: 0.7 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 140 },
    ],
  },
  {
    id: 'comet',
    name: 'Comet',
    category: 'Object',
    params: [
      { key: 'radius', label: 'Radius', min: 20, max: 140, step: 2, default: 38 },
      { key: 'tail', label: 'Tail Length', min: 40, max: 360, step: 5, default: 140 },
      { key: 'width', label: 'Tail Width', min: 6, max: 80, step: 2, default: 26 },
      { key: 'sparkle', label: 'Sparkle', min: 0, max: 1.2, step: 0.05, default: 0.5 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 210 },
    ],
  },
  {
    id: 'asteroid_belt',
    name: 'Asteroid Belt',
    category: 'Field',
    params: [
      { key: 'radius', label: 'Radius', min: 200, max: 1600, step: 20, default: 620 },
      { key: 'thickness', label: 'Thickness', min: 40, max: 320, step: 10, default: 120 },
      { key: 'count', label: 'Count', min: 40, max: 240, step: 10, default: 120 },
      { key: 'variation', label: 'Variation', min: 0, max: 1, step: 0.05, default: 0.6 },
      { key: 'hue', label: 'Hue', min: 0, max: 360, step: 1, default: 30 },
    ],
  },
];

const SUN_VARIANTS = [
  {
    name: 'Boiling Cells',
    sunStyle: 0,
    sunParams: [0.64, 0.9, 1.4, 0.85, 1.4, 0.55],
    coronaStyle: 0,
    coronaParams: [1.0, 1.4, 1.0, 0.2, 0.2, 0.6],
  },
  {
    name: 'Chromosphere',
    sunStyle: 1,
    sunParams: [0.5, 0.6, 1.0, 0.35, 1.0, 0.35],
    coronaStyle: 0,
    coronaParams: [1.0, 2.2, 0.8, 0.2, 0.2, 0.4],
  },
  {
    name: 'White Dwarf',
    sunStyle: 2,
    sunParams: [0.42, 0.3, 1.8, 0.2, 1.6, 0.75],
    coronaStyle: 0,
    coronaParams: [1.0, 1.2, 1.4, 0.25, 0.2, 0.4],
  },
  {
    name: 'Polar Storm',
    sunStyle: 3,
    sunParams: [0.52, 1.2, 1.1, 0.9, 1.5, 0.6],
    coronaStyle: 1,
    coronaParams: [1.0, 10, 0.14, 1.8, 0.8, 0.7],
  },
  {
    name: 'Iron Sun',
    sunStyle: 4,
    sunParams: [0.7, 0.2, 0.8, 0.35, 1.0, 0.3],
    coronaStyle: 0,
    coronaParams: [1.0, 1.6, 0.7, 0.2, 0.2, 0.3],
  },
];

class VisualSandbox {
  private app!: Application;
  private worldContainer!: Container;
  private backgroundContainer!: Container;
  private elementContainer!: Container;
  private entityContainer!: Container;
  private effectContainer!: Container;
  private gridCanvas!: HTMLCanvasElement;
  private gridCtx!: CanvasRenderingContext2D;
  
  // Camera
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  private readonly MIN_ZOOM = 0.03;  // 3x more range
  private readonly MAX_ZOOM = 15;
  
  // Panning
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartCamX = 0;
  private panStartCamY = 0;
  
  // Tool state
  private currentTool: 'pan' | 'spawn' = 'pan';
  private elementTool: 'move' | 'scale' | 'rotate' | 'params' = 'move';
  private activeDragElementId: number | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartRadius = 0;
  private dragStartDistance = 0;
  private dragStartRotation = 0;
  private dragStartAngle = 0;
  private selectedSpawnType: string | null = null;
  
  // Starfield
  private starCache: Map<string, StarData[]> = new Map();
  private starsGraphics!: Graphics;
  private readonly STARFIELD_FOCAL = 1000;
  private readonly STARFIELD_SNAP = 3000;
  private layerEnabled: boolean[] = [true, true, true, true, true, true];
  
  // Config values
  public config = {
    // Stars
    starShader: 'classic',
    starBrightness: 6.0,
    starHueShift: 0,
    starDensity: 6.0,
    starTwinkleSpeed: 2.0,
    starTwinkleAmt: 0.3,
    starSize: 6.0,
    starParallax: 0.4,
    starBaseCell: 10,
    starLodBlend: 0.65,
  };
  
  // Entities
  private entities: Map<number, TestEntity> = new Map();
  private particles: Particle[] = [];
  private nextEntityId = 1;
  private elements: Map<number, ElementInstance> = new Map();
  private nextElementId = 1;
  private selectedElementId: number | null = null;
  private elementClipboard: string | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lastCommittedState: Map<number, ElementState> | null = null;
  private readonly MAX_UNDO = 30;
  private showGrid = true;
  private snapToGrid = true;
  private gridSize = 100;

  // Galaxy editor mode
  private editorMode: EditorMode = 'system';
  private galaxyContainer!: Container;
  private galaxyGraphics!: Graphics;
  private galaxyCameraX = 0;
  private galaxyCameraY = 0;
  private galaxyCameraZoom = 0.005; // very zoomed out for galaxy scale
  private systems: Map<string, SystemNode> = new Map();
  private selectedSystemId: string | null = null;
  private activeSystemId: string | null = null; // which system is being edited in system mode
  private draggingSystemId: string | null = null;
  private scalingSystemId: string | null = null;
  private galaxyScaleStartDist = 0;
  private galaxyScaleStartRadius = 0;
  private galaxyPreviewRadius: number | null = null; // shown during scale drag
  private galaxyDragOffsetX = 0;
  private galaxyDragOffsetY = 0;
  private nextSystemNum = 1;
  
  // Timing
  private time = 0;
  private animTime = 0;
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private fps = 0;
  
  // Admin server connection
  private adminWs: WebSocket | null = null;
  private adminConnected = false;
  private adminAuthenticated = false;
  private adminToken: string | null = null;
  private serverStats: { tick: number; playerCount: number; entityCount: number; tickTime: number; uptime: number } | null = null;
  
  async init() {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    
    this.app = new Application();
    await this.app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x000000,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    
    // Setup containers
    this.worldContainer = new Container();
    this.backgroundContainer = new Container();
    this.elementContainer = new Container();
    this.elementContainer.sortableChildren = true;
    this.entityContainer = new Container();
    this.effectContainer = new Container();
    this.starsGraphics = new Graphics();
    this.gridCanvas = document.getElementById('grid-overlay') as HTMLCanvasElement;
    this.gridCtx = this.gridCanvas.getContext('2d')!;
    this.resizeGridCanvas();
    
    this.worldContainer.addChild(this.backgroundContainer);
    this.worldContainer.addChild(this.elementContainer);
    this.worldContainer.addChild(this.entityContainer);
    this.worldContainer.addChild(this.effectContainer);
    this.app.stage.addChild(this.worldContainer);

    // Galaxy view container (hidden by default)
    this.galaxyContainer = new Container();
    this.galaxyGraphics = new Graphics();
    this.galaxyContainer.addChild(this.galaxyGraphics);
    this.galaxyContainer.visible = false;
    this.app.stage.addChild(this.galaxyContainer);
    
    this.backgroundContainer.addChild(this.starsGraphics);
    
    // Setup
    this.setupCanvasInput();
    this.setupWindowDragging();
    this.setupToolbar();
    this.setupToolPanel();
    this.setupControls();
    this.setupSpawnButtons();
    this.setupElementLibrary();
    this.setupGalaxyMode();
    this.pushUndo();
    this.setupServerBrowser();
    this.connectToAdmin();
    
    window.addEventListener('resize', () => this.onResize());
    this.app.ticker.add(() => this.update());
    
    console.log('Visual Sandbox initialized');
  }
  
  // ============================================
  // SERVER BROWSER
  // ============================================
  
  private serverBrowserUrl = 'https://spacegame-v2.fly.dev';
  
  private setupServerBrowser() {
    const refreshBtn = document.getElementById('refresh-servers-btn');
    const listContainer = document.getElementById('server-browser-list');
    
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshServerList());
    }
    
    // Auto-refresh on load
    this.refreshServerList();

    document.getElementById('history-undo-btn')?.addEventListener('click', () => this.undo());
    document.getElementById('history-redo-btn')?.addEventListener('click', () => this.redo());
    document.getElementById('entity-unparent')?.addEventListener('click', () => this.unparentSelectedElement());
  }
  
  private async refreshServerList() {
    const listContainer = document.getElementById('server-browser-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<div style="color: #888; font-size: 11px;">Loading servers...</div>';
    
    try {
      const response = await fetch(`${this.serverBrowserUrl}/list`);
      const data = await response.json();
      
      if (!data.servers || data.servers.length === 0) {
        listContainer.innerHTML = '<div style="color: #666; font-size: 11px;">No servers available</div>';
        return;
      }
      
      listContainer.innerHTML = '';
      
      for (const server of data.servers) {
        const serverEl = document.createElement('div');
        serverEl.style.cssText = `
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px; margin-bottom: 4px; background: #1a1a24;
          border: 1px solid #2a2a3a; border-radius: 4px; cursor: pointer;
          transition: background 0.2s;
        `;
        serverEl.onmouseover = () => serverEl.style.background = '#252535';
        serverEl.onmouseout = () => serverEl.style.background = '#1a1a24';
        
        // Use adminPort from server info, or fallback to 3001
        const adminPort = server.adminPort || 3001;
        const protocol = server.secure ? 'wss' : 'ws';
        const adminUrl = `${protocol}://${server.host}:${adminPort}`;
        const hasAdmin = !!server.adminPort;
        
        const left = document.createElement('div');
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size: 11px; color: #fff;';
        nameEl.textContent = String(server.name || 'Unknown');
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size: 9px; color: #666;';
        metaEl.textContent = `${String(server.region || 'unknown')} • ${Number(server.players || 0)}/${Number(server.maxPlayers || 0)}${hasAdmin ? ' • 🔧' : ''}`;
        left.appendChild(nameEl);
        left.appendChild(metaEl);

        const btn = document.createElement('button');
        btn.className = 'spawn-btn';
        btn.style.cssText = 'font-size: 10px; padding: 4px 8px;';
        btn.textContent = 'Admin';
        btn.disabled = !hasAdmin;
        serverEl.appendChild(left);
        serverEl.appendChild(btn);

        if (btn && hasAdmin) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const urlInput = document.getElementById('admin-url') as HTMLInputElement;
            if (urlInput) {
              urlInput.value = adminUrl;
            }
          });
        }
        
        listContainer.appendChild(serverEl);
      }
    } catch (e) {
      console.error('Failed to fetch server list:', e);
      listContainer.innerHTML = '<div style="color: #f55; font-size: 11px;">Failed to load servers</div>';
    }
  }
  
  // ============================================
  // ADMIN SERVER CONNECTION
  // ============================================
  
  private connectToAdmin() {
    const statusEl = document.getElementById('admin-status');
    const connectBtn = document.getElementById('admin-connect-btn');
    const urlInput = document.getElementById('admin-url') as HTMLInputElement;
    const passwordInput = document.getElementById('admin-password') as HTMLInputElement;
    const loginBtn = document.getElementById('admin-login-btn');
    const loginSection = document.getElementById('admin-login-section');
    const controlsSection = document.getElementById('admin-controls-section');
    
    const updateUI = () => {
      if (statusEl) {
        if (this.adminAuthenticated) {
          statusEl.textContent = '🟢 Authenticated';
        } else if (this.adminConnected) {
          statusEl.textContent = '🟡 Connected (login required)';
        } else {
          statusEl.textContent = '🔴 Disconnected';
        }
      }
      if (loginSection) loginSection.style.display = this.adminConnected && !this.adminAuthenticated ? 'block' : 'none';
      if (controlsSection) controlsSection.style.display = this.adminAuthenticated ? 'block' : 'none';
      if (connectBtn) connectBtn.textContent = this.adminConnected ? 'Disconnect' : 'Connect';
      if (urlInput) urlInput.disabled = this.adminConnected;
    };
    
    const connect = () => {
      try {
        const url = urlInput?.value || 'ws://localhost:3001';
        this.adminWs = new WebSocket(url);
        
        this.adminWs.onopen = () => {
          this.adminConnected = true;
          this.adminAuthenticated = false;
          updateUI();
          console.log('🔧 Connected to admin server (awaiting auth)');
        };
        
        this.adminWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            this.handleAdminMessage(msg, updateUI);
          } catch (e) {
            console.error('Admin message parse error:', e);
          }
        };
        
        this.adminWs.onclose = () => {
          this.adminConnected = false;
          this.adminAuthenticated = false;
          this.adminWs = null;
          this.adminToken = null;
          updateUI();
          console.log('🔧 Disconnected from admin server');
        };
        
        this.adminWs.onerror = () => {
          console.log('🔧 Admin server not available');
          this.adminConnected = false;
          this.adminAuthenticated = false;
          updateUI();
        };
      } catch (e) {
        if (statusEl) statusEl.textContent = '🔴 Error';
      }
    };
    
    // Connect button
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        if (this.adminConnected && this.adminWs) {
          this.adminWs.close();
        } else {
          connect();
        }
      });
    }
    
    // Login button
    if (loginBtn && passwordInput) {
      const doLogin = () => {
        const password = passwordInput.value;
        if (password && this.adminWs && this.adminConnected) {
          this.adminWs.send(JSON.stringify({ type: 'auth', password }));
        }
      };
      
      loginBtn.addEventListener('click', doLogin);
      passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doLogin();
      });
    }
    
    // Do not auto-connect by default; connect manually from the Admin panel.
    updateUI();
  }
  
  private handleAdminMessage(msg: { type: string; data?: any; token?: string; error?: string }, updateUI: () => void) {
    switch (msg.type) {
      case 'authSuccess':
        this.adminAuthenticated = true;
        this.adminToken = msg.token || null;
        console.log('🔧 Admin authenticated!');
        updateUI();
        break;
        
      case 'authFailed':
        console.log('🔧 Admin auth failed:', msg.error);
        alert('Authentication failed: ' + (msg.error || 'Invalid password'));
        break;
        
      case 'config':
        console.log('🔧 Received server config:', msg.data);
        break;
        
      case 'stats':
        this.serverStats = msg.data;
        this.updateServerStatsUI();
        break;
        
      case 'error':
        console.error('🔧 Admin error:', msg.error);
        break;
    }
  }
  
  private updateServerStatsUI() {
    const statsEl = document.getElementById('server-stats');
    if (statsEl && this.serverStats) {
      const s = this.serverStats;
      statsEl.innerHTML = `
        Tick: ${s.tick} | 
        Players: ${s.playerCount} | 
        Entities: ${s.entityCount} | 
        Tick: ${s.tickTime.toFixed(2)}ms | 
        Uptime: ${Math.floor(s.uptime / 1000)}s
      `;
    }
  }
  
  private sendToAdmin(type: string, data: any) {
    if (this.adminWs && this.adminConnected && this.adminAuthenticated) {
      this.adminWs.send(JSON.stringify({ type, data }));
    }
  }
  
  /**
   * Push current sandbox config to the server
   */
  private pushConfigToServer() {
    this.sendToAdmin('configUpdate', this.config);
  }
  
  /**
   * Execute an admin command on the server
   */
  private executeAdminCommand(command: string, args: any = {}) {
    this.sendToAdmin('command', { command, args });
  }
  
  private setupCanvasInput() {
    const canvas = this.app.canvas;
    
    // Mouse down - start pan or spawn
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;

      // ── Galaxy mode ──
      if (this.editorMode === 'galaxy') {
        const gp = this.galaxyScreenToWorld(e.clientX, e.clientY);
        const hitId = this.selectSystemAt(gp.x, gp.y);

        if (hitId) {
          this.selectedSystemId = hitId;
          const sys = this.systems.get(hitId)!;
          this.updateGalaxySystemList();
          this.updateGalaxyPropertiesUI();

          if (this.elementTool === 'scale') {
            // Start scale drag
            this.scalingSystemId = hitId;
            const dx = gp.x - sys.x;
            const dy = gp.y - sys.y;
            this.galaxyScaleStartDist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            this.galaxyScaleStartRadius = sys.boundaryRadius;
            this.galaxyPreviewRadius = sys.boundaryRadius;
          } else {
            // Start move drag
            this.draggingSystemId = hitId;
            this.galaxyDragOffsetX = gp.x - sys.x;
            this.galaxyDragOffsetY = gp.y - sys.y;
          }
        } else if (this.currentTool === 'spawn') {
          // Spawn a new system, snapping to 10% overlap with nearest neighbor
          const defaultRadius = 50000;
          const snapped = this.snapToOverlap(gp.x, gp.y, defaultRadius);
          this.addSystem(snapped.x, snapped.y);
        } else {
          // Deselect + pan
          this.selectedSystemId = null;
          this.draggingSystemId = null;
          this.isPanning = true;
          this.panStartX = e.clientX;
          this.panStartY = e.clientY;
          this.panStartCamX = this.galaxyCameraX;
          this.panStartCamY = this.galaxyCameraY;
          canvas.classList.add('panning');
          this.updateGalaxySystemList();
          this.updateGalaxyPropertiesUI();
        }
        return;
      }

      // ── System mode (existing) ──
      const worldPos = this.screenToWorld(e.clientX, e.clientY);
      const hit = this.pickElementAt(worldPos.x, worldPos.y);
      if (hit) {
        this.selectElement(hit.id);

        if (this.elementTool === 'move') {
          this.activeDragElementId = hit.id;
          this.dragOffsetX = worldPos.x - hit.x;
          this.dragOffsetY = worldPos.y - hit.y;
        } else if (this.elementTool === 'scale') {
          this.activeDragElementId = hit.id;
          const dx = worldPos.x - hit.x;
          const dy = worldPos.y - hit.y;
          this.dragStartDistance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          this.dragStartRadius = hit.params.radius ?? 100;
        } else if (this.elementTool === 'rotate') {
          this.activeDragElementId = hit.id;
          const dx = worldPos.x - hit.x;
          const dy = worldPos.y - hit.y;
          this.dragStartAngle = Math.atan2(dy, dx);
          this.dragStartRotation = hit.rotation;
        }

        return;
      }

      if (this.currentTool === 'pan') {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panStartCamX = this.cameraX;
        this.panStartCamY = this.cameraY;
        canvas.classList.add('panning');
      } else if (this.currentTool === 'spawn' && this.selectedSpawnType) {
        this.spawnAtPosition(this.selectedSpawnType, worldPos.x, worldPos.y);
      }
    });
    
    // Mouse move - pan
    canvas.addEventListener('mousemove', (e) => {
      // ── Galaxy mode ──
      if (this.editorMode === 'galaxy') {
        if (this.isPanning) {
          const dx = (e.clientX - this.panStartX) / this.galaxyCameraZoom;
          const dy = (e.clientY - this.panStartY) / this.galaxyCameraZoom;
          this.galaxyCameraX = this.panStartCamX - dx;
          this.galaxyCameraY = this.panStartCamY - dy;
          return;
        }
        if (this.scalingSystemId) {
          const gp = this.galaxyScreenToWorld(e.clientX, e.clientY);
          const sys = this.systems.get(this.scalingSystemId);
          if (sys) {
            const dx = gp.x - sys.x;
            const dy = gp.y - sys.y;
            const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const ratio = dist / this.galaxyScaleStartDist;
            const newRadius = Math.max(10000, Math.min(200000, this.galaxyScaleStartRadius * ratio));
            this.galaxyPreviewRadius = newRadius;
          }
          return;
        }
        if (this.draggingSystemId) {
          const gp = this.galaxyScreenToWorld(e.clientX, e.clientY);
          const sys = this.systems.get(this.draggingSystemId);
          if (sys) {
            const rawX = gp.x - this.galaxyDragOffsetX;
            const rawY = gp.y - this.galaxyDragOffsetY;
            // Snap to 10% overlap with nearest neighbor
            const snapped = this.snapToOverlap(rawX, rawY, sys.boundaryRadius, sys.id);
            sys.x = snapped.x;
            sys.y = snapped.y;
            this.updateGalaxyPropertiesUI();
          }
          return;
        }
        return;
      }

      // ── System mode (existing) ──
      if (this.isPanning) {
        const dx = (e.clientX - this.panStartX) / this.cameraZoom;
        const dy = (e.clientY - this.panStartY) / this.cameraZoom;
        this.cameraX = this.panStartCamX - dx;
        this.cameraY = this.panStartCamY - dy;
        return;
      }

      if (this.activeDragElementId !== null) {
        const element = this.elements.get(this.activeDragElementId);
        if (!element) return;
        const worldPos = this.screenToWorld(e.clientX, e.clientY);

        if (this.elementTool === 'move') {
          let nx = worldPos.x - this.dragOffsetX;
          let ny = worldPos.y - this.dragOffsetY;
          if (this.snapToGrid) {
            nx = Math.round(nx / this.gridSize) * this.gridSize;
            ny = Math.round(ny / this.gridSize) * this.gridSize;
          }
          if (element.parentId) {
            const parent = this.elements.get(element.parentId);
            if (parent) {
              element.parentOffsetX = nx - parent.x;
              element.parentOffsetY = ny - parent.y;
            } else {
              element.x = nx;
              element.y = ny;
            }
          } else {
            element.x = nx;
            element.y = ny;
          }
        } else if (this.elementTool === 'scale') {
          const dx = worldPos.x - element.x;
          const dy = worldPos.y - element.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const ratio = dist / this.dragStartDistance;
          const radiusParam = element.params.radius ?? 100;
          const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
          const radiusDef = def?.params.find((p) => p.key === 'radius');
          let newRadius = this.dragStartRadius * ratio;
          if (radiusDef) {
            newRadius = Math.max(radiusDef.min, Math.min(radiusDef.max, newRadius));
          }
          element.params.radius = newRadius;
        } else if (this.elementTool === 'rotate') {
          const dx = worldPos.x - element.x;
          const dy = worldPos.y - element.y;
          const ang = Math.atan2(dy, dx);
          element.rotation = this.dragStartRotation + (ang - this.dragStartAngle);
        }

        this.drawElementGraphic(element);
      }
    });
    
    // Mouse up - stop pan
    window.addEventListener('mouseup', () => {
      // Apply scale if we were scaling
      if (this.scalingSystemId && this.galaxyPreviewRadius !== null) {
        const sys = this.systems.get(this.scalingSystemId);
        if (sys) {
          const oldRadius = sys.boundaryRadius;
          sys.boundaryRadius = this.galaxyPreviewRadius;
          // Maintain overlaps with neighbors
          this.maintainOverlapsOnResize(sys, oldRadius);
          this.updateGalaxyPropertiesUI();
        }
      }
      this.scalingSystemId = null;
      this.galaxyPreviewRadius = null;
      this.draggingSystemId = null;
      if (this.activeDragElementId !== null) {
        this.pushUndo();
      }
      this.activeDragElementId = null;
      this.isPanning = false;
      canvas.classList.remove('panning');
    });
    
    // Scroll - zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Base 2.5% zoom, scales up with scroll speed (deltaY magnitude)
      const speed = Math.min(Math.abs(e.deltaY) / 100, 1); // 0..1 normalized
      const rate = 0.025 + 0.125 * speed * speed; // 2.5% base, up to 15% for fast scrolls
      const zoomFactor = e.deltaY > 0 ? 1 - rate : 1 + rate;

      if (this.editorMode === 'galaxy') {
        this.galaxyCameraZoom = Math.max(0.0002, Math.min(0.05, this.galaxyCameraZoom * zoomFactor));
      } else {
        this.cameraZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.cameraZoom * zoomFactor));
      }
    });

    // Zoom slider (logarithmic: slider value = ln(zoom))
    const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement | null;
    if (zoomSlider) {
      // min/max match ln(MIN_ZOOM)..ln(MAX_ZOOM) ≈ -3.5..2.7
      zoomSlider.min = Math.log(this.MIN_ZOOM).toFixed(2);
      zoomSlider.max = Math.log(this.MAX_ZOOM).toFixed(2);
      zoomSlider.value = Math.log(this.cameraZoom).toString();
      zoomSlider.addEventListener('input', () => {
        this.cameraZoom = Math.exp(parseFloat(zoomSlider.value));
      });
    }
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    const zoomInBtn = document.getElementById('zoom-in-btn');
    zoomOutBtn?.addEventListener('click', () => {
      this.cameraZoom = Math.max(this.MIN_ZOOM, this.cameraZoom * 0.7);
    });
    zoomInBtn?.addEventListener('click', () => {
      this.cameraZoom = Math.min(this.MAX_ZOOM, this.cameraZoom * 1.4);
    });

    // Drag from library onto canvas
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const defId = e.dataTransfer?.getData('text/element-id');
      if (!defId) return;
      const worldPos = this.screenToWorld(e.clientX, e.clientY);
      this.spawnElement(defId, worldPos.x, worldPos.y);
    });

    // Double-click to enter system in galaxy mode
    canvas.addEventListener('dblclick', (e) => {
      if (this.editorMode !== 'galaxy') return;
      const gp = this.galaxyScreenToWorld(e.clientX, e.clientY);
      const hitId = this.selectSystemAt(gp.x, gp.y);
      if (hitId) {
        this.selectedSystemId = hitId;
        this.enterSystem();
      }
    });
    
    // Keyboard
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName ?? '').toLowerCase();
      const typingInField = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;

      if (typingInField) {
        // Allow only undo/redo while typing
        const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
        const isRedo = (e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y');
        if (isUndo) {
          e.preventDefault();
          this.undo();
        } else if (isRedo) {
          e.preventDefault();
          this.redo();
        }
        return;
      }

      // Tab toggles galaxy/system mode
      if (e.key === 'Tab') {
        e.preventDefault();
        this.setEditorMode(this.editorMode === 'system' ? 'galaxy' : 'system');
        return;
      }

      if (e.key === 'R' && e.shiftKey) {
        if (this.editorMode === 'galaxy') {
          this.galaxyCameraX = 0;
          this.galaxyCameraY = 0;
          this.galaxyCameraZoom = 0.005;
        } else {
          this.resetView();
        }
        return;
      }

      // Galaxy mode: Delete selected system, Escape to deselect
      if (this.editorMode === 'galaxy') {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          this.deleteSelectedSystem();
        }
        if (e.key === 'Escape') {
          this.selectedSystemId = null;
          this.updateGalaxySystemList();
          this.updateGalaxyPropertiesUI();
        }
        if (e.key === 'Enter') {
          this.enterSystem();
        }
        return; // don't run system-mode shortcuts
      }

      // ── System mode shortcuts ──
      if (e.key === 'Escape') {
        // Return to galaxy
        this.setEditorMode('galaxy');
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        this.setElementTool('move');
      }
      if (e.key === 's' || e.key === 'S') {
        this.setElementTool('scale');
      }
      if (e.key === 'r' || e.key === 'R') {
        this.setElementTool('rotate');
      }
      if (e.key === 'p' || e.key === 'P') {
        this.setElementTool('params');
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        this.duplicateSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        this.copySelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        this.pasteSelectedElement();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.redo();
      }
      if (e.key === 'f' || e.key === 'F') {
        this.focusSelectedElement();
      }
      // Number keys toggle windows
      if (e.key === '1') this.toggleWindow('library');
      if (e.key === '2') this.toggleWindow('element');
      if (e.key === '3') this.toggleWindow('spawn');
      if (e.key === '4') this.toggleWindow('admin');
      if (e.key === '5') this.toggleWindow('entities');
      if (e.key === '6') this.toggleWindow('history');
    });
  }
  
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = (screenX - rect.left - this.app.renderer.width / 2) / this.cameraZoom + this.cameraX;
    const y = (screenY - rect.top - this.app.renderer.height / 2) / this.cameraZoom + this.cameraY;
    return { x, y };
  }
  
  private setupWindowDragging() {
    document.querySelectorAll('.window').forEach((win) => {
      const header = win.querySelector('.window-header') as HTMLElement;
      const closeBtn = win.querySelector('.window-close') as HTMLElement;
      const windowEl = win as HTMLElement;
      
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      
      header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = windowEl.offsetLeft;
        startTop = windowEl.offsetTop;
        // Bring to front
        document.querySelectorAll('.window').forEach((w) => (w as HTMLElement).style.zIndex = '1000');
        windowEl.style.zIndex = '1001';
      });
      
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const nextLeft = startLeft + dx;
        const nextTop = startTop + dy;
        const maxLeft = Math.max(0, window.innerWidth - windowEl.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - windowEl.offsetHeight);
        const clampedLeft = Math.max(0, Math.min(maxLeft, nextLeft));
        const clampedTop = Math.max(0, Math.min(maxTop, nextTop));
        windowEl.style.left = `${clampedLeft}px`;
        windowEl.style.top = `${clampedTop}px`;
        windowEl.style.right = 'auto';
      });
      
      window.addEventListener('mouseup', () => {
        isDragging = false;
      });
      
      closeBtn.addEventListener('click', () => {
        const windowId = windowEl.id.replace('window-', '');
        this.setWindowVisible(windowId, false);
      });
    });
  }
  
  private setupToolbar() {
    // Tool buttons
    document.querySelectorAll('.toolbar-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool') as 'pan' | 'spawn';
        this.setTool(tool);
      });
    });
    
    // Window toggle buttons
    document.querySelectorAll('.toolbar-btn[data-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const windowId = btn.getAttribute('data-window')!;
        this.toggleWindow(windowId);
      });
    });
    
    // Action buttons
    document.querySelectorAll('.toolbar-btn[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'reset') this.resetView();
        if (action === 'reset-layout') this.resetPanelLayout();
      });
    });
  }

  private setupToolPanel() {
    document.querySelectorAll('.tool-btn[data-toolmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-toolmode') as 'move' | 'scale' | 'rotate' | 'params';
        this.setElementTool(mode);
      });
    });
    this.setElementTool(this.elementTool);
  }

  private setElementTool(tool: 'move' | 'scale' | 'rotate' | 'params') {
    this.elementTool = tool;
    document.querySelectorAll('.tool-btn[data-toolmode]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-toolmode') === tool);
    });

    if (tool === 'params') {
      this.setWindowVisible('element', true);
    }
  }
  
  private setTool(tool: 'pan' | 'spawn') {
    this.currentTool = tool;
    const canvas = this.app.canvas;
    
    document.querySelectorAll('.toolbar-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === tool);
    });
    
    canvas.classList.remove('tool-spawn');
    if (tool === 'spawn') {
      canvas.classList.add('tool-spawn');
    }
  }

  private setWindowVisible(windowId: string, visible: boolean) {
    const win = document.getElementById(`window-${windowId}`);
    if (win) {
      win.classList.toggle('visible', visible);
    }
    const btn = document.querySelector(`.toolbar-btn[data-window="${windowId}"]`);
    if (btn) {
      btn.classList.toggle('active', visible);
    }
  }
  
  private toggleWindow(windowId: string) {
    const win = document.getElementById(`window-${windowId}`);
    if (win) {
      const visible = !win.classList.contains('visible');
      this.setWindowVisible(windowId, visible);
    }
  }

  private resetPanelLayout() {
    const positions: Record<string, { top: number; left?: number; right?: number; width?: number }> = {
      'window-library': { top: 60, left: 540 },
      'window-element': { top: 60, left: 820 },
      'window-entities': { top: 60, left: 1090, width: 300 },
      'window-history': { top: 420, left: 1090, width: 300 },
      'window-stars': { top: 60, left: 530 },
      'window-spawn': { top: 60, right: 10 },
      'window-admin': { top: 60, right: 280 },
      'window-galaxy': { top: 60, left: 10, width: 280 },
    };

    for (const [id, pos] of Object.entries(positions)) {
      const el = document.getElementById(id) as HTMLElement | null;
      if (!el) continue;
      el.style.top = `${pos.top}px`;
      if (pos.left !== undefined) {
        el.style.left = `${pos.left}px`;
        el.style.right = 'auto';
      } else if (pos.right !== undefined) {
        el.style.right = `${pos.right}px`;
      }
      if (pos.width !== undefined) {
        el.style.width = `${pos.width}px`;
      }
    }
  }
  
  private setupControls() {
    // Stars
    this.bindSlider('star-brightness', (v) => this.config.starBrightness = v);
    this.bindSlider('star-size', (v) => this.config.starSize = v);
    this.bindSlider('star-hue', (v) => this.config.starHueShift = v);
    this.bindSlider('star-density', (v) => this.config.starDensity = v);
    this.bindSlider('star-twinkle', (v) => this.config.starTwinkleSpeed = v);
    this.bindSlider('star-twinkle-amt', (v) => this.config.starTwinkleAmt = v);
    this.bindSlider('star-parallax', (v) => this.config.starParallax = v);
    this.bindSlider('star-basecell', (v) => this.config.starBaseCell = v);
    this.bindSlider('star-lodblend', (v) => this.config.starLodBlend = v);

    const showGrid = document.getElementById('editor-show-grid') as HTMLInputElement | null;
    const snapGrid = document.getElementById('editor-snap-grid') as HTMLInputElement | null;
    const gridSize = document.getElementById('editor-grid-size') as HTMLInputElement | null;
    const gridSizeVal = document.getElementById('editor-grid-size-val');
    if (showGrid) {
      showGrid.checked = this.showGrid;
      showGrid.addEventListener('change', () => {
        this.showGrid = showGrid.checked;
      });
    }
    if (snapGrid) {
      snapGrid.checked = this.snapToGrid;
      snapGrid.addEventListener('change', () => {
        this.snapToGrid = snapGrid.checked;
      });
    }
    if (gridSize && gridSizeVal) {
      gridSize.value = this.gridSize.toString();
      gridSizeVal.textContent = this.gridSize.toString();
      gridSize.addEventListener('input', () => {
        this.gridSize = parseInt(gridSize.value, 10) || 100;
        gridSizeVal.textContent = this.gridSize.toString();
      });
    }

    document.getElementById('elements-save')?.addEventListener('click', () => {
      this.saveElementsToFile();
    });
    const loadBtn = document.getElementById('elements-load');
    const loadInput = document.getElementById('elements-load-input') as HTMLInputElement | null;
    if (loadBtn && loadInput) {
      loadBtn.addEventListener('click', () => loadInput.click());
      loadInput.addEventListener('change', () => this.loadElementsFromFile(loadInput));
    }

    const systemSaveBtn = document.getElementById('system-save');
    const systemLoadBtn = document.getElementById('system-load');
    const systemLoadInput = document.getElementById('system-load-input') as HTMLInputElement | null;
    if (systemSaveBtn) {
      systemSaveBtn.addEventListener('click', () => this.saveSystemToFile());
    }
    if (systemLoadBtn && systemLoadInput) {
      systemLoadBtn.addEventListener('click', () => systemLoadInput.click());
      systemLoadInput.addEventListener('change', () => this.loadSystemFromFile(systemLoadInput));
    }
  }

  private setupElementLibrary() {
    const library = document.getElementById('element-library');
    if (!library) return;

    library.innerHTML = '';

    for (const def of ELEMENT_LIBRARY) {
      const item = document.createElement('div');
      item.className = 'library-item';
      item.setAttribute('draggable', 'true');
      item.dataset.elementId = def.id;

      const canvas = document.createElement('canvas');
      canvas.className = 'library-thumb';
      canvas.width = 80;
      canvas.height = 80;

      this.drawElementThumbnail(def, canvas);

      const label = document.createElement('div');
      label.textContent = def.name;

      item.appendChild(canvas);
      item.appendChild(label);

      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/element-id', def.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });

      item.addEventListener('dblclick', () => {
        this.spawnElement(def.id, this.cameraX, this.cameraY);
      });

      library.appendChild(item);
    }
  }

  private drawElementThumbnail(def: ElementDefinition, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const params = this.getDefaultParams(def);
    this.drawElementCanvas(ctx, def, params, canvas.width / 2, canvas.height / 2, 0.6);
  }

  private spawnElement(defId: string, x: number, y: number) {
    const def = ELEMENT_LIBRARY.find((d) => d.id === defId);
    if (!def) return;
    const params = this.getDefaultParams(def);
    this.createElementInstance(def, {
      x,
      y,
      rotation: 0,
      lockToOrigin: false,
      seed: Math.floor(Math.random() * 1000000),
      params,
    });
    this.pushUndo();
  }

  private getDefaultParams(def: ElementDefinition): Record<string, number> {
    const params: Record<string, number> = {};
    for (const param of def.params) {
      params[param.key] = param.default;
    }
    return params;
  }

  private pickElementAt(x: number, y: number): ElementInstance | null {
    const arr = Array.from(this.elements.values()).sort((a, b) => {
      if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
      return a.id - b.id;
    });
    for (let i = arr.length - 1; i >= 0; i--) {
      const element = arr[i];
      const dx = x - element.x;
      const dy = y - element.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= element.hitRadius) return element;
    }
    return null;
  }

  private selectElement(id: number | null) {
    this.selectedElementId = id;
    this.updateElementPropertiesUI();
    this.updateEntityListUI();
    for (const element of this.elements.values()) {
      this.drawElementGraphic(element);
    }
    if (this.elementTool === 'params') {
      this.setWindowVisible('element', true);
    }
  }

  private updateElementPropertiesUI() {
    const titleEl = document.getElementById('element-properties-title');
    const emptyEl = document.getElementById('element-properties-empty');
    const container = document.getElementById('element-properties');
    if (!container || !titleEl || !emptyEl) return;

    container.innerHTML = '';

    if (this.selectedElementId === null) {
      titleEl.textContent = 'No Selection';
      emptyEl.style.display = 'block';
      return;
    }

    const element = this.elements.get(this.selectedElementId);
    if (!element) {
      titleEl.textContent = 'No Selection';
      emptyEl.style.display = 'block';
      return;
    }

    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;

    titleEl.textContent = `${def.name} (${def.category})`;
    emptyEl.style.display = 'none';

    const lockRow = document.createElement('div');
    lockRow.className = 'checkbox-row';
    lockRow.innerHTML = `
      <input type="checkbox" id="element-lock-origin" ${element.lockToOrigin ? 'checked' : ''}>
      <label for="element-lock-origin">Lock to Origin</label>
    `;
    container.appendChild(lockRow);
    const lockCheckbox = lockRow.querySelector('input') as HTMLInputElement;
    lockCheckbox.addEventListener('change', () => {
      element.lockToOrigin = lockCheckbox.checked;
      this.pushUndo('Lock toggle');
    });

    const orderSection = document.createElement('div');
    orderSection.className = 'section';
    orderSection.innerHTML = `
      <div class="section-title">Render Order</div>
      <div class="control-row" style="display:flex; gap:8px; align-items:center;">
        <input type="number" id="element-render-order" value="${Math.round(element.renderOrder)}" style="width:80px; padding:4px 6px; background:#1a1a24; border:1px solid #2a2a3a; border-radius:4px; color:#fff;">
        <button class="spawn-btn" id="element-send-back" style="flex:1;">Send Back</button>
        <button class="spawn-btn" id="element-bring-front" style="flex:1;">Bring Front</button>
      </div>
    `;
    container.appendChild(orderSection);
    const orderInput = orderSection.querySelector('#element-render-order') as HTMLInputElement;
    const backBtn = orderSection.querySelector('#element-send-back') as HTMLButtonElement;
    const frontBtn = orderSection.querySelector('#element-bring-front') as HTMLButtonElement;
    orderInput.addEventListener('change', () => {
      element.renderOrder = parseFloat(orderInput.value) || 0;
      this.applyElementRenderOrder(element);
      this.pushUndo('Render order');
    });
    backBtn.addEventListener('click', () => {
      element.renderOrder -= 10;
      orderInput.value = String(Math.round(element.renderOrder));
      this.applyElementRenderOrder(element);
      this.pushUndo('Send back');
    });
    frontBtn.addEventListener('click', () => {
      element.renderOrder += 10;
      orderInput.value = String(Math.round(element.renderOrder));
      this.applyElementRenderOrder(element);
      this.pushUndo('Bring front');
    });

    if (def.id === 'sun') {
      this.buildSunVariantSelector(container, element);
    }

    // Group params by group if available (for detail_sun), else render flat
    const hasGroups = def.params.some((p) => p.group);
    if (hasGroups) {
      const groups: string[] = [];
      for (const param of def.params) {
        const g = param.group ?? 'General';
        if (!groups.includes(g)) groups.push(g);
      }
      for (const group of groups) {
        const section = document.createElement('div');
        section.className = 'section';
        section.innerHTML = `<div class="section-title">${group}</div>`;
        const groupParams = def.params.filter((p) => (p.group ?? 'General') === group);
        for (const param of groupParams) {
          section.appendChild(this.buildParamControlRow(element, param));
        }
        container.appendChild(section);
      }
    } else {
      def.params.forEach((param) => {
        if (def.id === 'sun' && param.key === 'variant') return;
        container.appendChild(this.buildParamControlRow(element, param));
      });
    }

    // Color pickers for elements with color defs
    if (def.colors && def.colors.length > 0) {
      const colorSection = document.createElement('div');
      colorSection.className = 'section';
      colorSection.innerHTML = `<div class="section-title">Colors</div>`;
      const colorGrid = document.createElement('div');
      colorGrid.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px;';
      for (const colorDef of def.colors) {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex; flex-direction:column; gap:4px; font-size:10px; color:#aaa; align-items:center;';
        const span = document.createElement('span');
        span.textContent = colorDef.label;
        const input = document.createElement('input');
        input.type = 'color';
        input.value = element.stringParams[colorDef.key] ?? colorDef.default;
        let colorStart = input.value;
        const beginInteraction = () => { colorStart = input.value; };
        input.addEventListener('mousedown', beginInteraction);
        input.addEventListener('focus', beginInteraction);
        input.addEventListener('input', () => {
          this.setElementStringParam(element, colorDef.key, input.value, true);
        });
        input.addEventListener('change', () => {
          if ((element.stringParams[colorDef.key] ?? colorDef.default) !== colorStart) {
            this.pushUndo(`Color: ${colorDef.label}`);
          }
        });
        label.appendChild(span);
        label.appendChild(input);
        colorGrid.appendChild(label);
      }
      colorSection.appendChild(colorGrid);
      container.appendChild(colorSection);
    }

    const actionRow = document.createElement('div');
    actionRow.className = 'spawn-grid';
    actionRow.innerHTML = `
      <button class="spawn-btn" id="element-duplicate">📄 Duplicate</button>
      <button class="spawn-btn danger" id="element-delete">🗑️ Delete</button>
    `;
    container.appendChild(actionRow);
    document.getElementById('element-duplicate')?.addEventListener('click', () => this.duplicateSelectedElement());
    document.getElementById('element-delete')?.addEventListener('click', () => this.deleteSelectedElement());

    const focusRow = document.createElement('div');
    focusRow.className = 'spawn-grid';
    focusRow.innerHTML = `
      <button class="spawn-btn" id="element-focus">🎯 Focus</button>
      <button class="spawn-btn" id="element-copy">📋 Copy</button>
    `;
    container.appendChild(focusRow);
    document.getElementById('element-focus')?.addEventListener('click', () => this.focusSelectedElement());
    document.getElementById('element-copy')?.addEventListener('click', () => this.copySelectedElement());
  }

  private buildParamControlRow(element: ElementInstance, param: ElementParamDef): HTMLElement {
    const totalSteps = (param.max - param.min) / Math.max(param.step, 1e-9);
    const useSlider = Number.isFinite(totalSteps) && totalSteps <= 60;
    return useSlider
      ? this.buildParamSliderRow(element, param)
      : this.buildParamRollerRow(element, param);
  }

  private buildParamSliderRow(element: ElementInstance, param: ElementParamDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'control-row';
    const decimals = param.step < 1 ? 2 : 0;
    const value = element.params[param.key] ?? param.default;

    row.innerHTML = `
      <div class="control-label">
        <span>${param.label}</span>
        <span class="control-value">${value.toFixed(decimals)}</span>
      </div>
      <input type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${value}">
    `;

    const slider = row.querySelector('input') as HTMLInputElement;
    const valueEl = row.querySelector('.control-value') as HTMLElement;

    const startVal = value;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      this.setElementNumericParam(element, param.key, v, true);
      valueEl.textContent = (element.params[param.key] ?? v).toFixed(decimals);
    });
    slider.addEventListener('change', () => {
      const after = element.params[param.key] ?? startVal;
      this.commitElementNumericParamChange(element, param.key, startVal, after, `Param: ${param.label}`);
    });

    return row;
  }

  private buildParamRollerRow(element: ElementInstance, param: ElementParamDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'control-row';
    const decimals = param.step < 1 ? 2 : 0;
    const value = element.params[param.key] ?? param.default;

    row.innerHTML = `
      <div class="control-label" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${param.label}</span>
        <span class="control-value">${value.toFixed(decimals)}</span>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <div class="roller-handle" style="flex:1; padding:6px 8px; border:1px solid #2a2a3a; border-radius:4px; background:#141420; color:#889; font-size:10px; cursor:ew-resize; user-select:none; text-align:center;">↔ drag</div>
        <input type="number" step="${param.step}" min="${param.min}" max="${param.max}" value="${value}" style="width:88px; padding:5px 6px; background:#1a1a24; border:1px solid #2a2a3a; border-radius:4px; color:#fff; font-size:11px; text-align:right;">
      </div>
    `;

    const valueEl = row.querySelector('.control-value') as HTMLElement;
    const input = row.querySelector('input') as HTMLInputElement;
    const handle = row.querySelector('.roller-handle') as HTMLElement;

    const clamp = (v: number) => Math.max(param.min, Math.min(param.max, v));
    const apply = (v: number, commit: boolean, startValue?: number) => {
      const nv = clamp(v);
      this.setElementNumericParam(element, param.key, nv, true);
      valueEl.textContent = nv.toFixed(decimals);
      input.value = nv.toString();
      if (commit) {
        const sv = startValue ?? value;
        this.commitElementNumericParamChange(element, param.key, sv, nv, `Param: ${param.label}`);
      }
    };

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) apply(v, false);
    });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) apply(v, true, value);
    });
    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      const base = e.shiftKey ? param.step * 0.1 : e.ctrlKey ? param.step * 10 : param.step;
      const sign = e.deltaY > 0 ? -1 : 1;
      apply((element.params[param.key] ?? value) + sign * base, false);
    });

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startVal = element.params[param.key] ?? value;

      const onMove = (me: MouseEvent) => {
        const dx = me.clientX - startX;
        const mult = me.shiftKey ? 0.1 : me.ctrlKey ? 10 : 1;
        const delta = dx * param.step * 0.2 * mult;
        apply(startVal + delta, false);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const after = element.params[param.key] ?? startVal;
        this.commitElementNumericParamChange(element, param.key, startVal, after, `Param: ${param.label}`);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    return row;
  }

  private setElementNumericParam(element: ElementInstance, key: string, value: number, redraw: boolean) {
    element.params[key] = value;
    if (redraw) this.drawElementGraphic(element);
  }

  private commitElementNumericParamChange(
    element: ElementInstance,
    key: string,
    before: number,
    after: number,
    label: string,
  ) {
    if (Math.abs(before - after) < 1e-9) return;
    this.pushUndo(label);
  }

  private setElementStringParam(element: ElementInstance, key: string, value: string, redraw: boolean) {
    element.stringParams[key] = value;
    if (redraw) this.drawElementGraphic(element);
  }

  private deleteSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    if (element.sunRenderer) {
      this.elementContainer.removeChild(element.sunRenderer.getContainer());
      element.sunRenderer.destroy();
    }
    if (element.coronaRenderer) {
      this.elementContainer.removeChild(element.coronaRenderer.getContainer());
      element.coronaRenderer.destroy();
    }
    if (element.glowRenderer) {
      this.elementContainer.removeChild(element.glowRenderer.getContainer());
      element.glowRenderer.destroy();
    }
    if (element.nebulaRenderer) {
      this.elementContainer.removeChild(element.nebulaRenderer.getContainer());
      element.nebulaRenderer.destroy();
    }
    this.elementContainer.removeChild(element.graphic);
    for (const child of this.elements.values()) {
      if (child.parentId === element.id) {
        child.parentId = undefined;
        child.parentOffsetX = undefined;
        child.parentOffsetY = undefined;
      }
    }
    this.elements.delete(this.selectedElementId);
    this.selectedElementId = null;
    this.updateElementPropertiesUI();
    this.updateEntityListUI();
    this.pushUndo('Delete element');
  }

  private duplicateSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;
    const offset = this.gridSize;
    this.createElementInstance(def, {
      x: element.x + offset,
      y: element.y + offset,
      rotation: element.rotation,
      lockToOrigin: element.lockToOrigin,
      seed: Math.floor(Math.random() * 1000000),
      params: { ...element.params },
      stringParams: { ...element.stringParams },
      renderOrder: element.renderOrder,
    });
    this.pushUndo('Duplicate element');
  }

  private copySelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    const data = this.serializeElementsToBase64([element]);
    this.elementClipboard = data;
  }

  private pasteSelectedElement() {
    if (!this.elementClipboard) return;
    this.deserializeElementsFromBase64(this.elementClipboard, true);
    this.pushUndo('Paste element');
  }

  private focusSelectedElement() {
    if (this.selectedElementId === null) return;
    const element = this.elements.get(this.selectedElementId);
    if (!element) return;
    this.cameraX = element.x;
    this.cameraY = element.y;
  }

  private pushUndo(label: string = 'Edit') {
    const current = this.captureElementStateMap();

    // Baseline initialization (first call)
    if (!this.lastCommittedState) {
      this.lastCommittedState = current;
      this.updateHistoryUI();
      return;
    }

    const changes = this.computeChanges(this.lastCommittedState, current);
    if (changes.created.length === 0 && changes.deleted.length === 0 && changes.updated.length === 0) {
      return;
    }

    this.undoStack.push({ label, timestamp: Date.now(), changes });
    this.redoStack = [];
    if (this.undoStack.length > this.MAX_UNDO) {
      this.undoStack.shift();
    }
    this.lastCommittedState = current;
    this.updateHistoryUI();
  }

  private undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.applyHistoryChangeSet(entry.changes, true);
    this.redoStack.push(entry);
    this.lastCommittedState = this.captureElementStateMap();
    this.updateHistoryUI();
  }

  private redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.applyHistoryChangeSet(entry.changes, false);
    this.undoStack.push(entry);
    this.lastCommittedState = this.captureElementStateMap();
    this.updateHistoryUI();
  }

  private cloneElementState(s: ElementState): ElementState {
    return {
      ...s,
      params: { ...s.params },
      stringParams: { ...s.stringParams },
    };
  }

  private captureElementStateMap(): Map<number, ElementState> {
    const out = new Map<number, ElementState>();
    for (const e of this.elements.values()) {
      out.set(e.id, {
        id: e.id,
        defId: e.defId,
        x: e.x,
        y: e.y,
        rotation: e.rotation,
        lockToOrigin: e.lockToOrigin,
        seed: e.seed,
        renderOrder: e.renderOrder,
        parentId: e.parentId,
        parentOffsetX: e.parentOffsetX,
        parentOffsetY: e.parentOffsetY,
        params: { ...e.params },
        stringParams: { ...e.stringParams },
      });
    }
    return out;
  }

  private elementStateEquals(a: ElementState, b: ElementState): boolean {
    if (
      a.id !== b.id ||
      a.defId !== b.defId ||
      a.x !== b.x ||
      a.y !== b.y ||
      a.rotation !== b.rotation ||
      a.lockToOrigin !== b.lockToOrigin ||
      a.seed !== b.seed ||
      a.renderOrder !== b.renderOrder ||
      a.parentId !== b.parentId ||
      a.parentOffsetX !== b.parentOffsetX ||
      a.parentOffsetY !== b.parentOffsetY
    ) return false;

    const aParamKeys = Object.keys(a.params);
    const bParamKeys = Object.keys(b.params);
    if (aParamKeys.length !== bParamKeys.length) return false;
    for (const k of aParamKeys) {
      if (a.params[k] !== b.params[k]) return false;
    }

    const aStrKeys = Object.keys(a.stringParams);
    const bStrKeys = Object.keys(b.stringParams);
    if (aStrKeys.length !== bStrKeys.length) return false;
    for (const k of aStrKeys) {
      if (a.stringParams[k] !== b.stringParams[k]) return false;
    }

    return true;
  }

  private computeChanges(prev: Map<number, ElementState>, curr: Map<number, ElementState>): HistoryChangeSet {
    const created: ElementState[] = [];
    const deleted: ElementState[] = [];
    const updated: Array<{ before: ElementState; after: ElementState }> = [];

    for (const [id, c] of curr) {
      const p = prev.get(id);
      if (!p) {
        created.push(this.cloneElementState(c));
      } else if (!this.elementStateEquals(p, c)) {
        updated.push({ before: this.cloneElementState(p), after: this.cloneElementState(c) });
      }
    }

    for (const [id, p] of prev) {
      if (!curr.has(id)) {
        deleted.push(this.cloneElementState(p));
      }
    }

    return { created, deleted, updated };
  }

  private removeElementInstanceById(id: number) {
    const element = this.elements.get(id);
    if (!element) return;

    if (element.sunRenderer) {
      this.elementContainer.removeChild(element.sunRenderer.getContainer());
      element.sunRenderer.destroy();
    }
    if (element.coronaRenderer) {
      this.elementContainer.removeChild(element.coronaRenderer.getContainer());
      element.coronaRenderer.destroy();
    }
    if (element.glowRenderer) {
      this.elementContainer.removeChild(element.glowRenderer.getContainer());
      element.glowRenderer.destroy();
    }
    if (element.nebulaRenderer) {
      this.elementContainer.removeChild(element.nebulaRenderer.getContainer());
      element.nebulaRenderer.destroy();
    }
    this.elementContainer.removeChild(element.graphic);
    this.elements.delete(id);
  }

  private createElementFromState(state: ElementState) {
    const def = ELEMENT_LIBRARY.find((d) => d.id === state.defId);
    if (!def) return;
    this.createElementInstance(def, {
      x: state.x,
      y: state.y,
      rotation: state.rotation,
      lockToOrigin: state.lockToOrigin,
      seed: state.seed,
      params: { ...state.params },
      stringParams: { ...state.stringParams },
      parentId: state.parentId,
      parentOffsetX: state.parentOffsetX,
      parentOffsetY: state.parentOffsetY,
      renderOrder: state.renderOrder,
      forceId: state.id,
      suppressSelect: true,
    });
  }

  private applyElementState(state: ElementState) {
    this.removeElementInstanceById(state.id);
    this.createElementFromState(state);
  }

  private applyHistoryChangeSet(changes: HistoryChangeSet, inverse: boolean) {
    if (inverse) {
      // Undo: remove creations, restore deletions, restore previous updates
      for (const c of changes.created) this.removeElementInstanceById(c.id);
      for (const d of changes.deleted) this.createElementFromState(d);
      for (const u of changes.updated) this.applyElementState(u.before);
    } else {
      // Redo: recreate creations, remove deletions, apply next updates
      for (const c of changes.created) this.createElementFromState(c);
      for (const d of changes.deleted) this.removeElementInstanceById(d.id);
      for (const u of changes.updated) this.applyElementState(u.after);
    }

    this.updateEntityListUI();
    this.updateElementPropertiesUI();
  }

  private updateHistoryUI() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';

    const entries = this.undoStack.slice(-25);
    entries.forEach((entry, i) => {
      const row = document.createElement('div');
      const isTop = i === entries.length - 1;
      row.style.cssText = `padding:6px 8px; border:1px solid #2a2a3a; border-radius:4px; margin-bottom:4px; font-size:10px; color:${isTop ? '#cfe8ff' : '#aaa'}; background:${isTop ? '#1a2735' : '#141420'};`;
      const t = new Date(entry.timestamp).toLocaleTimeString();
      row.textContent = `${isTop ? '● ' : ''}${entry.label} · ${t}`;
      list.appendChild(row);
    });

    const redoBtn = document.getElementById('history-redo-btn') as HTMLButtonElement | null;
    const undoBtn = document.getElementById('history-undo-btn') as HTMLButtonElement | null;
    if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
    if (undoBtn) undoBtn.disabled = this.undoStack.length < 1;
  }

  private serializeElementsToBase64(elements: ElementInstance[] = Array.from(this.elements.values())): string {
    const buffer = new BitBuffer(1024);
    buffer.writeUint16(5); // version 5 - lossless params + stable ids
    buffer.writeVarUint(elements.length);

    for (const element of elements) {
      const defIndex = ELEMENT_LIBRARY.findIndex((d) => d.id === element.defId);
      const def = ELEMENT_LIBRARY[defIndex];
      buffer.writeUint32(element.id);
      buffer.writeVarUint(defIndex);
      buffer.writeFloat32(element.x);
      buffer.writeFloat32(element.y);
      buffer.writeFloat32(element.rotation);
      buffer.writeBool(element.lockToOrigin);
      buffer.writeUint32(element.seed);
      buffer.writeVarUint(element.parentId ?? 0);
      buffer.writeFloat32(element.parentOffsetX ?? 0);
      buffer.writeFloat32(element.parentOffsetY ?? 0);
      buffer.writeFloat32(element.renderOrder ?? 0);

      for (const param of def.params) {
        const value = element.params[param.key] ?? param.default;
        buffer.writeFloat32(value);
      }

      // Serialize color defs as 24-bit RGB
      if (def.colors) {
        for (const colorDef of def.colors) {
          const hex = element.stringParams[colorDef.key] ?? colorDef.default;
          const val = hex.startsWith('#') ? hex.slice(1) : hex;
          const rgb = parseInt(val, 16) || 0;
          buffer.writeUint32(rgb);
        }
      }
    }

    return buffer.toBase64();
  }

  private deserializeElementsFromBase64(base64: string, append: boolean) {
    const buffer = BitBuffer.fromBase64(base64);
    const version = buffer.readUint16();
    if (version < 1 || version > 5) return;
    const count = buffer.readVarUint();
    if (!append) {
      this.clearElements();
    }

    let maxSeenId = this.nextElementId - 1;

    for (let i = 0; i < count; i++) {
      const elementId = version >= 5 ? buffer.readUint32() : 0;
      const defIndex = buffer.readVarUint();
      const def = ELEMENT_LIBRARY[defIndex];
      const x = buffer.readFloat32();
      const y = buffer.readFloat32();
      const rotation = buffer.readFloat32();
      const lockToOrigin = buffer.readBool();
      const seed = buffer.readUint32();
      const parentId = version >= 3 ? buffer.readVarUint() : 0;
      const parentOffsetX = version >= 3 ? buffer.readFloat32() : 0;
      const parentOffsetY = version >= 3 ? buffer.readFloat32() : 0;
      const renderOrder = version >= 4 ? buffer.readFloat32() : this.getDefaultRenderOrder(def.id);
      const params: Record<string, number> = {};
      for (const param of def.params) {
        params[param.key] = version >= 5
          ? buffer.readFloat32()
          : buffer.readQuantized(param.min, param.max, 16);
      }

      const stringParams: Record<string, string> = {};
      if (version >= 2 && def.colors) {
        for (const colorDef of def.colors) {
          const rgb = buffer.readUint32();
          stringParams[colorDef.key] = '#' + rgb.toString(16).padStart(6, '0');
        }
      }

      const created = this.createElementInstance(def, {
        x,
        y,
        rotation,
        lockToOrigin,
        seed,
        params,
        stringParams,
        parentId,
        parentOffsetX,
        parentOffsetY,
        renderOrder,
        forceId: elementId > 0 ? elementId : undefined,
        suppressSelect: true,
      });
      maxSeenId = Math.max(maxSeenId, created.id);
    }

    this.nextElementId = Math.max(this.nextElementId, maxSeenId + 1);

    this.updateEntityListUI();
    this.updateElementPropertiesUI();
  }

  private saveElementsToFile() {
    const data = this.serializeElementsToBase64();
    const payload = JSON.stringify({ version: 1, data }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spacegame-elements.sgx';
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadElementsFromFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        if (json?.data) {
          this.deserializeElementsFromBase64(json.data, false);
          this.pushUndo();
        }
      } catch (e) {
        console.error('Failed to load elements:', e);
      }
    };
    reader.readAsText(file);
    input.value = '';
  }

  /** Write config keys into a BitBuffer in a fixed order */
  private writeConfigToBuffer(buf: BitBuffer, cfg: typeof this.config) {
    buf.writeString(cfg.starShader ?? 'classic');
    buf.writeFloat32(cfg.starBrightness ?? 6.0);
    buf.writeFloat32(cfg.starHueShift ?? 0);
    buf.writeFloat32(cfg.starDensity ?? 6.0);
    buf.writeFloat32(cfg.starTwinkleSpeed ?? 2.0);
    buf.writeFloat32(cfg.starTwinkleAmt ?? 0.3);
    buf.writeFloat32(cfg.starSize ?? 6.0);
    buf.writeFloat32(cfg.starParallax ?? 0.4);
    buf.writeFloat32(cfg.starBaseCell ?? 10);
    buf.writeFloat32(cfg.starLodBlend ?? 0.65);
  }

  /** Read config keys from a BitBuffer */
  private readConfigFromBuffer(buf: BitBuffer): typeof this.config {
    return {
      starShader: buf.readString(),
      starBrightness: buf.readFloat32(),
      starHueShift: buf.readFloat32(),
      starDensity: buf.readFloat32(),
      starTwinkleSpeed: buf.readFloat32(),
      starTwinkleAmt: buf.readFloat32(),
      starSize: buf.readFloat32(),
      starParallax: buf.readFloat32(),
      starBaseCell: buf.readFloat32(),
      starLodBlend: buf.readFloat32(),
    };
  }

  private saveSystemToFile() {
    const buf = new BitBuffer(4096);
    // Header
    buf.writeUint8(0x53); // 'S'
    buf.writeUint8(0x59); // 'Y'
    buf.writeUint8(0x53); // 'S'
    buf.writeUint16(1);   // version

    // Config
    this.writeConfigToBuffer(buf, this.config);

    // Layer enabled flags (6 bools packed)
    for (let i = 0; i < 6; i++) {
      buf.writeBool(this.layerEnabled[i] ?? true);
    }
    buf.alignToByte();

    // Camera
    buf.writeFloat32(this.cameraX);
    buf.writeFloat32(this.cameraY);
    buf.writeFloat32(this.cameraZoom);

    // Elements (embed the base64 as a string — it's already BitBuffer-encoded)
    buf.writeString(this.serializeElementsToBase64());

    const blob = new Blob([buf.getBuffer()], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spacegame-system.sgsys';
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadSystemFromFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (this.elements.size > 0 && !confirm('Replace current system elements with file contents?')) {
          input.value = '';
          return;
        }
        const buf = BitBuffer.fromArrayBuffer(reader.result as ArrayBuffer);

        // Header check
        const s = buf.readUint8();
        const y = buf.readUint8();
        const s2 = buf.readUint8();
        if (s !== 0x53 || y !== 0x59 || s2 !== 0x53) {
          console.error('Invalid .sgsys file header');
          return;
        }
        const version = buf.readUint16();
        if (version < 1) return;

        // Config
        this.config = this.readConfigFromBuffer(buf);

        // Layer enabled
        for (let i = 0; i < 6; i++) {
          this.layerEnabled[i] = buf.readBool();
          const checkbox = document.getElementById(`star-layer-${i}`) as HTMLInputElement | null;
          if (checkbox) checkbox.checked = this.layerEnabled[i];
        }
        buf.alignToByte();

        // Camera
        this.cameraX = buf.readFloat32();
        this.cameraY = buf.readFloat32();
        this.cameraZoom = buf.readFloat32();

        // Elements
        const elementsBase64 = buf.readString();
        if (elementsBase64) {
          this.deserializeElementsFromBase64(elementsBase64, false);
        }

        this.syncControlsFromConfig();
        this.starCache.clear();
        this.pushUndo('Load system');
      } catch (e) {
        console.error('Failed to load system:', e);
      }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
  }

  private syncControlsFromConfig() {
    const setSlider = (id: string, value: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      const valueEl = document.getElementById(`${id}-val`);
      if (!el) return;
      el.value = String(value);
      if (valueEl) {
        const decimals = value < 0.001 ? 5 : value < 1 ? 2 : value < 100 ? 1 : 0;
        valueEl.textContent = value.toFixed(decimals);
      }
    };

    setSlider('star-brightness', this.config.starBrightness);
    setSlider('star-size', this.config.starSize);
    setSlider('star-hue', this.config.starHueShift);
    setSlider('star-density', this.config.starDensity);
    setSlider('star-twinkle', this.config.starTwinkleSpeed);
    setSlider('star-twinkle-amt', this.config.starTwinkleAmt);
    setSlider('star-parallax', this.config.starParallax);
    setSlider('star-basecell', this.config.starBaseCell);
    setSlider('star-lodblend', this.config.starLodBlend);
  }

  private clearElements() {
    for (const element of this.elements.values()) {
      if (element.sunRenderer) {
        this.elementContainer.removeChild(element.sunRenderer.getContainer());
        element.sunRenderer.destroy();
      }
      if (element.coronaRenderer) {
        this.elementContainer.removeChild(element.coronaRenderer.getContainer());
        element.coronaRenderer.destroy();
      }
      if (element.glowRenderer) {
        this.elementContainer.removeChild(element.glowRenderer.getContainer());
        element.glowRenderer.destroy();
      }
      if (element.nebulaRenderer) {
        this.elementContainer.removeChild(element.nebulaRenderer.getContainer());
        element.nebulaRenderer.destroy();
      }
      this.elementContainer.removeChild(element.graphic);
    }
    this.elements.clear();
    this.nextElementId = 1;
    this.selectedElementId = null;
    this.updateEntityListUI();
    this.updateElementPropertiesUI();
  }

  private createElementInstance(
    def: ElementDefinition,
    data: {
      x: number;
      y: number;
      rotation: number;
      lockToOrigin: boolean;
      seed: number;
      params: Record<string, number>;
      stringParams?: Record<string, string>;
      parentId?: number;
      parentOffsetX?: number;
      parentOffsetY?: number;
      renderOrder?: number;
      forceId?: number;
      suppressSelect?: boolean;
    }
  ): ElementInstance {
    const id = data.forceId ?? this.nextElementId;
    this.nextElementId = Math.max(this.nextElementId, id + 1);
    const graphic = new Graphics();

    // Build default string params for colors
    const stringParams: Record<string, string> = { ...(data.stringParams ?? {}) };
    if (def.colors) {
      for (const c of def.colors) {
        if (stringParams[c.key] === undefined) {
          stringParams[c.key] = c.default;
        }
      }
    }

    let normalizedSeed = Number.isFinite(data.seed) && data.seed > 0
      ? Math.floor(data.seed)
      : Math.floor(Math.random() * 1000000) + 1;

    if (def.id === 'nebula') {
      const used = new Set<number>();
      for (const el of this.elements.values()) {
        if (el.defId === 'nebula') used.add(el.seed);
      }
      let guard = 0;
      while (used.has(normalizedSeed) && guard < 16) {
        normalizedSeed = Math.floor(Math.random() * 1000000) + 1;
        guard++;
      }
    }

    const instance: ElementInstance = {
      id,
      defId: def.id,
      x: data.x,
      y: data.y,
      renderOrder: data.renderOrder ?? this.getDefaultRenderOrder(def.id),
      parentId: data.parentId,
      parentOffsetX: data.parentOffsetX,
      parentOffsetY: data.parentOffsetY,
      rotation: data.rotation,
      params: data.params,
      stringParams,
      graphic,
      hitRadius: data.params.radius ?? 100,
      lockToOrigin: data.lockToOrigin,
      seed: normalizedSeed,
    };

    this.elements.set(id, instance);
    if (def.id === 'sun') {
      instance.sunRenderer = new SunRenderer();
      instance.sunRenderer.initialize();
      this.elementContainer.addChild(instance.sunRenderer.getContainer());
    } else if (def.id === 'detail_sun') {
      instance.sunRenderer = new SunRenderer();
      instance.sunRenderer.initialize();
      this.elementContainer.addChild(instance.sunRenderer.getContainer());
    } else if (def.id === 'detail_corona') {
      instance.coronaRenderer = new CoronaRaysRenderer();
      instance.coronaRenderer.initialize();
      this.elementContainer.addChild(instance.coronaRenderer.getContainer());
    } else if (def.id === 'detail_atmosphere') {
      instance.glowRenderer = new GlowRenderer();
      instance.glowRenderer.initialize();
      this.elementContainer.addChild(instance.glowRenderer.getContainer());
    } else if (def.id === 'nebula') {
      instance.nebulaRenderer = new NebulaRenderer();
      instance.nebulaRenderer.initialize(normalizedSeed);
      this.elementContainer.addChild(instance.nebulaRenderer.getContainer());
    }
    this.elementContainer.addChild(graphic);
    this.applyElementRenderOrder(instance);
    this.drawElementGraphic(instance);
    if (!data.suppressSelect) {
      this.selectElement(id);
      this.updateEntityListUI();
    }
    return instance;
  }

  private setParent(childId: number, parentId: number | null) {
    const child = this.elements.get(childId);
    if (!child) return;

    if (parentId === null) {
      child.parentId = undefined;
      child.parentOffsetX = undefined;
      child.parentOffsetY = undefined;
      this.updateEntityListUI();
      this.pushUndo('Unparent element');
      return;
    }
    if (childId === parentId) return;
    let cursor: number | undefined = parentId;
    while (cursor) {
      if (cursor === childId) return;
      cursor = this.elements.get(cursor)?.parentId;
    }

    const parent = this.elements.get(parentId);
    if (!parent) return;
    child.parentId = parentId;
    child.parentOffsetX = child.x - parent.x;
    child.parentOffsetY = child.y - parent.y;
    if (child.defId === 'detail_corona' && (parent.defId === 'sun' || parent.defId === 'detail_sun')) {
      // Corona should lock to the sun center and use radius offset behavior
      child.parentOffsetX = 0;
      child.parentOffsetY = 0;
      child.x = parent.x;
      child.y = parent.y;
      child.params.radius = 0; // now acts as +/- offset from parent sun radius
      if ((child.params.coronaInnerRadius ?? 1.0) < 1.0) child.params.coronaInnerRadius = 1.0;
      child.renderOrder = parent.renderOrder - 20;
      this.applyElementRenderOrder(child);
      this.drawElementGraphic(child);
    }
    if (child.defId === 'detail_atmosphere' && (parent.defId === 'sun' || parent.defId === 'detail_sun')) {
      // Atmosphere should also center-lock when parented to sun
      child.parentOffsetX = 0;
      child.parentOffsetY = 0;
      child.x = parent.x;
      child.y = parent.y;
      child.renderOrder = parent.renderOrder - 30;
      this.applyElementRenderOrder(child);
      this.drawElementGraphic(child);
    }
    this.updateEntityListUI();
    this.pushUndo('Parent element');
  }

  private unparentSelectedElement() {
    if (this.selectedElementId === null) return;
    this.setParent(this.selectedElementId, null);
  }

  private updateEntityListUI() {
    const list = document.getElementById('entity-list');
    if (!list) return;
    list.innerHTML = '';

    const getDepth = (el: ElementInstance): number => {
      let d = 0;
      let p = el.parentId;
      while (p) {
        d++;
        p = this.elements.get(p)?.parentId;
        if (d > 20) break;
      }
      return d;
    };

    const arr = Array.from(this.elements.values()).sort((a, b) => getDepth(a) - getDepth(b) || a.id - b.id);
    for (const el of arr) {
      const def = ELEMENT_LIBRARY.find((d) => d.id === el.defId);
      const row = document.createElement('div');
      const selected = el.id === this.selectedElementId;
      row.draggable = true;
      row.dataset.elementId = String(el.id);
      row.style.cssText = `padding:6px 8px; border:1px solid #2a2a3a; border-radius:4px; margin-bottom:4px; cursor:pointer; background:${selected ? '#203245' : '#141420'}; color:${selected ? '#cfe8ff' : '#ddd'}; margin-left:${getDepth(el) * 14}px;`;
      row.textContent = `${def?.name ?? el.defId} #${el.id}${el.parentId ? `  ↳ ${el.parentId}` : ''}`;

      row.addEventListener('click', () => this.selectElement(el.id));
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer?.setData('text/element-parent-source', String(el.id));
      });
      row.addEventListener('dragover', (ev) => ev.preventDefault());
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const src = parseInt(ev.dataTransfer?.getData('text/element-parent-source') || '', 10);
        if (!Number.isFinite(src)) return;
        this.setParent(src, el.id);
      });

      list.appendChild(row);
    }
  }

  private buildSunVariantSelector(container: HTMLElement, element: ElementInstance) {
    const section = document.createElement('div');
    section.className = 'section';
    section.innerHTML = `<div class="section-title">Sun Variants</div>`;

    const grid = document.createElement('div');
    grid.className = 'variant-grid';
    const hue = element.params.hue ?? 40;

    SUN_VARIANTS.forEach((variant, index) => {
      const card = document.createElement('div');
      card.className = 'variant-card';
      const variantIndex = index + 1;
      if ((element.params.variant ?? 1) === variantIndex) {
        card.classList.add('active');
      }

      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 60;
      canvas.className = 'variant-thumb';
      this.drawSunVariantThumbnail(canvas, hue, index);

      const label = document.createElement('div');
      label.textContent = variant.name;

      card.appendChild(canvas);
      card.appendChild(label);

      card.addEventListener('click', () => {
        element.params.variant = variantIndex;
        this.updateElementPropertiesUI();
        this.drawElementGraphic(element);
      });

      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);
  }

  private drawSunVariantThumbnail(canvas: HTMLCanvasElement, baseHue: number, variantIndex: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, w, h);

    const variant = SUN_VARIANTS[variantIndex];
    const hue = (baseHue + variantIndex * 12) % 360;
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.5, 8, w * 0.5, h * 0.5, 34);
    glow.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.9)`);
    glow.addColorStop(0.4, `hsla(${hue + 15}, 90%, 60%, 0.6)`);
    glow.addColorStop(1, `hsla(${hue + 30}, 90%, 45%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 34, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 22, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 75%, ${55 + variantIndex * 2}%)`;
    ctx.fill();

    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `hsla(${hue + 20}, 90%, 80%, 0.6)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private getDefaultRenderOrder(defId: string): number {
    if (defId === 'detail_atmosphere') return -30;
    if (defId === 'detail_corona') return -20;
    if (defId === 'sun' || defId === 'detail_sun') return 0;
    return 10;
  }

  private applyElementRenderOrder(element: ElementInstance) {
    const z = element.renderOrder ?? 0;
    const base = z + element.id * 0.0001;
    element.graphic.zIndex = base + 0.2;
    if (element.sunRenderer) {
      element.sunRenderer.getContainer().zIndex = base;
    }
    if (element.coronaRenderer) {
      element.coronaRenderer.getContainer().zIndex = base;
    }
    if (element.glowRenderer) {
      element.glowRenderer.getContainer().zIndex = base;
    }
    if (element.nebulaRenderer) {
      element.nebulaRenderer.getContainer().zIndex = base;
    }
  }

  private getResolvedCoronaRadius(element: ElementInstance): number {
    const offsetOrRadius = element.params.radius ?? 1000;
    if (!element.parentId) return Math.max(50, offsetOrRadius);

    const parent = this.elements.get(element.parentId);
    if (!parent) return Math.max(50, offsetOrRadius);

    const isSunParent = parent.defId === 'sun' || parent.defId === 'detail_sun';
    if (!isSunParent) return Math.max(50, offsetOrRadius);

    const parentRadius = parent.params.radius ?? 1000;
    return Math.max(50, parentRadius + offsetOrRadius);
  }

  private drawElementGraphic(element: ElementInstance) {
    const def = ELEMENT_LIBRARY.find((d) => d.id === element.defId);
    if (!def) return;
    element.graphic.clear();
    if (def.id === 'sun' && element.sunRenderer) {
      const radius = element.params.radius ?? 500;
      element.hitRadius = Math.max(80, radius * 1.1);
      if (element.id === this.selectedElementId) {
        element.graphic.circle(0, 0, radius * 1.1);
        element.graphic.stroke({ color: 0x66aaff, width: 2, alpha: 0.9 });
      }
    } else if (def.id === 'detail_sun' && element.sunRenderer) {
      const radius = element.params.radius ?? 1000;
      element.hitRadius = Math.max(80, radius * 1.1);
      if (element.id === this.selectedElementId) {
        element.graphic.circle(0, 0, radius * 1.1);
        element.graphic.stroke({ color: 0x66aaff, width: 2, alpha: 0.9 });
      }
    } else if (def.id === 'detail_corona' && element.coronaRenderer) {
      const radius = this.getResolvedCoronaRadius(element);
      const outerMul = element.params.coronaOuterRadius ?? 1.5;
      element.hitRadius = Math.max(80, radius * outerMul);
      if (element.id === this.selectedElementId) {
        element.graphic.circle(0, 0, radius * outerMul);
        element.graphic.stroke({ color: 0x66aaff, width: 2, alpha: 0.9 });
      }
    } else if (def.id === 'detail_atmosphere' && element.glowRenderer) {
      const radius = element.params.glowRadius ?? 8000;
      element.hitRadius = Math.max(200, radius * 0.5);
      if (element.id === this.selectedElementId) {
        element.graphic.circle(0, 0, radius * 0.3);
        element.graphic.stroke({ color: 0x66aaff, width: 2, alpha: 0.9 });
      }
    } else {
      element.hitRadius = this.drawElementPixi(
        element.graphic,
        def,
        element.params,
        element.seed,
        element.id === this.selectedElementId,
        this.time
      );
    }
  }

  private updateSunElement(element: ElementInstance, dt: number, screenSize: { width: number; height: number }) {
    const renderer = element.sunRenderer;
    if (!renderer) return;

    const params = element.params;
    const radius = params.radius ?? 500;
    const hue = params.hue ?? 40;
    const noiseScale = params.noiseScale ?? 1;
    const coronaSize = 1.0;
    const coronaIntensity = 0.0;
    const speed = params.speed ?? 1;
    const variantIndex = Math.max(1, Math.min(5, Math.round(params.variant ?? 1))) - 1;
    const variant = SUN_VARIANTS[variantIndex];

    renderer.setSunStyle(variantIndex, variant.sunParams);
    renderer.setCoronaStyle(variant.coronaStyle, variant.coronaParams);
    renderer.setRadius(0.35);
    renderer.setNoiseScale(noiseScale);
    renderer.setCoronaSize(coronaSize);
    renderer.setCoronaIntensity(coronaIntensity);
    renderer.setAnimationSpeed(speed);
    renderer.setLOD(Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9)));
    renderer.update(dt, hue, radius, screenSize);
  }

  private updateDetailSunElement(element: ElementInstance, dt: number, screenSize: { width: number; height: number }) {
    const renderer = element.sunRenderer;
    if (!renderer) return;

    const p = element.params;
    const sp = element.stringParams;
    const radius = p.radius ?? 1000;
    const hue = p.hue ?? 40;
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));

    // Resolve the brownian sun style (same shader used on the login screen)
    const brownianIndex = sunShaderDefs.sunStyles.findIndex(s => s.id === 'brownian');
    const styleIndex = brownianIndex >= 0 ? brownianIndex : 2;
    const sunParams = [
      0.5,                              // coreRadius
      p.octaves ?? 5.0,                 // octaves (1-8)
      p.lacunarity ?? 2.0,              // lacunarity (freq multiplier)
      p.gain ?? 0.5,                    // gain (amplitude multiplier)
      0.9,                              // unused
      p.warpAmount ?? 0.4,              // warpAmount for domain warping
    ];
    renderer.setSunStyle(styleIndex, sunParams);

    // Disable corona on the body — use a separate Detail Corona element
    renderer.setCoronaSize(0);
    renderer.setCoronaIntensity(0);

    renderer.setRadius(0.4);
    renderer.setLOD(lodZoom);
    renderer.setWarpParams(p.warpScale ?? 0.5, 0.0, p.turbulenceMix ?? 0.3);
    renderer.setFbmParams(p.noiseScale ?? 4.0, p.animSpeed ?? 0.15, p.fbmContrast ?? 1.0);
    renderer.setPlasmaParams(p.plasmaIntensity ?? 0.3, p.plasmaScale ?? 3.0, p.plasmaSpeed ?? 1.0);
    renderer.setCenterLight(
      p.centerDarken ?? 0.5,
      p.centerHighlight ?? 0.5,
      p.centerFalloff ?? 1.5,
      p.centerMidpoint ?? 0.5
    );
    renderer.setInsideAdjust(p.innerDarkening ?? 0.0, p.whiteBalance ?? 0.0, p.saturation ?? 1.0);
    renderer.setEdgeStyle(p.edgeBrightness ?? 1.0, p.edgeThickness ?? 0.03, p.edgeSharpness ?? 0.5);
    renderer.setEdgeGlow(p.limbDarkening ?? 0.5, 0.0, 0.0);
    renderer.setAtmosphereRadii(0.0, 0.0);
    renderer.setCoronaRadii(0.0, 0.0);
    renderer.setCustomColors(
      this.hexToRgb(sp.darkColor ?? '#1a0500'),
      this.hexToRgb(sp.midColor ?? '#661100'),
      this.hexToRgb(sp.brightColor ?? '#ff6600'),
      this.hexToRgb(sp.edgeColor ?? '#ffaa33')
    );
    renderer.setPlasmaColor(this.hexToRgb(sp.plasmaColor ?? '#ff9933'));
    renderer.setCenterColor(this.hexToRgb(sp.centerColor ?? '#ffe6cc'));
    renderer.update(dt, hue, radius, screenSize);
  }

  private updateDetailCoronaElement(element: ElementInstance, dt: number, _screenSize: { width: number; height: number }) {
    const renderer = element.coronaRenderer;
    if (!renderer) return;

    const p = element.params;
    const s = element.stringParams;
    const radius = this.getResolvedCoronaRadius(element);
    const hue = p.hue ?? 40;
    renderer.update(dt * 1000, hue, radius, {
      intensity: p.coronaIntensity ?? 0.8,
      innerRadiusMul: p.coronaInnerRadius ?? 1.0,
      outerRadiusMul: p.coronaOuterRadius ?? 1.5,
      rayCount: Math.round(p.rayCount ?? 10),
      rayWidth: p.rayWidth ?? 0.06,
      rayVariation: p.rayVariation ?? 0.35,
      raySpeed: p.raySpeed ?? 0.35,
      rayTurbulence: p.rayTurbulence ?? 0.15,
      baseColor: this.hexToRgb(s.baseColor ?? '#ffb366'),
      tipColor: this.hexToRgb(s.tipColor ?? '#ffe0b0'),
    });
  }

  private updateDetailAtmosphereElement(element: ElementInstance, dt: number, _screenSize: { width: number; height: number }) {
    const renderer = element.glowRenderer;
    if (!renderer) return;

    const p = element.params;
    const s = element.stringParams;
    const radius = p.radius ?? 1000;
    const hue = p.hue ?? 40;
    const glowRadius = p.glowRadius ?? 8000;
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));

    renderer.setLOD(lodZoom);
    renderer.update(
      dt,
      hue,
      radius,
      glowRadius,
      element.x,
      element.y,
      p.glowIntensity ?? 0.6,
      p.glowSize ?? 0.1,
      this.hexToRgb(s.innerColor ?? '#ffbb66'),
      this.hexToRgb(s.outerColor ?? '#ff9966'),
    );
    renderer.setPosition(element.x, element.y);
  }

  private updateNebulaElement(element: ElementInstance, dt: number) {
    const renderer = element.nebulaRenderer;
    if (!renderer) return;

    const p = element.params;
    const radius = p.radius ?? 1200;
    const lodZoom = Math.max(0, Math.min(1, (this.cameraZoom - 0.1) / 1.9));

    renderer.update(dt, radius, {
      shapeScale: p.shapeScale,
      intensity: p.intensity,
      animSpeed: p.animSpeed,
      lod: lodZoom,
      parallax: p.parallax,
      cameraX: this.cameraX,
      cameraY: this.cameraY,
    });

    renderer.setPosition(element.x, element.y);
  }

  private drawElementCanvas(
    ctx: CanvasRenderingContext2D,
    def: ElementDefinition,
    params: Record<string, number>,
    cx: number,
    cy: number,
    scale: number
  ) {
    const radius = (params.radius ?? 100) * scale;
    const hue = params.hue ?? 40;
    ctx.save();
    ctx.translate(cx, cy);

    if (def.id === 'sun') {
      const glow = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.2);
      glow.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.9)`);
      glow.addColorStop(0.6, `hsla(${hue + 15}, 90%, 60%, 0.6)`);
      glow.addColorStop(1, `hsla(${hue + 20}, 90%, 45%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue}, 75%, 60%)`;
      ctx.fill();
    } else if (def.id === 'detail_sun') {
      // Detail sun thumbnail - richer look with corona
      const glow = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius * 1.5);
      glow.addColorStop(0, `hsla(${hue}, 90%, 80%, 1.0)`);
      glow.addColorStop(0.25, `hsla(${hue + 5}, 85%, 65%, 0.9)`);
      glow.addColorStop(0.5, `hsla(${hue + 10}, 90%, 55%, 0.6)`);
      glow.addColorStop(0.8, `hsla(${hue + 20}, 80%, 40%, 0.2)`);
      glow.addColorStop(1, `hsla(${hue + 30}, 70%, 30%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue}, 85%, 55%)`;
      ctx.fill();

      // Inner corona ring
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.95, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue + 15}, 95%, 75%, 0.5)`;
      ctx.lineWidth = Math.max(1, radius * 0.06);
      ctx.stroke();
    } else if (def.id === 'detail_corona') {
      // Corona-only thumbnail: ring with glow
      const coronaGlow = ctx.createRadialGradient(0, 0, radius * 0.6, 0, 0, radius * 1.4);
      coronaGlow.addColorStop(0, `hsla(${hue}, 60%, 40%, 0.0)`);
      coronaGlow.addColorStop(0.3, `hsla(${hue + 10}, 80%, 55%, 0.3)`);
      coronaGlow.addColorStop(0.5, `hsla(${hue + 15}, 95%, 65%, 0.6)`);
      coronaGlow.addColorStop(0.7, `hsla(${hue + 20}, 90%, 55%, 0.3)`);
      coronaGlow.addColorStop(1, `hsla(${hue + 30}, 80%, 40%, 0)`);
      ctx.fillStyle = coronaGlow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.85, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue + 15}, 95%, 75%, 0.7)`;
      ctx.lineWidth = Math.max(1, radius * 0.08);
      ctx.stroke();
    } else if (def.id === 'detail_atmosphere') {
      // Atmosphere thumbnail: large soft radial glow
      const atmoGlow = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius * 1.5);
      atmoGlow.addColorStop(0, `hsla(${hue}, 70%, 65%, 0.5)`);
      atmoGlow.addColorStop(0.4, `hsla(${hue + 10}, 60%, 50%, 0.3)`);
      atmoGlow.addColorStop(0.7, `hsla(${hue + 20}, 50%, 40%, 0.1)`);
      atmoGlow.addColorStop(1, `hsla(${hue + 30}, 40%, 30%, 0)`);
      ctx.fillStyle = atmoGlow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (def.id === 'corona_soft') {
      const thickness = (params.thickness ?? 20) * scale;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 90%, 70%, 0.75)`;
      ctx.lineWidth = thickness;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue + 20}, 90%, 60%, 0.4)`;
      ctx.lineWidth = thickness * 0.6;
      ctx.stroke();
    } else if (def.id === 'corona_streams') {
      const streams = Math.max(4, Math.round(params.streams ?? 8));
      ctx.strokeStyle = `hsla(${hue}, 95%, 70%, 0.8)`;
      ctx.lineWidth = Math.max(1, (params.width ?? 10) * scale * 0.3);
      for (let i = 0; i < streams; i++) {
        const ang = (i / streams) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius, ang, ang + Math.PI * 0.35);
        ctx.stroke();
      }
    } else if (def.id === 'ambient_glow') {
      const grad = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius);
      grad.addColorStop(0, `hsla(${hue}, 80%, 70%, 0.7)`);
      grad.addColorStop(1, `hsla(${hue}, 80%, 40%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (def.id === 'nebula') {
      // Nebula thumbnail: layered soft gradients
      const grad = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius);
      grad.addColorStop(0, `hsla(280, 70%, 60%, 0.6)`);
      grad.addColorStop(0.35, `hsla(290, 65%, 45%, 0.4)`);
      grad.addColorStop(0.65, `hsla(260, 60%, 35%, 0.2)`);
      grad.addColorStop(1, `hsla(270, 50%, 20%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      const grad2 = ctx.createRadialGradient(radius * 0.25, -radius * 0.15, 0, radius * 0.25, -radius * 0.15, radius * 0.6);
      grad2.addColorStop(0, `hsla(310, 70%, 55%, 0.4)`);
      grad2.addColorStop(1, `hsla(280, 60%, 30%, 0)`);
      ctx.fillStyle = grad2;
      ctx.beginPath();
      ctx.arc(radius * 0.25, -radius * 0.15, radius * 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else if (def.id === 'black_hole') {
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = '#050008';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 80%, 60%, 0.8)`;
      ctx.lineWidth = Math.max(2, radius * 0.12);
      ctx.stroke();
    } else if (def.id === 'wormhole') {
      const rings = Math.max(3, Math.round(params.rings ?? 6));
      for (let i = 0; i < rings; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, radius * (0.4 + i / rings * 0.6), 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 80%, 70%, ${0.2 + i / rings * 0.4})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (def.id === 'comet') {
      const tail = (params.tail ?? 80) * scale;
      const width = (params.width ?? 12) * scale;
      ctx.beginPath();
      ctx.moveTo(-tail, -width * 0.5);
      ctx.lineTo(0, 0);
      ctx.lineTo(-tail, width * 0.5);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 90%, 70%, 0.6)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
    } else if (def.id === 'aurora_arc') {
      const length = (params.length ?? 120) * scale;
      const thickness = (params.thickness ?? 16) * scale;
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${hue}, 90%, 60%, 0.7)`;
      ctx.lineWidth = thickness;
      ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + length / 200);
      ctx.stroke();
    } else if (def.id === 'asteroid_belt') {
      const count = Math.round(params.count ?? 60);
      ctx.fillStyle = `hsla(${hue}, 40%, 50%, 0.7)`;
      for (let i = 0; i < count / 8; i++) {
        const ang = (i / (count / 8)) * Math.PI * 2;
        const r = radius * (0.7 + Math.random() * 0.3);
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * r, Math.sin(ang) * r, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawElementPixi(
    g: Graphics,
    def: ElementDefinition,
    params: Record<string, number>,
    seed: number,
    selected: boolean,
    time: number
  ): number {
    const radius = params.radius ?? 100;
    const hue = params.hue ?? 40;
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.5);
    const rng = this.seededRandom(seed);

    if (def.id === 'corona_soft') {
      const thickness = params.thickness ?? 30;
      const intensity = params.intensity ?? 0.8;
      const flicker = params.flicker ?? 0.6;
      const flickerPulse = 0.7 + 0.3 * Math.sin(time * (1.5 + flicker) + seed);
      const baseAlpha = intensity * flickerPulse;

      g.circle(0, 0, radius * 1.12);
      g.stroke({ color: this.hslToHex(hue + 10, 0.9, 0.8), width: thickness * 0.6, alpha: baseAlpha * 0.35 });
      g.circle(0, 0, radius);
      g.stroke({ color: this.hslToHex(hue, 0.95, 0.7), width: thickness, alpha: baseAlpha * 0.8 });
      g.circle(0, 0, radius * 0.88);
      g.stroke({ color: this.hslToHex(hue + 25, 0.85, 0.75), width: thickness * 0.5, alpha: baseAlpha * 0.6 });
    } else if (def.id === 'corona_streams') {
      const streams = Math.max(4, Math.round(params.streams ?? 8));
      const width = params.width ?? 18;
      const speed = params.speed ?? 1.0;
      const intensity = params.intensity ?? 1.0;
      const streamPulse = 0.6 + 0.4 * Math.sin(time * speed + seed * 0.1);

      for (let i = 0; i < streams; i++) {
        const ang = (i / streams) * Math.PI * 2 + Math.sin(time * speed + i) * 0.4;
        const arcLen = Math.PI * (0.25 + 0.15 * Math.sin(time * 0.7 + i));
        const r = radius * (0.96 + 0.06 * Math.sin(time + i));
        g.arc(0, 0, r, ang, ang + arcLen);
        g.stroke({ color: this.hslToHex(hue + i * 4, 0.9, 0.7), width: width, alpha: intensity * streamPulse * 0.6 });
        g.arc(0, 0, r * 1.05, ang + 0.1, ang + arcLen + 0.1);
        g.stroke({ color: this.hslToHex(hue + 20 + i * 3, 0.9, 0.75), width: width * 0.5, alpha: intensity * 0.4 });
      }
    } else if (def.id === 'ambient_glow') {
      const intensity = params.intensity ?? 0.5;
      const falloff = params.falloff ?? 1.6;
      g.circle(0, 0, radius * (1.2 + falloff * 0.1));
      g.fill({ color: this.hslToHex(hue, 0.7, 0.6), alpha: intensity * 0.15 });
      g.circle(0, 0, radius * 1.05);
      g.fill({ color: this.hslToHex(hue + 12, 0.75, 0.6), alpha: intensity * 0.25 });
      g.circle(0, 0, radius * 0.85);
      g.fill({ color: this.hslToHex(hue, 0.8, 0.55), alpha: intensity * 0.35 });
    } else if (def.id === 'nebula') {
      // Shader handles all rendering — just draw selection ring
      if (selected) {
        g.circle(0, 0, radius);
        g.stroke({ color: 0x4fc3f7, width: 2, alpha: 0.6 });
      }
    } else if (def.id === 'black_hole') {
      const disk = params.disk ?? 80;
      const warp = params.warp ?? 0.7;
      const glow = params.glow ?? 0.9;
      const diskPulse = 0.6 + 0.4 * Math.sin(time * 0.8 + seed * 0.2);

      g.circle(0, 0, radius * 0.7);
      g.fill({ color: 0x050008, alpha: 1 });

      for (let i = 0; i < 3; i++) {
        const ringR = radius * (0.85 + i * 0.1);
        g.circle(0, 0, ringR);
        g.stroke({ color: this.hslToHex(hue + i * 12, 0.8, 0.6), width: disk * (0.12 + i * 0.04), alpha: glow * (0.3 + 0.2 * i) * diskPulse });
      }

      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + time * 0.4 * warp;
        g.arc(0, 0, radius * (1.05 + i * 0.03), ang, ang + Math.PI * 0.2);
        g.stroke({ color: this.hslToHex(hue + 40, 0.9, 0.7), width: 4, alpha: 0.4 * glow });
      }
    } else if (def.id === 'wormhole') {
      const rings = Math.max(4, Math.round(params.rings ?? 8));
      const twist = params.twist ?? 0.8;
      const intensity = params.intensity ?? 1.0;
      for (let i = 0; i < rings; i++) {
        const r = radius * (0.35 + i / rings * 0.75);
        const ang = time * 0.3 * twist + i * 0.6;
        g.arc(0, 0, r, ang, ang + Math.PI * 1.2);
        g.stroke({ color: this.hslToHex(hue + i * 8, 0.8, 0.6), width: 2 + i * 0.4, alpha: intensity * (0.2 + i / rings * 0.6) });
      }
    } else if (def.id === 'aurora_arc') {
      const length = params.length ?? 120;
      const thickness = params.thickness ?? 16;
      const shimmer = params.shimmer ?? 0.7;
      const shimmerPulse = 0.6 + 0.4 * Math.sin(time * 1.8 + seed * 0.3);
      g.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + length / 180);
      g.stroke({ color: this.hslToHex(hue, 0.9, 0.65), width: thickness, alpha: shimmerPulse * shimmer });
      g.arc(0, 0, radius * 0.92, -Math.PI / 2, -Math.PI / 2 + length / 180);
      g.stroke({ color: this.hslToHex(hue + 20, 0.9, 0.7), width: thickness * 0.5, alpha: shimmerPulse * 0.6 });
    } else if (def.id === 'comet') {
      const tail = params.tail ?? 140;
      const width = params.width ?? 26;
      const sparkle = params.sparkle ?? 0.5;
      g.moveTo(-tail, -width * 0.5);
      g.lineTo(0, 0);
      g.lineTo(-tail, width * 0.5);
      g.closePath();
      g.fill({ color: this.hslToHex(hue, 0.85, 0.7), alpha: 0.7 });
      g.circle(0, 0, radius * 0.8);
      g.fill({ color: 0xffffff, alpha: 1 });
      for (let i = 0; i < 6; i++) {
        const ang = rng() * Math.PI * 2;
        const r = radius * (0.8 + rng() * 0.6);
        g.circle(Math.cos(ang) * r, Math.sin(ang) * r, 1 + rng() * 2);
        g.fill({ color: this.hslToHex(hue + 30, 0.9, 0.8), alpha: sparkle * 0.8 });
      }
    } else if (def.id === 'asteroid_belt') {
      const count = Math.round(params.count ?? 120);
      const beltThickness = params.thickness ?? 120;
      const variation = params.variation ?? 0.6;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + rng() * 0.2;
        const r = radius + (rng() - 0.5) * beltThickness * (0.4 + variation);
        const size = 2 + rng() * 4;
        g.circle(Math.cos(ang) * r, Math.sin(ang) * r, size);
        g.fill({ color: this.hslToHex(hue + rng() * 20, 0.35, 0.55), alpha: 0.7 + rng() * 0.3 });
      }
    }

    if (selected) {
      g.circle(0, 0, radius * 1.05);
      g.stroke({ color: 0x66aaff, width: 2, alpha: 0.8 });
    }

    return Math.max(60, radius * 1.2);
  }

  private bindSlider(id: string, callback: (val: number) => void) {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valueDisplay = document.getElementById(id + '-val');
    
    if (slider && valueDisplay) {
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        const decimals = val < 0.001 ? 5 : val < 1 ? 2 : val < 100 ? 1 : 0;
        valueDisplay.textContent = val.toFixed(decimals);
        callback(val);
      });
    }
  }
  
  private setupSpawnButtons() {
    // Spawn type selection
    document.querySelectorAll('.spawn-btn[data-spawn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-spawn')!;
        
        // Toggle selection
        if (this.selectedSpawnType === type) {
          this.selectedSpawnType = null;
          btn.classList.remove('active');
          this.setTool('pan');
        } else {
          document.querySelectorAll('.spawn-btn[data-spawn]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this.selectedSpawnType = type;
          this.setTool('spawn');
        }
      });
    });
    
    // Instant effects
    document.querySelectorAll('.spawn-btn[data-effect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const effect = btn.getAttribute('data-effect')!;
        this.spawnEffect(effect);
      });
    });
    
    // Clear buttons
    document.querySelectorAll('.spawn-btn[data-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const clearType = btn.getAttribute('data-clear')!;
        if (clearType === 'entities') this.clearEntities();
        if (clearType === 'all') this.clearAll();
      });
    });
    
    // Admin buttons
    document.getElementById('admin-push-config')?.addEventListener('click', () => {
      this.pushConfigToServer();
    });
    
    document.getElementById('admin-reload-data')?.addEventListener('click', () => {
      this.sendToAdmin('reload', {});
    });
    
    document.getElementById('admin-kill-all')?.addEventListener('click', () => {
      this.executeAdminCommand('killAll');
    });
    
    document.getElementById('admin-toggle-invincible')?.addEventListener('click', () => {
      this.executeAdminCommand('toggleInvincible');
    });
    
    document.getElementById('admin-spawn-test')?.addEventListener('click', () => {
      this.executeAdminCommand('spawnEnemy', { type: 'ice_sprite', x: 0, y: 5000, systemId: 'sol' });
    });
    
    document.getElementById('admin-tp-origin')?.addEventListener('click', () => {
      // This would need a player ID - for now teleport player 1 (if exists)
      this.executeAdminCommand('teleportPlayer', { playerId: 1, x: 0, y: 0 });
    });
  }
  
  private resetView() {
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZoom = 1;
  }
  
  private onResize() {
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
    this.resizeGridCanvas();
  }

  // ============================================
  // GALAXY MODE
  // ============================================

  private setupGalaxyMode() {
    // Mode toggle button
    const toggleBtn = document.getElementById('mode-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.setEditorMode(this.editorMode === 'system' ? 'galaxy' : 'system');
      });
    }

    // Galaxy panel buttons
    document.getElementById('galaxy-add-system')?.addEventListener('click', () => this.addSystem());
    document.getElementById('galaxy-delete-system')?.addEventListener('click', () => this.deleteSelectedSystem());
    document.getElementById('galaxy-edit-system')?.addEventListener('click', () => this.enterSystem());

    // System name input
    const nameInput = document.getElementById('galaxy-system-name') as HTMLInputElement | null;
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) {
            sys.name = nameInput.value;
            this.updateGalaxySystemList();
          }
        }
      });
    }

    // Boundary radius slider
    const radiusSlider = document.getElementById('galaxy-boundary-radius') as HTMLInputElement | null;
    if (radiusSlider) {
      radiusSlider.addEventListener('input', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) {
            const oldRadius = sys.boundaryRadius;
            sys.boundaryRadius = parseFloat(radiusSlider.value);
            this.maintainOverlapsOnResize(sys, oldRadius);
            this.updateGalaxyPropertiesUI();
          }
        }
      });
    }

    // Boundary radius numeric input
    const radiusInput = document.getElementById('galaxy-boundary-radius-input') as HTMLInputElement | null;
    if (radiusInput) {
      radiusInput.addEventListener('change', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) {
            const oldRadius = sys.boundaryRadius;
            sys.boundaryRadius = Math.max(10000, Math.min(200000, parseFloat(radiusInput.value) || 50000));
            this.maintainOverlapsOnResize(sys, oldRadius);
            this.updateGalaxyPropertiesUI();
          }
        }
      });
    }

    // Position X/Y inputs
    const posXInput = document.getElementById('galaxy-system-pos-x') as HTMLInputElement | null;
    const posYInput = document.getElementById('galaxy-system-pos-y') as HTMLInputElement | null;
    if (posXInput) {
      posXInput.addEventListener('change', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) {
            sys.x = parseFloat(posXInput.value) || 0;
            this.updateGalaxyPropertiesUI();
          }
        }
      });
    }
    if (posYInput) {
      posYInput.addEventListener('change', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) {
            sys.y = parseFloat(posYInput.value) || 0;
            this.updateGalaxyPropertiesUI();
          }
        }
      });
    }

    // System color picker
    const colorInput = document.getElementById('galaxy-system-color') as HTMLInputElement | null;
    if (colorInput) {
      colorInput.addEventListener('input', () => {
        if (this.selectedSystemId) {
          const sys = this.systems.get(this.selectedSystemId);
          if (sys) sys.color = colorInput.value;
        }
      });
    }

    // Universe save/load
    document.getElementById('galaxy-save-universe')?.addEventListener('click', () => this.saveUniverse());
    const loadInput = document.getElementById('galaxy-load-input') as HTMLInputElement | null;
    document.getElementById('galaxy-load-universe')?.addEventListener('click', () => loadInput?.click());
    if (loadInput) {
      loadInput.addEventListener('change', () => {
        const file = loadInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          this.loadUniverse(reader.result as ArrayBuffer);
        };
        reader.readAsArrayBuffer(file);
        loadInput.value = '';
      });
    }

    // Create a default system
    this.addSystem(0, 0, 'Sol System');
  }

  private setEditorMode(mode: EditorMode) {
    if (this.editorMode === mode) return;

    // Save current system state before switching
    if (this.editorMode === 'system' && this.activeSystemId) {
      this.saveActiveSystemState();
    }

    this.editorMode = mode;

    // Toggle visibility
    const isGalaxy = mode === 'galaxy';
    this.worldContainer.visible = !isGalaxy;
    this.galaxyContainer.visible = isGalaxy;
    if (this.starfieldRenderer) {
      this.starfieldRenderer.getContainer().visible = !isGalaxy;
    }

    if (isGalaxy) {
      ['stars', 'library', 'element', 'spawn', 'admin', 'entities', 'history'].forEach((id) => this.setWindowVisible(id, false));
    }

    // Toggle UI
    this.setWindowVisible('galaxy', isGalaxy);

    // Toggle toolbar items visibility
    const systemOnlyBtns = document.querySelectorAll('[data-window="stars"], [data-window="library"], [data-window="element"], [data-window="spawn"]');
    systemOnlyBtns.forEach(btn => (btn as HTMLElement).style.display = isGalaxy ? 'none' : '');

    // Update toggle button text
    const toggleBtn = document.getElementById('mode-toggle-btn');
    if (toggleBtn) toggleBtn.textContent = isGalaxy ? '🌍 Galaxy' : '⭐ System';

    // Update help text
    const helpKeys = document.querySelector('.help-keys');
    if (helpKeys) {
      helpKeys.textContent = isGalaxy
        ? '🌌 Galaxy Mode · Drag: Pan · Scroll: Zoom · DblClick: Edit System'
        : '';
      // Re-add the kbd elements for system mode
      if (!isGalaxy) {
        helpKeys.innerHTML = '<kbd>Drag</kbd> Pan · <kbd>Scroll</kbd> Zoom · <kbd>Shift+R</kbd> Reset';
      }
    }

    // Hide grid in galaxy mode
    if (isGalaxy) {
      this.gridCtx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
    }

    if (isGalaxy) {
      this.updateGalaxySystemList();
      this.updateGalaxyPropertiesUI();
    }
  }

  private saveActiveSystemState() {
    if (!this.activeSystemId) return;
    const sys = this.systems.get(this.activeSystemId);
    if (!sys) return;
    sys.elementsBase64 = this.serializeElementsToBase64();
  }

  /**
   * Snap a position so it sits at the ideal overlap distance from nearby systems.
   * Target: 10% of the smaller boundary overlaps with each neighbor.
   * Considers multiple neighbors and tries to satisfy as many as possible.
   * Returns the snapped {x, y}.
   */
  private snapToOverlap(px: number, py: number, myRadius: number, excludeId?: string): { x: number; y: number } {
    const overlapFraction = 0.10;
    const snapZoneFraction = 0.30;

    // Collect all nearby systems with their ideal distances
    type Candidate = { sys: SystemNode; idealDist: number; currentDist: number; dx: number; dy: number };
    const candidates: Candidate[] = [];

    for (const [id, sys] of this.systems) {
      if (id === excludeId) continue;
      const dx = px - sys.x;
      const dy = py - sys.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const smallerRadius = Math.min(myRadius, sys.boundaryRadius);
      const idealDist = myRadius + sys.boundaryRadius - smallerRadius * overlapFraction;
      const snapThreshold = idealDist * snapZoneFraction;

      // Only consider systems we're close enough to snap to
      if (Math.abs(dist - idealDist) <= snapThreshold) {
        candidates.push({ sys, idealDist, currentDist: dist, dx, dy });
      }
    }

    if (candidates.length === 0) {
      return { x: px, y: py };
    }

    if (candidates.length === 1) {
      // Single neighbor: snap along the line to it
      const c = candidates[0];
      const len = Math.max(1, c.currentDist);
      return {
        x: c.sys.x + (c.dx / len) * c.idealDist,
        y: c.sys.y + (c.dy / len) * c.idealDist,
      };
    }

    // Multiple neighbors: find the position that best satisfies all constraints
    // Use iterative averaging - start at cursor, adjust toward ideal position for each
    let bestX = px;
    let bestY = py;
    for (let iter = 0; iter < 5; iter++) {
      let sumX = 0, sumY = 0, weight = 0;
      for (const c of candidates) {
        const dx = bestX - c.sys.x;
        const dy = bestY - c.sys.y;
        const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        // Target position for this constraint
        const tx = c.sys.x + (dx / len) * c.idealDist;
        const ty = c.sys.y + (dy / len) * c.idealDist;
        sumX += tx;
        sumY += ty;
        weight++;
      }
      bestX = sumX / weight;
      bestY = sumY / weight;
    }

    return { x: bestX, y: bestY };
  }

  private addSystem(x?: number, y?: number, name?: string): SystemNode {
    const id = `system_${this.nextSystemNum++}`;
    const node: SystemNode = {
      id,
      name: name ?? `System ${this.nextSystemNum - 1}`,
      x: x ?? this.galaxyCameraX,
      y: y ?? this.galaxyCameraY,
      boundaryRadius: 50000,
      color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
      elementsBase64: '',
    };
    this.systems.set(id, node);
    this.selectedSystemId = id;
    this.updateGalaxySystemList();
    this.updateGalaxyPropertiesUI();
    return node;
  }

  private deleteSelectedSystem() {
    if (!this.selectedSystemId) return;
    if (this.systems.size <= 1) return; // keep at least one
    const sys = this.systems.get(this.selectedSystemId);
    if (sys && !confirm(`Delete system "${sys.name}"?`)) return;
    this.systems.delete(this.selectedSystemId);
    if (this.activeSystemId === this.selectedSystemId) {
      this.activeSystemId = null;
    }
    this.selectedSystemId = null;
    this.updateGalaxySystemList();
    this.updateGalaxyPropertiesUI();
  }

  private enterSystem() {
    if (!this.selectedSystemId) return;
    const sys = this.systems.get(this.selectedSystemId);
    if (!sys) return;

    // Save any current system state first
    if (this.activeSystemId) {
      this.saveActiveSystemState();
    }

    // Load this system's state
    this.activeSystemId = this.selectedSystemId;

    if (sys.elementsBase64) {
      this.deserializeElementsFromBase64(sys.elementsBase64, false);
    } else {
      this.clearElements();
    }

    // Reset system camera to origin
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZoom = 1;

    // Switch to system mode
    this.setEditorMode('system');

    // Update title
    const titleEl = document.getElementById('mode-toggle-btn');
    if (titleEl) titleEl.textContent = `⭐ ${sys.name}`;
  }

  private selectSystemAt(galaxyX: number, galaxyY: number): string | null {
    for (const [id, sys] of this.systems) {
      const dx = galaxyX - sys.x;
      const dy = galaxyY - sys.y;
      const hitRadius = Math.max(sys.boundaryRadius * 0.15, 3000); // min hit size
      if (dx * dx + dy * dy <= hitRadius * hitRadius) return id;
    }
    return null;
  }

  private updateGalaxySystemList() {
    const listEl = document.getElementById('galaxy-system-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (const [id, sys] of this.systems) {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 6px 8px; cursor: pointer; border-radius: 4px;
        display: flex; align-items: center; gap: 8px;
        background: ${id === this.selectedSystemId ? '#1a3a5c' : 'transparent'};
        border: 1px solid ${id === this.selectedSystemId ? '#4fc3f7' : 'transparent'};
      `;
      item.innerHTML = `
        <span style="width:10px;height:10px;border-radius:50%;background:${sys.color};display:inline-block;flex-shrink:0;"></span>
        <span style="font-size:12px;color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sys.name}</span>
        ${id === this.activeSystemId ? '<span style="font-size:9px;color:#4fc3f7;">editing</span>' : ''}
      `;
      item.addEventListener('click', () => {
        this.selectedSystemId = id;
        this.updateGalaxySystemList();
        this.updateGalaxyPropertiesUI();
      });
      item.addEventListener('dblclick', () => {
        this.selectedSystemId = id;
        this.enterSystem();
      });
      listEl.appendChild(item);
    }
  }

  private updateGalaxyPropertiesUI() {
    const nameInput = document.getElementById('galaxy-system-name') as HTMLInputElement | null;
    const radiusSlider = document.getElementById('galaxy-boundary-radius') as HTMLInputElement | null;
    const radiusInput = document.getElementById('galaxy-boundary-radius-input') as HTMLInputElement | null;
    const colorInput = document.getElementById('galaxy-system-color') as HTMLInputElement | null;
    const posXInput = document.getElementById('galaxy-system-pos-x') as HTMLInputElement | null;
    const posYInput = document.getElementById('galaxy-system-pos-y') as HTMLInputElement | null;
    const overlapInfo = document.getElementById('galaxy-overlap-info');
    const propsContainer = document.getElementById('galaxy-properties-content');
    const emptyEl = document.getElementById('galaxy-properties-empty');

    if (!this.selectedSystemId) {
      if (propsContainer) propsContainer.style.display = 'none';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (propsContainer) propsContainer.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    const sys = this.systems.get(this.selectedSystemId);
    if (!sys) return;

    if (nameInput) nameInput.value = sys.name;
    if (radiusSlider) radiusSlider.value = sys.boundaryRadius.toString();
    if (radiusInput) radiusInput.value = sys.boundaryRadius.toString();
    if (colorInput) colorInput.value = sys.color;
    if (posXInput) posXInput.value = Math.round(sys.x).toString();
    if (posYInput) posYInput.value = Math.round(sys.y).toString();

    // Show overlap info
    if (overlapInfo) {
      const overlaps: string[] = [];
      for (const [id, other] of this.systems) {
        if (id === sys.id) continue;
        const dx = sys.x - other.x;
        const dy = sys.y - other.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const touchDist = sys.boundaryRadius + other.boundaryRadius;
        if (dist < touchDist) {
          const overlap = touchDist - dist;
          const smallerRadius = Math.min(sys.boundaryRadius, other.boundaryRadius);
          const pct = ((overlap / smallerRadius) * 100).toFixed(1);
          overlaps.push(`${other.name}: ${pct}%`);
        }
      }
      if (overlaps.length > 0) {
        overlapInfo.innerHTML = `<strong style="color:#888;">Overlaps:</strong> ${overlaps.join(', ')}`;
      } else {
        overlapInfo.textContent = 'No overlaps';
      }
    }
  }

  /**
   * When a system's radius changes, adjust its position to maintain existing overlaps.
   * Only moves if it was previously overlapping neighbors.
   */
  private maintainOverlapsOnResize(sys: SystemNode, oldRadius: number) {
    const overlapFraction = 0.10;
    // Find neighbors that were overlapping before the resize
    const overlappingNeighbors: { neighbor: SystemNode; oldIdealDist: number }[] = [];

    for (const [id, other] of this.systems) {
      if (id === sys.id) continue;
      const dx = sys.x - other.x;
      const dy = sys.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const oldMaxDist = oldRadius + other.boundaryRadius;
      // Was overlapping?
      if (dist < oldMaxDist) {
        const oldSmallerRadius = Math.min(oldRadius, other.boundaryRadius);
        const oldIdealDist = oldRadius + other.boundaryRadius - oldSmallerRadius * overlapFraction;
        overlappingNeighbors.push({ neighbor: other, oldIdealDist });
      }
    }

    if (overlappingNeighbors.length === 0) return;

    // Compute new position that maintains 10% overlap with all previously-overlapping neighbors
    const snapped = this.snapToOverlap(sys.x, sys.y, sys.boundaryRadius, sys.id);
    sys.x = snapped.x;
    sys.y = snapped.y;
  }

  private renderGalaxy() {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

    // Update galaxy container transform
    this.galaxyContainer.x = w / 2 - this.galaxyCameraX * this.galaxyCameraZoom;
    this.galaxyContainer.y = h / 2 - this.galaxyCameraY * this.galaxyCameraZoom;
    this.galaxyContainer.scale.set(this.galaxyCameraZoom);

    const g = this.galaxyGraphics;
    g.clear();

    // Galaxy grid
    const gridStep = 50000;
    const viewLeft = this.galaxyCameraX - w / 2 / this.galaxyCameraZoom;
    const viewTop = this.galaxyCameraY - h / 2 / this.galaxyCameraZoom;
    const viewRight = this.galaxyCameraX + w / 2 / this.galaxyCameraZoom;
    const viewBottom = this.galaxyCameraY + h / 2 / this.galaxyCameraZoom;

    const startX = Math.floor(viewLeft / gridStep) * gridStep;
    const startY = Math.floor(viewTop / gridStep) * gridStep;

    for (let x = startX; x <= viewRight; x += gridStep) {
      g.moveTo(x, viewTop);
      g.lineTo(x, viewBottom);
    }
    for (let y = startY; y <= viewBottom; y += gridStep) {
      g.moveTo(viewLeft, y);
      g.lineTo(viewRight, y);
    }
    g.stroke({ color: 0x111122, width: 1 / this.galaxyCameraZoom });

    // Connection lines between nearby systems
    const systemArr = Array.from(this.systems.values());
    for (let i = 0; i < systemArr.length; i++) {
      for (let j = i + 1; j < systemArr.length; j++) {
        const a = systemArr[i];
        const b = systemArr[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = a.boundaryRadius + b.boundaryRadius;
        if (dist < maxDist * 1.5) {
          const overlap = dist < maxDist;
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke({
            color: overlap ? 0x336644 : 0x222244,
            width: (overlap ? 3 : 1) / this.galaxyCameraZoom,
            alpha: overlap ? 0.8 : 0.3,
          });
          // Overlap percentage label
          if (overlap) {
            const overlapPct = Math.round((1 - dist / maxDist) * 100);
            // We can't easily draw text with Graphics, but the line color indicates overlap
          }
        }
      }
    }

    // Draw systems
    for (const [id, sys] of this.systems) {
      const selected = id === this.selectedSystemId;
      const active = id === this.activeSystemId;
      const colorNum = parseInt(sys.color.replace('#', ''), 16) || 0x6666ff;

      // Boundary radius circle
      g.circle(sys.x, sys.y, sys.boundaryRadius);
      g.stroke({
        color: colorNum,
        width: (selected ? 3 : 1) / this.galaxyCameraZoom,
        alpha: selected ? 0.5 : 0.15,
      });

      // Overlap zone (10-15% of boundary)
      g.circle(sys.x, sys.y, sys.boundaryRadius * 0.875); // 12.5% inset
      g.stroke({
        color: colorNum,
        width: 1 / this.galaxyCameraZoom,
        alpha: 0.08,
      });

      // System node dot
      const dotSize = Math.max(2000, sys.boundaryRadius * 0.05);
      g.circle(sys.x, sys.y, dotSize);
      g.fill({ color: colorNum, alpha: selected ? 1 : 0.8 });

      // Selection ring
      if (selected) {
        g.circle(sys.x, sys.y, dotSize * 1.6);
        g.stroke({ color: 0x4fc3f7, width: 2 / this.galaxyCameraZoom, alpha: 0.9 });
      }
      // Active indicator
      if (active) {
        g.circle(sys.x, sys.y, dotSize * 2);
        g.stroke({ color: 0x66ff66, width: 2 / this.galaxyCameraZoom, alpha: 0.6 });
      }

      // Scale preview ring
      if (id === this.scalingSystemId && this.galaxyPreviewRadius !== null) {
        g.circle(sys.x, sys.y, this.galaxyPreviewRadius);
        g.stroke({ color: 0xffaa00, width: 3 / this.galaxyCameraZoom, alpha: 0.8 });
      }
    }
  }

  private galaxyScreenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const sx = (screenX - rect.left) * (w / rect.width);
    const sy = (screenY - rect.top) * (h / rect.height);
    return {
      x: (sx - w / 2) / this.galaxyCameraZoom + this.galaxyCameraX,
      y: (sy - h / 2) / this.galaxyCameraZoom + this.galaxyCameraY,
    };
  }

  private saveUniverse() {
    // Save current system state first
    if (this.activeSystemId) {
      this.saveActiveSystemState();
    }

    const buf = new BitBuffer(8192);
    // Magic header "UNIV"
    buf.writeUint8(0x55); // 'U'
    buf.writeUint8(0x4E); // 'N'
    buf.writeUint8(0x49); // 'I'
    buf.writeUint8(0x56); // 'V'
    buf.writeUint16(1);   // version

    // Galaxy camera
    buf.writeFloat32(this.galaxyCameraX);
    buf.writeFloat32(this.galaxyCameraY);
    buf.writeFloat32(this.galaxyCameraZoom);

    // Universe-level config (background starfield settings)
    this.writeConfigToBuffer(buf, this.config);

    // Systems
    const systemArr = Array.from(this.systems.values());
    buf.writeVarUint(systemArr.length);

    for (const sys of systemArr) {
      buf.writeString(sys.id);
      buf.writeString(sys.name);
      buf.writeFloat32(sys.x);
      buf.writeFloat32(sys.y);
      buf.writeFloat32(sys.boundaryRadius);
      // Color as 24-bit RGB
      const colorVal = parseInt(sys.color.replace('#', ''), 16) || 0x6666ff;
      buf.writeUint32(colorVal);
      // Elements payload
      buf.writeString(sys.elementsBase64 ?? '');
    }

    const blob = new Blob([buf.getBuffer()], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'universe.sguniverse';
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadUniverse(arrayBuffer: ArrayBuffer) {
    try {
      if (this.systems.size > 0 && !confirm('Replace current universe with loaded file?')) {
        return;
      }
      const buf = BitBuffer.fromArrayBuffer(arrayBuffer);

      // Header check "UNIV"
      const u = buf.readUint8();
      const n = buf.readUint8();
      const i = buf.readUint8();
      const v = buf.readUint8();
      if (u !== 0x55 || n !== 0x4E || i !== 0x49 || v !== 0x56) {
        console.error('Invalid .sguniverse file header');
        return;
      }
      const version = buf.readUint16();
      if (version < 1) return;

      // Clear current state
      this.systems.clear();
      this.selectedSystemId = null;
      this.activeSystemId = null;
      this.clearElements();

      // Galaxy camera
      this.galaxyCameraX = buf.readFloat32();
      this.galaxyCameraY = buf.readFloat32();
      this.galaxyCameraZoom = buf.readFloat32();

      // Universe-level config
      this.config = this.readConfigFromBuffer(buf);
      this.syncControlsFromConfig();

      // Systems
      const count = buf.readVarUint();
      let maxNum = 0;

      for (let idx = 0; idx < count; idx++) {
        const id = buf.readString();
        const name = buf.readString();
        const x = buf.readFloat32();
        const y = buf.readFloat32();
        const boundaryRadius = buf.readFloat32();
        const colorVal = buf.readUint32();
        const color = '#' + colorVal.toString(16).padStart(6, '0');
        const elementsBase64 = buf.readString();

        const node: SystemNode = { id, name, x, y, boundaryRadius, color, elementsBase64 };
        this.systems.set(id, node);

        const match = id.match(/system_(\d+)/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
      }
      this.nextSystemNum = maxNum + 1;

      // Switch to galaxy mode to see the loaded universe
      this.setEditorMode('galaxy');
      this.updateGalaxySystemList();
      this.updateGalaxyPropertiesUI();
      console.log(`Loaded universe with ${this.systems.size} systems`);
    } catch (e) {
      console.error('Failed to load universe:', e);
    }
  }

  private update() {
    const dt = this.app.ticker.deltaMS / 1000;
    this.time += dt;
    this.animTime += dt;
    
    // FPS
    this.frameCount++;
    if (this.time - this.lastFpsUpdate >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = this.time;
    }

    if (this.editorMode === 'galaxy') {
      this.renderGalaxy();
      this.updateUI();
      return;
    }
    
    this.updateEntities(dt);
    this.updateParticles(dt);
    this.updateElements(dt);
    this.render();
    this.updateUI();
  }
  
  private updateEntities(dt: number) {
    for (const entity of this.entities.values()) {
      entity.x += entity.vx * dt;
      entity.y += entity.vy * dt;
      entity.angle += dt * 0.5;
    }
  }
  
  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      
      if (p.life <= 0) {
        this.effectContainer.removeChild(p.graphic);
        this.particles.splice(i, 1);
      }
    }
  }

  private updateElements(_dt: number) {
    const dt = this.app.ticker.deltaMS / 1000;
    const screenSize = { width: this.app.renderer.width, height: this.app.renderer.height };

    // Parent follow pass
    for (const element of this.elements.values()) {
      if (element.parentId) {
        const parent = this.elements.get(element.parentId);
        if (parent) {
          element.x = parent.x + (element.parentOffsetX ?? 0);
          element.y = parent.y + (element.parentOffsetY ?? 0);
        }
      }
    }

    for (const element of this.elements.values()) {
      if (element.lockToOrigin) {
        element.x = 0;
        element.y = 0;
      }
      if (element.defId === 'detail_sun' && element.sunRenderer) {
        this.updateDetailSunElement(element, dt, screenSize);
      } else if (element.defId === 'detail_corona' && element.coronaRenderer) {
        this.updateDetailCoronaElement(element, dt, screenSize);
      } else if (element.defId === 'detail_atmosphere' && element.glowRenderer) {
        this.updateDetailAtmosphereElement(element, dt, screenSize);
      } else if (element.defId === 'nebula' && element.nebulaRenderer) {
        this.updateNebulaElement(element, dt);
      } else if (element.sunRenderer) {
        this.updateSunElement(element, dt, screenSize);
      }
      this.drawElementGraphic(element);
    }
  }
  
  private render() {
    const width = this.app.renderer.width;
    const height = this.app.renderer.height;
    
    // Update camera transform
    this.worldContainer.x = width / 2 - this.cameraX * this.cameraZoom;
    this.worldContainer.y = height / 2 - this.cameraY * this.cameraZoom;
    this.worldContainer.scale.set(this.cameraZoom);
    
    // Render starfield
    this.renderStarfield();
    this.renderGrid();

    // Render elements
    for (const element of this.elements.values()) {
      element.graphic.x = element.x;
      element.graphic.y = element.y;
      element.graphic.rotation = element.rotation;
      if (element.sunRenderer) {
        element.sunRenderer.setPosition(element.x, element.y);
        element.sunRenderer.getContainer().rotation = element.rotation;
      }
      if (element.coronaRenderer) {
        element.coronaRenderer.setPosition(element.x, element.y);
      }
      if (element.glowRenderer) {
        element.glowRenderer.setPosition(element.x, element.y);
      }
    }
    
    // Render entities
    for (const entity of this.entities.values()) {
      entity.graphic.x = entity.x;
      entity.graphic.y = entity.y;
      entity.graphic.rotation = entity.angle;
    }
    
    // Render particles
    for (const p of this.particles) {
      p.graphic.x = p.x;
      p.graphic.y = p.y;
      p.graphic.alpha = p.life / p.maxLife;
    }
  }
  
  // Integrate StarfieldRenderer
  private starfieldRenderer: StarfieldRenderer | null = null;
  private renderStarfield() {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

    if (!this.starfieldRenderer) {
      this.starfieldRenderer = new StarfieldRenderer();
      this.starfieldRenderer.initialize(w, h);
      // Add to stage (screen-space) behind worldContainer so it always fills the viewport
      this.app.stage.addChildAt(this.starfieldRenderer.getContainer(), 0);
    }

    this.starfieldRenderer.update(
      this.app.ticker.deltaMS,
      this.cameraX,
      this.cameraY,
      this.cameraZoom,
      w,
      h,
      {
        starBrightness:    this.config.starBrightness ?? 6.0,
        twinkleSpeed:      this.config.starTwinkleSpeed ?? 2.0,
        twinkleAmount:     this.config.starTwinkleAmt ?? 0.3,
        hueShift:          this.config.starHueShift ?? 0,
        density:           this.config.starDensity ?? 6.0,
        starSize:          this.config.starSize ?? 6.0,
        parallaxStrength:  this.config.starParallax ?? 0.4,
        baseCell:          this.config.starBaseCell ?? 10,
        lodBlendWidth:     this.config.starLodBlend ?? 0.65,
      },
    );
  }

  // drawSolarStar removed (handled by shader)

  private resizeGridCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.gridCanvas.width = window.innerWidth * dpr;
    this.gridCanvas.height = window.innerHeight * dpr;
    this.gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private renderGrid() {
    const ctx = this.gridCtx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.showGrid) return;

    // World-to-screen helpers
    const zoom = this.cameraZoom;
    const cx = w / 2 - this.cameraX * zoom;
    const cy = h / 2 - this.cameraY * zoom;
    const worldToScreenX = (wx: number) => cx + wx * zoom;
    const worldToScreenY = (wy: number) => cy + wy * zoom;

    // Visible world bounds
    const worldLeft = (0 - cx) / zoom;
    const worldRight = (w - cx) / zoom;
    const worldTop = (0 - cy) / zoom;
    const worldBottom = (h - cy) / zoom;

    // Adaptive power-of-two grid
    const baseSize = 100;
    const rawSize = baseSize / zoom;
    const exponent = Math.log2(rawSize / baseSize);
    const floorExp = Math.floor(exponent);
    const ceilExp = Math.ceil(exponent);
    const lower = baseSize * Math.pow(2, floorExp);
    const upper = baseSize * Math.pow(2, ceilExp);
    const t = exponent - floorExp;

    // Draw a grid layer in screen space
    const drawLayer = (step: number, alpha: number) => {
      if (alpha < 0.01) return;
      const sx = Math.floor(worldLeft / step) * step;
      const ex = Math.ceil(worldRight / step) * step;
      const sy = Math.floor(worldTop / step) * step;
      const ey = Math.ceil(worldBottom / step) * step;
      const count = ((ex - sx) / step) + ((ey - sy) / step);
      if (count > 400) return;
      ctx.strokeStyle = `rgba(51,68,102,${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = sx; x <= ex; x += step) {
        const sx2 = Math.round(worldToScreenX(x)) + 0.5;
        ctx.moveTo(sx2, 0);
        ctx.lineTo(sx2, h);
      }
      for (let y = sy; y <= ey; y += step) {
        const sy2 = Math.round(worldToScreenY(y)) + 0.5;
        ctx.moveTo(0, sy2);
        ctx.lineTo(w, sy2);
      }
      ctx.stroke();
    };

    // Draw both layers with crossfading opacity
    // 20% hold at each end: 0..0.2 = lower full, 0.8..1 = upper full, blend in between
    if (lower === upper) {
      drawLayer(lower, 1.0);
    } else {
      const hold = 0.2;
      const lowerA = t <= hold ? 1.0 : t >= (1 - hold) ? 0.0 : 1 - (t - hold) / (1 - 2 * hold);
      const upperA = t >= (1 - hold) ? 1.0 : t <= hold ? 0.0 : (t - hold) / (1 - 2 * hold);
      drawLayer(lower, lowerA);
      drawLayer(upper, upperA);
    }

    // Origin axes
    const ox = Math.round(worldToScreenX(0)) + 0.5;
    const oy = Math.round(worldToScreenY(0)) + 0.5;
    ctx.strokeStyle = 'rgba(68,136,170,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, 0); ctx.lineTo(ox, h);
    ctx.moveTo(0, oy); ctx.lineTo(w, oy);
    ctx.stroke();

    // Origin crosshair
    const cs = 12;
    ctx.strokeStyle = 'rgba(102,187,221,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ox - cs, oy); ctx.lineTo(ox + cs, oy);
    ctx.moveTo(ox, oy - cs); ctx.lineTo(ox, oy + cs);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ox, oy, cs * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    // Distance labels on whichever layer is more visible
    const labelStep = t <= 0.5 ? lower : upper;
    const labelAlpha = t <= 0.5 ? (1 - t) : t;
    this.renderGridLabels(ctx, worldLeft, worldRight, worldTop, worldBottom, labelStep, labelAlpha, worldToScreenX, worldToScreenY, oy, ox);
  }

  private renderGridLabels(
    ctx: CanvasRenderingContext2D,
    worldLeft: number, worldRight: number, worldTop: number, worldBottom: number,
    spacing: number, alpha: number,
    toSX: (wx: number) => number, toSY: (wy: number) => number,
    originScreenY: number, originScreenX: number
  ) {
    const formatDist = (v: number): string => {
      const abs = Math.abs(v);
      if (abs >= 10000) return `${(v / 1000).toFixed(0)}k`;
      if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
      return v.toString();
    };

    ctx.font = '11px monospace';
    ctx.fillStyle = `rgba(85,153,187,${alpha * 0.8})`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    const sx = Math.floor(worldLeft / spacing) * spacing;
    const ex = Math.ceil(worldRight / spacing) * spacing;
    for (let x = sx; x <= ex; x += spacing) {
      if (x === 0) continue;
      ctx.fillText(formatDist(x), toSX(x), originScreenY - 4);
    }

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const sy = Math.floor(worldTop / spacing) * spacing;
    const ey = Math.ceil(worldBottom / spacing) * spacing;
    for (let y = sy; y <= ey; y += spacing) {
      if (y === 0) continue;
      ctx.fillText(formatDist(y), originScreenX - 6, toSY(y));
    }

    // Origin label
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = `rgba(102,187,221,${alpha * 0.9})`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText('0,0', originScreenX - 6, originScreenY - 4);
  }
  
  // getStarsForRegion removed (handled by shared utilities)
  
  // simplexNoise2D removed (handled by shared utilities)
  
  private seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  private hslToHex(h: number, s: number, l: number): number {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }
    const ri = Math.round((r + m) * 255);
    const gi = Math.round((g + m) * 255);
    const bi = Math.round((b + m) * 255);
    return (ri << 16) | (gi << 8) | bi;
  }
  
  // hashRegion removed (handled by shared utilities)

  private hexToRgb(hex: string): [number, number, number] {
    const value = hex.startsWith('#') ? hex.slice(1) : hex;
    if (value.length !== 6) return [1, 1, 1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return [r / 255, g / 255, b / 255];
  }

  private updateUI() {
    const fpsEl = document.getElementById('fps');
    const cameraPosEl = document.getElementById('camera-pos');
    const zoomEl = document.getElementById('zoom-level');
    const entityCountEl = document.getElementById('entity-count');
    const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement | null;
    
    if (fpsEl) fpsEl.textContent = this.fps.toString();

    if (this.editorMode === 'galaxy') {
      if (cameraPosEl) cameraPosEl.textContent = `${Math.round(this.galaxyCameraX)}, ${Math.round(this.galaxyCameraY)}`;
      if (zoomEl) zoomEl.textContent = `${this.galaxyCameraZoom.toFixed(4)}x`;
      if (entityCountEl) entityCountEl.textContent = `${this.systems.size} sys`;
    } else {
      if (cameraPosEl) cameraPosEl.textContent = `${Math.round(this.cameraX)}, ${Math.round(this.cameraY)}`;
      if (zoomEl) zoomEl.textContent = `${this.cameraZoom.toFixed(2)}x`;
      if (entityCountEl) entityCountEl.textContent = `${this.entities.size + this.particles.length}`;
      // Keep slider in sync (logarithmic scale)
      if (zoomSlider && document.activeElement !== zoomSlider) {
        zoomSlider.value = Math.log(this.cameraZoom).toString();
      }
    }
  }
  
  // ===== SPAWNING =====
  
  private spawnAtPosition(type: string, x: number, y: number) {
    switch (type) {
      case 'asteroid': this.spawnAsteroid(x, y); break;
      case 'drone': this.spawnEnemy('drone', x, y); break;
      case 'fighter': this.spawnEnemy('fighter', x, y); break;
      case 'boss': this.spawnEnemy('boss', x, y); break;
      case 'station': this.spawnStation(x, y); break;
      case 'portal': this.spawnPortal(x, y); break;
      case 'blackhole': this.spawnBlackHole(x, y); break;
      case 'wormhole': this.spawnWormhole(x, y); break;
      case 'comet': this.spawnComet(x, y); break;
      case 'nebula': this.spawnNebula(x, y); break;
      case 'gascloud': this.spawnGasCloud(x, y); break;
      case 'satellite': this.spawnSatellite(x, y); break;
      case 'ufo': this.spawnUfo(x, y); break;
      case 'spacewhale': this.spawnSpaceWhale(x, y); break;
      case 'derelict': this.spawnDerelict(x, y); break;
      case 'anomaly': this.spawnAnomaly(x, y); break;
    }
  }
  
  private spawnAsteroid(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    const radius = 30 + Math.random() * 40;
    const points: { x: number; y: number }[] = [];
    const numPoints = 8 + Math.floor(Math.random() * 6);
    
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const r = radius * (0.7 + Math.random() * 0.4);
      points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      g.lineTo(points[i].x, points[i].y);
    }
    g.closePath();
    g.fill({ color: 0x555555 });
    g.stroke({ color: 0x777777, width: 2 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'asteroid', x, y,
      vx: (Math.random() - 0.5) * 20,
      vy: (Math.random() - 0.5) * 20,
      angle: Math.random() * Math.PI * 2,
      graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnEnemy(type: string, x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    let color = 0xff3333;
    let size = 20;
    
    switch (type) {
      case 'drone': color = 0xff6666; size = 15; break;
      case 'fighter': color = 0xff3333; size = 25; break;
      case 'boss': color = 0xff0000; size = 60; break;
    }
    
    g.moveTo(size, 0);
    g.lineTo(-size * 0.7, -size * 0.6);
    g.lineTo(-size * 0.4, 0);
    g.lineTo(-size * 0.7, size * 0.6);
    g.closePath();
    g.fill({ color });
    g.stroke({ color: 0xffffff, width: 1 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: `enemy_${type}`, x, y,
      vx: (Math.random() - 0.5) * 50,
      vy: (Math.random() - 0.5) * 50,
      angle: Math.random() * Math.PI * 2,
      graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnStation(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    g.rect(-40, -40, 80, 80);
    g.fill({ color: 0x3366aa });
    g.stroke({ color: 0x6699dd, width: 3 });
    g.circle(0, 0, 25);
    g.fill({ color: 0x4477bb });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'station', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }
  
  private spawnPortal(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    
    g.circle(0, 0, 60);
    g.stroke({ color: 0x9933ff, width: 8 });
    g.circle(0, 0, 50);
    g.fill({ color: 0x220033, alpha: 0.5 });
    
    graphic.addChild(g);
    
    this.entities.set(id, {
      id, type: 'portal', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    
    this.entityContainer.addChild(graphic);
  }

  private spawnBlackHole(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 70);
    g.fill({ color: 0x050008 });
    g.circle(0, 0, 85);
    g.stroke({ color: 0x7a3cff, width: 6 });
    g.circle(0, 0, 110);
    g.stroke({ color: 0x3a1a66, width: 4, alpha: 0.6 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'blackhole', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnWormhole(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    for (let i = 0; i < 5; i++) {
      g.circle(0, 0, 40 + i * 12);
      g.stroke({ color: 0x33ccff, width: 3, alpha: 0.25 + i * 0.1 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'wormhole', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnComet(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 18);
    g.fill({ color: 0xffffff });
    g.moveTo(-60, -10);
    g.lineTo(0, 0);
    g.lineTo(-60, 10);
    g.closePath();
    g.fill({ color: 0x88ccff, alpha: 0.6 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'comet', x, y,
      vx: 120, vy: -40, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnNebula(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    const colors = [0x6633ff, 0x9933ff, 0x332266];

    for (let i = 0; i < 6; i++) {
      const r = 40 + Math.random() * 80;
      const cx = (Math.random() - 0.5) * 60;
      const cy = (Math.random() - 0.5) * 60;
      g.circle(cx, cy, r);
      g.fill({ color: colors[i % colors.length], alpha: 0.15 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'nebula', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnGasCloud(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();
    const colors = [0x88ffaa, 0x55cc88, 0x336644];

    for (let i = 0; i < 5; i++) {
      const r = 35 + Math.random() * 70;
      const cx = (Math.random() - 0.5) * 50;
      const cy = (Math.random() - 0.5) * 50;
      g.circle(cx, cy, r);
      g.fill({ color: colors[i % colors.length], alpha: 0.18 });
    }

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'gascloud', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnSatellite(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.rect(-12, -10, 24, 20);
    g.fill({ color: 0xcccccc });
    g.rect(-40, -8, 20, 16);
    g.fill({ color: 0x3366ff });
    g.rect(20, -8, 20, 16);
    g.fill({ color: 0x3366ff });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'satellite', x, y,
      vx: 10, vy: 6, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnUfo(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, -6, 12);
    g.fill({ color: 0x66ccff });
    g.rect(-36, -6, 72, 14);
    g.fill({ color: 0xaaaaaa });
    g.rect(-30, 8, 60, 6);
    g.fill({ color: 0x88ffcc, alpha: 0.5 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'ufo', x, y,
      vx: 20, vy: -12, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnSpaceWhale(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 55);
    g.fill({ color: 0x335577 });
    g.moveTo(40, -15);
    g.lineTo(95, 0);
    g.lineTo(40, 15);
    g.closePath();
    g.fill({ color: 0x2a3f55 });
    g.circle(-20, -10, 6);
    g.fill({ color: 0xffffff });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'spacewhale', x, y,
      vx: 15, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnDerelict(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.moveTo(-50, -15);
    g.lineTo(30, -25);
    g.lineTo(60, 0);
    g.lineTo(20, 25);
    g.lineTo(-45, 10);
    g.closePath();
    g.fill({ color: 0x555555 });
    g.stroke({ color: 0x888888, width: 2 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'derelict', x, y,
      vx: -8, vy: 4, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }

  private spawnAnomaly(x: number, y: number) {
    const id = this.nextEntityId++;
    const graphic = new Container();
    const g = new Graphics();

    g.circle(0, 0, 40);
    g.stroke({ color: 0xff99ee, width: 3, alpha: 0.6 });
    g.moveTo(0, -30);
    g.lineTo(12, -8);
    g.lineTo(30, -6);
    g.lineTo(16, 6);
    g.lineTo(20, 28);
    g.lineTo(0, 14);
    g.lineTo(-20, 28);
    g.lineTo(-16, 6);
    g.lineTo(-30, -6);
    g.lineTo(-12, -8);
    g.closePath();
    g.fill({ color: 0xff66cc, alpha: 0.8 });

    graphic.addChild(g);
    this.entities.set(id, {
      id, type: 'anomaly', x, y,
      vx: 0, vy: 0, angle: 0, graphic,
    });
    this.entityContainer.addChild(graphic);
  }
  
  private spawnEffect(effect: string) {
    const x = this.cameraX;
    const y = this.cameraY;
    
    switch (effect) {
      case 'explosion': this.spawnExplosion(x, y); break;
      case 'shield': this.spawnShieldHit(x, y); break;
      case 'mining': this.spawnMiningParticles(x, y); break;
      case 'blaster': this.fireBlaster(x, y); break;
    }
  }
  
  private spawnExplosion(x: number, y: number) {
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      const g = new Graphics();
      const size = 3 + Math.random() * 5;
      const color = Math.random() > 0.5 ? 0xff6600 : 0xffff00;
      
      g.circle(0, 0, size);
      g.fill({ color });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private spawnShieldHit(x: number, y: number) {
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const g = new Graphics();
      const size = 2 + Math.random() * 3;
      
      g.circle(0, 0, size);
      g.fill({ color: 0x00aaff });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.3,
        maxLife: 0.6,
        color: 0x00aaff, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private spawnMiningParticles(x: number, y: number) {
    for (let i = 0; i < 15; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.5;
      const speed = 80 + Math.random() * 120;
      const g = new Graphics();
      const size = 2 + Math.random() * 4;
      
      g.circle(0, 0, size);
      g.fill({ color: 0x888888 });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        color: 0x888888, size, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private fireBlaster(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const speed = 500;
      const g = new Graphics();
      
      g.circle(0, 0, 5);
      g.fill({ color: 0x00ff00 });
      
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.5,
        maxLife: 1.5,
        color: 0x00ff00, size: 5, graphic: g,
      });
      
      this.effectContainer.addChild(g);
    }
  }
  
  private clearEntities() {
    for (const entity of this.entities.values()) {
      this.entityContainer.removeChild(entity.graphic);
    }
    this.entities.clear();
  }
  
  private clearAll() {
    this.clearEntities();
    this.clearElements();
    this.pushUndo('Clear all');
    
    for (const p of this.particles) {
      this.effectContainer.removeChild(p.graphic);
    }
    this.particles = [];
  }
}

// Initialize
const sandbox = new VisualSandbox();
sandbox.init();

// Expose for debugging
(window as any).sandbox = sandbox;
