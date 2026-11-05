/**
 * Helios Drone (Helios Drones, Sol; replaces the grid helios_drone): docs/enemies/custom-roster.md.
 * Directorate engineering gone astray (docs/lore-canon.md: the Array's maintenance drones, slow, half-blind, welding
 * torches, a schedule nobody at the Array wrote): a slim service chassis in pale titanium with a little brass trim, a
 * sensor dome at its nose whose lens is lit on one side and dead on the other, a light jointed welding arm off its
 * starboard bow ending in a torch head, two solar panels on thin booms (the stations' own solar cells: `surface:
 * 'solar'`), one small service drive.
 *   the starter's first kill: it drifts on its round and only welds what comes too close.
 *   node scripts/bespoke/enemies/helios_drone.mjs
 * (2026-11-05 restyle: half the chassis' width, a lighter arm, thin booms; the panels the stations' cells)
 */
import { design, mid, bar, ringPts, oval, rivets, glow, ring, halo, raise, recess, channel, cable, bell } from './kit.mjs';

const SHELL = 'titanium', METAL = 'titanium', STEEL = 'pyre_steel', GLASS = 'pyre_crystal';
const BRASS = '#b49a62', BRASS2 = '#8f7a4e', DEEP = '#2a2f38', PLATE = '#d4d0c6', PLATE2 = '#bdb8ac', SEAMC = '#7c776c',
  LENS = '#9fe8ff', DEAD = '#1a1d22', TORCH = '#bfefff', HOT = '#ffffff', SOOT = '#3a3530', FRAME = '#8a96a6', STRUT = '#9aa0a8';

const d = design('helios_drone', {
  name: 'Helios Drone', faction: 'helios', sky: 'sol', replaces: 'grid_helios_drone',
  role: 'passive / welder', level: '1-3', threat: 'low',
});

