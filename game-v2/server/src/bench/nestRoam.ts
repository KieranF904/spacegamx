/**
 * Where the Scrap Mother's den packs go (docs/bosses/rework-2026-11.md 9.1, 14): the real server with the Nest Rock
 * loaded, every den ship's place sampled every half second over a few minutes of sim time, in three cases:
 *
 *   ghosts   nobody in the pocket: each slot's ghost (common ghostShip), as the map draws it and a ship loads there
 *   landing  a pilot idling at the landing, out of everyone's sight: the packs loaded, on patrol
 *   den      a pilot idling in the Gullet (can't be hurt), fought by whoever sees it
 *
 * Reported per heap: which chamber its ships are in, how far they fly, the share of samples pressed on rock (within
 * 80 of it) and stuck there (barely moving), and the pack's spread. `--png <dir>` writes top-down plots of the tracks
 * as PNGs (for docs/panels; `--tag` names them).
 *   npx tsx src/bench/nestRoam.ts [--minutes 5] [--png dir]
 */
import { join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import * as bitecs from 'bitecs';
import { InSystem, Position, Velocity, insideTerrain, terrainRadius, ghostCentre, ghostShip, slotStyle, type Terrain } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = fileURLToPath(new URL('../../../data', import.meta.url));
const files = readGameDataFiles(dataDir);
const NEST = 'sol_scrap_nest';

/** The rock's chambers (scripts/terrain/scrap_nest.mjs CHAMBERS) */
export const CHAMBERS: Record<string, { c: [number, number]; r: number }> = {
  heart: { c: [0, 0], r: 5600 }, gullet: { c: [0, 12500], r: 3400 }, sorting: { c: [-13500, 5500], r: 4300 },
  smelter: { c: [13500, 4500], r: 4300 }, gallery: { c: [0, -14000], r: 3700 },
};
/** Its tunnels' lines (TUNNELS there; half-widths 1,500-1,800, rough edges a little wider) */
const TUNNELS: [number, number][][] = [
  [[0, 4600], [0, 10000]], [[0, 14500], [0, 18000], [0, 25000]], [[-2400, 13600], [-7000, 11600], [-10400, 8700]], [[2400, 13600], [7000, 11400], [10400, 7800]],
  [[-14200, 1500], [-14000, -5000], [-10000, -10600], [-3000, -14000]], [[14200, 500], [14000, -5000], [10000, -10600], [3000, -14000]],
];
const ROCK_R = 21500;

function segDist(x: number, y: number, a: [number, number], b: [number, number]): number {
  const ex = b[0] - a[0], ey = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey || 1)));
  return Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t);
}

/**
 * Which part of the den a point is in: a chamber, a tunnel, outside the rock, or the rock (its solid edge, or behind
 * it: the terrain is only the walls' depth, so a point deep in the rock is "open" to the terrain but nowhere a ship goes)
 */
export function areaOf(t: Terrain | null, x: number, y: number): string {
  if (insideTerrain(t, x, y)) return 'rock';
  for (const [k, ch] of Object.entries(CHAMBERS)) if (Math.hypot(x - ch.c[0], y - ch.c[1]) < ch.r + 400) return k;
  if (Math.hypot(x, y - 800) > ROCK_R) return 'outside';
  return TUNNELS.some((ps) => ps.slice(1).some((b, i) => segDist(x, y, ps[i], b) < 2100)) ? 'tunnel' : 'rock';
}

export interface Track { nest: string; type: string; pts: [number, number][]; walled: number; stuck: number; dist: number }

export function denWorld() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'idler' } as any);
  const pid = t.getPlayerId();
  const num = server['gameData'].getSystemNum(NEST);
  return { server, pid, num, rock: server.terrainOf(num) as Terrain | null };
}

