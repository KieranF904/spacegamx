/**
 * Your station (common/src/econ/outpost.ts, data/station.json): charter it at
 * one of the sites, then build its tracks up a tier at a time. A tier takes
 * its materials from storage (and the hold) at once and finishes on the wall
 * clock, whether the pilot's on or not; it's finished off when they next come
 * by (each second while they're on, and at login).
 */

import { unlocks, type StationFile, type StationData } from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';

export interface OutpostHost {
  now(): number;
  /** The station the pilot is docked at (or in range of), if any */
  stationAt(conn: PilotConn): StationData | null;
  stationName(id: string): string;
}

export class Outpost {
  constructor(private host: OutpostHost, private pilots: Pilots, private file: StationFile) {}

  /** Charter a station at a site (docked at the site's station) */
  charter(conn: PilotConn, site: string): void {
    const p = this.pilots.get(conn);
    const s = this.file.sites.find((x) => x.id === site);
    if (!p || !s) return;
    if (p.outpost) return this.pilots.toast(conn, 'You have a station already', 'warn');
    const c = this.file.charter;
    if (p.level < c.level) return this.pilots.toast(conn, `A station charter takes pilot level ${c.level}`, 'warn');
    if (this.host.stationAt(conn)?.id !== s.station) return this.pilots.toast(conn, `Charter it at ${this.host.stationName(s.station)}`, 'warn');
    if (p.credits < c.credits) return this.pilots.toast(conn, `A charter costs ${c.credits.toLocaleString()} cr`, 'warn');
    if (!this.pilots.take(conn, c.items)) return this.pilots.toast(conn, `A charter takes ${Object.entries(c.items).map(([id, n]) => `${n} × ${this.pilots.econ.items.name(id)}`).join(', ')}`, 'warn');
    this.pilots.addCredits(conn, -c.credits);
    p.outpost = { site, tracks: {} };
    this.pilots.markDirty(conn);
    this.pilots.saveNow(conn);
    this.pilots.sendProfile(conn);
    this.pilots.toast(conn, `Your station is chartered at ${s.name}. Build it up from the station window (Your station)`, 'good');
  }

  /** Start the next tier of a track (one build at a time) */
  upgrade(conn: PilotConn, track: string): void {
    const p = this.pilots.get(conn);
    const def = this.file.tracks[track];
    if (!p || !def) return;
    const o = p.outpost;
    if (!o) return this.pilots.toast(conn, 'Charter a station first', 'warn');
    this.finish(conn);
    if (o.build) return this.pilots.toast(conn, `Your station is busy with ${this.file.tracks[o.build.track]?.name ?? o.build.track} ${o.build.tier}`, 'warn');
    const tier = (o.tracks[track] ?? 0) + 1;
    const next = def.tiers[tier - 1];
    if (!next) return this.pilots.toast(conn, `${def.name} is built as far as it goes`, 'info');
    if (!this.pilots.take(conn, next.cost)) return this.pilots.toast(conn, `${def.name} ${tier} takes ${Object.entries(next.cost).map(([id, n]) => `${n} × ${this.pilots.econ.items.name(id)}`).join(', ')}`, 'warn');
    o.build = { track, tier, readyAt: this.host.now() + next.minutes * 60_000 };
    this.pilots.markDirty(conn);
    this.pilots.saveNow(conn);
    this.pilots.sendItems(conn);
    this.pilots.sendProfile(conn);
    this.pilots.toast(conn, `Building ${def.name} ${tier}: ${next.name}. Ready in ${fmt(next.minutes)}`, 'info');
  }

  /** A finished build takes effect */
  finish(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    const b = p?.outpost?.build;
    if (!p || !b || this.host.now() < b.readyAt) return;
    p.outpost!.tracks[b.track] = b.tier;
    delete p.outpost!.build;
    while (p.hangar.length < unlocks(p).hangarSlots) p.hangar.push(null);
    this.pilots.markDirty(conn);
    this.pilots.sendProfile(conn);
    const def = this.file.tracks[b.track];
    this.pilots.toast(conn, `Your station: ${def?.name ?? b.track} ${b.tier} is built (${def?.tiers[b.tier - 1]?.name ?? ''})`, 'good');
  }
}

function fmt(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
