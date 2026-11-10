/**
 * Port marks (portMarks.ts): each mark sits exactly where the ports core puts the port, for every rotation and flip, and
 * its glyph points out of (OUT) or into (IN) the part across that edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, placeGeometry, blueprintGeometry, SIDE_NORMAL, type PlacedPart, type Rot } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import type { ShipTuning } from '@space-game/common';
import { portMarks } from './portMarks';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const base = readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/ports-gunship.json'), 'utf-8');

/** A ports ship with `fn` stood far off to the side in the given turn; the core's own port list for it */
function corePorts(fn: string, rot: Rot, flip: boolean, pieceId: string) {
  const bp = parseBlueprint(base);
  // (the core and a block of hull joined to it, so the part stands in a live ship, with room round it)
  bp.parts = bp.parts.filter((q) => q.fn === 'core');
  const hull = (uid: number, x: number, y: number) => ({ uid, piece: 'sq', fn: 'hull', material: 'alloy', x, y, rot: 0, flip: false }) as PlacedPart;
  for (let y = 1; y <= 8; y++) bp.parts.push(hull(100 + y, 0, y));
  for (let x = 1; x <= 2; x++) for (let y = 4; y <= 8; y++) bp.parts.push(hull(200 + x * 10 + y, x, y));
  const p = { uid: 9000, piece: pieceId, fn, material: 'steel', x: 3, y: 6, rot, flip } as PlacedPart;
  bp.parts.push(p);
  const ship = createShipState(catalog, tuning, 1, bp, 0);
  const idx = ship.blueprint.parts.findIndex((q) => q.uid === 9000);
  const geom = blueprintGeometry(catalog, ship.blueprint)[idx];
  return { ports: ship.derived.ports!.ports.filter((q) => q.part === idx), geom, part: ship.blueprint.parts[idx] };
}

describe('port marks match the ports core', () => {
  const cases: [string, string][] = [['power_cell_reactor', 'sq'], ['power_splitter_bank', 'rect2'], ['power_splitter_elbow', 'rect2'], ['power_splitter_tee', 'rect2'], ['power_conduit', 'sq'], ['power_corner', 'sq']];
  for (const [fn, pc] of cases) {
    for (const flip of [false, true]) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        it(`${fn} rot ${rot}${flip ? ' flipped' : ''}`, () => {
          if (!catalog.functions.get(fn)) return;
          const { ports, geom, part } = corePorts(fn, rot, flip, pc);
          const marks = portMarks(part, geom);
          expect(marks.length).toBe(ports.length);
          expect(ports.length).toBeGreaterThan(0);
          for (const q of ports) {
            const m = marks.find((k) => k.cell[0] === q.x && k.cell[1] === q.y && k.side === q.side && k.kind === (q.dir ? 'out' : 'in'));
            expect(m, `${fn} port ${q.dir} at ${q.x},${q.y} ${q.side}`).toBeDefined();
            expect(m!.dir).toEqual(SIDE_NORMAL[q.side]);
            // (OUT's tip is outside the edge, IN's inside)
            const tip = m!.poly[1], d = (tip[0] - m!.at[0]) * m!.dir[0] + (tip[1] - m!.at[1]) * m!.dir[1];
            expect(q.dir ? d > 0 : d < 0).toBe(true);
          }
        });
      }
    }
  }

  it('a Cell Reactor has just OUT marks and a part with no ports none', () => {
    const p = { uid: 1, piece: 'sq', fn: 'power_cell_reactor', material: 'steel', x: 0, y: 0, rot: 0, flip: false } as PlacedPart;
    expect(portMarks(p, placeGeometry(catalog, p)).every((m) => m.kind === 'out')).toBe(true);
    const h = { ...p, fn: 'hull' } as PlacedPart;
    expect(portMarks(h, placeGeometry(catalog, h))).toEqual([]);
  });
});
