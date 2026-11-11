/**
 * @contract client.ui.guest-banner-model
 * owns:       what the guest banner says: the title, the rules in short and the time left, from the server's guestStatus
 * needs:      type-only import of @space-game/common (the guest status message)
 * invariants: the time left counts down from when the status arrived and never goes below zero; an expired guest is told to
 *             register to keep playing — client/src/ui/guest/guestBannerModel.test.ts
 * extend:     the words are here and nowhere else; the DOM that shows them is guestBanner.ts
 */

import type { ServerGuestStatusMessage } from '@space-game/common';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** A span in few words: "2 d 5 h", "5 h 20 m", "12 h", "40 m", "under a minute" (never a part of a unit it can't see: whole units, rounded down) */
export function spanText(ms: number): string {
  if (!(ms >= MIN)) return 'under a minute';
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR);
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / MIN);
    // (From 10 h on minutes are noise: "12 h", not "11 h 59 m")
    return m && h < 10 ? `${h} h ${m} m` : `${h} h`;
  }
  return `${Math.floor(ms / MIN)} m`;
}

export interface GuestBannerModel {
  title: string;
  /** The rules in short, with the time left */
  detail: string;
  /** The 3 days are up: the guest can only register */
  expired: boolean;
  /** Under an hour left to register or play on */
  urgent: boolean;
}

/**
 * The banner for a status that arrived at `receivedAt` (client clock ms), as it reads at `now`. Active: kept `keepMs` after the
 * guest leaves, and gone when the time is up. Expired: wiped when the grace runs out, only registering keeps it
 */
export function guestBannerModel(status: Pick<ServerGuestStatusMessage, 'state' | 'keepMs' | 'expiresInMs'>, receivedAt: number, now: number): GuestBannerModel {
  const left = Math.max(0, status.expiresInMs - Math.max(0, now - receivedAt));
  if (status.state === 'expired') {
    return {
      title: 'Your guest account has expired',
      detail: `Register to keep playing · wiped in ${spanText(left)}`,
      expired: true, urgent: true,
    };
  }
  return {
    title: 'Guest account — register to save your progress',
    detail: `Kept ${spanText(status.keepMs)} after you leave · expires in ${spanText(left)}`,
    expired: false, urgent: left < HOUR,
  };
}
