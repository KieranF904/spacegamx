/**
 * @contract client.ui.station-shared
 * owns:       what every station window tab shares: tab ids, StationWindowDeps, StationCtx, the station data files
 *             and text helpers
 * needs:      @space-game/common types, econ/clientEcon, data JSON files, ui/escape
 * invariants: the repair bank tab behaves as its store says — none pinned
 * extend:     a new tab id goes in Tab, a new shared need on StationCtx (built once in StationWindow.ts), and a new
 *             tab is a module under ui/station/ plus a line in StationWindow's tab list and render()
 */

/**
 * Station window: what every tab shares.
 *
 * Owns: the tab ids, `StationWindowDeps` (what the window gets from the game), `StationCtx` (what a
 * tab gets from the window), the station data files read once (docking fees, quartermaster
 * stations, your-station file, gems file) and the small text helpers the tabs use.
 * Needs: nothing from the window; the window builds the context and hands it to each tab.
 * Extend: a new tab id goes in `Tab`; a new thing every tab needs goes on `StationCtx`
 * (implemented once, in StationWindow.ts); a new tab is one module under ui/station/ with a class
 * taking a `StationCtx` and a `render(body)`, plus a line each in StationWindow's tab list and render().
 */

import type { ClientMessage, OrderLine, OrderPlan, QuestsFile, ServerStationMessage, GemsFile, StationFile } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import type { QuestClient } from '../QuestUI';
import questsData from '../../../../data/quests.json';
import stationsData from '../../../../data/stations.json';
import gemsData from '../../../../data/gems.json';
import stationData from '../../../../data/station.json';
import { esc } from '../escape';
export { esc };

export type Tab = 'overview' | 'ships' | 'contracts' | 'market' | 'vendors' | 'refinery' | 'fabricator' | 'outpost' | 'bank';

export interface StationWindowDeps {
  pilot: PilotState;
  send(m: ClientMessage): void;
  sound(id: string, volume?: number): void;
  openHangar(slot?: number): void;
  openInventory(): void;
  onClose(): void;
  quests: QuestClient;
}

/** What the window gives each tab (implemented once, in StationWindow.ts) */
export interface StationCtx {
  readonly d: StationWindowDeps;
  /** The station's last message (the tabs only render once there is one) */
  readonly st: ServerStationMessage | null;
  /** How many of an item the pilot has (cargo and storage) */
  have(id: string): number;
  /** Server time now (the local clock plus the skew the station message gave) */
  now(): number;
  /** Orders, against the freshest jobs (the station's) */
  orders(): OrderPlan[];
  /** Redraw the open tab (scroll positions are kept) */
  render(): void;
  /** Update just the job lists in the body */
  renderJobs(): void;
}

/** Outer-ring stations' docking fees (from DOCK_FEE_LEVEL) */
export const DOCK_FEES = new Map((stationsData.stations as { id: string; dockingFee?: number }[]).filter((s) => s.dockingFee).map((s) => [s.id, s.dockingFee!]));

/** Stations with a faction quartermaster */
export const VENDOR_STATIONS = new Set(Object.values((questsData as unknown as QuestsFile).reputations).flatMap((r) => r.vendor?.stations ?? []));

export const GEMS = gemsData as unknown as GemsFile;
export const STATION = stationData as unknown as StationFile;
const STATION_NAMES: Record<string, string> = Object.fromEntries(((stationsData as unknown as { stations: { id: string; name: string }[] }).stations ?? []).map((s) => [s.id, s.name]));
export const stationName = (id: string) => STATION_NAMES[id] ?? id;


/** "for the hull & armour, Pulse Laser" */
export function forText(l: OrderLine): string {
  return l.for.map((f) => (f === 'structure' ? 'hull & armour' : f)).join(', ');
}

/** "Iron Ore" → "Iron" for the compact gather list */
export function shortName(name: string): string {
  return name.replace(/ Ore$/, '');
}

/** A bill line's state: ready, being made, waiting, short */
export function lineStatus(l: OrderLine): string {
  const bits: string[] = [];
  if (l.ready) bits.push(`<span style="color:#86efac">✓ ${l.ready}</span>`);
  if (l.coming) bits.push(`<span style="color:#7dd3fc">⏳ ${l.coming}</span>`);
  if (l.waiting) bits.push(`<span style="color:#fbbf24" title="${l.blocked === 'queue' ? 'Next, when a queue slot frees' : 'Waiting for what it is made from'}">◷ ${l.waiting}</span>`);
  if (l.short) bits.push(`<span style="color:#fca5a5" title="${l.blocked === 'schematic' ? 'It opens at a later level' : 'Gather or buy it'}">${l.blocked === 'schematic' ? '🔒' : '✕'} ${l.short}</span>`);
  return bits.join(' ');
}

/** The window's scrolling lists, in page order (a re-render builds the same ones in the same order) */
export function scrollsOf(b: HTMLElement): HTMLElement[] {
  return [b, ...[...b.querySelectorAll<HTMLElement>('*')].filter((el) => /auto|scroll/.test(el.style.overflowY))];
}

export function fmt(s: number): string {
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
