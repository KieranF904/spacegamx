// The game's validator for the evolver, as a process it keeps open: one JSON line in, one out.
//   in:  {"id": 1, "parts": [{uid, piece, fn, material, x, y, rot, flip, facing?}, ...]}
//   out: {"id": 1, "valid": bool, "errors": [{code, message, uids}], "points": build points}
// validateBlueprint is the game's own (common/src/ships/blueprint.ts): overlaps, one core, facings, mounting, every
// part joined to the core, part count. Nothing is owned-checked (inventory null).
import { createInterface } from 'readline';
import { type Blueprint, buildPoints, validateBlueprint } from '../../../common/src/ships/index';
import { loadContext } from '../core/context';

const ctx = loadContext();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let id: unknown = null;
  try {
    const req = JSON.parse(line) as { id: unknown; parts: Blueprint['parts'] };
    id = req.id;
    const bp: Blueprint = { name: 'evolved', catalogVersion: ctx.catalog.version, parts: req.parts };
    const v = validateBlueprint(ctx.catalog, bp, ctx.tuning, null, { mounting: true });
    process.stdout.write(JSON.stringify({ id, valid: v.errors.length === 0, errors: v.errors.map((e) => ({ code: e.code, message: e.message, uids: e.uids })), points: buildPoints(ctx.catalog, bp) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, valid: false, errors: [{ code: 'crash', message: String((e as Error)?.message ?? e), uids: [] }], points: 0 }) + '\n');
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