/** Den ships' tracks over `ticks`, the pilot held at (px, py) (in the pocket) */
export function liveTracks(px: number, py: number, ticks: number, every = 30, unseen = false): { tracks: Map<number, Track>; rock: Terrain | null } {
  const { server, pid, num, rock } = denWorld();
  server.bosses.unhurt.add(pid);
  // (unseen: nobody goes for the pilot, so every heap's packs just patrol)
  if (unseen) (server.enemies as any).host.sheltered = () => true;
  const hold = () => { InSystem.systemId[pid] = num; Position.x[pid] = px; Position.y[pid] = py; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const tracks = new Map<number, Track>();
  const enemies = (server.enemies as any).enemies as Map<number, { type: string; boss?: string; pack: number }>;
  const packs = (server.enemies as any).packs as Map<number, { nest?: string }>;
  for (let i = 0; i < ticks; i++) {
    hold();
    server.step();
    if (i % every) continue;
    for (const [eid, e] of enemies) {
      if (InSystem.systemId[eid] !== num || e.boss) continue;
      const nest = packs.get(e.pack)?.nest?.split(':')[1] ?? '?';
      let tr = tracks.get(eid);
      if (!tr) tracks.set(eid, (tr = { nest, type: e.type, pts: [], walled: 0, stuck: 0, dist: 0 }));
      const x = Position.x[eid], y = Position.y[eid], last = tr.pts[tr.pts.length - 1];
      const moved = last ? Math.hypot(x - last[0], y - last[1]) : 0;
      tr.dist += moved;
      const r = terrainRadius(server.getShips().get(eid)?.derived.radius ?? 60);
      if (insideTerrain(rock, x, y, r + 80)) { tr.walled++; if (last && moved < 60) tr.stuck++; }
      tr.pts.push([x, y]);
    }
  }
  return { tracks, rock };
}

/** The den's ghosts over `ticks` (nobody there): each live slot ship's place every GHOST_STEP */
export function ghostTracks(ticks: number): { tracks: Map<string, Track>; rock: Terrain | null } {
  const { server, num, rock } = denWorld();
  const pops = ((server.enemies as any).populations() as Map<number, any[]>).get(num) ?? [];
  const tracks = new Map<string, Track>();
  for (let t = 0; t < ticks; t += 300) {
    for (const pop of pops) {
      pop.slots.forEach((slot: { group: number; alive: number }, i: number) => {
        const g = pop.sp.def.groups[slot.group];
        if (!g) return;
        const c = ghostCentre(pop.sys, pop.sysId, pop.sp, i, slotStyle(pop.sp, slot.group), t, pop.lure);
        g.ships.forEach((type: string, k: number) => {
          const key = `${pop.sp.def.id}:${i}:${k}`, at = ghostShip(c, k);
          let tr = tracks.get(key);
          if (!tr) tracks.set(key, (tr = { nest: pop.sp.def.id, type, pts: [], walled: 0, stuck: 0, dist: 0 }));
          const last = tr.pts[tr.pts.length - 1];
          if (last) tr.dist += Math.hypot(at.x - last[0], at.y - last[1]);
          if (insideTerrain(rock, at.x, at.y, 60)) tr.walled++;
          tr.pts.push([at.x, at.y]);
        });
      });
    }
  }
  return { tracks, rock };
}

/** Per heap: ships, chamber shares, mean flown, walled/stuck shares, pack spread (mean distance from the heap's centroid) */
export function summarise(tracks: Iterable<Track>, rock: Terrain | null) {
  const by = new Map<string, Track[]>();
  for (const t of tracks) by.set(t.nest, [...(by.get(t.nest) ?? []), t]);
  const out: Record<string, { ships: number; areas: Record<string, number>; flown: number; walled: number; stuck: number; spread: number; cells: number }> = {};
  for (const [nest, ts] of [...by].sort()) {
    const areas: Record<string, number> = {};
    let n = 0, walled = 0, stuck = 0, spread = 0, sn = 0;
    const cells = new Set<string>();
    for (const t of ts) {
      walled += t.walled; stuck += t.stuck; n += t.pts.length;
      for (const [x, y] of t.pts) { const a = areaOf(rock, x, y); areas[a] = (areas[a] ?? 0) + 1; cells.add(`${Math.floor(x / 1000)},${Math.floor(y / 1000)}`); }
    }
    const len = Math.min(...ts.map((t) => t.pts.length));
    for (let i = 0; i < len; i++) {
      const cx = ts.reduce((s, t) => s + t.pts[i][0], 0) / ts.length, cy = ts.reduce((s, t) => s + t.pts[i][1], 0) / ts.length;
      for (const t of ts) { spread += Math.hypot(t.pts[i][0] - cx, t.pts[i][1] - cy); sn++; }
    }
    for (const k of Object.keys(areas)) areas[k] = Math.round((areas[k] / n) * 100);
    out[nest] = { ships: ts.length, areas, flown: Math.round(ts.reduce((s, t) => s + t.dist, 0) / ts.length), walled: Math.round((walled / n) * 100), stuck: Math.round((stuck / n) * 100), spread: Math.round(spread / Math.max(1, sn)), cells: cells.size };
  }
  return out;
}

// ---- Plots: the rock as it is, each ship's track coloured by its heap ----

const COLOURS: Record<string, [number, number, number]> = {
  nest_gullet: [255, 200, 60], nest_sorting: [90, 200, 255], nest_smelter: [255, 110, 70], nest_gallery: [200, 120, 255],
  nest_rim_w: [120, 255, 140], nest_rim_n: [255, 120, 200], nest_seam: [240, 240, 240],
};

function plot(tracks: Iterable<Track>, rock: Terrain | null, title: string): { w: number; h: number; px: Uint8Array } {
  const W = 640, S = W / 60000, px = new Uint8Array(W * W * 4);
  const set = (i: number, j: number, c: readonly number[], a = 1) => {
    if (i < 0 || j < 0 || i >= W || j >= W) return;
    const o = (j * W + i) * 4;
    for (let k = 0; k < 3; k++) px[o + k] = Math.round(px[o + k] * (1 - a) + c[k] * a);
    px[o + 3] = 255;
  };
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const x = (i - W / 2) / S, y = (j - W / 2) / S;
    set(i, j, Math.hypot(x, y) > 29000 ? [4, 4, 6] : insideTerrain(rock, x, y) ? [70, 60, 56] : [14, 15, 22]);
  }
  for (const ch of Object.values(CHAMBERS)) for (let a = 0; a < 720; a++) set(Math.round(ch.c[0] * S + W / 2 + Math.cos(a / 114.6) * ch.r * S), Math.round(ch.c[1] * S + W / 2 + Math.sin(a / 114.6) * ch.r * S), [110, 110, 130], 0.5);
  for (const t of tracks) {
    const c = COLOURS[t.nest] ?? [200, 200, 200];
    for (let n = 1; n < t.pts.length; n++) {
      const [x0, y0] = t.pts[n - 1], [x1, y1] = t.pts[n], steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * S));
      for (let s = 0; s <= steps; s++) set(Math.round((x0 + ((x1 - x0) * s) / steps) * S + W / 2), Math.round((y0 + ((y1 - y0) * s) / steps) * S + W / 2), c, 0.35);
    }
    const [lx, ly] = t.pts[t.pts.length - 1] ?? [0, 0];
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) set(Math.round(lx * S + W / 2) + di, Math.round(ly * S + W / 2) + dj, c);
  }
  void title;
  return { w: W, h: W, px };
}

