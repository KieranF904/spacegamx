/**
 * BitBuffer - Efficient bit-level read/write for network serialization
 * 
 * Supports both byte-aligned fast paths and arbitrary bit-width operations
 * for maximum compression when needed.
 */

export class BitBuffer {
  private buffer: Uint8Array;
  private bitPosition: number = 0;
  private bytePosition: number = 0;
  
  // For reading
  private view: DataView;
  
  constructor(sizeOrBuffer: number | Uint8Array = 1024) {
    if (typeof sizeOrBuffer === 'number') {
      this.buffer = new Uint8Array(sizeOrBuffer);
    } else {
      this.buffer = sizeOrBuffer;
    }
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }

  // ============================================
  // POSITION MANAGEMENT
  // ============================================

  /** Current bit position in the buffer */
  get position(): number {
    return this.bytePosition * 8 + this.bitPosition;
  }

  /** Total bits written/readable */
  get length(): number {
    return this.buffer.length * 8;
  }

  /** Reset read/write position to start */
  reset(): void {
    this.bitPosition = 0;
    this.bytePosition = 0;
  }

  /** Seek to a specific bit position */
  seek(bitPos: number): void {
    this.bytePosition = Math.floor(bitPos / 8);
    this.bitPosition = bitPos % 8;
  }

  /** Align to next byte boundary (for mixing with byte-aligned data) */
  alignToByte(): void {
    if (this.bitPosition > 0) {
      this.bitPosition = 0;
      this.bytePosition++;
    }
  }

  /** Get the underlying buffer (trimmed to actual data) */
  getBuffer(): Uint8Array {
    const totalBytes = Math.ceil((this.bytePosition * 8 + this.bitPosition) / 8);
    return this.buffer.slice(0, totalBytes);
  }

  /** Ensure buffer has capacity for more bits */
  private ensureCapacity(additionalBits: number): void {
    const requiredBytes = Math.ceil((this.position + additionalBits) / 8);
    if (requiredBytes > this.buffer.length) {
      const newSize = Math.max(requiredBytes, this.buffer.length * 2);
      const newBuffer = new Uint8Array(newSize);
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
      this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    }
  }

  // ============================================
  // BIT-LEVEL OPERATIONS
  // ============================================

  /**
   * Write arbitrary number of bits (1-32)
   */
  writeBits(value: number, bitCount: number): void {
    if (bitCount < 1 || bitCount > 32) {
      throw new Error(`Invalid bit count: ${bitCount}`);
    }
    
    this.ensureCapacity(bitCount);
    
    // Mask to ensure we only write the specified bits
    const mask = bitCount === 32 ? 0xFFFFFFFF : (1 << bitCount) - 1;
    value = (value & mask) >>> 0;
    
    let bitsRemaining = bitCount;
    
    while (bitsRemaining > 0) {
      const bitsAvailableInByte = 8 - this.bitPosition;
      const bitsToWrite = Math.min(bitsRemaining, bitsAvailableInByte);
      
      // Extract the bits we want to write (from the high end of remaining bits)
      const shift = bitsRemaining - bitsToWrite;
      const bitsValue = (value >>> shift) & ((1 << bitsToWrite) - 1);
      
      // Position them in the current byte
      const byteShift = bitsAvailableInByte - bitsToWrite;
      this.buffer[this.bytePosition] |= bitsValue << byteShift;
      
      this.bitPosition += bitsToWrite;
      if (this.bitPosition >= 8) {
        this.bitPosition = 0;
        this.bytePosition++;
      }
      
      bitsRemaining -= bitsToWrite;
    }
  }

