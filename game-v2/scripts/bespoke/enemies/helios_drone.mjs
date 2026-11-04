/**
 * Helios Drone (Helios Drones, Sol; replaces the grid helios_drone): docs/enemies/custom-roster.md.
 * Directorate engineering gone astray (docs/lore-canon.md: the Array's maintenance drones, slow, half-blind, welding
 * torches, a schedule nobody at the Array wrote): a clean hexagonal service chassis in pale titanium with gold trim and
 * stencilled access hatches, a sensor dome at its nose whose lens is lit on one side and dead on the other, a jointed
 * welding arm off its starboard bow ending in a torch head, two folding solar panels, one small service drive.
 *   the starter's first kill: it drifts on its round and only welds what comes too close.
 *   node scripts/bespoke/enemies/helios_drone.mjs
 */
import { design, mid, bar, ringPts, oval, inset, rivets, glow, ring, halo, raise, recess, channel, stripes, cable, bell } from './kit.mjs';

const SHELL = 'titanium', METAL = 'titanium', STEEL = 'pyre_steel', GLASS = 'pyre_crystal';
const GOLD = '#e8c86a', GOLD2 = '#b8923e', DEEP = '#2a2f38', PANEL = '#1f2c44', CELL = '#2f4a72', CELL2 = '#3c5f8e',
  CREAM = '#e9e4d6', LENS = '#9fe8ff', DEAD = '#1a1d22', TORCH = '#bfefff', HOT = '#ffffff', SOOT = '#3a3530';

const d = design('helios_drone', {
  name: 'Helios Drone', faction: 'helios', sky: 'sol', replaces: 'grid_helios_drone',
  role: 'passive / welder', level: '1-3', threat: 'low',
});

