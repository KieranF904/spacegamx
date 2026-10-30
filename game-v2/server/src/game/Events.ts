/**
 * Dynamic events: things that happen in a system while players are there.
 *   raid     a raiding party heads for a station; drive it off and the station
 *            pays everyone who stayed to defend it
 *   salvage  a freighter breaks up somewhere in the belt: its cargo floats free
 *            (anyone can take it), and scavengers or pirates come for it too
 *   warband  a band of veterans makes camp out on the rim (factions.json
 *            spawns.<system>.events.warband): break it up and everyone who
 *            fought there is paid a bounty
 *   peak     the signal peaks (spawns.<system>.events.peak, Borealis): a flock
 *            of Frost Brood bursts out of where they nest and scatters, and
 *            the rime they shed floats free there (anyone can take it); the
 *            flock flies off and is gone when the peak passes
 * A system's `events` (factions.json) can aim its raids at some stations only,
 * draw raiders and salvagers from a zone's packs, and put wrecks in one belt.
 * Each is announced to the system and shown as a marker until it ends.
 * Events are rolled once a minute per occupied system, with a cooldown.
 */

import { Position, Bag, ServerMessage, mulberry32 } from '@space-game/common';
import type { Enemies, FactionsFile } from './Enemies.js';
import { mergeRules, texts, type RulesPatch, type StringsFile, type Texts } from '../data/rules.js';

