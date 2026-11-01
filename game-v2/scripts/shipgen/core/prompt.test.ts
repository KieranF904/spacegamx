import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadContext } from './context';
import { buildLegend } from './legend';
import { check } from './check';
import { gridToBlueprint } from './grid';
import { feedbackMessage, rulesShort, rulesText, shownLegend, systemPrompt } from './prompt';
import { briefCheck, loadRoles, type Selector } from './roles';
import { BLUEPRINTS } from './testShips';

const ctx = loadContext();
const roles = loadRoles(ctx).roles;

describe('shipgen roles and prompt', () => {
  it('has roles whose selectors name real functions, families and power roles, and real examples', () => {
    expect(roles.length).toBeGreaterThanOrEqual(5);
    const fns = ctx.catalog.functions, families = new Set([...fns.values()].map((f) => f.family).filter(Boolean));
    const powerRoles = new Set(['generator', 'store', 'conduit', 'diode', 'dynamo', 'weapon', 'thruster', 'tool', 'core', 'engine']);
    const list = <T>(v: T | T[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    for (const r of roles) {
      expect(r.size.cells[0]).toBeLessThan(r.size.cells[1]);
      expect(r.band.maxLevel).toBeGreaterThan(0);
      for (const s of [...(r.require ?? []), ...(r.encourage ?? [])] as Selector[]) {
        for (const f of list(s.fn)) expect(fns.has(f), `${r.id}: fn ${f}`).toBe(true);
        for (const f of list(s.family)) expect(families.has(f), `${r.id}: family ${f}`).toBe(true);
        for (const p of list(s.role)) expect(powerRoles.has(p), `${r.id}: role ${p}`).toBe(true);
      }
      if (r.example) expect(existsSync(join(BLUEPRINTS, `${r.example}.json`)), r.example).toBe(true);
    }
  });

  it('reads the rules block from docs/areas/energy.md', () => {
    const rules = rulesText(ctx);
    expect(rules).toMatch(/touch/);
    expect(rules).toMatch(/DIODE/);
    expect(rules).not.toMatch(/shipgen:rules/);
  });

  for (const r of roles) {
    it(`builds the ${r.id} prompt from the current catalog`, () => {
      const p = systemPrompt(ctx, { role: r.id, text: 'Something striking.' });
      expect(p).toContain(rulesShort(ctx));
      expect(rulesShort(ctx).length).toBeLessThan(rulesText(ctx).length);
      expect(p).toContain('## Grid format');
      expect(p).toContain(r.summary);
      expect(p).toContain('Something striking.');
      for (const e of shownLegend(ctx, { role: r.id })) expect(p).toContain(e.kind === 'structure' ? `${e.code} ` : e.line);
      // (Short: the prompt is not the old 10-26k characters)
      expect(p.length).toBeLessThan(14000);
      // (nothing above the band's level unless the example uses it)
      if (r.example) expect(p).toContain('## Example');
      expect(p.length).toBeLessThan(40000);
    });
  }

  it('leaves the legend codes in the prompt to the band', () => {
    const p = systemPrompt(ctx, { role: 'starter' });
    const legend = buildLegend(ctx);
    const high = legend.entries.find((e) => e.level > 30 && e.kind === 'model')!;
    expect(p).not.toContain(high.line);
  });

  it('turns a check into specific feedback', () => {
    const text = ['name: Walled', 'grid:', '  0 PI^ HA CA', '  1 HA HA CR', '  2 .. IDv IDv', 'end'].join('\n');
    const bp = gridToBlueprint(ctx, text).bp!;
    const msg = feedbackMessage({ result: check(ctx, bp), brief: briefCheck(ctx, bp, roles.find((x) => x.id === 'starter')!) });
    expect(msg).toMatch(/row 0 col 0/);
    expect(msg).toMatch(/gets no power/);
    expect(msg).toMatch(/size: /);
    expect(msg).toMatch(/Scores/);
    const bad = feedbackMessage({ gridErrors: gridToBlueprint(ctx, 'grid:\n 0 QQ ..\nend').errors });
    expect(bad).toMatch(/couldn't read your grid/);
    expect(bad).toMatch(/QQ/);
  });
});
