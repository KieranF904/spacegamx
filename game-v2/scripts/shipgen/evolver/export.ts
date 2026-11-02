// The parts catalogue the evolver scores with, in the game's own numbers: partStats (HP, armour, mass, damage, power,
// thrust, cargo, shield), partPower (what it makes, holds, gives and uses in the power core) and the recipe value
// (credits). The parts are the player's: the models (fixed named modules: weapons, engines, power, shields) as they
// are, and the structure (core, hull, armour, cargo) on the box pieces in the five standard materials (Mk I-V). The
// legacy functions the models replace are left out. Nothing here is made up: change the game's data and run this again.
//   node --import <tsx loader> scripts/shipgen/evolver/export.ts   ->  scripts/shipgen/evolver/catalogue.json
import { writeFileSync } from 'fs';
import { join } from 'path';
import { partStats } from '../../../common/src/ships/index';
import { partItemId } from '../../../common/src/econ/index';
import { loadContext } from '../core/context';
import { partPower } from '../core/partPower';

const PIECES: Record<string, [number, number]> = { sq: [1, 1], rect2: [2, 1], block2: [2, 2], block3: [3, 3] };
const MATERIALS = ['alloy', 'steel', 'titanium', 'cobalt', 'neutronium'];
const STRUCTURE = new Set(['core', 'hull', 'armor', 'cargo']);
const MODEL_CATEGORIES = new Set(['power', 'engines', 'weapons', 'shields']);

const ctx = loadContext();
const parts: Record<string, unknown>[] = [];
const skipped: string[] = [];
// (A piece's size from its cells, and whether it fills that box: round and wedge pieces don't)
const box = (piece: string) => {
  const cells = ctx.catalog.variants.get(piece)?.[0]?.cells ?? [];
  const w = Math.max(...cells.map((c) => c[0])) + 1, h = Math.max(...cells.map((c) => c[1])) + 1;
  return { w, h, full: cells.length === w * h };
};
for (const fn of ctx.catalog.functions.values()) {
  const f = fn as typeof fn & { model?: unknown; material?: string; family?: string; pool?: string; loss?: number };
  const model = !!f.model && MODEL_CATEGORIES.has(fn.category ?? '');
  if (!model && !STRUCTURE.has(fn.id)) { skipped.push(`${fn.id} (${f.model ? fn.category : 'legacy or not a player part'})`); continue; }
  const pieces = model ? (fn.pieces as string[]) : fn.pieces === '*' ? Object.keys(PIECES) : (fn.pieces as string[]).filter((p) => p in PIECES);
  for (const piece of pieces) {
    for (const material of model ? [f.material ?? 'alloy'] : MATERIALS) {
      const st = partStats(ctx.catalog, ctx.tuning, { fn: fn.id, piece, material });
      if (!st) continue;
      let cost: number | null = null;
      try { cost = ctx.econ ? Math.round(ctx.econ.recipes.partValue(partItemId({ fn: fn.id, piece, material }), ctx.econ.items) * 10) / 10 : null; } catch { /* (no recipe) */ }
      let pw: ReturnType<typeof partPower> | null = null;
      try { pw = partPower(ctx, fn, piece, material); } catch { /* (not in the power core) */ }
      const { w, h, full } = box(piece);
      parts.push({
        id: model ? fn.id : `${fn.id}:${piece}:${material}`, fn: fn.id, name: fn.name, family: f.family ?? fn.id, model, category: fn.category,
        piece, w, h, full, material, grade: st.grade, mark: st.mark,
        hp: Math.round(st.hp * 10) / 10, armour: st.armour, resist: st.resist ?? {}, mass: Math.round(st.mass * 100) / 100, cost,
        carriesFlow: !!fn.carriesFlow, pool: f.pool ?? null, loss: f.loss ?? null,
        power: pw ? { role: pw.role, makes: pw.makes ?? 0, holds: pw.holds ?? 0, gives: pw.gives ?? 0, takes: pw.takes ?? 0, uses: pw.uses ?? 0, boostUses: pw.boostUses ?? 0, gun: pw.gun ?? null } : null,
        dps: st.dps ?? 0, range: st.range ?? 0, damageType: st.damageType ?? null, pen: st.pen ?? null,
        supply: st.supply ?? 0, draw: st.draw ?? 0, thrust: st.thrust ?? 0, cargo: st.cargo ?? 0, shield: st.shield ?? 0,
      });
    }
  }
}
const out = join(__dirname, 'catalogue.json');
// (Damage × this at each step of (weapon pen − block armour): tuning.json damage.penetration, as damage.ts reads it)
const penetration = (ctx.tuning as { damage?: { penetration?: Record<string, number> } }).damage?.penetration ?? {};
writeFileSync(out, JSON.stringify({ made: new Date().toISOString(), materials: MATERIALS, penetration, skipped, parts }, null, 1));
console.log(`${parts.length} parts -> ${out}`);
console.log(`skipped: ${skipped.join(', ')}`);
