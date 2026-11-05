/**
 * Boss dens' features (docs/bosses/rework-2026-11.md 9): each system's `den` (systems.json) built from the registry
 * by kind, stepped every tick (from the bosses' tick), told of damage, and naming the bodies that are theirs. They
 * teach a fight's meta with nothing riding on the boss: no buff, no key, no shortcut.
 */

import type { DenFeatureData } from '@space-game/common';
import type { DenFeature, DenHost } from './types.js';
import { DEN_KINDS } from './registry.js';

export class Dens {
  private readonly dens: { num: number; features: DenFeature[] }[];

  constructor(private host: DenHost) {
    this.dens = host.systems().map(({ num, den }) => ({
      num,
      features: den.map((d) => (DEN_KINDS[d.kind] as (h: DenHost, n: number, x: DenFeatureData) => DenFeature)(host, num, d)),
    }));
  }

  tick(): void {
    const now = this.host.tick();
    for (const d of this.dens) {
      const players = this.host.players(d.num);
      for (const f of d.features) f.tick(now, players);
    }
  }

  onDamage(eid: number, amount: number, source: number): void {
    for (const d of this.dens) for (const f of d.features) f.onDamage?.(eid, amount, source);
  }

  /** A den body's name (a cache's crust), for the snapshot's names */
  nameOf(eid: number): string | undefined {
    for (const d of this.dens) for (const f of d.features) { const n = f.nameOf?.(eid); if (n) return n; }
    return undefined;
  }
}
