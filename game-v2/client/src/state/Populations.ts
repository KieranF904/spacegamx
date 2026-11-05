/**
 * The system's hostile populations (pops messages; common world/populations.ts): which of each nest's and zone's
 * packs' ships are alive, and which packs are loaded (real ships the server sends as ships). Every other live ship is
 * a ghost, and where it is is worked out here from the shared rules, the same as the server does (it's loaded right
 * there once a pilot comes near): it costs no bytes beyond the alive bits, sent when they change.
 */

import { spawnersOf, ghostCentre, ghostShip, slotStyle, unpackPopSlot, type PopSpawnerDef, type ServerPopsMessage, type Spawner, type StarSystemData } from '@space-game/common';

/** A ghost ship for the maps: where it is, whose it is (faction index), and whether its pack leaves pilots be */
export interface PopGhost { x: number; y: number; faction: number; calm: boolean }

export class Populations {
  /** Each spawner's slot codes (packPopSlot), by spawner index */
  private slots = new Map<number, number[]>();
  private system = '';
  private spawners: { sys: string; list: Spawner[] } | null = null;

  constructor(private readonly spawns: Record<string, { nests?: PopSpawnerDef[]; zones?: PopSpawnerDef[] }>, private readonly factions: string[]) {}

  apply(msg: ServerPopsMessage, system: string): void {
    if (system !== this.system || msg.full) { this.slots.clear(); this.system = system; }
    const p = msg.p;
    for (let i = 0; i + 1 < p.length;) {
      const index = p[i], n = p[i + 1];
      this.slots.set(index, p.slice(i + 2, i + 2 + n));
      i += 2 + n;
    }
  }

  clear(): void {
    this.slots.clear();
    this.system = '';
  }

  /** How many ghost ships there are (the map's stats, the tests) */
  get size(): number {
    let n = 0;
    for (const codes of this.slots.values()) for (const c of codes) { const s = unpackPopSlot(c); if (!s.loaded) for (let a = s.alive; a; a &= a - 1) n++; }
    return n;
  }

  /** Every ghost ship at server tick `tick` (none for another system than the one it was told of) */
  ghosts(system: string, sys: StarSystemData | undefined, tick: number, out: PopGhost[] = []): PopGhost[] {
    out.length = 0;
    if (system !== this.system || !this.slots.size) return out;
    if (this.spawners?.sys !== system) this.spawners = { sys: system, list: spawnersOf(this.spawns[system], sys) };
    for (const sp of this.spawners.list) {
      const codes = this.slots.get(sp.index);
      if (!codes) continue;
      codes.forEach((code, slot) => {
        const s = unpackPopSlot(code);
        const g = sp.def.groups[s.group];
        if (s.loaded || !s.alive || !g) return;
        const c = ghostCentre(sys, system, sp, slot, slotStyle(sp, s.group), tick);
        const faction = this.factions.indexOf(g.faction);
        for (let k = 0; k < g.ships.length; k++) {
          if (!(s.alive & (1 << k))) continue;
          const at = ghostShip(c, k);
          out.push({ x: at.x, y: at.y, faction, calm: !!g.passive });
        }
      });
    }
    return out;
  }
}
