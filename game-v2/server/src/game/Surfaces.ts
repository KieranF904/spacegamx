/**
 * Planet surfaces: small bounded systems of their own (systems.json entries
 * with `surface`), shared by everyone. Press X in orbit close to a planet
 * that has one and you descend, arriving on the side you came in from; fly
 * past its edge and you climb back to orbit beside the planet.
 *
 * A surface with a city and a `siege` is attacked every so often while pilots
 * are there: a warning, then waves of raiders from the edge of the map going
 * for the city's shield pylons. Break every wave with a pylon standing and
 * everyone who fought near the city is paid; lose every pylon and the city's
 * shields fall (the pylons are rebuilt before the next siege).
 *
 * The siege's state goes to the pilots on the surface as `objective`
 * messages (a banner: title, a line of text, pylons left).
 *
 * Pockets (systems.json `pocket`: a boss's nest) travel the same way without
 * being surfaces: X at the way in, out in another system, takes you in; fly
 * past the pocket's edge and you're back beside the way in.
 */

import { moonOffset, planetPosition, pocketAt, pocketExit, type PlanetData, type ServerMessage, type StarSystemData, datan2, dcos, dhypot, dsin, mulberry32 } from '@space-game/common';
import type { PilotConn } from './Pilots.js';
import { mergeRules, texts, type RulesPatch, type StringsFile, type Texts } from '../data/rules.js';

