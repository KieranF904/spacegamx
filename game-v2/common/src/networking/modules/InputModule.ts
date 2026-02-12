import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';
import { INPUT_ANGLE_BITS } from '../Precision';

/**
 * Input state for a player/ship
 * Packed efficiently since this is sent every tick
 */
export interface InputData {
  // Movement keys as bitflags (4 bits)
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  
  // Aim angle in radians (INPUT_ANGLE_BITS precision)
  aimAngle: number;
  
  // Action flags (4 bits)
  firing: boolean;
  boost: boolean;
  ability1: boolean;
  ability2: boolean;
}

// Total: 4 + INPUT_ANGLE_BITS + 4 = 4 + 12 + 4 = 20 bits per input (~2.5 bytes)

/**
 * Pack movement keys into 4 bits
 */
function packMovementKeys(data: InputData): number {
  return (
    (data.forward ? 1 : 0) |
    (data.backward ? 2 : 0) |
    (data.left ? 4 : 0) |
    (data.right ? 8 : 0)
  );
}

/**
 * Unpack movement keys from 4 bits
 */
function unpackMovementKeys(packed: number): Pick<InputData, 'forward' | 'backward' | 'left' | 'right'> {
  return {
    forward: (packed & 1) !== 0,
    backward: (packed & 2) !== 0,
    left: (packed & 4) !== 0,
    right: (packed & 8) !== 0,
  };
}

/**
 * Pack action flags into 4 bits
 */
function packActionFlags(data: InputData): number {
  return (
    (data.firing ? 1 : 0) |
    (data.boost ? 2 : 0) |
    (data.ability1 ? 4 : 0) |
    (data.ability2 ? 8 : 0)
  );
}

/**
 * Unpack action flags from 4 bits
 */
function unpackActionFlags(packed: number): Pick<InputData, 'firing' | 'boost' | 'ability1' | 'ability2'> {
  return {
    firing: (packed & 1) !== 0,
    boost: (packed & 2) !== 0,
    ability1: (packed & 4) !== 0,
    ability2: (packed & 8) !== 0,
  };
}

/**
 * Input module - Control category
 * Broadcast every tick so other clients can simulate player movement
 */
export const InputModule: NetworkModule<InputData> = createModule<InputData>(
  'input',
  'control',
  (buffer: BitBuffer, data: InputData) => {
    // Pack movement (4 bits)
    buffer.writeBits(packMovementKeys(data), 4);
    
    // Aim angle (INPUT_ANGLE_BITS precision)
    buffer.writeAngle(data.aimAngle, INPUT_ANGLE_BITS);
    
    // Action flags (4 bits)
    buffer.writeBits(packActionFlags(data), 4);
  },
  (buffer: BitBuffer): InputData => {
    const movement = unpackMovementKeys(buffer.readBits(4));
    const aimAngle = buffer.readAngle(INPUT_ANGLE_BITS);
    const actions = unpackActionFlags(buffer.readBits(4));
    
    return {
      ...movement,
      aimAngle,
      ...actions,
    };
  },
  {
    bitSize: 4 + INPUT_ANGLE_BITS + 4,
  }
);

/**
 * Create a default/empty input state
 */
export function createEmptyInput(): InputData {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    aimAngle: 0,
    firing: false,
    boost: false,
    ability1: false,
    ability2: false,
  };
}

/**
 * Compare two input states for equality
 */
export function inputsEqual(a: InputData, b: InputData): boolean {
  return (
    a.forward === b.forward &&
    a.backward === b.backward &&
    a.left === b.left &&
    a.right === b.right &&
    a.firing === b.firing &&
    a.boost === b.boost &&
    a.ability1 === b.ability1 &&
    a.ability2 === b.ability2 &&
    Math.abs(a.aimAngle - b.aimAngle) < 0.01 // ~0.5 degree tolerance
  );
}
