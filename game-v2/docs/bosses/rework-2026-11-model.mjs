// Fight-length model for the boss rework (docs/bosses/rework-2026-11.md section 3). Run: node docs/bosses/rework-2026-11-model.mjs
// Env overrides: OUT (outside-window multiplier), CAP (Pyreclast stage 1-2 cap), P1-P3 (Pyreclast stage HP).
const MUL_OUT = +process.env.OUT || 0.35, MUL_WIN = 2.0, CRACK = 0.10;
function stageTime(hp, s, pilots) {
  // s: { moves: [{tell, active, win, cap, gap}], dpsMove, dpsWin } per pilot landed raw DPS
  let dealt = 0, t = 0, loops = 0;
  const per = [];
  for (const m of s.moves) {
    const outT = m.tell + m.active + m.gap;
    const out = outT * s.dpsMove * pilots * MUL_OUT;
    const rate = s.dpsWin * pilots * MUL_WIN;
    const fillT = m.cap / rate;
    let win;
    if (fillT >= m.win) win = rate * m.win; else win = m.cap * (1 + CRACK) + (m.win - fillT) * s.dpsWin * pilots * MUL_OUT;
    per.push({ out, win, T: outT + m.win, fill: Math.min(1, rate * m.win / m.cap) });
  }
  const loopD = per.reduce((a, p) => a + p.out + p.win, 0), loopT = per.reduce((a, p) => a + p.T, 0);
  return { secs: hp / loopD * loopT, loopD, loopT, fill: per.map((p) => p.fill.toFixed(2)) };
}
function fight(name, b, who) {
  for (const [label, s] of Object.entries(who)) {
    const row = [];
    for (const n of [1, 2, 3, 4]) {
      let t = b.overhead;
      const fills = [];
      b.stages.forEach((st, i) => { const r = stageTime(st.hp, { ...s, moves: st.moves }, n); t += r.secs; if (n === 1) fills.push(r.fill.join('/') + ` loop ${r.loopT}s ${Math.round(r.loopD)}`); });
      row.push(`${n}p ${(t / 60).toFixed(1)} min`);
      if (n === 1) console.log(name, label, 'solo fills', fills.join(' | '));
    }
    console.log(' ', name, label, row.join(', '));
  }
}
// ---- Scrap Mother: starter (2 Pips, 112 raw); armour 1 -> pen 0.775, resist ~0.95
const pip = 112 * 0.775 * 0.95;
const mm = (cap) => ({ tell: 1, active: 5, win: 7, cap, gap: 2 });
const M = { overhead: 6 + 2 * 8, stages: [
  { hp: 6000, moves: [mm(1400), mm(1400), mm(1400)] },
  { hp: 8000, moves: [mm(1400), mm(1400), mm(1400)] },
  { hp: 6000, moves: [mm(1400), mm(1400), mm(1400)] },
] };
fight('Mother', M, { starter: { dpsMove: pip * 0.5 * 0.6, dpsWin: pip * 0.85 * 0.95 } });
// ---- Pyreclast: level-30 ship 260 raw sustained. Body armour 3.
const R = 260;
const off = { dpsMove: R * 0.775 * 0.45 * 0.45, dpsWin: R * 0.775 * 0.8 * 0.95, vent: R * 0.775 * 0.65 * 0.95 };
const meta = { dpsMove: R * 1.075 * 0.5 * 0.6, dpsWin: R * 1.075 * 0.85 * 0.95 * 1.1, vent: R * 1.075 * 0.85 * 0.95 * 1.1 };
const pm = (cap, win = 7) => ({ tell: 1.2, active: 6, win, cap, gap: 2 });
const capP = +process.env.CAP || 5200;
const P = { overhead: 8 + 2 * 10, stages: [
  { hp: +process.env.P1 || 23400, moves: [pm(capP), pm(capP), pm(capP)] },
  { hp: +process.env.P2 || 31200, moves: [pm(capP), pm(capP), pm(capP)] },
  { hp: +process.env.P3 || 23400, moves: [pm(capP * 0.7, 5), pm(capP * 0.7, 5), pm(capP * 0.7, 5), pm(capP * 1.6, 10)] },
] };
fight('Pyreclast', P, { offMeta: off, meta });