export interface SurfaceHost {
  tick(): number;
  systems(): StarSystemData[];
  systemNum(id: string): number;
  /** Every copy of a system (instanced ones have several) */
  instances(id: string): number[];
  /** Pilots flying in a system (alive) */
  pilots(num: number): { conn: PilotConn; eid: number; x: number; y: number }[];
  travel(conn: PilotConn, num: number, x: number, y: number): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** A structure players defend (a ward hostiles go for); returns its entity */
  /** A structure players defend, built in `grade` (default: as designed); returns its entity (-1: couldn't) */
  spawnStructure(design: string, num: number, x: number, y: number, name: string, grade?: number): number;
  removeStructure(eid: number): void;
  /** A ship (structure or raider) still there: where, and how whole (0..1) */
  shipAt(eid: number): { x: number; y: number; hull: number } | null;
  /** Mend a structure fully */
  repairStructure(eid: number): void;
  /** Hostiles of a faction at a point, sent at another */
  spawnRaid(num: number, faction: string, x: number, y: number, size: number, at: { x: number; y: number }): number[];
  sendRaid(eids: number[], at: { x: number; y: number }): void;
  hostileAlive(eid: number): boolean;
  removeHostile(eid: number): void;
  reward(conn: PilotConn, xp: number, credits: number, label: string): void;
  send(num: number, msg: ServerMessage): void;
  announce(num: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad'): void;
}

const SECOND = 60;
const PYLON = 'city_pylon';

/** Surface and city-siege tuning (data/rules.json `surfaces`; these are the defaults) */
export interface SurfaceRules {
  /** How close to a planet's edge (beyond its radius) X takes you down */
  descendRange: number;
  /** Climbing back up: this much further out than descendRange */
  orbitMargin: number;
  /** Descending to an open surface: arrive this far out (of its radius) */
  arriveRadius: number;
  warningSeconds: number;
  pauseSeconds: number;
  /** Nobody near for this long and a siege is called off */
  abandonSeconds: number;
  /** After the shields fall, the raiders stay this long */
  fallenSeconds: number;
  /** The first siege comes after this share of `everySeconds` */
  firstSiegeShare: number;
  /** Pilots within this many city radii count as defending */
  defendRadius: number;
  /** Raiders are re-sent at the nearest pylon this often (ticks) */
  retargetTicks: number;
  /** Wave size: min(maxSize, base + perWave × wave + perExtraPilot × (pilots - 1)), from two fronts at `twoFrontsFrom`, spawned at spawnRadius × the map's radius */
  wave: { base: number; perWave: number; perExtraPilot: number; maxSize: number; twoFrontsFrom: number; spawnRadius: number };
  /** Holding pays each defender base + perWave × the siege's waves */
  reward: { xpBase: number; xpPerWave: number; creditsBase: number; creditsPerWave: number };
}

export const DEFAULT_SURFACE_RULES: SurfaceRules = {
  descendRange: 900,
  orbitMargin: 400,
  arriveRadius: 0.8,
  warningSeconds: 20,
  pauseSeconds: 12,
  abandonSeconds: 60,
  fallenSeconds: 20,
  firstSiegeShare: 0.5,
  defendRadius: 2.2,
  retargetTicks: 120,
  wave: { base: 2, perWave: 1, perExtraPilot: 2, maxSize: 12, twoFrontsFrom: 3, spawnRadius: 0.85 },
  reward: { xpBase: 120, xpPerWave: 90, creditsBase: 150, creditsPerWave: 110 },
};

/** Surface text (data/strings.json; these are the defaults) */
export const SURFACE_STRINGS = {
  'surfaces.notOpen': 'Not open yet',
  'surfaces.downOn': 'Down on {name}. Fly out past the edge to return to orbit',
  'surfaces.entering': "Entering {name}'s atmosphere. Fly out past the edge to return to orbit",
  'surfaces.backInOrbit': 'Back in orbit over {name}',
  'surfaces.cave': 'Down into {name}. Fly out past the edge to climb back up',
  'surfaces.surfacing': 'Back up on {name}',
  'surfaces.pocket.in': 'Into {name}. Fly out past its edge to leave',
  'surfaces.pocket.out': 'Back out of {name}',
  'surfaces.pylonName': '{city} shield pylon',
  'surfaces.siege.inbound': 'Raiders inbound to {city}! Defend the shield pylons',
  'surfaces.siege.waveBroken': 'Wave {wave} broken. The next is {secs} seconds out',
  'surfaces.siege.wave': 'Wave {wave} of {waves}: {raiders} raiders',
  'surfaces.siege.held': '{city} holds! Every pilot who defended it has been paid',
  'surfaces.siege.fell': "{city}'s shields have fallen. The raiders loot the outer districts and pull back",
  'surfaces.banner.title': 'Siege of {city}',
  'surfaces.banner.warning': 'Raiders inbound in {secs}s',
  'surfaces.banner.pause': 'Wave {wave} of {waves} broken · next in {secs}s',
  'surfaces.banner.wave': 'Wave {wave} of {waves} · {left} raider{s} left',
  'surfaces.banner.fallen': 'The shields have fallen',
  'surfaces.banner.meter': 'Shield pylons',
};

interface Siege {
  num: number;
  sys: StarSystemData;
  phase: 'calm' | 'warning' | 'wave' | 'pause' | 'fallen';
  next: number;
  wave: number;
  pylons: number[];
  raiders: number[];
  /** Pilots who fought near the city this siege */
  defenders: Set<PilotConn>;
  lastPilots: number;
  /** Last banner sent (only changes are sent) */
  shown: string;
}

/** Where a pilot goes down to their own (or their party's) copy of a siege moon (or why they can't) */
export type PartyEntry = (conn: PilotConn, surface: StarSystemData) => { num: number; x: number; y: number } | string;

export class Surfaces {
  private sieges = new Map<number, Siege>();
  /** Server-only randomness, seeded (math/rng.ts): where a raid comes from */
  private rng = mulberry32(0x5f4ce);
  private surfaces: StarSystemData[];
  private pockets: StarSystemData[];
  /** Siege moons (a surface with a bastion: everyone gets their own copy) are handed to this */
  partyEntry: PartyEntry | null = null;

  readonly rules: SurfaceRules;
  private t: Texts<keyof typeof SURFACE_STRINGS>;

