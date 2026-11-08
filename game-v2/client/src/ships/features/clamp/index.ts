/**
 * @contract feature.clamp.client
 * owns:       the Docking Clamps client half: the prompt, dock and swap keys, HUD chip, glow, and the link messages
 * needs:      ClientFeature (types.ts), pixi.js, common/network clampProtocol + clampWorld, ClampIndicator, clampView
 * invariants: its keys, parsers, drawers and chips run in feature id order and the first key user wins —
 *             client/src/ships/features/host.test.ts
 *             the clamp card and prompt text come from the pure view —
 *             client/src/ships/features/clamp/clampView.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * Docking Clamps' client half (shared half: common/src/ships/features/clamp; docs/design/groups-mines-docking.md 3):
 * the lined-up prompt, the dock key (H, the Dock key: taken only while a prompt is up or the ship is docked, otherwise
 * H docks at a station as before), the swap key (Minus), the HUD chip and the clamps' glow. The links themselves step
 * in the replica set (common network/replication.ts noteClampLink), told by the three server messages (onClamp*).
 */
import { Graphics } from 'pixi.js';
import {
  EntityType, clampWorld, type ServerClampAskMessage, type ServerClampLinkMessage, type ServerClampBreakMessage,
  type ShipReplicaSet,
} from '@space-game/common';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from '../types';
import { ClampIndicator } from './ClampIndicator';
import { clampView, findPrompt, breakText, type PromptShip } from './clampView';

export { clampView, findPrompt, ClampView } from './clampView';

const chip = new ClampIndicator();
let glow: Graphics | undefined;

const nameOf = (host: ClientFeatureHost, id: number): string => host.entity(id)?.name || 'the other pilot';

/** A drawn ship as the prompt reads it (its drawn pose and motion) */
function promptShip(host: ClientFeatureHost, id: number): PromptShip | null {
  const e = host.entity(id), ship = host.ship(id);
  if (!e || !ship || ship.kind !== 'ship') return null;
  return { id, ship, body: { x: e.renderX, y: e.renderY, angle: e.renderAngle, vx: e.vx, vy: e.vy, angVel: e.angVel ?? 0 } };
}

/** The prompt now: our clamps against every other pilot's drawn near us (none while docked or berthed) */
function prompt(host: ClientFeatureHost): ReturnType<typeof findPrompt> {
  const self = host.playerId();
  if (clampView.linkOf(self) || host.hangarOpen()) return null;
  const me = promptShip(host, self);
  if (!me?.ship.derived.fx?.clamp) return null;
  const others: PromptShip[] = [];
  for (const [id, e] of host.entities?.() ?? []) {
    if (id === self || e.type !== EntityType.Player) continue;
    const o = promptShip(host, id);
    if (o) others.push(o);
  }
  return findPrompt(me, others, host.cellSize ?? 24);
}

export const clientFeature: ClientFeature = {
  id: 'clamp',
  actions: [
    { id: 'clampSwap', label: 'Swap who steers (docked)', category: 'Ship & world', key: 'Minus', after: 'tow', hint: 'Docked with another ship: both press it to swap who steers' },
  ],
  onKey(code, host) {
    const self = host.playerId();
    const link = clampView.linkOf(self);
    if (code === 'KeyH') {
      if (link) { host.send({ type: 'clampUndock' }); return true; }
      const p = clampView.prompt;
      if (!p) return false;
      host.send({ type: 'clampDock', with: p.with, clamp: p.clamp, theirs: p.theirs });
      clampView.waiting = { with: p.with, what: 'dock', until: performance.now() + 3000 };
      return true;
    }
    if (code === 'Minus' && link) {
      host.send({ type: 'clampSwap' });
      clampView.waiting = { with: link.leader === self ? link.follower : link.leader, what: 'swap', until: performance.now() + 3000 };
      return true;
    }
    return false;
  },
  beginFrame(shared) {
    if (!glow) { glow = new Graphics(); shared.addChild(glow); }
    glow.clear();
  },
  drawShip(ctx: ShipDrawCtx, host) {
    if (!glow) return;
    const clamps = ctx.ship.derived.fx?.clamp?.clamps;
    if (!clamps?.length) return;
    const self = host.playerId(), link = clampView.linkOf(ctx.eid), p = clampView.prompt;
    // (Lit while docked, and on the two ships the prompt is about)
    const lit = link ? [link.leader === ctx.eid ? link.lc : link.fc] : p && (ctx.eid === self || ctx.eid === p.with) ? [ctx.eid === self ? p.clamp : p.theirs] : null;
    if (!lit) return;
    const e = ctx.entity, body = { x: e.renderX, y: e.renderY, angle: e.renderAngle, vx: 0, vy: 0, angVel: 0 };
    const pulse = 0.55 + 0.35 * Math.sin(ctx.now / 260);
    for (const c of clamps) {
      if (!lit.includes(c.uid)) continue;
      const w = clampWorld(c, ctx.ship.derived.com, ctx.cs, body);
      glow.circle(w.x, w.y, ctx.cs * 0.45).fill({ color: 0x5eead4, alpha: (link ? 0.35 : 0.22) * pulse });
      glow.circle(w.x, w.y, ctx.cs * 0.2).fill({ color: 0xccfbf1, alpha: 0.8 * pulse });
    }
  },
  indicator: {
    update(host) {
      const now = performance.now();
      clampView.expire(now);
      clampView.prompt = prompt(host);
      if (clampView.notice) { host.showMessage(clampView.notice, '#5eead4'); clampView.notice = null; }
      const self = host.playerId(), link = clampView.linkOf(self);
      const dock = host.keyName('dock'), swap = host.keyName('clampSwap');
      let text = '';
      if (host.hangarOpen()) text = '';
      else if (clampView.ask) {
        const who = nameOf(host, clampView.ask.from);
        text = clampView.ask.what === 'dock' ? `${who} wants to dock: press ${dock}` : `${who} wants to swap who steers: press ${swap}`;
      } else if (clampView.waiting) text = `Waiting for ${nameOf(host, clampView.waiting.with)}`;
      else if (link) {
        const other = link.leader === self ? link.follower : link.leader;
        const name = nameOf(host, other);
        text = `Docked with ${name} · ${link.leader === self ? 'you steer' : `${name} steers`} · ${dock} undock · ${swap} swap`;
      } else if (clampView.prompt) text = `Press ${dock} to dock`;
      chip.update(text);
    },
  },
};

// ---- Server messages (app/serverMessages.ts: one line each)

export function onClampAsk(m: ServerClampAskMessage): void {
  clampView.onAsk(m, performance.now());
}

export function onClampLink(m: ServerClampLinkMessage, reps: ShipReplicaSet, self: number): void {
  reps.noteClampLink(m);
  clampView.onLink(m, self);
}

export function onClampBreak(m: ServerClampBreakMessage, reps: ShipReplicaSet, self: number): void {
  reps.noteClampBreak(m);
  clampView.onBreak(m, self, breakText);
}
