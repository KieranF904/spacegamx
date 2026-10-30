// Build ship blueprints from compact text layouts (front of the ship at the top).
// Used by scripts/gen-enemy-ships.mjs and scripts/gen-plan-ships.mjs; see the legend there.
// The layouts speak in legacy functions (what enemies are built of); a player's plan goes through asModels.
const FN = { C: 'core', G: 'generator', K: 'conduit', H: 'hull', A: 'armor', X: 'cargo', S: 'shield', T: 'thruster',
  W: 'weapon', L: 'laser', F: 'flak', M: 'missile', E: 'emp', R: 'railgun', P: 'lance', N: 'miner', O: 'scanner' };
const WEAPONS = new Set(['weapon', 'laser', 'flak', 'missile', 'emp', 'railgun', 'lance']);

/** tri connectors by rotation (clockwise quarter turns): rot0 W,S · rot1 N,W · rot2 E,N · rot3 S,E */
const TRI = [['W', 'S'], ['N', 'W'], ['E', 'N'], ['S', 'E']];
const DIR = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export function build(name, material, rows) {
  const grid = rows.map((r) => [...r]);
  const at = (x, y) => (grid[y] && grid[y][x]) || '.';
  const parts = [];
  let uid = 0;
  const h = grid.length;
  const cx = Math.floor(Math.max(...grid.map((r) => r.length)) / 2);
  const cy = grid.findIndex((r) => r.includes('C'));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const ch = grid[y][x];
      if (ch === '.' || ch === ' ') continue;
      const px = x - cx, py = y - cy;
      if ('<>/\\'.includes(ch)) {
        // The rotation whose two connector sides touch the most neighbours (top rows prefer solid-bottom wedges)
        let best = 0, score = -1;
        TRI.forEach((sides, rot) => {
          let s = sides.filter((d) => at(x + DIR[d][0], y + DIR[d][1]) !== '.').length * 10;
          if (y < cy && sides.includes('S')) s += 1;
          if (y > cy && sides.includes('N')) s += 1;
          if (s > score) { score = s; best = rot; }
        });
        parts.push({ uid: uid++, piece: 'tri', fn: 'hull', material, x: px, y: py, rot: best, flip: false });
        continue;
      }
      const lower = ch !== ch.toUpperCase();
      const fn = FN[ch.toUpperCase()];
      if (!fn) throw new Error(`${name}: unknown cell '${ch}'`);
      if ((fn === 'railgun' || fn === 'lance')) {
        if (grid[y][x - 1] === ch) continue; // second half of the pair
        const p = { uid: uid++, piece: 'rect2', fn, material, x: px, y: py, rot: 0, flip: false, facing: 'N' };
        if (lower) p.mount = 'turret';
        parts.push(p);
        continue;
      }
      const p = { uid: uid++, piece: 'sq', fn, material, x: px, y: py, rot: 0, flip: false };
      if (fn === 'thruster') p.facing = 'S';
      if (WEAPONS.has(fn) || fn === 'miner') {
        // Forward if the cell ahead is clear, else whichever side is
        p.facing = at(x, y - 1) === '.' ? 'N' : at(x - 1, y) === '.' ? 'W' : at(x + 1, y) === '.' ? 'E' : 'N';
        if (lower) p.mount = 'turret';
      }
      parts.push(p);
    }
  }
  return { name, catalogVersion: 1, parts };
}


/** Where a 2×2 piece's origin cell sits, per rotation, so it covers the same 2×2 square (pieces turn about their origin cell) */
const BLOCK_ORIGIN = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * The same layouts at twice the size, for giants: every cell is a 2×2 piece (block2), and the
 * wedges are rounded corners (round2). Railguns and lances are one cell each here, not pairs.
 */
export function buildBlocks(name, material, rows) {
  const grid = rows.map((r) => [...r]);
  const at = (x, y) => (grid[y] && grid[y][x]) || '.';
  const parts = [];
  let uid = 0;
  const cx = Math.floor(Math.max(...grid.map((r) => r.length)) / 2);
  const cy = grid.findIndex((r) => r.includes('C'));
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const ch = grid[y][x];
      if (ch === '.' || ch === ' ') continue;
      const px = (x - cx) * 2, py = (y - cy) * 2;
      if ('<>/\\'.includes(ch)) {
        let best = 0, score = -1;
        TRI.forEach((sides, rot) => {
          let s = sides.filter((d) => at(x + DIR[d][0], y + DIR[d][1]) !== '.').length * 10;
          if (y < cy && sides.includes('S')) s += 1;
          if (y > cy && sides.includes('N')) s += 1;
          if (s > score) { score = s; best = rot; }
        });
        const [ox, oy] = BLOCK_ORIGIN[best];
        parts.push({ uid: uid++, piece: 'round2', fn: 'hull', material, x: px + ox, y: py + oy, rot: best, flip: false });
        continue;
      }
      const lower = ch !== ch.toUpperCase();
      const fn = FN[ch.toUpperCase()];
      if (!fn) throw new Error(`${name}: unknown cell '${ch}'`);
      const p = { uid: uid++, piece: 'block2', fn, material, x: px, y: py, rot: 0, flip: false };
      if (fn === 'thruster') p.facing = 'S';
      if (WEAPONS.has(fn)) {
        p.facing = at(x, y - 1) === '.' ? 'N' : at(x - 1, y) === '.' ? 'W' : at(x + 1, y) === '.' ? 'E' : at(x, y + 1) === '.' ? 'S' : 'N';
        if (lower) p.mount = 'turret';
      }
      parts.push(p);
    }
  }
  return { name, catalogVersion: 1, parts };
}

/**
 * A player's plan from a layout: each legacy module as the starter model of its kind (data/ships/models.json,
 * its own fixed material), conduits as hull (power runs on wires now, auto-wired when built). Unknown: an error.
 */
export const PLAYER_MODELS = {
  generator: 'power_cell_reactor', thruster: 'engine_ion_drive', weapon: 'cannon_pip', miner: 'utility_mining_laser', scanner: 'utility_scanner',
  shield: 'shield_deflector', laser: 'laser_glint', flak: 'flak_burst', missile: 'missile_dart', emp: 'emp_hush', railgun: 'railgun_needle', lance: 'lance_lance',
};
const STRUCTURE = new Set(['core', 'hull', 'armor', 'cargo']);

export function asModels(bp, models) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const parts = bp.parts.map((p) => {
    if (STRUCTURE.has(p.fn)) return p;
    if (p.fn === 'conduit') return { ...p, fn: 'hull' };
    const m = byId.get(PLAYER_MODELS[p.fn]);
    if (!m) throw new Error(`${bp.name}: no player model for ${p.fn}`);
    if (!m.pieces.includes(p.piece)) throw new Error(`${bp.name}: ${m.id} doesn't come in ${p.piece}`);
    // (A model weapon's mount is its own: a layout's lower-case letter says nothing for it)
    const { mount, ...rest } = p;
    return { ...rest, ...(mount && !m.mount ? { mount } : {}), fn: m.id, material: m.material };
  });
  return { ...bp, parts };
}