  /** `rules`: data/rules.json `surfaces` (over the defaults); `strings`: data/strings.json */
  constructor(private host: SurfaceHost, rules?: RulesPatch<SurfaceRules>, strings?: StringsFile) {
    this.rules = mergeRules(DEFAULT_SURFACE_RULES, rules);
    this.t = texts(SURFACE_STRINGS, strings);
    this.surfaces = host.systems().filter((s) => s.surface);
    this.pockets = host.systems().filter((s) => s.pocket);
  }

  /** Is this system (any copy) a planet's or moon's surface */
  isSurface(num: number): boolean {
    return this.surfaces.some((s) => this.host.instances(s.id).includes(num));
  }

  /** The body (planet or moon) a surface belongs to, and where it is now */
  bodyOf(surface: StarSystemData, tick: number): { name: string; radius: number; x: number; y: number; system: string } | null {
    const sd = surface.surface!;
    const parent = this.host.systems().find((x) => x.id === sd.of);
    const planet = parent?.planets?.find((pl) => pl.id === sd.planet);
    if (!parent || !planet) return null;
    const p = planetPosition(planet, tick);
    if (sd.moon === undefined) return { name: planet.name, radius: planet.radius, x: p.x, y: p.y, system: parent.id };
    const m = planet.moons?.[sd.moon];
    if (!m) return null;
    const o = moonOffset(planet, sd.moon, tick);
    return { name: m.name ?? `${planet.name}'s moon`, radius: m.radius, x: p.x + o.x, y: p.y + o.y, system: parent.id };
  }

  /** The surface below a pilot in orbit, if they're close enough to descend */
  surfaceNear(system: StarSystemData, x: number, y: number, tick: number): { name: string; surface: StarSystemData; px: number; py: number } | null {
    for (const surface of this.surfaces) {
      // A job's arena has no way down from orbit (Arenas.ts sends you), nor has a cave (it's entered from its surface)
      if (surface.surface!.of !== system.id || surface.surface!.arena || surface.surface!.under) continue;
      const b = this.bodyOf(surface, tick);
      if (b && dhypot(x - b.x, y - b.y) < b.radius + this.rules.descendRange) return { name: b.name, surface, px: b.x, py: b.y };
    }
    return null;
  }

  /** X in orbit: down to the surface below, arriving on the side you came in from. True if it did. */
  descend(conn: PilotConn, system: StarSystemData, x: number, y: number): boolean {
    // A pocket's way in here: in you go (everyone shares it, as a cave)
    const pocket = pocketAt(this.pockets, system.id, x, y);
    if (pocket) {
      const p = pocket.pocket!;
      this.host.travel(conn, this.host.systemNum(pocket.id), p.landing.x, p.landing.y);
      this.host.toast(conn, this.t('surfaces.pocket.in', { name: p.entrance.name }), 'info');
      return true;
    }
    // On a surface: a cave's mouth here takes you down into it
    const cave = this.caveNear(system, x, y);
    if (cave) {
      const land = cave.surface!.landing ?? { x: 0, y: 0 };
      this.host.travel(conn, this.host.systemNum(cave.id), land.x, land.y);
      this.host.toast(conn, this.t('surfaces.cave', { name: cave.surface!.under!.name ?? cave.name }), 'info');
      return true;
    }
    const near = this.surfaceNear(system, x, y, this.host.tick());
    if (!near) return false;
    if (near.surface.surface!.bastion) {
      const to = this.partyEntry?.(conn, near.surface) ?? this.t('surfaces.notOpen');
      if (typeof to === 'string') { this.host.toast(conn, to, 'warn'); return true; }
      this.host.travel(conn, to.num, to.x, to.y);
      this.host.toast(conn, this.t('surfaces.downOn', { name: near.name }), 'info');
      return true;
    }
    const a = datan2(y - near.py, x - near.px);
    const r = near.surface.surface!.radius * this.rules.arriveRadius;
    // (a surface with its own landing spot: there, whichever way you came in)
    const land = near.surface.surface!.landing;
    this.host.travel(conn, this.host.systemNum(near.surface.id), land ? land.x : dcos(a) * r, land ? land.y : dsin(a) * r);
    this.host.toast(conn, this.t('surfaces.entering', { name: near.name }), 'info');
    return true;
  }

