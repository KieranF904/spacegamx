// Weapon firing effect strips and frame times off the dev stage (client/src/dev/fxStage.ts), in a tab of the render
// daemon's Chrome. Needs the client's Vite server (:5273).
//   node scripts/fx-shots/strips.mjs <outDir> [bench]
//   node scripts/fx-shots/strips.mjs <outDir> close <zoom> <frames,comma,separated> <model...>   (a closer look: <model>-close.png)
//   node scripts/fx-shots/strips.mjs <outDir> mods <zoom> <frames,comma,separated> <effects> <model...>   (weapon modifier layers: <effects> as
//                                       velocity:1,burn:0.3 or none, several separated by / stacked as rows; <zoom> as 1.5 or 1.5@150
//                                       (the wall stood 150 from the muzzle); writes <model>-<effects>.png, or <model>-$FX_NAME.png)
//   node scripts/fx-shots/strips.mjs <outDir> charge   (the charge tells: charge-<look>.png)
//   node scripts/fx-shots/strips.mjs <outDir> flak     (only the flak bursts)
//   node scripts/fx-shots/strips.mjs <outDir> blast <model> <kind> <radius> <view> <frames,comma,separated>   (any detonation: <model>-blast.png)
// Writes <outDir>/<model>.png (four frames of the first shot, left to right), <outDir>/<model>-burst.png for the flak
// models' bursts, and with `bench` <outDir>/bench.json.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { daemonUrl } from '../render/daemonClient.mjs';

const [outDir, mode] = process.argv.slice(2);
if (!outDir) { console.error('usage: strips.mjs <outDir> [bench]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
export const GUNS = [
  'cannon_pip', 'cannon_hammer', 'cannon_twinlink', 'cannon_longbarrel', 'cannon_bastion', 'cannon_slurry', 'cannon_mauler',
  'autocannon_rattler', 'autocannon_chainsaw', 'autocannon_stinger', 'flak_burst', 'flak_cloudmaker',
  'mortar_lobber', 'mortar_quake', 'missile_dart', 'missile_swarm', 'missile_hammerhead', 'torpedo_eel', 'torpedo_leviathan',
  'railgun_needle', 'railgun_coilgun', 'railgun_spear', 'railgun_rail_driver', 'emp_hush', 'emp_blackout', 'arc_spark', 'arc_tesla',
  'legendary_hive', 'legendary_frostbite', 'legendary_cinder_bloom', 'legendary_prism', 'legendary_phase', 'legendary_singularity',
  'utility_demolition_launcher',
];
const FLAK = ['flak_burst', 'flak_cloudmaker'];
const BENCH = ['cannon_pip', 'cannon_bastion', 'autocannon_chainsaw', 'railgun_needle', 'railgun_spear', 'missile_swarm', 'flak_burst', 'legendary_singularity'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = await daemonUrl();
const tab = await (await fetch(`${base}/tab`)).json();
let returned = false;
const giveBack = async () => { if (returned) return; returned = true; try { await fetch(`${base}/tab/close?id=${tab.id}`); } catch {} };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => giveBack().finally(() => process.exit(1)));
process.on('uncaughtException', (e) => { console.error(e); giveBack().finally(() => process.exit(1)); });
const ws = new WebSocket(tab.ws);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.error('EXC', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:5273/viewer.html?ui=0' });
  await sleep(5000);
  // (the viewer's own page is only a host for the modules: cleared, and deaf to hot reloads while this runs)
  await run("(() => { document.body.innerHTML = ''; return 1; })()");
  const stage = "import('/src/dev/fxStage.ts')";
  const save = (name, url) => writeFileSync(join(outDir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  if (mode === 'bench') {
    const out = {};
    for (const g of BENCH) {
      out[g] = { firing: await run(`${stage}.then((m) => m.bench('${g}', false))`), withHits: await run(`${stage}.then((m) => m.bench('${g}', true))`) };
      console.log(g, JSON.stringify(out[g]));
    }
    for (const g of FLAK) { out[`${g}-burst`] = await run(`${stage}.then((m) => m.benchFlak('${g}'))`); console.log(g, 'burst', JSON.stringify(out[`${g}-burst`])); }
    writeFileSync(join(outDir, 'bench.json'), JSON.stringify(out, null, 1));
  } else if (mode === 'close') {
    const [zoom, at, ...ids] = process.argv.slice(4);
    for (const g of ids) {
      try { save(`${g}-close`, await run(`${stage}.then((m) => m.gun('${g}', [${at}], ${Number(zoom)}))`)); console.log(g); } catch (e) { console.error(g, 'FAILED', e.message.split('\n')[0]); }
    }
  } else if (mode === 'mods') {
    const [zoom, at, spec, ...ids] = process.argv.slice(4);
    if (!/^[a-z0-9:.,/]*$/.test(spec)) throw new Error('effects are names with strengths: velocity:1,burn:0.3');
    const tag = process.env.FX_NAME || spec.replace(/:/g, '').replace(/,/g, '+').replaceAll('/', '_') || 'none';
    const [z, wall] = zoom.split('@').map(Number);
    for (const g of ids) {
      try { save(`${g}-${tag}`, await run(`${stage}.then((m) => m.modSheet('${g}', '${spec}'.split('/'), [${at}], ${z}, 7, ${wall || 150}))`)); console.log(g, tag); } catch (e) { console.error(g, tag, 'FAILED', e.message.split('\n')[0]); }
    }
  } else if (mode === 'flak') {
    for (const g of FLAK) { save(`${g}-burst`, await run(`${stage}.then((m) => m.flak('${g}'))`)); console.log(g, 'burst'); }
  } else if (mode === 'blast') {
    const [g, kind, radius, view, at] = process.argv.slice(4);
    save(`${g}-blast`, await run(`${stage}.then((m) => m.blast('${g}', '${kind}', ${Number(radius)}, [${at}], 7, ${Number(view)}))`)); console.log(g, 'blast');
  } else if (mode === 'charge') {
    for (const look of ['dot', 'sight', 'blackout']) { save(`charge-${look}`, await run(`${stage}.then((m) => m.charge('${look}'))`)); console.log('charge', look); }
  } else {
    for (const g of GUNS) {
      try { save(g, await run(`${stage}.then((m) => m.gun('${g}'))`)); console.log(g); } catch (e) { console.error(g, 'FAILED', e.message.split('\n')[0]); }
    }
    for (const g of FLAK) { save(`${g}-burst`, await run(`${stage}.then((m) => m.flak('${g}'))`)); console.log(g, 'burst'); }
  }
} finally {
  ws.close();
  await giveBack();
}
process.exit(0);