export interface EventHost {
  tick(): number;
  systemNum(id: string): number;
  systemId(num: number): string | undefined;
  systemName(num: number): string;
  /** Living players in a system */
  players(systemNum: number): number[];
  /** Station entities in a system, with names (and data ids) */
  stations(systemNum: number): { eid: number; name: string; id?: string }[];
  /** Somewhere in the belt (or extra belt `belt`, 1 the first), away from stations, the star and players */
  openSpace(systemNum: number, belt?: number): { x: number; y: number } | null;
  danger(systemNum: number): number;
  send(systemNum: number, msg: ServerMessage): void;
  announce(systemNum: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad'): void;
  spawnPod(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, lifeSeconds?: number): void;
  /** Pay a player for helping (credits, standing) */
  reward(player: number, credits: number, xp: number, reputation: Record<string, number>, why: string): void;
}

export interface WorldEvent {
  id: number;
  kind: 'raid' | 'salvage' | 'warband' | 'peak';
  systemNum: number;
  title: string;
  text: string;
  x: number;
  y: number;
  endsAt: number;
  ships: number[];
  /** Raids: the station under attack */
  station?: number;
  /** Raids: its name */
  stationName?: string;
  /** Warbands: where its last ship was seen (the bounty's paid round there) */
  last?: { x: number; y: number };
}

/** A system's own event settings (factions.json spawns.<system>.events) */
export interface SystemEvents {
  /** Raids only ever hit these stations (inner Sol's are safe) */
  raidStations?: string[];
  /** Raiders, and whoever answers a mayday, from this zone's packs (not the system's) */
  raidZone?: string;
  salvageZone?: string;
  /** Wrecks in this belt (1: the first extra belt) */
  salvageBelt?: number;
  /** Warbands: their packs (each camp is `packs` of them, the first plated), where they camp (a zone's ring), and how often they're the event */
  warband?: { zone: string; share: number; groups: { faction: string; ships: string[]; weight: number; plating?: number }[] };
  /** Signal peaks: how often they're the event, where the flock bursts out, how many pods of which goods it sheds, and the flock */
  peak?: { share: number; x: number; y: number; pods: number; goods: string[]; flock: { faction: string; ships: string[]; weight: number } };
}

/** Event tuning (data/rules.json `events`; these are the defaults) */
export interface EventRules {
  /** Each occupied system is rolled for an event this often */
  rollEverySeconds: number;
  /** No new event in a system for this long after one starts */
  cooldownSeconds: number;
  /** The chance a roll starts something */
  chance: number;
  /** Of those, the share that are raids (the rest: salvage) */
  raidShare: number;
  /** With nobody in the system, an event ends this long before its time */
  emptyEndSeconds: number;
  raid: {
    packs: number;
    /** Radians between the packs' approaches */
    spread: number;
    /** The packs arrive from this far out, then hold this far from the station */
    spawnRing: number;
    holdRing: number;
    leash: number;
    durationSeconds: number;
    /** Players within this of the station when the raid is driven off are paid (× the system's danger) */
    rewardRange: number;
    creditsPerDanger: number;
    xpPerDanger: number;
    reputation: Record<string, number>;
  };
  warband: {
    packs: number;
    durationSeconds: number;
    /** Players within this of its last ship when it's broken are paid (× the system's danger) */
    rewardRange: number;
    creditsPerDanger: number;
    xpPerDanger: number;
    leash: number;
    reputation: Record<string, number>;
  };
  salvage: {
    goods: string[];
    rare: string[];
    /** podsMin + up to podsExtra - 1 more */
    podsMin: number;
    podsExtra: number;
    /** Each pod: countMin + up to (countSpread + danger) - 1 more of one good */
    countMin: number;
    countSpread: number;
    /** Chance per danger of a rare part as well */
    rareChancePerDanger: number;
    scatterMin: number;
    scatterExtra: number;
    drift: number;
    /** Whoever heard the mayday comes from this far out */
    spawnRing: number;
    leash: number;
    durationSeconds: number;
    /** The pods outlast the event a little (default: a loot pod's own life) */
    podLifeSeconds?: number;
  };
  peak: {
    durationSeconds: number;
    /** Each pod: countMin + up to countSpread - 1 more */
    countMin: number;
    countSpread: number;
    scatterMin: number;
    scatterExtra: number;
    drift: number;
    /** The flock scatters to this far from where it burst out */
    fleeRing: number;
    leash: number;
    podLifeSeconds: number;
  };
}

export const DEFAULT_EVENT_RULES: EventRules = {
  rollEverySeconds: 60,
  cooldownSeconds: 60 * 6,
  chance: 0.35,
  raidShare: 0.5,
  emptyEndSeconds: 60,
  raid: {
    packs: 2, spread: 0.6, spawnRing: 7000, holdRing: 3400, leash: 6000, durationSeconds: 60 * 5,
    rewardRange: 9000, creditsPerDanger: 40, xpPerDanger: 120, reputation: { sol_patrol: 3 },
  },
  warband: { packs: 3, durationSeconds: 60 * 10, rewardRange: 12000, creditsPerDanger: 160, xpPerDanger: 500, leash: 5000, reputation: { sol_patrol: 6 } },
  salvage: {
    goods: ['scrap_electronics', 'alloy_plate', 'copper_wire', 'steel_plate', 'power_coupling', 'servo_motor', 'targeting_chip'],
    rare: ['crystal_lens', 'shield_emitter', 'nav_computer', 'titanium_plate', 'cobalt_alloy'],
    podsMin: 10, podsExtra: 6, countMin: 2, countSpread: 3, rareChancePerDanger: 0.12,
    scatterMin: 150, scatterExtra: 1200, drift: 0.6, spawnRing: 5000, leash: 6000, durationSeconds: 60 * 7, podLifeSeconds: 60 * 8,
  },
  peak: { durationSeconds: 60 * 3, countMin: 2, countSpread: 4, scatterMin: 200, scatterExtra: 1800, drift: 0.8, fleeRing: 16000, leash: 5000, podLifeSeconds: 60 * 5 },
};

/** Event text (data/strings.json; these are the defaults) */
export const EVENT_STRINGS = {
  'events.raid.title': 'Raid on {station}',
  'events.raid.text': 'Raiders are closing on {station}! Drive them off and the station will pay its defenders.',
  'events.raid.announce': '⚠ {text}',
  'events.raid.over': 'The raid on {station} is over. The station thanks its defenders.',
  'events.raid.pulledBack': 'The raiders have pulled back.',
  'events.salvage.title': 'Freighter wreck',
  'events.salvage.text': 'A freighter broke up in the belt. Its cargo is floating free: first come, first served. Others are on their way.',
  'events.warband.title': '{faction} warband',
  'events.warband.text': 'A {faction} warband has made camp out on the rim. Break it up and the patrol pays a bounty to everyone who fought.',
  'events.warband.over': 'The {faction} warband is broken. The bounty is paid.',
  'events.warband.gone': 'The {faction} warband has moved on.',
  'events.peak.title': 'Signal peak',
  'events.peak.text': 'The heartbeat peaks. The Frost Brood burst out of the Curtain and scatter, shedding rime as they go: it is anyone\'s for the taking.',
  'events.peak.over': 'The peak has passed. The Brood drift back to the Curtain.',
};

const SECOND = 60;

export class Events {
  private live = new Map<number, WorldEvent>();
  private nextId = 1;
  private cooldown = new Map<number, number>();
  private rng = mulberry32(0xe7e7);
  readonly rules: EventRules;
  private t: Texts<keyof typeof EVENT_STRINGS>;

