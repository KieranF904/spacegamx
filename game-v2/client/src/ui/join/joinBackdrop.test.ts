// The join screen's backdrop is the sign-in screen's own scene carried on under it (LoginUI.showBackdropOnly), not a
// tiled CSS star pattern. These read the two screens' sources: the styles and the wiring are text there.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const join = read('../ServerBrowserUI.ts');
const login = read('../LoginUI.ts');
const game = read('../../Game.ts');
const banner = read('./topBanner.ts');

/** The z-index of the rule whose selector is `sel`, in `css` */
function zIndex(css: string, sel: string): number {
  const at = css.indexOf(sel + ' {');
  expect(at, sel).toBeGreaterThanOrEqual(0);
  // (to the brace that ends a line: one of these rules has a ${...} in it)
  const end = at + css.slice(at).search(/\}\s*\n/);
  const m = /z-index:\s*(\d+)/.exec(css.slice(at, end));
  expect(m, sel + ' z-index').not.toBeNull();
  return Number(m![1]);
}

describe('the join screen backdrop', () => {
  it('has no tiled star pattern: nothing in the join screen is drawn on a repeating pixel tile', () => {
    const panel = join.slice(join.indexOf('#server-browser-panel {'), join.indexOf('.join-wrap {'));
    expect(panel).not.toMatch(/background-size:[^;]*\d+px \d+px/);
    expect(panel).not.toMatch(/radial-gradient\(\s*1(\.5)?px/);
  });

  it('lets the scene behind show: the join screen paints only a see-through scrim', () => {
    const panel = join.slice(join.indexOf('#server-browser-panel {'), join.indexOf('.join-wrap {'));
    const bg = /background:([^;]*);/.exec(panel)?.[1] ?? '';
    expect(bg).toContain('rgba(');
    expect(bg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('sits under the join screen, which sits under the top banner', () => {
    const backdrop = zIndex(login, '#login-panel.backdrop-only');
    const screen = zIndex(join, '#server-browser-panel');
    expect(backdrop).toBeLessThan(screen);
    expect(screen).toBeLessThan(zIndex(banner, '.sg-topbar'));
    // (and takes no clicks, and shows nothing of the form)
    expect(login).toMatch(/#login-panel\.backdrop-only \{[^}]*pointer-events: none/);
    expect(login).toMatch(/#login-panel\.backdrop-only > :not\(canvas\) \{ display: none; \}/);
  });

  it("is the sky alone: the sign-in screen's bodies are gone under the join screen, and nothing of them is updated or drawn", () => {
    // (they glide out, join/bodyGlide.ts, towards "gone" whenever the backdrop is up without the form)
    expect(login).toContain('this.glide = glideStep(this.glide, this.backdropOnly,');
    // Gone: the group isn't drawn, and the branch that updates the bodies and draws the star isn't taken
    expect(login).toContain('this.bodies.visible = this.glide < 1;');
    const frame = login.slice(login.indexOf('private updateAnimation'), login.indexOf('private drawStars('));
    const gone = frame.indexOf('if (this.glide >= 1) {'), bodyUpdate = frame.indexOf('this.body.update('), starDraw = frame.indexOf('this.sunRenderer.drawAt(');
    expect(gone).toBeGreaterThan(0);
    expect(bodyUpdate).toBeGreaterThan(gone);
    expect(starDraw).toBeGreaterThan(gone);
    expect(frame.slice(gone, bodyUpdate)).toContain('else if (this.body)');
    // (a backdrop rebuilt straight under the join screen, after a game, starts with them gone)
    expect(login).toContain('this.glide = this.backdropOnly ? 1 : 0;');
    expect(login).toContain('this.bodies.visible = !this.backdropOnly;');
    // The star and the planets are all in the one group
    expect(login).toContain('this.bodies.addChild(this.sunRenderer.container)');
    expect(login).toContain('this.bodies.addChild(this.body.container)');
    expect(login).not.toContain('worldContainer.addChild(this.sunRenderer.container)');
    expect(login).not.toContain('worldContainer.addChild(this.body.container)');
  });

  it('goes up with every showing of the join screen and comes down when a server is picked', () => {
    const shows = game.match(/this\.serverBrowserUI\.show\(/g)?.length ?? 0;
    expect(shows).toBeGreaterThan(0);
    expect(game.match(/this\.loginUI\.showBackdropOnly\(\);\s*this\.serverBrowserUI\.show\(/g)?.length).toBe(shows);
    const pick = game.slice(game.indexOf('private handleServerSelect('), game.indexOf('private handleLogout('));
    expect(pick).toMatch(/this\.serverBrowserUI\.hide\(\);[\s\S]*this\.loginUI\.hide\(\);/);
  });
});

describe('the join screen and the flight HUD', () => {
  it('flight HUD pieces on the page itself are put away while the join screen is up, and come back when it goes', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../ServerBrowserUI.ts'), 'utf-8');
    expect(src).toMatch(/body\.sg-join-open \.ctb-fab, body\.sg-join-open \.sg-jump-hud \{ display: none !important; \}/);
    expect(src).toMatch(/classList\.add\('sg-join-open'\)/);
    expect(src).toMatch(/classList\.remove\('sg-join-open'\)/);
    expect(readFileSync(join(__dirname, '../../ships/JumpFx.ts'), 'utf-8')).toContain("this.hud.className = 'sg-jump-hud'");
  });
});
