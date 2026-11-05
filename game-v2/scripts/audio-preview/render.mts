/**
 * Offline audio previews, no browser: each system's music (and the situations: an area change, docked, a boss's
 * arena and fight, combat), rendered by the game's own MusicEngine, and a board of the weapon sounds as the game
 * prepares them (AudioManager.prepare: trimmed, loudness matched, low-passed, pitched). Writes WAVs.
 *
 *   npm i --no-save node-web-audio-api        (once: a Web Audio implementation for Node)
 *   server/node_modules/.bin/tsx scripts/audio-preview/render.mts [out dir] [only ids...]
 *
 * Default out dir: docs/panels/<today>/audio (WAVs there stay local: .gitignore).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MusicEngine } from '../../client/src/audio/MusicEngine';
import type { MusicPlace } from '../../client/src/audio/musicProfiles';
import { prepare, FILE_GAIN, FILE_LOWPASS, FILE_PITCH } from '../../client/src/audio/AudioManager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WA: any;
try {
  WA = await import('node-web-audio-api');
} catch {
  console.error('needs node-web-audio-api: npm i --no-save node-web-audio-api');
  process.exit(1);
}
const { OfflineAudioContext } = WA;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('-') ? args[0] : join(root, 'docs/panels', new Date().toISOString().slice(0, 10), 'audio');
const only = new Set(args.slice(1));
mkdirSync(out, { recursive: true });
const SR = 44100;

/** A scene: what plays when (seconds), as the game would set it */
interface Scene { id: string; seconds: number; events: { at: number; place?: MusicPlace; combat?: number; dread?: number }[] }

const scene = (id: string, seconds: number, events: Scene['events']): Scene => ({ id, seconds, events });
const SCENES: Scene[] = [
  ...['sol', 'ashfall', 'borealis', 'nebula_prime', 'void_sector', 'cinder_reach', 'the_maw', 'glasswater'].map((s) => scene(`system_${s}`, 26, [{ at: 0, place: { system: s } }])),
  scene('area_sol_inner_to_smugglers_lanes', 32, [{ at: 0, place: { system: 'sol', region: 'inner' } }, { at: 12, place: { system: 'sol', region: 'middle', zone: 'lanes' } }]),
  scene('area_sol_to_terra_nova_orbit', 28, [{ at: 0, place: { system: 'sol', region: 'inner' } }, { at: 10, place: { system: 'sol', region: 'inner', planet: 'terra_nova' } }]),
  scene('situation_sol_docked', 20, [{ at: 0, place: { system: 'sol', region: 'inner', docked: true } }]),
  scene('situation_cinder_reach_combat', 28, [{ at: 0, place: { system: 'cinder_reach' } }, ...Array.from({ length: 30 }, (_, i) => ({ at: 8 + i * 0.5, combat: 1 }))]),
  scene('boss_scrap_mother_arena_then_fight', 34, [{ at: 0, place: { system: 'sol_scrap_nest', arena: 'boss_scrap_mother' }, dread: 1 }, { at: 12, place: { system: 'sol_scrap_nest', arena: 'boss_scrap_mother', boss: 'boss_scrap_mother' } }, ...Array.from({ length: 30 }, (_, i) => ({ at: 14 + i * 0.6, combat: 1 }))]),
  scene('boss_pyreclast_arena_then_fight', 34, [{ at: 0, place: { system: 'ashfall_cavern', arena: 'boss_pyreclast' }, dread: 1 }, { at: 12, place: { system: 'ashfall_cavern', arena: 'boss_pyreclast', boss: 'boss_pyreclast' } }, ...Array.from({ length: 30 }, (_, i) => ({ at: 14 + i * 0.6, combat: 1 }))]),
  scene('boss_heart_of_the_maw_fight', 30, [{ at: 0, place: { system: 'the_maw' }, dread: 0.5 }, { at: 8, place: { system: 'the_maw', boss: 'boss_maw_heart' } }, ...Array.from({ length: 30 }, (_, i) => ({ at: 10 + i * 0.6, combat: 1 }))]),
];

function wav(path: string, chans: Float32Array[]): void {
  const n = chans[0].length, c = chans.length;
  const buf = Buffer.alloc(44 + n * c * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * c * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(c, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * c * 2, 28); buf.writeUInt16LE(c * 2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * c * 2, 40);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < c; ch++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, chans[ch][i])) * 32767), 44 + (i * c + ch) * 2);
  writeFileSync(path, buf);
}

/** The game's master chain: music bus (at the default music volume) into a compressor */
function master(ctx: InstanceType<typeof OfflineAudioContext>, volume: number): AudioNode {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.connect(ctx.destination);
  const g = ctx.createGain();
  g.gain.value = volume;
  g.connect(comp);
  return g;
}

