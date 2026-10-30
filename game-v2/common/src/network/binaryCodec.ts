/**
 * A compact binary form for JSON-like values: what the server's messages are
 * sent as. It carries exactly what JSON would (a value decodes to what
 * JSON.parse(JSON.stringify(value)) gives), in far fewer bytes:
 *
 *   0x00-0x7f  integer 0..127
 *   0x80 null   0x81 false   0x82 true
 *   0x83 n     integer n (varint)            0x84 n  integer -1 - n
 *   0x85-0x8a  decimal with 1-6 places: zigzag varint m, value m / 10^places
 *              (a position like 27302.93 is 5 bytes; it decodes to the same
 *              double JSON.parse would give, which encoding checks)
 *   0x8b f32   0x8c f64 (anything else)
 *   0x8d len   string (UTF-8)                0x8e len  array
 *   0x8f n     object: n × (string key, value)
 *   0xa0-0xbf  array of 0..31 items          0xc0-0xdf  string of 0..31 bytes
 *   0xe0-0xff  integer -32..-1
 *   0x90 i     a common string (DICTIONARY[i]): part functions, materials, pieces,
 *              blueprint and message keys, how parts break...
 *
 * Varints are 7 bits a byte, low first, and go up to 2^53.
 */

// (Both are globals in browsers and Node; common is built without the DOM types)
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(b: Uint8Array): string } };

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

