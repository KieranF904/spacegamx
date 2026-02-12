import { BitBuffer } from '../BitBuffer';

/**
 * Module category determines when data is sent:
 * - control: Broadcast every tick (inputs, AI state) - others simulate from this
 * - state: Only on spawn + corrections (position, velocity, health)
 * - static: Only on spawn (orbit params, entity type) - never changes
 */
export type ModuleCategory = 'control' | 'state' | 'static';

/**
 * Base interface for network modules
 * Each module handles serialization for a specific aspect of an entity
 */
export interface NetworkModule<T = unknown> {
  /** Unique identifier for this module type */
  readonly id: string;
  
  /** Category determines when this module's data is sent */
  readonly category: ModuleCategory;
  
  /** Number of bits this module uses (for fixed-size modules) */
  readonly bitSize?: number;
  
  /**
   * Serialize the module data to the buffer
   */
  write(buffer: BitBuffer, data: T): void;
  
  /**
   * Deserialize the module data from the buffer
   */
  read(buffer: BitBuffer): T;
  
  /**
   * Compare two states and return true if they differ enough to warrant a correction
   * Only relevant for 'state' category modules
   */
  needsCorrection?(serverState: T, clientState: T): boolean;
  
  /**
   * Interpolate between two states (for smooth corrections)
   * Only relevant for 'state' category modules
   */
  interpolate?(from: T, to: T, t: number): T;
}

/**
 * Registry of all network modules
 */
export class NetworkModuleRegistry {
  private modules: Map<string, NetworkModule> = new Map();
  
  register<T>(module: NetworkModule<T>): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module '${module.id}' is already registered`);
    }
    this.modules.set(module.id, module);
  }
  
  get<T>(id: string): NetworkModule<T> | undefined {
    return this.modules.get(id) as NetworkModule<T> | undefined;
  }
  
  getRequired<T>(id: string): NetworkModule<T> {
    const module = this.get<T>(id);
    if (!module) {
      throw new Error(`Module '${id}' not found`);
    }
    return module;
  }
  
  getByCategory(category: ModuleCategory): NetworkModule[] {
    return Array.from(this.modules.values()).filter(m => m.category === category);
  }
}

/**
 * Global module registry instance
 */
export const moduleRegistry = new NetworkModuleRegistry();

/**
 * Helper to create simple modules with less boilerplate
 */
export function createModule<T>(
  id: string,
  category: ModuleCategory,
  writer: (buffer: BitBuffer, data: T) => void,
  reader: (buffer: BitBuffer) => T,
  options?: {
    bitSize?: number;
    needsCorrection?: (server: T, client: T) => boolean;
    interpolate?: (from: T, to: T, t: number) => T;
  }
): NetworkModule<T> {
  return {
    id,
    category,
    bitSize: options?.bitSize,
    write: writer,
    read: reader,
    needsCorrection: options?.needsCorrection,
    interpolate: options?.interpolate,
  };
}