async function renderScene(s: Scene): Promise<void> {
  const ctx = new OfflineAudioContext(2, SR * s.seconds, SR);
  let now = 0;
  const music = new MusicEngine(ctx as unknown as BaseAudioContext, master(ctx, 0.5 * 1.6), { clock: () => now });
  const events = [...s.events].sort((a, b) => a.at - b.at);
  const apply = (e: Scene['events'][number]) => {
    if (e.place) music.setPlace(e.place);
    if (e.combat !== undefined) music.setCombat(e.combat);
    if (e.dread !== undefined) music.setDread(e.dread);
  };
  while (events.length && events[0].at <= 0) apply(events.shift()!);
  music.startManual();
  for (now = 0; now < s.seconds; now += 0.25) {
    while (events.length && events[0].at <= now) apply(events.shift()!);
    music.pump();
  }
  const b = await ctx.startRendering();
  // A short fade out at the end
  const chans = [b.getChannelData(0), b.getChannelData(1)];
  const f = SR * 1.5;
  for (const d of chans) for (let i = 0; i < f; i++) d[d.length - 1 - i] *= i / f;
  wav(join(out, `${s.id}.wav`), chans);
  console.log(`ok ${s.id}.wav`);
}

/** The weapon board: each weapon's sound as the game plays it, named in order (see weapons.txt) */
async function renderBoard(): Promise<void> {
  const sfxDir = join(root, 'client/public/sfx');
  const index = JSON.parse(readFileSync(join(sfxDir, 'index.json'), 'utf-8')) as Record<string, { variants: number; loop?: boolean }>;
  const list: [string, string, number][] = [
    // [label, sound id, repeats (rapid fire)]
    ['cannon', 'shot', 3], ['cannon turret', 'turret_shot', 3], ['autocannon', 'autocannon_shot', 6], ['pulse laser', 'pulse_shot', 4],
    ['flak', 'flak_shot', 3], ['mortar', 'mortar_shot', 2], ['railgun', 'railgun_shot', 2], ['missile', 'missile_launch', 1],
    ['torpedo', 'torpedo_launch', 1], ['mining charge', 'charge_launch', 2], ['EMP', 'emp_shot', 2], ['arc projector', 'arc_shot', 3],
    ['point defence', 'pd_shot', 5], ['hive', 'hive_launch', 1], ['cinder bloom', 'cinder_shot', 2], ['prism', 'prism_shot', 2],
    ['phase', 'phase_shot', 2], ['singularity', 'singularity_fire', 1],
    ['laser beam (Cutter, Searchlight)', 'laser_loop', 1], ['arc beam (Tesla)', 'arc_loop', 1], ['frostbite beam', 'frost_loop', 1],
    ['repair beam', 'repair_loop', 1], ['lance', 'lance_loop', 1],
    ['Scrap Mother rivets', 'rivet_shot', 4], ['Scrap Mother scrap chunk', 'scrap_chunk_shot', 2], ['Scrap Mother seam seeker', 'seeker_launch', 1],
    ['Pyreclast heart sparks', 'heart_spark', 4], ['Pyreclast heart seeker', 'heart_seeker', 1],
  ];
  const dec = new OfflineAudioContext(1, SR, SR);
  const clips: { label: string; at: number; buf: AudioBuffer; rate: number }[] = [];
  let t = 0.3;
  const lines: string[] = [];
  for (const [label, id, reps] of list) {
    const info = index[id];
    if (!info) { lines.push(`(missing) ${label}: ${id}`); continue; }
    const bufs: AudioBuffer[] = [];
    for (let v = 0; v < info.variants; v++) {
      const bytes = readFileSync(join(sfxDir, `${v ? `${id}_${v}` : id}.mp3`));
      const raw = await dec.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      bufs.push(prepare(dec as unknown as BaseAudioContext, raw, !!info.loop, FILE_GAIN[id] ?? 0.6, FILE_LOWPASS[id]));
    }
    lines.push(`${t.toFixed(1).padStart(5)} s  ${label}: ${id}${reps > 1 ? ` x${reps}` : ''}`);
    const rate = FILE_PITCH[id] ?? 1;
    const gap = info.loop ? 0 : Math.min(0.32, bufs[0].duration / rate * 0.8);
    for (let r = 0; r < reps; r++) {
      const buf = bufs[r % bufs.length];
      clips.push({ label, at: t, buf, rate: rate * (0.94 + Math.random() * 0.12) });
      t += info.loop ? Math.min(2.5, buf.duration) : gap;
    }
    t += 1.0;
  }
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * (t + 1)), SR);
  const dest = master(ctx, 0.8);
  for (const c of clips) {
    const src = ctx.createBufferSource();
    src.buffer = c.buf;
    src.playbackRate.value = c.rate;
    const g = ctx.createGain();
    g.gain.value = 0.7;
    src.connect(g).connect(dest);
    src.start(c.at);
    if (c.buf.duration > 2.5) src.stop(c.at + 2.5);
  }
  const b = await ctx.startRendering();
  wav(join(out, 'weapons_board.wav'), [b.getChannelData(0), b.getChannelData(1)]);
  writeFileSync(join(out, 'weapons_board.txt'), lines.join('\n') + '\n');
  console.log('ok weapons_board.wav (+ weapons_board.txt: what plays when)');
}

for (const s of SCENES) if (!only.size || only.has(s.id)) await renderScene(s);
if (!only.size || only.has('weapons')) await renderBoard();
