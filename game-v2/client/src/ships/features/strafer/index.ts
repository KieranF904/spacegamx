/**
 * The Burst Strafer's client half (shared half, which flies it: common/src/ships/features/strafer): its key and the
 * dodge control it sends, its HUD chip, and the jets drawn while a burst runs. Its counter and way are body state
 * (`entity.dodge`, `entity.dodgeDir`: the pilot's from its row and prediction, others' from their replicas).
 */
import {
  getPlan, worldToLocalDir, dodgePhase, strafeForce, chooseDodgeDir, dodgeAffordable,
  DODGE_LEFT, DODGE_RIGHT, DODGE_FORWARD, DODGE_BACK,
} from '@space-game/common';
import type { ActionDef } from '../../../input/keybindings';
import type { ClientFeature, ClientFeatureHost } from '../types';
import { DodgeIndicator, type DodgeHud } from './DodgeIndicator';
import { drawJets } from './jets';

/** A dodge pressed during the cooldown fires when it's over, if that's within this long (ms) */
const DODGE_BUFFER_MS = 250;

/** The shared input (common features/strafer DODGE_INPUT), as a key binding: listed after the helm switch */
function dodgeAction(): ActionDef {
  const inp = getPlan().inputs.find((i) => i.feature === 'strafer' && i.name === 'dodge')!;
  return { id: inp.name, label: inp.label, category: 'Flight', key: inp.defaultKey, hint: inp.hint, after: 'helm' };
}
const ACTION = dodgeAction();

// The dodge being sent this press and since when; the key last tick, when it was pressed, and whether that press is spent
let latch = false;
let latchAt = 0;
let keyDown = false;
let pressAt = -Infinity;
let used = true;

/**
 * The dodge control this input tick. A press of the dodge key (Space, rebindable) asks for one burst; which way is the
 * simulation's to work out from the movement keys sent with it (strafer.ts chooseDodgeDir), so prediction and the server
 * agree. A press during the cooldown waits for it (up to DODGE_BUFFER_MS) rather than being lost. Once sent it's held
 * for at least a few ticks so the server sees it, then until the key's let go (one burst a press: strafer.ts stepDodge).
 */
function dodgeControl(host: ClientFeatureHost): boolean {
  const down = !host.hangarOpen() && host.inputEnabled() && host.isKeyDown(ACTION.key);
  const now = performance.now();
  if (down && !keyDown) { pressAt = now; used = false; }
  keyDown = down;
  if (latch) {
    if (!down && now - latchAt > 120) latch = false;
    return latch;
  }
  if (used || now - pressAt > DODGE_BUFFER_MS) return false;
  const ship = host.ship(host.playerId()), me = host.entity(host.playerId());
  if (!ship || ship.kind !== 'ship' || !me) return false;
  const s = ship.derived.fx?.strafe;
  if (!s || !s.parts.length) {
    used = true;
    host.showMessage(ship.blueprint.parts.some((p) => host.catalog.functions.get(p.fn)?.strafe) ? 'The Burst Strafers have no power' : 'No Burst Strafer fitted: build one in the hangar to dodge', '#f2d24b');
    return false;
  }
  // (Still cooling down: the press waits for it)
  if (dodgePhase(me.dodge, s).phase !== 'ready') return false;
  latch = true;
  used = true;
  latchAt = now;
  return true;
}

/** The way the movement keys ask, ship-local (as flight.ts works it out from the same keys), or null */
function dodgeWay(host: ClientFeatureHost, angle: number): [number, number] | null {
  const k = (...codes: string[]) => (codes.some((c) => host.isKeyDown(c)) ? 1 : 0);
  const fwd = k('KeyW', 'ArrowUp'), back = k('KeyS', 'ArrowDown');
  if (host.helm()) { const lx = k('KeyE') - k('KeyQ'), ly = back - fwd; return lx || ly ? [lx, ly] : null; }
  const sx = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), sy = back - fwd;
  return sx || sy ? worldToLocalDir([sx, sy], angle) : null;
}

/** Your strafers' state (predicted), for the HUD: null without any */
function localDodge(host: ClientFeatureHost): DodgeHud | null {
  const ship = host.ship(host.playerId()), me = host.entity(host.playerId());
  if (!ship || ship.kind !== 'ship' || !me) return null;
  const s = ship.derived.fx?.strafe;
  if (!s || !s.parts.length) return null;
  const ph = dodgePhase(me.dodge, s);
  const way = chooseDodgeDir(s, dodgeWay(host, me.angle), me.dodgeDir);
  const can = (dir: number) => strafeForce(s, dir) > 1e-6;
  const ways = [[DODGE_FORWARD, '↑'], [DODGE_BACK, '↓'], [DODGE_LEFT, '←'], [DODGE_RIGHT, '→']] as const;
  const able = ways.filter(([d]) => can(d));
  return {
    phase: ph.phase, cooling: ph.cooling,
    afford: dodgeAffordable(ship.derived, host.charge(), way),
    ways: able.length === ways.length ? '' : able.map(([, a]) => a).join(''),
  };
}

const chip = new DodgeIndicator();

export const clientFeature: ClientFeature = {
  id: 'strafer',
  actions: [ACTION],
  controls: { dodge: dodgeControl },
  drawShip(ctx) {
    drawJets(ctx, ctx.entity.dodge, ctx.entity.dodgeDir);
  },
  // The chip: ready or cooling, and whether the ship can pay
  indicator: {
    update(host) {
      chip.update(host.hangarOpen() ? null : localDodge(host), host.keyName('dodge'));
    },
  },
  // The status panel's line: ready, bursting or cooling, and short of power
  status(host) {
    const s = localDodge(host);
    if (!s) return null;
    const low = s.afford < 0.999;
    if (s.phase === 'burst') return { label: 'DODGE', text: 'BURST', tone: 'busy' };
    if (s.phase === 'cooling') return { label: 'DODGE', text: 'COOLING', tone: 'busy', progress: 1 - s.cooling };
    if (low) return { label: 'DODGE', text: s.afford < 0.25 ? 'NO POWER' : `LOW ${Math.round(s.afford * 100)}%`, tone: s.afford < 0.25 ? 'bad' : 'warn' };
    return { label: 'DODGE', text: `READY ${host.keyName('dodge')}`, tone: 'ok' };
  },
};