  /** A cave whose mouth is on this surface, close enough to go down into */
  caveNear(system: StarSystemData, x: number, y: number): StarSystemData | null {
    if (!system.surface) return null;
    for (const s of this.surfaces) {
      const u = s.surface!.under;
      if (u && u.surface === system.id && dhypot(x - u.x, y - u.y) < u.radius) return s;
    }
    return null;
  }

  /** Back up to orbit beside a surface's planet or moon (on the side of `angle`) */
  toOrbit(conn: PilotConn, surface: StarSystemData, angle: number): void {
    const b = this.bodyOf(surface, this.host.tick());
    if (!b) return;
    const d = b.radius + this.rules.descendRange + this.rules.orbitMargin;
    this.host.travel(conn, this.host.systemNum(b.system), b.x + dcos(angle) * d, b.y + dsin(angle) * d);
    this.host.toast(conn, this.t('surfaces.backInOrbit', { name: b.name }), 'info');
  }

  tick(): void {
    const now = this.host.tick();
    if (now % 10 !== 0) return;
    for (const s of this.surfaces) {
      for (const num of this.host.instances(s.id)) {
        const pilots = this.host.pilots(num);
        // Past the edge: back to orbit, beside the planet (or moon) on that side
        for (const p of pilots) {
          if (dhypot(p.x, p.y) <= s.surface!.radius) continue;
          // Out of a cave: back up beside its mouth (south of it); out of anything else: back to orbit
          const u = s.surface!.under;
          if (u) {
            this.host.travel(p.conn, this.host.systemNum(u.surface), u.x, u.y + u.radius + 700);
            this.host.toast(p.conn, this.t('surfaces.surfacing', { name: this.host.systems().find((x) => x.id === u.surface)?.name ?? u.surface }), 'info');
          } else this.toOrbit(p.conn, s, datan2(p.y, p.x));
        }
        if (s.surface!.city && s.surface!.siege) this.stepSiege(s, num, pilots, now);
      }
    }
    // Out past a pocket's edge: back beside its way in, on the side you came out
    for (const s of this.pockets) {
      for (const num of this.host.instances(s.id)) {
        for (const p of this.host.pilots(num)) {
          if (dhypot(p.x, p.y) <= s.pocket!.radius) continue;
          const out = pocketExit(s, datan2(p.y, p.x));
          if (!out) continue;
          this.host.travel(p.conn, this.host.systemNum(out.system), out.x, out.y);
          this.host.toast(p.conn, this.t('surfaces.pocket.out', { name: s.pocket!.entrance.name }), 'info');
        }
      }
    }
  }

  /** Bring a surface's siege on now (admin). False if it has none, or one is already on. */
  startSiege(num: number): boolean {
    const g = this.sieges.get(num);
    if (!g || g.phase !== 'calm') return false;
    g.next = this.host.tick();
    return true;
  }

  /** What a pilot arriving should be told (the banner, if a siege is on) */
  briefing(num: number): ServerMessage[] {
    const g = this.sieges.get(num);
    return g && g.shown ? [JSON.parse(g.shown)] : [];
  }

  // ---------------------------------------------------------------------------