  /** `rules`: data/rules.json `events` (over the defaults); `strings`: data/strings.json */
  constructor(private host: EventHost, private enemies: Enemies, private factions: FactionsFile, rules?: RulesPatch<EventRules>, strings?: StringsFile) {
    this.rules = mergeRules(DEFAULT_EVENT_RULES, rules);
    this.t = texts(EVENT_STRINGS, strings);
  }

  active(systemNum?: number): WorldEvent[] {
    return [...this.live.values()].filter((e) => systemNum === undefined || e.systemNum === systemNum);
  }

  tick(): void {
    const now = this.host.tick();
    for (const e of [...this.live.values()]) this.step(e, now);
    if (now % (this.rules.rollEverySeconds * SECOND) !== 0) return;
    for (const sysId of Object.keys(this.factions.spawns)) {
      const num = this.host.systemNum(sysId);
      if (num < 0 || !this.host.players(num).length || this.active(num).length) continue;
      if (now < (this.cooldown.get(num) ?? 0) || this.rng() > this.rules.chance) continue;
      const cfg = this.config(num), wb = cfg.warband;
      if (cfg.peak && this.rng() < cfg.peak.share && this.startPeak(num)) continue;
      if (wb && this.rng() < wb.share && this.startWarband(num)) continue;
      if (this.rng() < this.rules.raidShare && this.startRaid(num)) continue;
      this.startSalvage(num);
    }
  }

  /** Start a raid now (tests, admin). Returns the event or null. */
  startRaid(num: number): WorldEvent | null {
    const R = this.rules.raid;
    const cfg = this.config(num);
    const stations = this.host.stations(num).filter((s) => !cfg.raidStations || (s.id !== undefined && cfg.raidStations.includes(s.id)));
    const groups = this.groupsOf(num, cfg.raidZone);
    if (!stations.length || !groups.length) return null;
    const st = stations[Math.floor(this.rng() * stations.length)];
    const sx = Position.x[st.eid], sy = Position.y[st.eid];
    const a = this.rng() * Math.PI * 2;
    // Two packs come in from out of sight, then hang about just outside the station's guns
    const ships: number[] = [];
    for (let k = 0; k < R.packs; k++) {
      const g = groups[Math.floor(this.rng() * groups.length)];
      const b = a + (k - 0.5) * R.spread;
      ships.push(...this.enemies.spawnPack(num, g, sx + Math.cos(b) * R.spawnRing, sy + Math.sin(b) * R.spawnRing));
    }
    const hold = { x: sx + Math.cos(a) * R.holdRing, y: sy + Math.sin(a) * R.holdRing };
    this.enemies.sendPack(ships, hold, R.leash);
    const e = this.add({
      kind: 'raid', systemNum: num, title: this.t('events.raid.title', { station: st.name }),
      text: this.t('events.raid.text', { station: st.name }),
      x: hold.x, y: hold.y, endsAt: this.host.tick() + R.durationSeconds * SECOND, ships, station: st.eid, stationName: st.name,
    });
    this.host.announce(num, this.t('events.raid.announce', { text: e.text }), 'warn');
    return e;
  }

  /** Start a salvage field now (tests, admin) */
  startSalvage(num: number): WorldEvent | null {
    const S = this.rules.salvage;
    const cfg = this.config(num);
    const at = this.host.openSpace(num, cfg.salvageBelt);
    if (!at) return null;
    const d = Math.max(1, this.host.danger(num));
    const goods = S.goods;
    const rare = S.rare;
    const pods = S.podsMin + Math.floor(this.rng() * S.podsExtra);
    for (let i = 0; i < pods; i++) {
      const bag: Bag = {};
      const id = goods[Math.floor(this.rng() * goods.length)];
      bag[id] = S.countMin + Math.floor(this.rng() * (S.countSpread + d));
      if (this.rng() < S.rareChancePerDanger * d) bag[rare[Math.floor(this.rng() * rare.length)]] = 1;
      const a = this.rng() * Math.PI * 2, r = S.scatterMin + this.rng() * S.scatterExtra;
      this.host.spawnPod(num, at.x + Math.cos(a) * r, at.y + Math.sin(a) * r, Math.cos(a) * S.drift, Math.sin(a) * S.drift, bag, S.podLifeSeconds);
    }
    // Something else heard the mayday
    const groups = this.groupsOf(num, cfg.salvageZone);
    const ships: number[] = [];
    if (groups.length) {
      const g = groups[Math.floor(this.rng() * groups.length)];
      const a = this.rng() * Math.PI * 2;
      ships.push(...this.enemies.spawnPack(num, g, at.x + Math.cos(a) * S.spawnRing, at.y + Math.sin(a) * S.spawnRing));
      this.enemies.sendPack(ships, at, S.leash);
    }
    const e = this.add({
      kind: 'salvage', systemNum: num, title: this.t('events.salvage.title'),
      text: this.t('events.salvage.text'),
      x: at.x, y: at.y, endsAt: this.host.tick() + S.durationSeconds * SECOND, ships,
    });
    this.host.announce(num, e.text, 'info');
    return e;
  }

