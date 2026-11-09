#!/usr/bin/env node
// Roll the game server out to every Fly server the lobby defines, then the VPS. DRY RUN unless --apply.
//   node scripts/deploy/regions.mjs                 print the plan
//   node scripts/deploy/regions.mjs --apply         run it (needs flyctl logged in; Kieran asks for this)
//   --only <id[,id]>   just these servers      --no-vps   skip the VPS restart
//   --file <path>      server file (default data/lobby/servers.json, or $REGIONS_FILE; example deploy/fly/servers.example.json)
// The file is the lobby's own definitions (server-browser/src/regions/defs.ts). A Fly server is a "kind": "on-demand" entry
//   with "app" (its Fly app) and "flyRegion" (a Fly region code, e.g. syd); the lobby ignores both. Always-on ones (the VPS) are skipped.
// Builds once (into the first app's registry), then every other app deploys that same image.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const apply = flag('--apply');
const file = resolve(root, opt('--file') ?? process.env.REGIONS_FILE ?? 'data/lobby/servers.json');
const only = opt('--only')?.split(',');

const doc = JSON.parse(readFileSync(file, 'utf8'));
const all = Array.isArray(doc) ? doc : doc.servers;
if (!Array.isArray(all)) throw new Error(`${file}: expected { "servers": [...] }`);
const fly = all.filter((s) => s.kind === 'on-demand' && s.app && (!only || only.includes(s.id)));
for (const s of fly) if (!s.id || !s.flyRegion) throw new Error(`${file}: a Fly server needs id, app and flyRegion (got ${JSON.stringify(s)})`);

const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'nogit';
const label = `rel-${rev}-${Date.now().toString(36)}`;
const cfg = 'deploy/fly/fly.server.toml';
// (SERVER_ID matches the lobby's definition; BUILD_ID is what its heartbeat reports, so the lobby can tell versions apart)
const envFlags = (s) => ['--env', `SERVER_ID=${s.id}`, '--env', `SERVER_REGION=${s.region ?? s.flyRegion}`, '--env', `SERVER_NAME=${s.name ?? s.id}`,
  '--env', `BUILD_ID=${rev}`, '--env', `PUBLIC_HOST=${s.host ?? `${s.app}.fly.dev`}`];

const steps = [];
if (fly.length) {
  const first = fly[0];
  steps.push(['fly', ['deploy', '--config', cfg, '--app', first.app, '--primary-region', first.flyRegion, '--image-label', label, '--ha=false', ...envFlags(first)], `build once and deploy ${first.id}`]);
  const image = `registry.fly.io/${first.app}:${label}`;
  for (const s of fly.slice(1)) steps.push(['fly', ['deploy', '--config', cfg, '--app', s.app, '--primary-region', s.flyRegion, '--image', image, '--ha=false', ...envFlags(s)], `same image to ${s.id}`]);
}
if (!flag('--no-vps')) steps.push(['bash', ['deploy/vps/deploy.sh'], 'VPS: ship the same tree and restart its server (the VPS also serves the client)']);

console.log(`${apply ? 'APPLY' : 'DRY RUN (add --apply to run)'}: ${fly.length} Fly server(s) from ${file}, image label ${label}`);
for (const [cmd, a, why] of steps) console.log(`- ${why}\n    ${cmd} ${a.join(' ')}`);
if (!apply) process.exit(0);
for (const [cmd, a, why] of steps) {
  console.log(`\n== ${why}`);
  const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`failed (${r.status}): ${cmd} ${a.join(' ')}`); process.exit(r.status || 1); }
}