  private stepSiege(s: StarSystemData, num: number, pilots: { conn: PilotConn; eid: number; x: number; y: number }[], now: number): void {
    const city = s.surface!.city!, cfg = s.surface!.siege!, R = this.rules;
    let g = this.sieges.get(num);
    if (!g) {
      g = { num, sys: s, phase: 'calm', next: now + cfg.everySeconds * SECOND * R.firstSiegeShare, wave: 0, pylons: [], raiders: [], defenders: new Set(), lastPilots: now, shown: '' };
      this.sieges.set(num, g);
    }
    if (pilots.length) g.lastPilots = now;
    // The pylons stand while anyone's here (rebuilt between sieges)
    if (pilots.length && (!g.pylons.length || (g.phase === 'calm' && g.pylons.some((e) => !this.host.shipAt(e))))) this.buildPylons(g, city);
    const standing = g.pylons.filter((e) => this.host.shipAt(e));
    g.raiders = g.raiders.filter((e) => this.host.hostileAlive(e));

    if (g.phase !== 'calm' && g.phase !== 'fallen') {
      // Who's defending: pilots near the city while it's under attack
      for (const p of pilots) if (dhypot(p.x - city.x, p.y - city.y) < city.radius * R.defendRadius) g.defenders.add(p.conn);
      if (now - g.lastPilots > R.abandonSeconds * SECOND) return this.endSiege(g, null, now);
      if (!standing.length) return this.endSiege(g, false, now);
    }

    switch (g.phase) {
      case 'calm':
        if (!pilots.length || now < g.next) break;
        g.phase = 'warning';
        g.next = now + R.warningSeconds * SECOND;
        g.wave = 0;
        g.defenders.clear();
        this.host.announce(num, this.t('surfaces.siege.inbound', { city: city.name }), 'warn');
        break;
      case 'warning':
        if (now >= g.next) this.startWave(g, s, pilots.length, now);
        break;
      case 'wave':
        if (!g.raiders.length) {
          if (g.wave >= cfg.waves) return this.endSiege(g, true, now);
          g.phase = 'pause';
          g.next = now + R.pauseSeconds * SECOND;
          this.host.announce(num, this.t('surfaces.siege.waveBroken', { wave: g.wave, secs: R.pauseSeconds }), 'good');
        } else if (now % R.retargetTicks === 0) {
          // Keep them on the nearest pylon still standing
          for (const r of g.raiders) {
            const t = nearest(standing.map((e) => this.host.shipAt(e)!), this.raiderPos(r));
            if (t) this.host.sendRaid([r], t);
          }
        }
        break;
      case 'pause':
        if (now >= g.next) this.startWave(g, s, pilots.length, now);
        break;
      case 'fallen':
        if (now >= g.next) {
          for (const r of g.raiders) this.host.removeHostile(r);
          g.raiders = [];
          g.phase = 'calm';
          g.next = now + cfg.everySeconds * SECOND;
        }
        break;
    }
    this.banner(g, standing.length, now);
  }

  private raiderPos(eid: number): { x: number; y: number } {
    return this.host.shipAt(eid) ?? { x: 0, y: 0 };
  }

  private buildPylons(g: Siege, city: NonNullable<NonNullable<StarSystemData['surface']>['city']>): void {
    city.pylons.forEach((p, i) => {
      if (g.pylons[i] !== undefined && this.host.shipAt(g.pylons[i])) return;
      g.pylons[i] = this.host.spawnStructure(PYLON, g.num, city.x + p.x, city.y + p.y, this.t('surfaces.pylonName', { city: city.name }));
    });
  }

  private startWave(g: Siege, s: StarSystemData, pilots: number, now: number): void {
    const cfg = s.surface!.siege!, R = s.surface!.radius, w = this.rules.wave;
    g.wave++;
    g.phase = 'wave';
    const standing = g.pylons.map((e) => this.host.shipAt(e)).filter((p): p is { x: number; y: number; hull: number } => !!p);
    // Bigger waves later, and for more defenders; from one or two directions
    const size = Math.min(w.maxSize, w.base + g.wave * w.perWave + Math.max(0, pilots - 1) * w.perExtraPilot);
    const fronts = g.wave >= w.twoFrontsFrom ? 2 : 1;
    for (let f = 0; f < fronts; f++) {
      const a = this.rng() * Math.PI * 2;
      const x = dcos(a) * R * w.spawnRadius, y = dsin(a) * R * w.spawnRadius;
      const target = nearest(standing, { x, y }) ?? { x: 0, y: 0 };
      g.raiders.push(...this.host.spawnRaid(g.num, cfg.faction ?? 'pirates', x, y, Math.ceil(size / fronts), target));
    }
    this.host.announce(g.num, this.t('surfaces.siege.wave', { wave: g.wave, waves: cfg.waves, raiders: g.raiders.length }), 'warn');
    void now;
  }