  /** Start a warband camp now (tests, admin) */
  startWarband(num: number): WorldEvent | null {
    const W = this.rules.warband;
    const wb = this.config(num).warband;
    const zone = wb && this.factions.spawns[this.host.systemId(num) ?? '']?.zones?.find((z) => z.id === wb.zone);
    if (!wb || !zone || !wb.groups.length) return null;
    // Somewhere on the rim, well away from the pilots there
    const players = this.host.players(num);
    let at: { x: number; y: number } | null = null;
    for (let i = 0; i < 30 && !at; i++) {
      const a = this.rng() * Math.PI * 2, r = zone.inner + (0.3 + 0.6 * this.rng()) * (zone.outer - zone.inner);
      const x = (zone.x ?? 0) + Math.cos(a) * r, y = (zone.y ?? 0) + Math.sin(a) * r;
      if (players.every((p) => Math.hypot(Position.x[p] - x, Position.y[p] - y) > 9000)) at = { x, y };
    }
    if (!at) return null;
    const ships: number[] = [];
    const lead = wb.groups[Math.floor(this.rng() * wb.groups.length)];
    for (let k = 0; k < W.packs; k++) {
      const g = k === 0 ? lead : wb.groups[Math.floor(this.rng() * wb.groups.length)];
      const a = (k / W.packs) * Math.PI * 2;
      const eids = this.enemies.spawnPack(num, { ...g, plating: (g.plating ?? 0) + (k === 0 ? 1 : 0) }, at.x + Math.cos(a) * 900, at.y + Math.sin(a) * 900);
      this.enemies.sendPack(eids, at, W.leash);
      ships.push(...eids);
    }
    if (!ships.length) return null;
    const faction = this.factions.factions[lead.faction]?.name ?? lead.faction;
    const e = this.add({
      kind: 'warband', systemNum: num, title: this.t('events.warband.title', { faction }), text: this.t('events.warband.text', { faction }),
      x: at.x, y: at.y, endsAt: this.host.tick() + W.durationSeconds * SECOND, ships, last: { ...at }, stationName: faction,
    });
    this.host.announce(num, `⚔ ${e.text}`, 'warn');
    return e;
  }

  /** Start a signal peak now (tests, admin): the flock bursts out and scatters, its rime floats free */
  startPeak(num: number): WorldEvent | null {
    const P = this.rules.peak;
    const pk = this.config(num).peak;
    if (!pk || !pk.goods.length) return null;
    const at = { x: pk.x, y: pk.y };
    for (let i = 0; i < pk.pods; i++) {
      const id = pk.goods[Math.floor(this.rng() * pk.goods.length)];
      const a = this.rng() * Math.PI * 2, r = P.scatterMin + this.rng() * P.scatterExtra;
      this.host.spawnPod(num, at.x + Math.cos(a) * r, at.y + Math.sin(a) * r, Math.cos(a) * P.drift, Math.sin(a) * P.drift, { [id]: P.countMin + Math.floor(this.rng() * P.countSpread) }, P.podLifeSeconds);
    }
    // The flock bursts out of the middle and flies off, away from it
    const away = this.rng() * Math.PI * 2;
    const ships = this.enemies.spawnPack(num, pk.flock, at.x, at.y);
    this.enemies.sendPack(ships, { x: at.x + Math.cos(away) * P.fleeRing, y: at.y + Math.sin(away) * P.fleeRing }, P.leash);
    const e = this.add({
      kind: 'peak', systemNum: num, title: this.t('events.peak.title'), text: this.t('events.peak.text'),
      x: at.x, y: at.y, endsAt: this.host.tick() + P.durationSeconds * SECOND, ships,
    });
    this.host.announce(num, e.text, 'info');
    return e;
  }

