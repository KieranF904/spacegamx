// Plain numbers for a weapon row: its kind's tuning with the model's weaponMods applied (the game's own moddedDef), and
// its firing model's beat. Labels and units only; nothing here decides how a weapon behaves.
import { moddedDef, weaponDef } from '../../common/src/ships/launch';
import { TICK_RATE } from '../../common/src/constants';

export interface Stat { label: string; value: string }

const n = (v: number, d = 1) => String(Math.round(v * 10 ** d) / 10 ** d);

/** `row`: a models.json / functions.json row (or `{ weapon: kind }`); `tuning`: the parsed tuning.json */
export function weaponStats(row: any, tuning: any): Stat[] {
  const base = tuning.weapons?.[row.weapon];
  if (!base) return [{ label: 'Kind', value: `${row.weapon} (not in tuning.json)` }];
  const d = moddedDef(weaponDef(tuning, row.weapon), row.weaponMods) as any;
  const fire = row.fire as any, interval: number | undefined = fire?.interval ?? row.fireInterval;
  const out: Stat[] = [{ label: 'Kind', value: `${row.weapon} (${d.type})` }];
  const add = (label: string, v: unknown, unit = '') => { if (v !== undefined && v !== null && v !== '') out.push({ label, value: `${v}${unit}` }); };
  add('Damage', d.damage !== undefined ? n(d.damage) : undefined);
  if (d.burst > 1) add('Shells per shot', d.burst);
  if (interval) add('Rate', n(TICK_RATE / interval), ' shots/s');
  if (fire) add('Firing model', fire.model + (fire.clip ? ` (clip ${fire.clip}, reload ${fire.reload} ticks)` : '') + (fire.charge ? ` (charge ${fire.charge} ticks)` : ''));
  if (d.damage !== undefined && interval) add('Damage per second', n(d.damage * (d.burst ?? 1) * TICK_RATE / interval));
  if (d.dps !== undefined) add('Beam damage', n(d.dps), ' /s');
  add('Round speed', d.speed !== undefined ? n(d.speed) : undefined, ' u/tick');
  add('Spread', d.spread, ' deg');
  if (d.speed !== undefined && d.life !== undefined) add('Range', n(d.speed * d.life, 0), ' u');
  else add('Range', d.range, ' u');
  add('Life', d.life, ' ticks');
  add('Fuse', d.fuse, ' ticks');
  if (d.splash) add('Splash', `${n(d.splash.damage)} dmg, radius ${n(d.splash.radius, 0)}`);
  if (d.emp) add('EMP', `radius ${d.emp.radius}, ${d.emp.ticks} ticks`);
  add('Piercing', d.pierce);
  add('Homing', d.homing);
  add('Power draw', row.demand, ' per cell');
  if (d.ammo) add('Ammo', `${d.ammo.item} (${d.ammo.rounds} rounds)`);
  add('Mount', row.mount);
  return out;
}
