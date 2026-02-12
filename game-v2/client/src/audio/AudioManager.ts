/**
 * Audio Manager - Spatial audio system with Web Audio API
 */

import { AUDIO_MAX_DISTANCE, AUDIO_REF_DISTANCE } from '@space-game/common';

export interface SoundDef {
  id: string;
  url: string;
  volume: number;
  poolSize: number;
  variations?: number; // Number of pitch/timing variations
}

// Sound definitions
export const SOUND_DEFS: SoundDef[] = [
  { id: 'laser', url: '/sounds/laser.wav', volume: 0.4, poolSize: 8 },
  { id: 'cannon', url: '/sounds/cannon.wav', volume: 0.5, poolSize: 8 },
  { id: 'scatter', url: '/sounds/scatter.wav', volume: 0.4, poolSize: 4 },
  { id: 'missile', url: '/sounds/missile.wav', volume: 0.5, poolSize: 4 },
  { id: 'explosion_small', url: '/sounds/explosion_small.wav', volume: 0.6, poolSize: 6 },
  { id: 'explosion_large', url: '/sounds/explosion_large.wav', volume: 0.8, poolSize: 4 },
  { id: 'pickup', url: '/sounds/pickup.wav', volume: 0.5, poolSize: 4 },
  { id: 'hit', url: '/sounds/hit.wav', volume: 0.4, poolSize: 8 },
  { id: 'engine', url: '/sounds/engine_loop.wav', volume: 0.3, poolSize: 1 },
  { id: 'boost', url: '/sounds/boost.wav', volume: 0.4, poolSize: 2 },
  { id: 'ui_click', url: '/sounds/ui_click.wav', volume: 0.3, poolSize: 2 },
  { id: 'ui_hover', url: '/sounds/ui_hover.wav', volume: 0.2, poolSize: 2 },
  { id: 'level_up', url: '/sounds/level_up.wav', volume: 0.7, poolSize: 1 },
  { id: 'error', url: '/sounds/error.wav', volume: 0.4, poolSize: 2 },
];

interface PooledSound {
  source: AudioBufferSourceNode | null;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  playing: boolean;
}