  /**
   * Read arbitrary number of bits (1-32)
   */
  readBits(bitCount: number): number {
    if (bitCount < 1 || bitCount > 32) {
      throw new Error(`Invalid bit count: ${bitCount}`);
    }
    
    let value = 0;
    let bitsRemaining = bitCount;
    
    while (bitsRemaining > 0) {
      const bitsAvailableInByte = 8 - this.bitPosition;
      const bitsToRead = Math.min(bitsRemaining, bitsAvailableInByte);
      
      // Extract bits from current byte
      const byteShift = bitsAvailableInByte - bitsToRead;
      const mask = (1 << bitsToRead) - 1;
      const bitsValue = (this.buffer[this.bytePosition] >>> byteShift) & mask;
      
      // Add to result
      value = (value << bitsToRead) | bitsValue;
      
      this.bitPosition += bitsToRead;
      if (this.bitPosition >= 8) {
        this.bitPosition = 0;
        this.bytePosition++;
      }
      
      bitsRemaining -= bitsToRead;
    }
    
    return value >>> 0; // Ensure unsigned
  }

  /**
   * Write a boolean as a single bit
   */
  writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  /**
   * Read a boolean from a single bit
   */
  readBool(): boolean {
    return this.readBits(1) === 1;
  }

  /**
   * Write a signed integer with specified bit count
   * Uses two's complement representation
   */
  writeSigned(value: number, bitCount: number): void {
    const maxVal = (1 << (bitCount - 1)) - 1;
    const minVal = -(1 << (bitCount - 1));
    value = Math.max(minVal, Math.min(maxVal, Math.round(value)));
    
    // Convert to unsigned representation
    if (value < 0) {
      value = (1 << bitCount) + value;
    }
    
    this.writeBits(value, bitCount);
  }

  /**
   * Read a signed integer with specified bit count
   */
  readSigned(bitCount: number): number {
    let value = this.readBits(bitCount);
    
    // Check sign bit and convert from two's complement
    const signBit = 1 << (bitCount - 1);
    if (value & signBit) {
      value = value - (1 << bitCount);
    }
    
    return value;
  }

  // ============================================
  // QUANTIZED FLOAT OPERATIONS
  // ============================================

  /**
   * Write a float quantized to a range with specified precision
   * @param value The float value to write
   * @param min Minimum expected value
   * @param max Maximum expected value
   * @param bits Number of bits to use (determines precision)
   */
  writeQuantized(value: number, min: number, max: number, bits: number): void {
    const range = max - min;
    const maxInt = (1 << bits) - 1;
    const normalized = Math.max(0, Math.min(1, (value - min) / range));
    const quantized = Math.round(normalized * maxInt);
    this.writeBits(quantized, bits);
  }

  /**
   * Read a quantized float from the specified range
   */
  readQuantized(min: number, max: number, bits: number): number {
    const maxInt = (1 << bits) - 1;
    const quantized = this.readBits(bits);
    const normalized = quantized / maxInt;
    return min + normalized * (max - min);
  }

  /**
   * Write an angle (0 to 2π) with specified precision
   * Default is 12 bits for ~0.088 degree precision
   */
  writeAngle(radians: number, bits: number = 12): void {
    // Normalize to 0-2π range
    const twoPi = Math.PI * 2;
    let normalized = ((radians % twoPi) + twoPi) % twoPi;
    this.writeQuantized(normalized, 0, twoPi, bits);
  }

  /**
   * Read an angle in radians
   * Default is 12 bits for ~0.088 degree precision
   */
  readAngle(bits: number = 12): number {
    return this.readQuantized(0, Math.PI * 2, bits);
  }

  // ============================================
  // BYTE-ALIGNED FAST PATHS
  // ============================================

  /**
   * Write a uint8 (byte-aligned for speed)
   */
  writeUint8(value: number): void {
    this.alignToByte();
    this.ensureCapacity(8);
    this.buffer[this.bytePosition++] = value & 0xFF;
  }

  /**
   * Read a uint8
   */
  readUint8(): number {
    this.alignToByte();
    return this.buffer[this.bytePosition++];
  }

  /**
   * Write a uint16 (byte-aligned, big-endian)
   */
  writeUint16(value: number): void {
    this.alignToByte();
    this.ensureCapacity(16);
    this.view.setUint16(this.bytePosition, value, false);
    this.bytePosition += 2;
  }

