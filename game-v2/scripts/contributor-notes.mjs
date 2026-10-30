#!/usr/bin/env node
/**
 * Contributor notes from the live server, printed for whoever implements them
 * (docs/contributor-notes.md). Run from game-v2/:
 *
 *   node scripts/contributor-notes.mjs [--author brotherk3d] [--system sol] [--status open|done|wontdo|all] [--json]
 *   node scripts/contributor-notes.mjs --mark-done <id> [--note "what was done"]
 *   node scripts/contributor-notes.mjs --mark-wontdo <id> [--note "why not"]
 *   node scripts/contributor-notes.mjs --reopen <id>
 *
 * Reads /opt/spacegame/data/contributor/notes.json (and clock.json, for where
 * orbiting notes are right now) over ssh, as the deploy does:
 * root@brotherk3d.com with ~/.ssh/bk3d_deploy (DEPLOY_HOST, DEPLOY_KEY and
 * CONTRIB_REMOTE_DIR override them). Nothing is served over HTTP.
 *
 *   --local [dir]   read a local data/contributor folder instead (default: game-v2/data/contributor)
 *   --file <path>   read a notes.json file (a sample, a copy); no clock: positions at --tick or 0
 *   --tick <n>      the server tick to work out positions at (default: from clock.json)
 *   --author        matches case-insensitively; --status defaults to open
 *
 * Output is sorted by author, then system: each note's author, system, title
 * and full text, its shape with sizes in world units, how it moves (orbit
 * radius about what, period, phase, or the body it's attached to), its
 * position now, status and dates. --json prints the same notes as JSON with
 * `positionNow` added.
 *
 * Marking a note leaves an op in the server's data/contributor/inbox/; the
 * server applies it within a few seconds (or at its next start) and tells
 * contributors with the overlay on. Needs common built (npm run build:common).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.DEPLOY_HOST || 'root@brotherk3d.com';
const KEY = process.env.DEPLOY_KEY || join(homedir(), '.ssh', 'bk3d_deploy');
const REMOTE = process.env.CONTRIB_REMOTE_DIR || '/opt/spacegame/data/contributor';
const TICK_RATE = 60;
/** A clock older than this: the server may have stopped (or restarted, which puts the tick back to 0) */
const STALE_MS = 2 * 60_000;

function parseArgs(argv) {
  const a = { status: 'open' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) fail(`${k} needs a value`); return v; };
    switch (k) {
      case '--author': a.author = next(); break;
      case '--system': a.system = next(); break;
      case '--status': a.status = next(); break;
      case '--json': a.json = true; break;
      case '--tick': a.tick = Number(next()); break;
      case '--file': a.file = next(); break;
      case '--local': a.local = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : join(ROOT, 'data', 'contributor'); break;
      case '--mark-done': a.mark = { id: next(), status: 'done' }; break;
      case '--mark-wontdo': a.mark = { id: next(), status: 'wontdo' }; break;
      case '--reopen': a.mark = { id: next(), status: 'open' }; break;
      case '--note': a.note = next(); break;
      case '-h': case '--help': a.help = true; break;
      default: fail(`Unknown option ${k} (--help)`);
    }
  }
  if (!['open', 'done', 'wontdo', 'all'].includes(a.status)) fail('--status is open, done, wontdo or all');
  return a;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function ssh(command, input) {
  return execFileSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, command], { input, encoding: 'utf-8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
}

/** notes.json and clock.json, from wherever they're kept */
function load(a) {
  if (a.file) return { notes: JSON.parse(readFileSync(a.file, 'utf-8')), clock: null, where: a.file };
  if (a.local) {
    const read = (f) => (existsSync(join(a.local, f)) ? JSON.parse(readFileSync(join(a.local, f), 'utf-8')) : null);
    return { notes: read('notes.json') ?? { notes: [] }, clock: read('clock.json'), where: a.local };
  }
  const MARK = '---contributor-clock---';
  const out = ssh(`cat ${REMOTE}/notes.json 2>/dev/null || echo '{"notes":[]}'; echo '${MARK}'; cat ${REMOTE}/clock.json 2>/dev/null || echo null`);
  const [notes, clock] = out.split(MARK);
  return { notes: JSON.parse(notes), clock: JSON.parse(clock.trim() || 'null'), where: `${HOST}:${REMOTE}` };
}