/** Strings sent by number (append only: both ends must agree) */
export const DICTIONARY: readonly string[] = [
  // ship part functions, materials, pieces and facings
  'core', 'hull', 'armor', 'generator', 'conduit', 'thruster', 'miner', 'scanner', 'cargo', 'weapon', 'railgun', 'laser',
  'flak', 'missile', 'lance', 'emp', 'shield', 'hive', 'frostbite', 'cinder_bloom', 'prism', 'phase', 'singularity', 'jumpcoil',
  'alloy', 'composite', 'steel', 'titanium',
  'sq', 'rect2', 'tri', 'slope2', 'cap', 'round', 'fillet', 'block2', 'block3', 'round2', 'fillet2',
  // blueprint keys
  'uid', 'piece', 'fn', 'material', 'rot', 'flip', 'facing', 'parts', 'catalogVersion', 'name', 'paint',
  // bodies, breakage, toasts
  'ship', 'debris', 'blast', 'break', 'crumble', 'info', 'good', 'bad', 'warn',
  // common message keys
  'type', 'text', 'kind', 'id', 'items', 'credits', 'source', 'color', 'storage', 'cargo', 'title', 'level', 'xp', 'system',
  'cannon', 'sol',
  // (appended: grades and engines)
  'cobalt', 'neutronium', 'afterburner', 'plasma_drive', 'battery', 'drive_battery', 'weapon_battery',
  // (appended: hazard materials and the wedge nose)
  'insulated_polymer', 'conductive_steel', 'leaded_iridium', 'ceramic_laminate', 'sealed_composite', 'dense_ferrite', 'nose2',
  'autocannon', 'pulse', 'arc', 'torpedo', 'mortar', 'charge', 'charge_launcher', 'siphon',
  // (appended: the construction rig)
  'constructor',
  // (appended: leestone, and bosses' own parts)
  'leestone', 'molten_plate', 'dash_coil', 'brood_bay', 'pyre_lance', 'magma_mortar', 'heat_vent', 'pyre_glass', 'pyre_crystal', 'magma', 'magma_cannon',
  // (appended: the bosses' skeletons and the rest of their materials)
  'bone_frame', 'pyre_chrome', 'pyre_steel', 'scrap_iron', 'scrap_rust', 'scrap_paint', 'scrap_steel', 'scrap_seam', 'dev_singularity',
  // (appended: the Brood Mother's materials)
  'brood_shell', 'brood_rime', 'brood_membrane', 'brood_ice', 'brood_gland',
  // (appended: blueprints' wires, and the player models: data/ships/models.json)
  'wires', 'cannon_pip', 'cannon_hammer', 'cannon_twinlink', 'cannon_longbarrel', 'cannon_bastion',
  'autocannon_rattler', 'autocannon_chainsaw', 'autocannon_stinger', 'flak_burst', 'flak_cloudmaker', 'mortar_lobber',
  'mortar_quake', 'laser_glint', 'laser_cutter', 'laser_searchlight', 'pulse_strobe', 'pulse_overpulse',
  'missile_dart', 'missile_swarm', 'missile_hammerhead', 'railgun_needle', 'railgun_coilgun', 'railgun_spear',
  'emp_hush', 'emp_blackout', 'arc_spark', 'arc_tesla', 'torpedo_eel', 'torpedo_leviathan', 'lance_lance',
  'legendary_hive', 'legendary_frostbite', 'legendary_cinder_bloom', 'legendary_prism', 'legendary_phase',
  'legendary_singularity', 'engine_ion_drive', 'engine_vernier', 'engine_afterburner', 'engine_torch',
  'engine_plasma_drive', 'engine_drift_sail', 'engine_fusion_torch', 'power_cell_reactor', 'power_isotope_pile',
  'power_fusion_plant', 'power_overclock_reactor', 'power_battery', 'power_capacitor', 'power_drive_cell',
  'power_heavy_bank', 'utility_mining_laser', 'utility_bore', 'utility_demolition_launcher', 'utility_siphon',
  'utility_scanner', 'utility_long_range_array', 'utility_constructor', 'shield_deflector', 'shield_flicker_screen',
  'shield_bulwark_projector', 'utility_jump_coil', 'utility_heavy_coil', 'plating_reactive_armour',
  'plating_spaced_plating',
];
const DICT_INDEX = new Map(DICTIONARY.map((s, i) => [s, i]));
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export class BinaryWriter {
  buf = new Uint8Array(4096);
  view = new DataView(this.buf.buffer);
  len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(b: number): void {
    this.room(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  varint(n: number): void {
    this.room(8);
    while (n >= 128) {
      this.buf[this.len++] = (n % 128) | 128;
      n = Math.floor(n / 128);
    }
    this.buf[this.len++] = n;
  }

  string(s: string): void {
    const d = DICT_INDEX.get(s);
    if (d !== undefined) { this.byte(0x90); this.varint(d); return; }
    let ascii = s.length < 64;
    for (let i = 0; ascii && i < s.length; i++) if (s.charCodeAt(i) > 127) ascii = false;
    if (ascii) {
      if (s.length < 32) this.byte(0xc0 | s.length); else { this.byte(0x8d); this.varint(s.length); }
      this.room(s.length);
      for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
      return;
    }
    const b = utf8.encode(s);
    if (b.length < 32) this.byte(0xc0 | b.length); else { this.byte(0x8d); this.varint(b.length); }
    this.bytes(b);
  }

  number(v: number): void {
    if (!Number.isFinite(v)) { this.byte(0x80); return; } // as JSON: null
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      if (v >= 0) { if (v < 128) this.byte(v); else { this.byte(0x83); this.varint(v); } }
      else if (v >= -32) this.byte(0x100 + v);
      else { this.byte(0x84); this.varint(-1 - v); }
      return;
    }
    for (let k = 1; k <= 6; k++) {
      const m = Math.round(v * POW10[k]);
      if (Math.abs(m) < 2 ** 51 && m / POW10[k] === v) {
        this.byte(0x84 + k);
        this.varint(m >= 0 ? m * 2 : -m * 2 - 1);
        return;
      }
    }
    this.room(9);
    if (Math.fround(v) === v) { this.buf[this.len++] = 0x8b; this.view.setFloat32(this.len, v, true); this.len += 4; }
    else { this.buf[this.len++] = 0x8c; this.view.setFloat64(this.len, v, true); this.len += 8; }
  }

  value(v: unknown): void {
    switch (typeof v) {
      case 'number': this.number(v); return;
      case 'string': this.string(v); return;
      case 'boolean': this.byte(v ? 0x82 : 0x81); return;
      case 'object': break;
      default: this.byte(0x80); return; // undefined (in an array), functions: null, as JSON
    }
    if (v === null) { this.byte(0x80); return; }
    if (Array.isArray(v)) {
      this.arrayHeader(v.length);
      for (const x of v) this.value(x);
      return;
    }
    const o = v as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof o.toJSON === 'function') { this.value(o.toJSON()); return; }
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function');
    this.byte(0x8f);
    this.varint(keys.length);
    for (const k of keys) { this.string(k); this.value(o[k]); }
  }

  /** An array of n items starts (the items follow, each a value) */
  arrayHeader(n: number): void {
    if (n < 32) this.byte(0xa0 | n); else { this.byte(0x8e); this.varint(n); }
  }

  /** What's been written, as its own bytes; the writer starts over */
  take(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
}

export class BinaryReader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('binary frame ended early');
    return this.buf[this.pos++];
  }

  varint(): number {
    let n = 0, mul = 1, b: number;
    do {
      b = this.byte();
      n += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    return n;
  }

  private str(n: number): string {
    const end = this.pos + n;
    if (end > this.buf.length) throw new Error('binary frame ended early');
    let s = '';
    let ascii = n < 64;
    for (let i = this.pos; ascii && i < end; i++) if (this.buf[i] > 127) ascii = false;
    if (ascii) for (let i = this.pos; i < end; i++) s += String.fromCharCode(this.buf[i]);
    else s = fromUtf8.decode(this.buf.subarray(this.pos, end));
    this.pos = end;
    return s;
  }

  value(): unknown {
    const t = this.byte();
    if (t < 0x80) return t;
    if (t >= 0xe0) return t - 0x100;
    if (t >= 0xc0) return this.str(t & 31);
    if (t >= 0xa0) return this.array(t & 31);
    switch (t) {
      case 0x80: return null;
      case 0x81: return false;
      case 0x82: return true;
      case 0x83: return this.varint();
      case 0x84: return -1 - this.varint();
      case 0x8b: { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
      case 0x8c: { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
      case 0x8d: return this.str(this.varint());
      case 0x90: {
        const s = DICTIONARY[this.varint()];
        if (s === undefined) throw new Error('unknown dictionary string');
        return s;
      }
      case 0x8e: return this.array(this.varint());
      case 0x8f: {
        const n = this.varint();
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const k = this.value();
          if (typeof k !== 'string') throw new Error('binary object key is not a string');
          o[k] = this.value();
        }
        return o;
      }
    }
    if (t >= 0x85 && t <= 0x8a) {
      const z = this.varint();
      const m = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      return m / POW10[t - 0x84];
    }
    throw new Error(`unknown binary tag ${t}`);
  }

  private array(n: number): unknown[] {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = this.value();
    return a;
  }
}

const shared = new BinaryWriter();

/** One value as bytes */
export function encodeBinary(v: unknown): Uint8Array {
  shared.value(v);
  return shared.take();
}

/** Every value in a run of them */
export function decodeBinaryAll(buf: Uint8Array, from = 0): unknown[] {
  const r = new BinaryReader(buf);
  r.pos = from;
  const out: unknown[] = [];
  while (!r.done) out.push(r.value());
  return out;
}