  /**
   * Read a uint16
   */
  readUint16(): number {
    this.alignToByte();
    const value = this.view.getUint16(this.bytePosition, false);
    this.bytePosition += 2;
    return value;
  }

  /**
   * Write a uint32 (byte-aligned, big-endian)
   */
  writeUint32(value: number): void {
    this.alignToByte();
    this.ensureCapacity(32);
    this.view.setUint32(this.bytePosition, value, false);
    this.bytePosition += 4;
  }

  /**
   * Read a uint32
   */
  readUint32(): number {
    this.alignToByte();
    const value = this.view.getUint32(this.bytePosition, false);
    this.bytePosition += 4;
    return value;
  }

  /**
   * Write a float32 (byte-aligned)
   */
  writeFloat32(value: number): void {
    this.alignToByte();
    this.ensureCapacity(32);
    this.view.setFloat32(this.bytePosition, value, false);
    this.bytePosition += 4;
  }

  /**
   * Read a float32
   */
  readFloat32(): number {
    this.alignToByte();
    const value = this.view.getFloat32(this.bytePosition, false);
    this.bytePosition += 4;
    return value;
  }

  // ============================================
  // VARIABLE-LENGTH INTEGERS
  // ============================================

  /**
   * Write a variable-length unsigned integer (1-5 bytes)
   * Uses continuation bit encoding
   */
  writeVarUint(value: number): void {
    this.alignToByte();
    value = value >>> 0; // Ensure unsigned
    
    while (value >= 0x80) {
      this.ensureCapacity(8);
      this.buffer[this.bytePosition++] = (value & 0x7F) | 0x80;
      value >>>= 7;
    }
    
    this.ensureCapacity(8);
    this.buffer[this.bytePosition++] = value & 0x7F;
  }

  /**
   * Read a variable-length unsigned integer
   */
  readVarUint(): number {
    this.alignToByte();
    let value = 0;
    let shift = 0;
    let byte: number;
    
    do {
      byte = this.buffer[this.bytePosition++];
      value |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte & 0x80);
    
    return value >>> 0;
  }

  // ============================================
  // STRING OPERATIONS
  // ============================================

  /**
   * Write a UTF-8 string with length prefix
   * Note: Uses manual UTF-8 encoding for cross-platform compatibility
   */
  writeString(str: string): void {
    // Convert string to UTF-8 bytes manually
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let charCode = str.charCodeAt(i);
      
      // Handle surrogate pairs for characters outside BMP
      if (charCode >= 0xD800 && charCode <= 0xDBFF && i + 1 < str.length) {
        const low = str.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          charCode = ((charCode - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
          i++;
        }
      }
      
      if (charCode < 0x80) {
        bytes.push(charCode);
      } else if (charCode < 0x800) {
        bytes.push(0xC0 | (charCode >> 6));
        bytes.push(0x80 | (charCode & 0x3F));
      } else if (charCode < 0x10000) {
        bytes.push(0xE0 | (charCode >> 12));
        bytes.push(0x80 | ((charCode >> 6) & 0x3F));
        bytes.push(0x80 | (charCode & 0x3F));
      } else {
        bytes.push(0xF0 | (charCode >> 18));
        bytes.push(0x80 | ((charCode >> 12) & 0x3F));
        bytes.push(0x80 | ((charCode >> 6) & 0x3F));
        bytes.push(0x80 | (charCode & 0x3F));
      }
    }
    
    this.writeVarUint(bytes.length);
    this.alignToByte();
    this.ensureCapacity(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) {
      this.buffer[this.bytePosition + i] = bytes[i];
    }
    this.bytePosition += bytes.length;
  }