function png(w: number, h: number, px: Uint8Array): Buffer {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let j = 0; j < h; j++) Buffer.from(px.buffer, j * w * 4, w * 4).copy(raw, j * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1]?.endsWith('nestRoam.ts')) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const ticks = Math.round(Number(arg('--minutes') ?? 5) * 3600), out = arg('--png'), tag = arg('--tag') ?? 'now';
  const cases: [string, () => { tracks: Map<unknown, Track>; rock: Terrain | null }][] = [
    ['ghosts', () => ghostTracks(ticks)],
    ['landing', () => liveTracks(0, 26500, ticks)],
    ['den', () => liveTracks(0, 12500, ticks)],
  ];
  for (const [name, run] of cases) {
    const { tracks, rock } = run();
    console.log(`\n== ${name} (${ticks / 3600} min): ${tracks.size} ships`);
    for (const [nest, s] of Object.entries(summarise(tracks.values(), rock))) console.log(`${nest.padEnd(13)} ships ${String(s.ships).padStart(2)}  flown ${String(s.flown).padStart(6)}  walled ${String(s.walled).padStart(3)}%  stuck ${String(s.stuck).padStart(3)}%  spread ${String(s.spread).padStart(5)}  cells ${String(s.cells).padStart(3)}  ${JSON.stringify(s.areas)}`);
    if (out) { mkdirSync(out, { recursive: true }); const p = plot(tracks.values(), rock, name); writeFileSync(join(out, `${name}-${tag}.png`), png(p.w, p.h, p.px)); }
  }
}