  /** A system's own event settings */
  private config(num: number): SystemEvents {
    return (this.factions.spawns[this.host.systemId(num) ?? ''] as { events?: SystemEvents } | undefined)?.events ?? {};
  }

  /** Packs for an event: a zone's, or the system's own */
  private groupsOf(num: number, zone?: string): { faction: string; ships: string[]; weight: number; passive?: boolean }[] {
    const sp = this.factions.spawns[this.host.systemId(num) ?? ''];
    const z = zone ? sp?.zones?.find((q) => q.id === zone) : undefined;
    return z?.groups ?? sp?.groups ?? [];
  }

  private add(e: Omit<WorldEvent, 'id'>): WorldEvent {
    const ev: WorldEvent = { ...e, id: this.nextId++ };
    this.live.set(ev.id, ev);
    this.cooldown.set(ev.systemNum, this.host.tick() + this.rules.cooldownSeconds * SECOND);
    this.host.send(ev.systemNum, { type: 'worldEvent', id: ev.id, kind: ev.kind, title: ev.title, text: ev.text, x: Math.round(ev.x), y: Math.round(ev.y), seconds: Math.round((ev.endsAt - this.host.tick()) / 60) });
    return ev;
  }

  private step(e: WorldEvent, now: number): void {
    const left = e.ships.filter((s) => this.enemies.isAlive(s));
    if (e.kind === 'warband') {
      if (left.length) e.last = { x: Position.x[left[0]], y: Position.y[left[0]] };
      else {
        // Broken: the bounty to everyone who was there for it
        const W = this.rules.warband;
        const d = Math.max(1, this.host.danger(e.systemNum));
        const at = e.last ?? { x: e.x, y: e.y };
        for (const p of this.host.players(e.systemNum)) {
          if (Math.hypot(Position.x[p] - at.x, Position.y[p] - at.y) > W.rewardRange) continue;
          this.host.reward(p, W.creditsPerDanger * d, W.xpPerDanger * d, { ...W.reputation }, 'warband');
        }
        this.host.announce(e.systemNum, this.t('events.warband.over', { faction: e.stationName ?? '' }), 'good');
        return this.end(e);
      }
    }
    if (e.kind === 'raid' && !left.length) {
      // Driven off: pay whoever stayed to fight (in the system, near the station)
      const R = this.rules.raid;
      const sx = e.station !== undefined ? Position.x[e.station] : e.x, sy = e.station !== undefined ? Position.y[e.station] : e.y;
      const d = Math.max(1, this.host.danger(e.systemNum));
      for (const p of this.host.players(e.systemNum)) {
        if (Math.hypot(Position.x[p] - sx, Position.y[p] - sy) > R.rewardRange) continue;
        this.host.reward(p, R.creditsPerDanger * d, R.xpPerDanger * d, { ...R.reputation }, 'raid');
      }
      this.host.announce(e.systemNum, this.t('events.raid.over', { station: e.stationName ?? e.title }), 'good');
      return this.end(e);
    }
    if (now >= e.endsAt || !this.host.players(e.systemNum).length && now >= e.endsAt - this.rules.emptyEndSeconds * SECOND) {
      if (e.kind === 'raid') this.host.announce(e.systemNum, this.t('events.raid.pulledBack'), 'info');
      if (e.kind === 'warband') {
        this.host.announce(e.systemNum, this.t('events.warband.gone', { faction: e.stationName ?? '' }), 'info');
        for (const s of left) this.enemies.retire?.(s);
      }
      if (e.kind === 'peak') {
        this.host.announce(e.systemNum, this.t('events.peak.over'), 'info');
        for (const s of left) this.enemies.retire?.(s);
      }
      this.end(e);
    }
  }

  private end(e: WorldEvent): void {
    this.live.delete(e.id);
    this.host.send(e.systemNum, { type: 'worldEventEnd', id: e.id });
  }

  /** Everything a player arriving in a system should know about */
  briefing(systemNum: number): ServerMessage[] {
    const now = this.host.tick();
    return this.active(systemNum).map((e) => ({ type: 'worldEvent', id: e.id, kind: e.kind, title: e.title, text: e.text, x: Math.round(e.x), y: Math.round(e.y), seconds: Math.round((e.endsAt - now) / 60) }));
  }

}
