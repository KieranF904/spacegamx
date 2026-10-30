// Generate the game's sound effects with fal.ai (ElevenLabs sound effects v2).
//   node --env-file=.env scripts/gen-sfx.mjs            # only sounds that don't exist yet
//   node --env-file=.env scripts/gen-sfx.mjs shot hit   # (re)generate these
// Writes client/public/sfx/<id>.mp3 (variants <id>_1.mp3 ...) and client/public/sfx/index.json,
// which the game reads at startup; anything missing falls back to the synthesised sound.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'client/public/sfx');
const MODEL = 'fal-ai/elevenlabs/sound-effects/v2';
const key = process.env.FAL_KEY;
if (!key) { console.error('FAL_KEY is not set (put it in game-v2/.env and run with --env-file=.env)'); process.exit(1); }

const { sounds } = JSON.parse(readFileSync(join(root, 'scripts/sfx-manifest.json'), 'utf-8'));
const only = new Set(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
const file = (id, v) => (v === 0 ? `${id}.mp3` : `${id}_${v}.mp3`);

async function generate(s) {
  const res = await fetch(`https://fal.run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: s.prompt, duration_seconds: s.duration, prompt_influence: s.influence ?? 0.5, loop: !!s.loop, output_format: 'mp3_44100_128' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const url = (await res.json()).audio?.url;
  if (!url) throw new Error('no audio url in response');
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

const jobs = [];
for (const s of sounds) {
  for (let v = 0; v < (s.variants ?? 1); v++) {
    const path = join(outDir, file(s.id, v));
    if (only.size ? !only.has(s.id) : existsSync(path)) continue;
    jobs.push({ s, v, path });
  }
}
console.log(`${jobs.length} generation(s)`);
// A few at a time
let failed = 0;
for (let i = 0; i < jobs.length; i += 4) {
  await Promise.all(jobs.slice(i, i + 4).map(async ({ s, v, path }) => {
    try {
      writeFileSync(path, await generate(s));
      console.log(`ok   ${file(s.id, v)}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${file(s.id, v)}: ${e.message}`);
    }
  }));
}

// Index of what exists: id -> number of variants
const index = {};
for (const s of sounds) {
  let n = 0;
  while (existsSync(join(outDir, file(s.id, n)))) n++;
  if (n) index[s.id] = { variants: n, loop: !!s.loop };
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`index: ${Object.keys(index).length} sounds${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
