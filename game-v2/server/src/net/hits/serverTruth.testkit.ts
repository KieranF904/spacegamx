/**
 * The server's own record of a fight, for the hit tests to hold their clients to (every client runs the full caps set:
 * there's no legacy observer to compare with any more). Wraps the server where each thing happens:
 *
 *   damage      Outbox.flushDamage: each snapshot's sums per target and source, to a tenth as the server hands them on
 *   ignites     a fire a hit set (HitLedger.hitFx) or anything else did (broadcast): "body:part:ticks"
 *   detonations the same, for detonations (a burst, a blast, a pierce's flash)
 *   impacts     HitLedger.shellHit: every shell striking something (a ship, or not)
 *   removed     every shell gone from the world (scanned after each step: alive, then gone or dead), and every shell seen
 *
 * Only for tests. Make it after the fake clients (it wraps server.step after them).
 */
import { defineQuery, hasComponent } from 'bitecs';
import { Projectile, Dead, isOwnShotWire, type ServerMessage } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';

export interface ServerTruth {
  damage: Map<string, number>;
  ignites: string[];
  detonations: number;
  impacts: number;
  removed: Set<number>;
  seen: Set<number>;
}

const shellQuery = defineQuery([Projectile]);

export function serverTruth(server: GameServer): ServerTruth {
  const t: ServerTruth = { damage: new Map(), ignites: [], detonations: 0, impacts: 0, removed: new Set(), seen: new Set() };
  const note = (m: ServerMessage) => {
    if (m.type === 'ignite') t.ignites.push(`${m.bodyId}:${m.part}:${m.ticks}`);
    else if (m.type === 'detonation') t.detonations++;
  };
  const net = server.net as unknown as {
    flushDamage(): void;
    heldDamage: { target: number; source: number; amount: number }[];
    broadcastNear(...a: unknown[]): void;
  };
  // (each snapshot's sums, to a tenth as the server hands them on: what a client is shown where no record covers them)
  const flushDamage = net.flushDamage.bind(net);
  net.flushDamage = () => {
    flushDamage();
    for (const e of net.heldDamage) {
      const amount = Math.round(e.amount * 10) / 10;
      if (amount <= 0) continue;
      const k = `${e.target},${e.source}`;
      t.damage.set(k, Math.round(((t.damage.get(k) ?? 0) + amount) * 10) / 10);
    }
  };
  // (every broadcast effect goes through broadcastNear: broadcastToSystem hands it the located ones)
  const near = net.broadcastNear.bind(net);
  net.broadcastNear = (...a: unknown[]) => { note(a[3] as ServerMessage); near(...a); };
  const ledger = server.hits as unknown as { hitFx(p: number, m: ServerMessage): boolean; shellHit(...a: unknown[]): void };
  const hitFx = ledger.hitFx.bind(ledger);
  ledger.hitFx = (p, m) => { const kept = hitFx(p, m); if (kept) note(m); return kept; };
  const shellHit = ledger.shellHit.bind(ledger);
  ledger.shellHit = (...a: unknown[]) => { t.impacts++; shellHit(...a); };
  let alive = new Set<number>();
  const step = server.step.bind(server);
  server.step = () => {
    step();
    const now = new Set<number>();
    for (const id of shellQuery(server.world)) if (!hasComponent(server.world, Dead, id)) { now.add(id); t.seen.add(id); }
    for (const id of alive) if (!now.has(id)) t.removed.add(id);
    alive = now;
  };
  return t;
}

/** The damage sums of a client and the server agree within `allowance` per target and source (rounding to tenths) */
export function damageOff(client: Map<string, number>, truth: Map<string, number>, allowance: number): string[] {
  const off: string[] = [];
  for (const k of new Set([...client.keys(), ...truth.keys()])) {
    const a = client.get(k) ?? 0, b = truth.get(k) ?? 0;
    if (Math.abs(a - b) > allowance) off.push(`${k}: client ${a.toFixed(2)} vs server ${b.toFixed(2)}`);
  }
  return off;
}

/**
 * Shells removed, each way round: the client's removals of shells the server had, and the server's removals of shells the
 * client knew. Its own shells it works out (named by shot id) are left out: it ends them itself at their end of life
 */
export function removedBoth(client: { removed: Set<number>; known: Set<number> }, truth: ServerTruth): { client: number[]; server: number[] } {
  const own = (id: number) => isOwnShotWire(id);
  return {
    client: [...client.removed].filter((id) => !own(id) && truth.seen.has(id)).sort((a, b) => a - b),
    server: [...truth.removed].filter((id) => client.known.has(id)).sort((a, b) => a - b),
  };
}