  /** true: held, false: fell, null: called off (nobody stayed) */
  private endSiege(g: Siege, held: boolean | null, now: number): void {
    const cfg = g.sys.surface!.siege!, city = g.sys.surface!.city!;
    if (held) {
      const r = this.rules.reward;
      const xp = r.xpBase + r.xpPerWave * cfg.waves, credits = r.creditsBase + r.creditsPerWave * cfg.waves;
      for (const c of g.defenders) this.host.reward(c, xp, credits, `defend:${city.name}`);
      this.host.announce(g.num, this.t('surfaces.siege.held', { city: city.name }), 'good');
      g.phase = 'calm';
      g.next = now + cfg.everySeconds * SECOND;
      for (const r of g.raiders) this.host.removeHostile(r);
      g.raiders = [];
      for (const e of g.pylons) if (this.host.shipAt(e)) this.host.repairStructure(e);
    } else if (held === false) {
      this.host.announce(g.num, this.t('surfaces.siege.fell', { city: city.name }), 'bad');
      g.phase = 'fallen';
      g.next = now + this.rules.fallenSeconds * SECOND;
    } else {
      for (const r of g.raiders) this.host.removeHostile(r);
      g.raiders = [];
      g.phase = 'calm';
      g.next = now + cfg.everySeconds * SECOND;
    }
    g.defenders.clear();
    g.wave = 0;
  }

  /** The siege banner for pilots on the surface (sent when it changes) */
  private banner(g: Siege, standing: number, now: number): void {
    const city = g.sys.surface!.city!, cfg = g.sys.surface!.siege!;
    let msg: ServerMessage;
    const total = city.pylons.length;
    if (g.phase === 'calm') msg = { type: 'objectiveEnd', id: `siege:${g.sys.id}` } as ServerMessage;
    else {
      const secs = Math.max(0, Math.ceil((g.next - now) / SECOND));
      const left = g.raiders.length;
      const text = g.phase === 'warning' ? this.t('surfaces.banner.warning', { secs })
        : g.phase === 'pause' ? this.t('surfaces.banner.pause', { wave: g.wave, waves: cfg.waves, secs })
        : g.phase === 'wave' ? this.t('surfaces.banner.wave', { wave: g.wave, waves: cfg.waves, left, s: left === 1 ? '' : 's' })
        : this.t('surfaces.banner.fallen');
      msg = {
        type: 'objective', id: `siege:${g.sys.id}`, title: this.t('surfaces.banner.title', { city: city.name }), text,
        meter: { label: this.t('surfaces.banner.meter'), value: standing, max: total }, danger: g.phase === 'wave' || g.phase === 'fallen',
        at: { x: city.x, y: city.y },
      } as ServerMessage;
    }
    const key = JSON.stringify(msg);
    if (key === g.shown) return;
    if (g.phase === 'calm' && !g.shown) return;
    g.shown = g.phase === 'calm' ? '' : key;
    this.host.send(g.num, msg);
  }
}

function nearest<T extends { x: number; y: number }>(list: T[], from: { x: number; y: number }): T | null {
  let best: T | null = null, bd = Infinity;
  for (const p of list) { const d = dhypot(p.x - from.x, p.y - from.y); if (d < bd) { bd = d; best = p; } }
  return best;
}