// The chassis: a slim hexagonal service body of pale plate, a raised spine with its hatch, a sensor bus forward, a
// brass band across its back and a heat grille aft
const chassis = [[0, -2.35], [-0.9, -1.75], [-1.0, 1.0], [-0.65, 2.45], [0.65, 2.45], [1.0, 1.0], [0.9, -1.75]];
d.part('chassis', 'hull', SHELL, chassis, {
  group: 'core', relief: 'round',
  detail: [
    // (the spine: a raised plate down the middle with its hatch and the hatch's latch)
    raise([[-0.42, -1.7], [0.42, -1.7], [0.48, 1.0], [-0.48, 1.0]], PLATE),
    recess([[-0.28, -0.1], [0.28, -0.1], [0.3, 0.75], [-0.3, 0.75]], PLATE2),
    channel(bar([-0.22, 0.08], [0.22, 0.08], 0.04), DEEP), ring([0, 0.45], 0.09, 0.04, BRASS, 6),
    // (the sensor bus forward: three small ports in a row)
    ...[-0.18, 0, 0.18].map((x) => ring([x, -1.3], 0.06, 0.03, DEEP, 6)),
    // (seams between the spine and the flanks, a vent slot in each flank)
    channel(bar([-0.55, -1.55], [-0.55, 0.95], 0.025), SEAMC), channel(bar([0.55, -1.55], [0.55, 0.95], 0.025), SEAMC),
    ...[-0.5, -0.1].map((y) => channel(bar([-0.85, y], [-0.65, y], 0.045), SEAMC)), ...[-0.5, -0.1].map((y) => channel(bar([0.65, y], [0.85, y], 0.045), SEAMC)),
    // (the Directorate's band across its back, in brass, its rivets, the heat grille)
    raise([[-0.92, 1.25], [0.92, 1.25], [0.88, 1.45], [-0.88, 1.45]], BRASS2),
    ...rivets([-0.6, 1.8], [0.6, 1.8], 4, 0.05, BRASS2),
    raise([[-0.55, 1.95], [0.55, 1.95], [0.47, 2.3], [-0.47, 2.3]], STRUT),
    ...[-0.25, 0, 0.25].map((x) => channel(bar([x, 2.0], [x, 2.25], 0.045), DEEP)),
    // (the torch shoulder's soot)
    recess(oval([0.72, -1.3], 0.22, 0.15, [1, -0.6], 10), SOOT),
  ],
});
// The core: a sealed service cell under a hatch in its middle (only seen once the chassis is opened up)
d.part('cell', 'core', METAL, ringPts([0, 0.6], 0.34, 6, Math.PI / 6), {
  group: 'core', relief: 'recess', under: true,
  detail: [recess(ringPts([0, 0.6], 0.32, 6, Math.PI / 6), DEEP), glow([0, 0.6], 0.2, BRASS)],
});
// The sensor dome at its nose: a brass collar, the lens lit down its port half and dead (cracked, dark) to starboard
const EYE = [0, -2.35];
d.part('eye', 'scanner', GLASS, ringPts(EYE, 0.55, 14), {
  group: 'eye', relief: 'round',
  detail: [
    ring(EYE, 0.48, 0.08, BRASS), recess(ringPts(EYE, 0.38, 14), DEEP),
    glow([-0.15, -2.38], 0.3, LENS), glow([-0.18, -2.4], 0.1, HOT), halo([-0.15, -2.38], 0.34, 0.04, LENS),
    recess([[0.0, -2.72], [0.33, -2.6], [0.4, -2.32], [0.32, -2.02], [0.0, -1.97]], DEAD),
    channel(bar([0.08, -2.65], [0.24, -2.2], 0.035), '#555b66'),
  ],
});
// The welding arm: a light two-strut arm off its starboard bow, the torch head at its end, its flame blue-white at the tip
const SH = [0.78, -1.4], EL = [1.65, -2.25], WR = [1.3, -3.45];
d.part('shoulder', 'hull', STEEL, ringPts(SH, 0.28, 10), { group: 'torch', relief: 'round', detail: [ring(SH, 0.2, 0.05, BRASS2, 10)] });
d.part('upper', 'hull', METAL, bar(SH, EL, 0.22, 0.85), { group: 'torch', relief: 'ridge', detail: [cable([mid(SH, EL, 0.15), [1.4, -1.7], mid(SH, EL, 0.95)], 0.035, SOOT)] });
d.part('elbow', 'hull', STEEL, ringPts(EL, 0.19, 10), { group: 'torch', relief: 'round', detail: [ring(EL, 0.13, 0.04, BRASS2, 8)] });
d.part('fore', 'hull', METAL, bar(EL, WR, 0.18, 0.85), { group: 'torch', relief: 'ridge' });
d.part('torch', 'hull', STEEL, [[1.16, -3.3], [1.46, -3.4], [1.46, -3.85], [1.3, -4.1], [1.13, -3.8]], {
  group: 'torch', relief: 'round', mount: { at: [1.3, -4.1], dir: [-0.15, -1], width: 0.22 },
  detail: [ring([1.3, -3.5], 0.11, 0.04, SOOT, 8), glow([1.3, -4.05], 0.24, TORCH), glow([1.3, -4.05], 0.09, HOT), halo([1.3, -4.05], 0.32, 0.035, TORCH)],
});
// The solar panels: each on a thin boom out of its flank, the stations' own cells (surface: solar) in a slim frame
// (each boom's root a bracket on the flank, overlapping it: what holds the panel on)
const X0 = 0.55, XR = 1.2, XB = 1.75, X1 = 3.55, Y0 = -0.5, Y1 = 0.7, BW = 0.07, RW = 0.3;
const panel = (sx) => [[X0 * sx, -RW], [XR * sx, -BW], [XB * sx, -BW], [XB * sx, Y0], [X1 * sx, Y0 - 0.06], [X1 * sx, Y1 - 0.06], [XB * sx, Y1], [XB * sx, BW], [XR * sx, BW], [X0 * sx, RW]];
const frame = (sx) => {
  const a = [XB * sx, Y0], b = [X1 * sx, Y0 - 0.06], c = [X1 * sx, Y1 - 0.06], e = [XB * sx, Y1], w = 0.07;
  return [
    raise([[X0 * sx, -RW], [XR * sx, -BW], [XR * sx, BW], [X0 * sx, RW]], STRUT), raise(bar([XR * sx, 0], [(XB + 0.05) * sx, 0], 0.13), STRUT),
    ring([(X0 + 0.17) * sx, 0], 0.07, 0.03, BRASS2, 6),
    ...[[a, b], [b, c], [c, e], [e, a]].map(([p, q]) => raise(bar(p, q, w), FRAME)),
    // (a cross brace down the middle, as the stations' arrays are braced)
    raise(bar(mid(a, b), mid(e, c), 0.045), FRAME),
  ];
};
d.part('panel_l', 'hull', METAL, panel(-1), { group: 'panel_l', relief: 'raise', surface: 'solar', detail: frame(-1) });
d.part('panel_r', 'hull', METAL, panel(1), {
  group: 'panel_r', relief: 'raise', surface: 'solar',
  detail: [...frame(1), recess(oval([2.95, 0.35], 0.2, 0.14, [1, 0.3], 8), '#121822')],
});
// The drive: one small service thruster under its tail, a brass ring round the bell
d.part('drive', 'thruster', STEEL, [[-0.42, 2.4], [0.42, 2.4], [0.5, 3.25], [-0.5, 3.25]], {
  group: 'drive', relief: 'round', mount: { at: [0, 3.25], dir: [0, 1], width: 0.8 },
  detail: [ring([0, 2.7], 0.36, 0.05, BRASS2, 12), bell([0, 3.25], [0, 1], 0.6, 0.42)],
});

d.write({ damaged: ['torch', 'panel_r'], paint: '#c9ccd2', scale: 0.62 });
