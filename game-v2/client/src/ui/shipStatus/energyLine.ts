/**
 * The ship panel's energy line (ShipHud, under the schematic), from the status record (source.ts `ShipStatus.energy`):
 * how full the stores are, which way they're going and how fast, and the one thing worth knowing now: what is short of
 * power, how long until they're empty or full, or the spare power while nothing drains them.
 */

import type { ShipStatus, Tone } from './source';

export interface EnergyLine {
  /** "ENERGY 64%", or "LOW POWER 0%" while something is short */
  head: string;
  headTone: Tone;
  /** "−38/s", "+52/s", or '' when steady */
  rate: string;
  rateTone: Tone;
  /** "engines, guns get 64%" (short of power, everything drawing on the Output gets the same share), "empty in 6 s", "full in 4 s", "+768/s spare" */
  note: string;
  noteTone: Tone;
}

const SHORT_WORDS: Record<ShipStatus['energy']['short'], string> = { '': '', engines: 'engines', guns: 'guns', 'engines+guns': 'engines, guns' };

const secs = (s: number) => (s < 10 ? `${(Math.ceil(s * 10) / 10).toFixed(1)} s` : `${Math.ceil(s)} s`);

export function energyLine(e: ShipStatus['energy'], out: EnergyLine = { head: '', headTone: 'ok', rate: '', rateTone: 'dim', note: '', noteTone: 'dim' }): EnergyLine {
  const pct = Math.max(0, Math.min(100, e.pct));
  out.head = `${e.brownout ? 'LOW POWER' : 'ENERGY'} ${Math.floor(pct)}%`;
  out.headTone = e.brownout ? 'bad' : pct < 25 && e.net < 0 ? 'warn' : 'ok';
  const r = Math.round(e.net);
  // (Full, a rise still in the smoothed rate is no news)
  out.rate = r === 0 || (r > 0 && pct >= 99.5) ? '' : `${r > 0 ? '+' : '−'}${Math.abs(r)}/s`;
  out.rateTone = r < 0 ? 'warn' : 'ok';
  if (e.brownout) {
    const words = SHORT_WORDS[e.short], p = Math.round(Math.max(0, e.share) * 100);
    out.note = words && p < 100 ? `${words} get ${p}%` : `${words || 'power'} short`;
    out.noteTone = 'bad';
  }
  else if (Number.isFinite(e.empty)) { out.note = `empty in ${secs(e.empty)}`; out.noteTone = e.empty < 5 ? 'warn' : 'busy'; }
  else if (Number.isFinite(e.full) && pct < 99.5) { out.note = `full in ${secs(e.full)}`; out.noteTone = 'dim'; }
  else { out.note = `+${Math.round(Math.max(0, e.gen - e.draw))}/s spare`; out.noteTone = 'dim'; }
  return out;
}
