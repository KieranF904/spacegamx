/**
 * @contract client.gun-range.messages
 * owns:       what the client does with gunRangeState: the range state kept (./rangeState), and on going in the station
 *             screen put away and the berth let go (the server took the ship out of it); a refusal shown
 * needs:      ./rangeState, common ServerGunRangeStateMessage; the host's station window, ship client and toasts
 * invariants: going in never sends anything (the server has already unberthed the pilot) — client/src/ui/gunRange/rangeState.test.ts
 * extend:     a new reaction to the range's state is a line in onGunRangeState
 *
 * Coming out needs nothing here: the server puts the pilot back in their berth first (dockResult: the station screen
 * opens as on any dock), then says `in: false`.
 */

import type { ServerGunRangeStateMessage } from '@space-game/common';
import { setRangeState } from './rangeState';

export interface RangeMessageHost {
  readonly shipClient: { leftBerth(): void; readonly hangarOpen: boolean };
  readonly stationWindow: { readonly value?: { readonly isOpen: boolean; close(): void } | null };
  readonly toasts: { show(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void } | null | undefined;
  readonly audio: { playUI(id: string, volume?: number): void };
}

export function onGunRangeState(h: RangeMessageHost, msg: ServerGunRangeStateMessage): void {
  const { entered } = setRangeState(msg);
  if (msg.error) {
    h.toasts?.show(msg.error, 'warn');
    h.audio.playUI('error', 0.5);
  }
  if (entered) {
    // (Let the berth go first: closing the station screen would otherwise ask to undock)
    h.shipClient.leftBerth();
    if (h.stationWindow.value?.isOpen) h.stationWindow.value.close();
    h.audio.playUI('ui_open', 0.5);
  }
}