/** The tick now, from the server's last clock (and a word on how sure that is) */
function tickNow(a, clock) {
  if (Number.isFinite(a.tick)) return { tick: a.tick, note: 'given with --tick' };
  if (!clock || !Number.isFinite(clock.tick)) return { tick: 0, note: 'no server clock: tick 0, where everything starts' };
  const age = Date.now() - clock.at;
  const tick = Math.round(clock.tick + (Math.max(0, age) / 1000) * (clock.tickRate || TICK_RATE));
  const at = new Date(clock.at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return { tick, note: age > STALE_MS ? `the server's clock is ${Math.round(age / 60_000)} min old (${at}): it may be down or restarted, so positions are a guess` : `server clock ${at}, ${Math.round(age / 1000)} s ago` };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, '')); return; }
  const lib = join(ROOT, 'common', 'dist', 'world', 'contributorNotes.js');
  if (!existsSync(lib)) fail('Build common first: npm run build:common');
  const { filterNotes, formatNotes, noteAnchorPosition } = await import(pathToFileURL(lib).href);

  const { notes: file, clock, where } = load(a);
  const notes = Array.isArray(file?.notes) ? file.notes : [];

  if (a.mark) {
    const n = notes.find((x) => x.id === a.mark.id);
    if (!n) fail(`No note ${a.mark.id} in ${where}`);
    const op = { op: 'status', id: n.id, status: a.mark.status, resolution: a.note ?? '', by: 'terminal' };
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const json = JSON.stringify(op);
    if (a.file) fail('--mark-* needs the server (or --local), not --file');
    if (a.local) {
      // (Written beside it then renamed: the server only picks up whole .json files)
      mkdirSync(join(a.local, 'inbox'), { recursive: true });
      writeFileSync(join(a.local, 'inbox', `${name}.tmp`), json);
      renameSync(join(a.local, 'inbox', `${name}.tmp`), join(a.local, 'inbox', name));
    } else {
      ssh(`mkdir -p ${REMOTE}/inbox && cat > ${REMOTE}/inbox/${name}.tmp && mv ${REMOTE}/inbox/${name}.tmp ${REMOTE}/inbox/${name} && (chown -R spacegame:spacegame ${REMOTE}/inbox 2>/dev/null || true)`, json);
    }
    console.log(`Queued: ${n.id} "${n.title}" (by ${n.author}) -> ${a.mark.status}${a.note ? ` (${a.note})` : ''}. The server applies it within a few seconds.`);
    return;
  }

  const systems = JSON.parse(readFileSync(join(ROOT, 'data', 'systems.json'), 'utf-8')).systems;
  const stations = JSON.parse(readFileSync(join(ROOT, 'data', 'stations.json'), 'utf-8')).stations;
  const bodiesOf = (id) => {
    const s = systems.find((x) => x.id === id);
    return s ? { name: s.name, planets: s.planets, nests: s.nests, lodestones: s.lodestones, stations: stations.filter((st) => st.system === id) } : null;
  };
  const { tick, note } = tickNow(a, clock);
  const list = filterNotes(notes, { author: a.author, system: a.system, status: a.status });
  if (a.json) {
    console.log(JSON.stringify({ tick, source: where, notes: list.map((n) => ({ ...n, positionNow: noteAnchorPosition(n.anchor, bodiesOf(n.system) ?? {}, tick) })) }, null, 2));
    return;
  }
  const what = [a.author && `author ${a.author}`, a.system && `system ${a.system}`, `status ${a.status}`].filter(Boolean).join(', ');
  console.log(`Contributor notes from ${where} (${what}; ${notes.length} in all)\n`);
  const out = formatNotes(list, { bodiesOf, tick, tickNote: note });
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
}

main().catch((e) => fail(e?.message ?? String(e)));
