/**
 * The view apart from the controls (input/viewMode.ts), its setting's migration (settings/Settings.ts loadSettings), and
 * the pinned aim of mouse-steer with the view on the heading (input/aimPin.ts).
 */
import { describe, it, expect } from 'vitest';
import { ViewMode, followsHeading, type CameraMode } from './viewMode';
import { AimPin } from './aimPin';
import { loadSettings } from '../settings/Settings';
import { screenToWorld } from '../rendering/cameraView';

describe('the camera setting', () => {
  it('an older save (no view setting) keeps how it was: helm follows the heading, mouse-steer is north up', () => {
    for (const controlMode of ['mouse', 'helm', 'auto', undefined]) {
      const s = loadSettings({ gameplay: { controlMode, jumpMode: 'hold' } });
      expect(s.gameplay.cameraMode).toBe('auto');
      expect(s.gameplay.jumpMode).toBe('hold');
      const helm = s.gameplay.controlMode === 'helm';
      expect(followsHeading(s.gameplay.cameraMode, helm)).toBe(helm);
    }
    expect(loadSettings(null).gameplay.cameraMode).toBe('auto');
    // (The camera key's default binding comes with it)
    expect(loadSettings({ bindings: { helm: 'KeyB' } }).bindings.camera).toBe('Backquote');
  });

  it('a saved pick is kept; anything unknown is put back to auto', () => {
    expect(loadSettings({ gameplay: { cameraMode: 'north' } }).gameplay.cameraMode).toBe('north');
    expect(loadSettings({ gameplay: { cameraMode: 'heading' } }).gameplay.cameraMode).toBe('heading');
    expect(loadSettings({ gameplay: { cameraMode: 'sideways' } }).gameplay.cameraMode).toBe('auto');
  });
});

describe('ViewMode: the four combinations', () => {
  const combos: [CameraMode, boolean, boolean, boolean][] = [
    // setting, helm  -> follows heading, pinned aim
    ['north', false, false, false],   // mouse + north up (today's default)
    ['heading', true, true, false],   // helm + follow heading (today's helm)
    ['north', true, false, false],    // helm + north up
    ['heading', false, true, true],   // mouse + follow heading: the aim pinned in the world
    ['auto', false, false, false],
    ['auto', true, true, false],
  ];
  it.each(combos)('%s, helm %s: follows the heading %s, pinned aim %s', (mode, helm, follows, pinned) => {
    const v = new ViewMode(() => mode);
    expect(v.followsHeading(helm)).toBe(follows);
    expect(v.pinnedAim(helm)).toBe(pinned);
  });

  it('the camera key flips the view in use for the session; a change of the setting wins over it', () => {
    let mode: CameraMode = 'auto';
    const v = new ViewMode(() => mode);
    expect(v.toggle(false)).toBe('heading');
    expect(v.followsHeading(false)).toBe(true);
    expect(v.followsHeading(true)).toBe(true);
    expect(v.toggle(true)).toBe('north');
    expect(v.followsHeading(true)).toBe(false);
    mode = 'heading';
    expect(v.followsHeading(false)).toBe(true);
    mode = 'auto';
    expect(v.followsHeading(false)).toBe(false);
    expect(v.followsHeading(true)).toBe(true);
  });
});

describe('AimPin: the aim pinned in the world while the view turns', () => {
  const W = 1200, H = 800;
  const cam = { x: 5000, y: -300, zoom: 0.5, angle: 0 };
  const pin = new AimPin(() => ({ w: W, h: H }), () => cam.angle);
  const world = () => { const s = pin.screen(); return screenToWorld(s.x, s.y, cam, W, H); };

  it('a still mouse while the view turns does not move the aim; the cursor is drawn where it now is', () => {
    cam.angle = 0.3;
    pin.pin(800, 250);
    const start = world();
    const first = pin.screen();
    expect(first.x).toBeCloseTo(800, 9); expect(first.y).toBeCloseTo(250, 9);
    for (const a of [0.5, 1.2, -0.4, 2.9, -3]) {
      cam.angle = a;
      const w = world();
      expect(w.x).toBeCloseTo(start.x, 6); expect(w.y).toBeCloseTo(start.y, 6);
    }
    // (Drawn elsewhere on the screen than it was pinned, the view having turned)
    expect(Math.hypot(pin.screen().x - 800, pin.screen().y - 250)).toBeGreaterThan(50);
  });

  it('the mouse moves it along the screen as it is now', () => {
    cam.angle = 1.0;
    pin.pin(600, 200);  // straight above the centre
    const a = pin.screen();
    pin.move(30, 0);
    const b = pin.screen();
    expect(b.x - a.x).toBeCloseTo(30, 9); expect(b.y - a.y).toBeCloseTo(0, 9);
  });

  it('held (a window has the pointer): the mouse does not move it', () => {
    cam.angle = 0;
    pin.pin(600, 200);
    pin.held = true;
    pin.move(40, 40);
    const s = pin.screen();
    expect(s.x).toBeCloseTo(600, 9); expect(s.y).toBeCloseTo(200, 9);
    pin.held = false;
  });

  it('stays on the screen when the view turns it past an edge, and a push back moves it from there', () => {
    cam.angle = 0;
    pin.pin(1150, 400);           // near the right edge
    cam.angle = Math.PI / 2;      // the view a quarter turn: that offset now points off the top
    const s = pin.screen();
    expect(s.y).toBe(4);
    expect(s.x).toBeCloseTo(W / 2, 9);
    pin.move(0, 10);              // a push back down moves it at once
    expect(pin.screen().y).toBeCloseTo(14, 9);
    void H;
  });

  it('unpinned: no longer pinned', () => {
    pin.unpin();
    expect(pin.pinned).toBe(false);
  });
});