export class AudioManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  
  private buffers: Map<string, AudioBuffer> = new Map();
  private pools: Map<string, PooledSound[]> = new Map();
  
  // Listener position for spatial audio
  private listenerX: number = 0;
  private listenerY: number = 0;
  
  // Volume settings
  private masterVolume: number = 1.0;
  private sfxVolume: number = 1.0;
  private musicVolume: number = 0.5;
  
  // Enabled state
  private enabled: boolean = true;
  private initialized: boolean = false;

  constructor() {
    // Don't initialize until user interaction
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Create audio context (must be after user interaction)
      this.context = new AudioContext();
      
      // Create master gain chain
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.context.destination);
      
      // SFX gain
      this.sfxGain = this.context.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.masterGain);
      
      // Music gain
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.masterGain);
      
      // Load all sounds
      await this.loadSounds();
      
      // Create sound pools
      this.createPools();
      
      this.initialized = true;
      console.log('🔊 Audio system initialized');
    } catch (e) {
      console.warn('Failed to initialize audio:', e);
    }
  }

  private async loadSounds(): Promise<void> {
    if (!this.context) return;
    
    const loadPromises = SOUND_DEFS.map(async (def) => {
      try {
        const response = await fetch(def.url);
        if (!response.ok) {
          // Create a silent buffer as placeholder
          const silentBuffer = this.context!.createBuffer(1, 22050, 22050);
          this.buffers.set(def.id, silentBuffer);
          return;
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.context!.decodeAudioData(arrayBuffer);
        this.buffers.set(def.id, audioBuffer);
      } catch (e) {
        // Create silent placeholder if sound doesn't exist
        const silentBuffer = this.context!.createBuffer(1, 22050, 22050);
        this.buffers.set(def.id, silentBuffer);
      }
    });
    
    await Promise.allSettled(loadPromises);
  }

  private createPools(): void {
    if (!this.context || !this.sfxGain) return;
    
    for (const def of SOUND_DEFS) {
      const pool: PooledSound[] = [];
      
      for (let i = 0; i < def.poolSize; i++) {
        const gainNode = this.context.createGain();
        gainNode.gain.value = def.volume;
        
        const panNode = this.context.createStereoPanner();
        panNode.connect(gainNode);
        gainNode.connect(this.sfxGain);
        
        pool.push({
          source: null,
          gainNode,
          panNode,
          playing: false
        });
      }
      
      this.pools.set(def.id, pool);
    }
  }

  /**
   * Play a sound at a world position (spatial audio)
   */
  play(soundId: string, worldX: number, worldY: number, options: {
    volume?: number;
    pitch?: number;
    loop?: boolean;
  } = {}): PooledSound | null {
    if (!this.enabled || !this.initialized || !this.context) return null;
    
    const pool = this.pools.get(soundId);
    const buffer = this.buffers.get(soundId);
    if (!pool || !buffer) return null;
    
    // Find available slot in pool
    let slot = pool.find(s => !s.playing);
    if (!slot) {
      // All slots busy, skip or steal oldest
      return null;
    }
    
    // Calculate spatial audio parameters
    const dx = worldX - this.listenerX;
    const dy = worldY - this.listenerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Distance attenuation
    const attenuation = Math.max(0, 1 - distance / AUDIO_MAX_DISTANCE);
    if (attenuation <= 0) return null; // Too far to hear
    
    // Stereo panning based on X position (-1 to 1)
    const pan = Math.max(-1, Math.min(1, dx / AUDIO_REF_DISTANCE));
    
    // Create new source
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop || false;
    source.playbackRate.value = options.pitch || 1.0;
    
    // Connect to pool slot's panner
    source.connect(slot.panNode);
    
    // Set volume with distance attenuation
    const volume = (options.volume ?? 1.0) * attenuation;
    slot.gainNode.gain.value = volume;
    slot.panNode.pan.value = pan;
    
    // Track playing state
    slot.source = source;
    slot.playing = true;
    
    source.onended = () => {
      slot!.playing = false;
      slot!.source = null;
    };
    
    source.start();
    
    return slot;
  }

  /**
   * Play a UI sound (no spatial positioning)
   */
  playUI(soundId: string, volume: number = 1.0): void {
    if (!this.enabled || !this.initialized || !this.context || !this.sfxGain) return;
    
    const buffer = this.buffers.get(soundId);
    if (!buffer) return;
    
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    
    const gainNode = this.context.createGain();
    gainNode.gain.value = volume;
    
    source.connect(gainNode);
    gainNode.connect(this.sfxGain);
    
    source.start();
  }

  /**
   * Stop a playing sound
   */
  stop(sound: PooledSound): void {
    if (sound.source && sound.playing) {
      try {
        sound.source.stop();
      } catch (e) {
        // Already stopped
      }
      sound.playing = false;
      sound.source = null;
    }
  }

  /**
   * Update listener position for spatial audio
   */
  setListenerPosition(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  /**
   * Set master volume (0-1)
   */
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  /**
   * Set SFX volume (0-1)
   */
  setSFXVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.sfxVolume;
    }
  }

  /**
   * Set music volume (0-1)
   */
  setMusicVolume(volume: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    if (this.musicGain) {
      this.musicGain.gain.value = this.musicVolume;
    }
  }

  /**
   * Enable/disable audio
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.context) {
      // Stop all playing sounds
      for (const pool of this.pools.values()) {
        for (const slot of pool) {
          if (slot.playing) {
            this.stop(slot);
          }
        }
      }
    }
  }

  /**
   * Resume audio context (call after user interaction)
   */
  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
export const audioManager = new AudioManager();
