/**
 * Station tab: Repair bank.
 *
 * Owns: mounting the repair-bank panel (station/BankPanel.ts) with the pilot's cargo, storage, licences and level; the panel and its store own the rest.
 * Needs: StationCtx (the pilot, send/sound), bankStore (the last bank message).
 * Extend: bank behaviour belongs in BankPanel.ts; this tab only wires it.
 */

import {
  stationLearned,
} from '@space-game/common';
import { itemIcon } from '../itemIcons';
import { mountBank } from './BankPanel';
import { getBank } from './bankStore';
import { STATION } from './shared';
import type { StationCtx } from './shared';

export class BankTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }

  /** The repair bank: the panel mounts into the tab body */
  render(b: HTMLElement): void {
    const p = this.d.pilot, bank = getBank();
    mountBank(b, {
      econ: p.econ, icon: (id) => itemIcon(p.econ, id), send: (m) => this.d.send(m), sound: (id, v) => this.d.sound(id, v),
      cargo: () => p.cargo, storage: () => p.storage,
      learned: () => stationLearned(p.profile?.recipes ?? [], p.profile?.outpost ?? undefined, STATION), level: () => p.profile?.level ?? 1,
    }, bank?.msg ?? null, bank?.at ?? Date.now());
  }
}
