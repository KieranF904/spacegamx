/**
 * Per-shot damage and tier of every gun against its impact's size and how long it lasts (client/src/rendering/weapons
 * ImpactLayers, measured by impactSpan), so heavy guns can be checked to read heavier and longer than light ones.
 * Held beams show their burn (BeamLook.burn: an impact every few frames). Prints a markdown table.
 *   npx vite-node scripts/balance/impact-audit.ts
 */
import { gunDef, weaponDef, type ShipTuning, type WeaponMods, WEAPON_KIND_TYPE, WeaponType } from '../../common/src/index';
import tuning from '../../data/ships/tuning.json';
import data from '../../data/ships/models.json';
import { weaponStyle, shotScale, beamLook } from '../../client/src/rendering/weapons/weaponStyles';
import { impactSpan } from '../../client/src/rendering/weapons/impactSpan';
import '../../client/src/ships/energyLooks';

type Model = { id: string; name: string; weapon?: string; weaponMods?: WeaponMods; infra?: { tier: string; damage: number } };
const models = (data as unknown as { models: Model[] }).models;
const T = tuning as unknown as ShipTuning;
const ORDER = ['simple', 'dual', 'heavy', 'super'];
const rows: { tier: string; dmg: number; line: string }[] = [];
for (const m of models) {
  if (!m.weapon || !m.infra) continue;
  const def = gunDef(T, m.weapon, { model: m.weaponMods });
  const type = WEAPON_KIND_TYPE[m.weapon];
  const beam = def.type === 'beam' || !!def.dps || !!def.pulse;
  if (beam || type === undefined) {
    const dps = Math.round((def.dps ?? 0) * m.infra.damage), burn = beamLook(m.id)?.burn;
    const sp = burn ? impactSpan({ ...weaponStyle(WeaponType.Cannon), hit: burn.hit }, 1) : null;
    rows.push({ tier: m.infra.tier, dmg: dps, line: `| ${m.name} | ${m.infra.tier} | ${def.pulse ? 'pulse' : `beam ${dps}/s`} | ${sp ? `${sp.size.toFixed(0)}, every ${burn!.every} frames` : '(its own FX)'} | ${sp ? `${(sp.frames / 60).toFixed(2)} s each` : ''} | ${sp ? sp.fragments : ''} |` });
    continue;
  }
  const dmg = (def.damage ?? weaponDef(T, m.weapon).damage ?? 0) * m.infra.damage;
  const st = weaponStyle(type, 1, m.id);
  const sp = impactSpan(st, (def.size ?? 1) * shotScale(dmg));
  // (explosives: their blast is the detonation's, DamageFx; this is only the shell's own mark)
  const blast = def.splash ? ` (+ blast ${Math.round(def.splash.radius)})` : '';
  rows.push({ tier: m.infra.tier, dmg, line: `| ${m.name} | ${m.infra.tier} | ${Math.round(dmg)} | ${sp.size.toFixed(0)}${blast} | ${(sp.frames / 60).toFixed(2)} s | ${sp.fragments} |` });
}
rows.sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.dmg - b.dmg);
console.log('| gun | tier | damage a shot | effect size (world units) | lasts | fragments |\n|---|---|---|---|---|---|\n' + rows.map((r) => r.line).join('\n'));