  /**
   * Read a UTF-8 string
   */
  readString(): string {
    const length = this.readVarUint();
    this.alignToByte();
    
    // Decode UTF-8 manually
    let result = '';
    let i = 0;
    while (i < length) {
      const byte1 = this.buffer[this.bytePosition + i++];
      
      if (byte1 < 0x80) {
        result += String.fromCharCode(byte1);
      } else if ((byte1 & 0xE0) === 0xC0) {
        const byte2 = this.buffer[this.bytePosition + i++];
        result += String.fromCharCode(((byte1 & 0x1F) << 6) | (byte2 & 0x3F));
      } else if ((byte1 & 0xF0) === 0xE0) {
        const byte2 = this.buffer[this.bytePosition + i++];
        const byte3 = this.buffer[this.bytePosition + i++];
        result += String.fromCharCode(
          ((byte1 & 0x0F) << 12) | ((byte2 & 0x3F) << 6) | (byte3 & 0x3F)
        );
      } else if ((byte1 & 0xF8) === 0xF0) {
        const byte2 = this.buffer[this.bytePosition + i++];
        const byte3 = this.buffer[this.bytePosition + i++];
        const byte4 = this.buffer[this.bytePosition + i++];
        const codePoint = 
          ((byte1 & 0x07) << 18) | ((byte2 & 0x3F) << 12) | 
          ((byte3 & 0x3F) << 6) | (byte4 & 0x3F);
        // Convert to surrogate pair
        const adjusted = codePoint - 0x10000;
        result += String.fromCharCode(0xD800 + (adjusted >> 10), 0xDC00 + (adjusted & 0x3FF));
      }
    }
    
    this.bytePosition += length;
    return result;
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Create a BitBuffer from a base64 string
   */
  static fromBase64(base64: string): BitBuffer {
    // Base64 decode manually for cross-platform compatibility
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Map<string, number>();
    for (let i = 0; i < chars.length; i++) {
      lookup.set(chars[i], i);
    }
    
    // Remove padding and calculate output size
    let padding = 0;
    if (base64.endsWith('==')) padding = 2;
    else if (base64.endsWith('=')) padding = 1;
    
    const outputLen = (base64.length * 3 / 4) - padding;
    const bytes = new Uint8Array(outputLen);
    
    let byteIdx = 0;
    for (let i = 0; i < base64.length; i += 4) {
      const a = lookup.get(base64[i]) ?? 0;
      const b = lookup.get(base64[i + 1]) ?? 0;
      const c = lookup.get(base64[i + 2]) ?? 0;
      const d = lookup.get(base64[i + 3]) ?? 0;
      
      bytes[byteIdx++] = (a << 2) | (b >> 4);
      if (byteIdx < outputLen) bytes[byteIdx++] = ((b & 0x0F) << 4) | (c >> 2);
      if (byteIdx < outputLen) bytes[byteIdx++] = ((c & 0x03) << 6) | d;
    }
    
    return new BitBuffer(bytes);
  }

  /**
   * Export buffer as base64 string
   */
  toBase64(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes = this.getBuffer();
    let result = '';
    
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i];
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      
      result += chars[b1 >> 2];
      result += chars[((b1 & 0x03) << 4) | (b2 >> 4)];
      result += i + 1 < bytes.length ? chars[((b2 & 0x0F) << 2) | (b3 >> 6)] : '=';
      result += i + 2 < bytes.length ? chars[b3 & 0x3F] : '=';
    }
    
    return result;
  }

  /**
   * Create a BitBuffer from an ArrayBuffer (for WebSocket binary messages)
   */
  static fromArrayBuffer(buffer: ArrayBuffer): BitBuffer {
    return new BitBuffer(new Uint8Array(buffer));
  }

  /**
   * Get as ArrayBuffer (for WebSocket binary messages)
   */
  toArrayBuffer(): ArrayBuffer {
    const trimmed = this.getBuffer();
    // Create a new ArrayBuffer and copy data to ensure we have a proper ArrayBuffer
    const result = new ArrayBuffer(trimmed.length);
    new Uint8Array(result).set(trimmed);
    return result;
  }
}