// The chassis: a long hexagon of pale ceramic plate, gold trim along its shoulders and flanks, a raised spine with
// its service hatch, a sensor bus forward, the Directorate's banded stripe across its back and a heat grille aft
const chassis = [[0, -2.6], [-1.5, -1.7], [-1.7, 1.1], [-1.1, 2.6], [1.1, 2.6], [1.7, 1.1], [1.5, -1.7]];
d.part('chassis', 'hull', SHELL, chassis, {
  group: 'core', relief: 'round',
  detail: [
    // (gold edging down both flanks and across the shoulders)
    raise([[-1.5, -1.7], [-0.55, -2.25], [-0.5, -2.0], [-1.32, -1.52]], GOLD), raise([[1.5, -1.7], [0.55, -2.25], [0.5, -2.0], [1.32, -1.52]], GOLD),
    raise([[-1.5, -1.7], [-1.7, 1.1], [-1.52, 1.1], [-1.33, -1.5]], GOLD2), raise([[1.5, -1.7], [1.7, 1.1], [1.52, 1.1], [1.33, -1.5]], GOLD2),
    // (the spine: a raised plate down the middle with its hatch and the hatch's gold latch)
    raise([[-0.55, -1.75], [0.55, -1.75], [0.62, 1.05], [-0.62, 1.05]], '#e4dccb'),
    recess([[-0.36, -0.15], [0.36, -0.15], [0.4, 0.85], [-0.4, 0.85]], '#b8b0a0'),
    channel(bar([-0.3, 0.05], [0.3, 0.05], 0.05), DEEP), ring([0, 0.5], 0.12, 0.05, GOLD, 6),
    // (the sensor bus forward: three small ports in a row)
    ...[-0.25, 0, 0.25].map((x) => ring([x, -1.25], 0.08, 0.04, DEEP, 6)),
    // (side plates, a shade darker, a vent slot in each)
    raise([[-1.3, -0.9], [-0.75, -0.95], [-0.75, 0.9], [-1.45, 0.9]], '#cfc6b4'), raise([[1.3, -0.9], [0.75, -0.95], [0.75, 0.9], [1.45, 0.9]], '#cfc6b4'),
    ...[-0.5, -0.1, 0.3].map((y) => channel(bar([-1.25, y], [-0.9, y], 0.06), '#6c675e')), ...[-0.5, -0.1, 0.3].map((y) => channel(bar([0.9, y], [1.25, y], 0.06), '#6c675e')),
    ...stripes([-1.15, 1.4], [1.15, 1.4], 0.3, 6, GOLD, DEEP),
    ...rivets([-0.95, 1.85], [0.95, 1.85], 5, 0.07, GOLD2),
    raise([[-0.85, 2.0], [0.85, 2.0], [0.72, 2.4], [-0.72, 2.4]], '#9aa0a8'),
    ...[-0.45, -0.15, 0.15, 0.45].map((x) => channel(bar([x, 2.05], [x, 2.35], 0.06), DEEP)),
    // (gold edging down the tail's flanks, the way the shoulders have it)
    raise([[-1.7, 1.1], [-1.1, 2.6], [-0.95, 2.48], [-1.5, 1.12]], GOLD2), raise([[1.7, 1.1], [1.1, 2.6], [0.95, 2.48], [1.5, 1.12]], GOLD2),
    // (stencilled access hatches on the side plates, a gold tab on each, and the torch shoulder's soot)
    recess([[-1.22, 0.5], [-0.88, 0.5], [-0.88, 0.8], [-1.25, 0.8]], '#8f897c'), raise(bar([-1.15, 0.65], [-0.95, 0.65], 0.07), GOLD),
    recess([[0.88, 0.5], [1.22, 0.5], [1.25, 0.8], [0.88, 0.8]], '#8f897c'), raise(bar([0.95, 0.65], [1.15, 0.65], 0.07), GOLD),
    recess(oval([1.05, -1.3], 0.32, 0.22, [1, -0.6], 10), SOOT),
    // (seams between the spine and its side plates)
    channel(bar([-0.68, -1.6], [-0.68, 0.95], 0.03), '#7c776c'), channel(bar([0.68, -1.6], [0.68, 0.95], 0.03), '#7c776c'),
  ],
});
// The core: a sealed service cell under a hatch in its middle (only seen once the chassis is opened up)
d.part('cell', 'core', METAL, ringPts([0, 0.65], 0.42, 6, Math.PI / 6), {
  group: 'core', relief: 'recess', under: true,
  detail: [recess(ringPts([0, 0.65], 0.4, 6, Math.PI / 6), DEEP), glow([0, 0.65], 0.25, GOLD)],
});
// The sensor dome at its nose: a gold collar, the lens lit down its port half and dead (cracked, dark) to starboard
const EYE = [0, -2.55];
d.part('eye', 'scanner', GLASS, ringPts(EYE, 0.72, 14), {
  group: 'eye', relief: 'round',
  detail: [
    ring(EYE, 0.62, 0.14, GOLD), recess(ringPts(EYE, 0.48, 14), DEEP),
    glow([-0.2, -2.58], 0.38, LENS), glow([-0.24, -2.6], 0.14, HOT), halo([-0.2, -2.58], 0.44, 0.06, LENS),
    recess([[0.0, -3.05], [0.44, -2.88], [0.53, -2.5], [0.42, -2.12], [0.0, -2.05]], DEAD),
    channel(bar([0.1, -2.95], [0.32, -2.35], 0.05), '#555b66'), channel(bar([0.2, -2.6], [0.42, -2.45], 0.04), '#555b66'),
  ],
});
// The welding arm: shoulder off its starboard bow, two jointed struts and the torch head, its flame blue-white at the tip
const SH = [1.25, -1.35], EL = [2.35, -2.35], WR = [1.85, -3.85];
d.part('shoulder', 'hull', STEEL, ringPts(SH, 0.42, 10), { group: 'torch', relief: 'round', detail: [ring(SH, 0.3, 0.08, GOLD2, 10)] });
d.part('upper', 'hull', METAL, bar(SH, EL, 0.42, 0.8), { group: 'torch', relief: 'ridge', detail: [raise(bar(mid(SH, EL, 0.15), mid(SH, EL, 0.85), 0.14), GOLD), cable([mid(SH, EL, 0.1), [2.05, -1.6], mid(SH, EL, 0.95)], 0.05, SOOT)] });
d.part('elbow', 'hull', STEEL, ringPts(EL, 0.3, 10), { group: 'torch', relief: 'round', detail: [ring(EL, 0.2, 0.07, GOLD2, 8)] });
d.part('fore', 'hull', METAL, bar(EL, WR, 0.34, 0.8), { group: 'torch', relief: 'ridge', detail: [raise(bar(mid(EL, WR, 0.2), mid(EL, WR, 0.8), 0.1), GOLD)] });
d.part('torch', 'hull', STEEL, [[1.62, -3.45], [2.08, -3.62], [2.05, -4.25], [1.85, -4.55], [1.6, -4.2]], {
  group: 'torch', relief: 'round', mount: { at: [1.85, -4.55], dir: [-0.15, -1], width: 0.3 },
  detail: [ring([1.84, -3.7], 0.16, 0.06, SOOT, 8), glow([1.85, -4.5], 0.32, TORCH), glow([1.85, -4.5], 0.12, HOT), halo([1.85, -4.5], 0.42, 0.05, TORCH)],
});
// The solar panels: folded out either side on a short boom, cells in a gold frame
const panel = (sx) => {
  const x0 = 1.5 * sx, x1 = 4.1 * sx;
  return [[x0, -0.55], [x1, -0.85], [x1, 1.15], [x0, 0.9]];
};
const cells = (sx) => {
  const out = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    const a = 1.9 + i * 0.55, b = a + 0.45, y0 = -0.5 + j * 0.85 - (a - 1.75) * 0.11, y1 = y0 + 0.7;
    out.push(raise([[a * sx, y0], [b * sx, y0 - 0.05], [b * sx, y1 - 0.05], [a * sx, y1]], (i + j) % 2 ? CELL : CELL2));
  }
  return out;
};
d.part('panel_l', 'hull', METAL, panel(-1), {
  group: 'panel_l', relief: 'raise',
  detail: [raise(inset(panel(-1), 0.97), GOLD), raise(inset(panel(-1), 0.88), PANEL), ...cells(-1), raise(bar([-1.55, 0.15], [-1.95, 0.15], 0.28), '#9aa0a8')],
});
d.part('panel_r', 'hull', METAL, panel(1), {
  group: 'panel_r', relief: 'raise',
  detail: [raise(inset(panel(1), 0.97), GOLD), raise(inset(panel(1), 0.88), PANEL), ...cells(1), raise(bar([1.55, 0.15], [1.95, 0.15], 0.28), '#9aa0a8'), recess(oval([3.3, 0.55], 0.28, 0.2, [1, 0.3], 8), '#121822')],
});
// The drive: one small service thruster under its tail, a gold ring round the bell
d.part('drive', 'thruster', STEEL, [[-0.6, 2.45], [0.6, 2.45], [0.7, 3.5], [-0.7, 3.5]], {
  group: 'drive', relief: 'round', mount: { at: [0, 3.5], dir: [0, 1], width: 1.1 },
  detail: [ring([0, 2.85], 0.5, 0.08, GOLD, 12), ...rivets([-0.5, 3.2], [0.5, 3.2], 3, 0.06, GOLD2), bell([0, 3.5], [0, 1], 0.8, 0.55)],
});

d.write({ damaged: ['torch', 'panel_r'], paint: '#c9ccd2', scale: 0.62 });
