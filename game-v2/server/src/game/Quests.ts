/**
 * Quests: story chains, side stories, guild work and station bounties,
 * saved in the pilot's profile (profile.quests) so progress survives logouts.
 *
 * Nothing is forced on you: no one calls, nothing pops up. Hand-written jobs
 * (data/quests.json) belong to people (People.ts): you're offered one by
 * talking to them, and take it or not. A few beginner jobs are in your log
 * from the start (`starter`); you hear about the rest by talking to people,
 * from rumours, and by finishing the jobs they follow on from (they join the
 * log marked new, `fresh`, until you look). Jobs you've heard about but not
 * taken are your leads. Bounties and fleet operations are generated per
 * station and time window (common/src/econ/quests.ts) and posted on its board.
 *
 * Steps run in order:
 *   - counted steps (mine, loot, refine, craft, kill, sell) advance on events
 *     that Pilots, StationServices and Enemies report
 *   - condition steps (travel, dock, visit, level, refit) are checked twice a second
 *   - deliver steps hand the goods over automatically once you're at the
 *     quest giver's station with them in cargo or storage
 *   - talk steps advance in conversation (People.ts), and so do arena bosses:
 *     you tell the person you're ready and fight in your own copy (Arenas.ts)
 * A step can end with a word from the job's person (`after`, a toast). When
 * the last step is done the rewards are paid at once (a toast says so; the
 * outro is in the log), and the jobs it opens up join the log.
 *
 * Operation steps (courier, scan, escort, defend, uplink) are run by the
 * Operations module, which advances or fails them through opAdvance / fail.
 * Fleet operations need a party: accepting one signs up the whole party.
 */

import {
  PlayerProfile, QuestDef, QuestStep, QuestsFile, QuestRewards, BountyContext, ServerMessage, QuestView, QuestLead, RewardView, QuestTarget,
  bountyIds, bountyDef, fleetIds, fleetDef, stepCount, stepText, stepHint, sectorLicence, SKILLS, BOUNTY_WINDOW_MS, OP_STEPS, condHolds, type CondContext, stationPerks, type BuildView,
} from '@space-game/common';
import type { Pilots, PilotConn, PilotEvent } from './Pilots.js';
import type { People } from './People.js';
import type { Codex } from './Codex.js';

/** Leads you can't take yet show only this many levels ahead of you */
const LEAD_LEVELS_AHEAD = 3;

export interface QuestHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  now(): number;
  /** The station the pilot is at (in range or docked), by data id */
  stationAt(conn: PilotConn): string | null;
  systemOf(conn: PilotConn): string | undefined;
  /** Where the pilot is flying (system id and position), for visit steps */
  where?(conn: PilotConn): { system: string; x: number; y: number } | null;
  /** The pilot's ship: total parts and parts per function */
  /** The ship flown: live parts, by function, and by material (`<material>` and `<fn>:<material>`) */
  ship(conn: PilotConn): { parts: number; fns: Record<string, number>; materials?: Record<string, number> } | null;
  bountyContext(stationId: string): BountyContext | null;
  /** Which system a station is in */
  stationSystem(stationId: string): string | undefined;
  /** Where a boss lairs (for the marker) */
  bossLair?(boss: string): { system: string; x: number; y: number } | null;
  /** Send the pilot down to their party's copy of an arena, with its boss: null, or why not */
  enterArena?(conn: PilotConn, arena: string, boss: string): string | null;
  /** The pilot's party, themselves included (or just them) */
  party?(conn: PilotConn): PilotConn[];
  /** Leads their party */
  leads?(conn: PilotConn): boolean;
  /** A job was finished (the news hears about fleet ops) */
  completed?(conn: PilotConn, q: QuestDef): void;
  /** Where an operation step is happening right now (the escorted freighter, the outpost) */
  opTarget?(conn: PilotConn, questId: string): QuestTarget | undefined;
  names: {
    item(id: string): string;
    station(id: string): string;
    system(id: string): string;
    faction(id: string): string;
    enemy(id: string): string;
    plan(file: string): string;
    recipe(id: string): string;
  };
}

const MAX_ACTIVE = 8;
const MAX_BOUNTIES = 4;
const CHECK_EVERY = 30;
/** Within this of a visit step's point (unless it says) */
const VISIT_RADIUS = 800;

type Progress = { stage: number; progress: number; data?: Record<string, number | string | boolean> };

export class Quests {
  private defs = new Map<string, QuestDef>();
  private ticks = 0;
  /** Who you can talk to (set once People is built) */
  people: People | null = null;
  /** Records a job can pay (set once Codex is built) */
  codex: Codex | null = null;

  constructor(private host: QuestHost, private pilots: Pilots, readonly file: QuestsFile) {
    for (const q of file.quests) this.defs.set(q.id, q);
    pilots.onEvent((conn, ev) => this.onEvent(conn, ev));
  }

  def(id: string): QuestDef | null {
    if (id.startsWith('bounty:') || id.startsWith('fleet:')) {
      const station = id.split(':')[1];
      const ctx = this.host.bountyContext(station);
      if (!ctx) return null;
      return id.startsWith('bounty:') ? bountyDef(id, ctx) : fleetDef(id, ctx);
    }
    return this.defs.get(id) ?? null;
  }

  /** A generated job's id is one the station's board offers, this window or the last */
  private onBoard(st: string, id: string): boolean {
    const now = this.host.now();
    return [now, now - BOUNTY_WINDOW_MS].some((t) => bountyIds(st, t).includes(id) || fleetIds(st, t).includes(id));
  }

  /** Generated jobs (bounties, fleet ops) are dropped from the done list after their window */
  private static generated(id: string): boolean {
    return id.startsWith('bounty:') || id.startsWith('fleet:');
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  /** Offers at the station the pilot is at: bounties, fleet ops, and any job posted with no one to give it */
  board(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    const st = this.host.stationAt(conn);
    if (!p || !st) return;
    const offers: QuestView[] = [];
    const locked: { name: string; level: number; chain: string }[] = [];
    for (const q of this.defs.values()) {
      if (q.person || q.giver !== st || this.isActive(p, q.id) || (p.quests.done.includes(q.id) && !q.repeatable)) continue;
      if (!this.prereqsMet(p, q)) continue;
      if (q.level > p.level) locked.push({ name: q.name, level: q.level, chain: q.chain });
      else offers.push(this.view(q, 0, 0));
    }
    const now = this.host.now();
    for (const id of [...bountyIds(st, now), ...fleetIds(st, now)]) {
      if (this.isActive(p, id) || p.quests.done.includes(id)) continue;
      const q = this.def(id);
      if (q) offers.push(this.view(q, 0, 0));
    }
    this.host.send(conn, { type: 'questBoard', station: st, stationName: this.host.names.station(st), offers, locked, refreshIn: BOUNTY_WINDOW_MS - (now % BOUNTY_WINDOW_MS) });
  }

  /** Accept a board job (people's jobs are accepted by talking to them) */
  accept(conn: PilotConn, msg: { id: string }): void {
    const p = this.pilots.get(conn);
    const q = p && this.def(String(msg.id));
    if (!p || !q) return;
    if (q.person) return this.pilots.toast(conn, `Talk to ${this.personName(q.person)} about this job`, 'warn');
    const st = this.host.stationAt(conn);
    if (!q.giver || st !== q.giver) return this.pilots.toast(conn, `Pick this up at ${q.giver ? this.host.names.station(q.giver) : 'its station'}`, 'warn');
    // A bounty or fleet op is rebuilt from its id: only ones the board offers (now, or just before it turned over) are taken
    if (Quests.generated(q.id) && !this.onBoard(st, q.id)) return this.pilots.toast(conn, 'That job is no longer on the board', 'warn');
    const err = this.canTake(conn, p, q);
    if (err) return this.pilots.toast(conn, err, 'warn');
    const party = this.host.party?.(conn) ?? [conn];
    if (q.party && party.length < q.party) {
      return this.pilots.toast(conn, `A fleet operation needs a party of ${q.party} or more. Invite pilots from their info card or with /invite name`, 'warn');
    }
    this.start(conn, p, q);
    // Fleet ops sign up the whole party
    if (q.party) {
      for (const m of party) {
        const mp = m === conn ? undefined : this.pilots.get(m);
        if (!mp || this.isActive(mp, q.id) || Object.keys(mp.quests.active).length >= MAX_ACTIVE) continue;
        this.start(m, mp, q);
        this.pilots.toast(m, `${conn.username} signed the party up for ${q.name}`, 'good');
      }
    }
    this.board(conn);
  }

  /** Accept a person's job (in conversation): null, or why not */
  acceptFrom(conn: PilotConn, id: string): string | null {
    const p = this.pilots.get(conn);
    const q = p && this.def(id);
    if (!p || !q) return 'That job is gone';
    const err = this.canTake(conn, p, q);
    if (err) return err;
    this.start(conn, p, q);
    return null;
  }

  private canTake(conn: PilotConn, p: PlayerProfile, q: QuestDef): string | null {
    if (this.isActive(p, q.id)) return 'You are already on this job';
    if (p.quests.done.includes(q.id) && !q.repeatable) return 'You have done this job';
    if (q.level > p.level) return `Needs pilot level ${q.level}`;
    if (!this.prereqsMet(p, q)) return 'Not yet';
    const active = Object.keys(p.quests.active);
    if (active.length >= MAX_ACTIVE) return `You can only take ${MAX_ACTIVE} jobs at once`;
    if (q.chain === 'bounty' && active.filter((id) => id.startsWith('bounty:')).length >= MAX_BOUNTIES) return `You can only hold ${MAX_BOUNTIES} bounties at once`;
    void conn;
    return null;
  }

  /**
   * Give up a job: no reward, its own items go back, and it can be taken again
   * (people offer theirs again; board jobs while they're posted). A fleet op:
   * the party leader calls it off for everyone on it, anyone else just leaves it.
   */
  abandon(conn: PilotConn, msg: { id: string }): void {
    const p = this.pilots.get(conn);
    const id = String(msg.id);
    if (!p || !p.quests.active[id]) return;
    const q = this.def(id);
    const party = q?.party ? (this.host.party?.(conn) ?? [conn]).filter((m) => m !== conn && this.pilots.get(m)?.quests.active[id]) : [];
    const lead = party.length > 0 && !!this.host.leads?.(conn);
    this.drop(conn, p, id);
    this.pilots.toast(conn, `Abandoned: ${q?.name ?? id}${q?.person ? `. ${this.personName(q.person)} will give it to you again` : lead ? '. Called off for the party' : ''}`, 'info');
    this.send(conn);
    if (this.host.stationAt(conn)) this.board(conn);
    for (const m of party) {
      if (lead) {
        this.drop(m, this.pilots.get(m)!, id);
        this.pilots.toast(m, `${conn.username} called off ${q!.name}`, 'warn');
        this.send(m);
        if (this.host.stationAt(m)) this.board(m);
      } else this.pilots.toast(m, `${conn.username} left ${q!.name}`, 'warn');
    }
  }

  private drop(conn: PilotConn, p: PlayerProfile, id: string): void {
    delete p.quests.active[id];
    for (const def of this.pilots.econ.items.all()) if (def.quest === id) this.pilots.removeEverywhere(conn, def.id);
    if (!Quests.generated(id) && this.defs.has(id) && !p.quests.known.includes(id)) p.quests.known.push(id);
    this.pilots.saveNow(conn);
  }

  /** Spend a skill point */
  skillUp(conn: PilotConn, msg: { skill: string }): void {
    const p = this.pilots.get(conn);
    // (Own keys only: '__proto__' or 'toString' would find something on a plain object)
    const sk = Object.hasOwn(SKILLS, String(msg.skill)) ? SKILLS[String(msg.skill)] : undefined;
    if (!p || !sk || p.skillPoints < 1) return;
    const cur = p.skills[msg.skill] ?? 0;
    if (cur >= sk.max) return;
    p.skills[msg.skill] = cur + 1;
    p.skillPoints--;
    this.pilots.markDirty(conn);
    this.pilots.skillsChanged(conn);
    this.pilots.toast(conn, `${sk.name} ${cur + 1}`, 'good');
  }

  // ---------------------------------------------------------------------------
  // People (People.ts asks)
  // ---------------------------------------------------------------------------

  /** A person's jobs this pilot could hear about now: ok (could take it) or only needing more levels */
  offersFrom(conn: PilotConn, p: PlayerProfile, person: string): { q: QuestDef; ok: boolean }[] {
    const out: { q: QuestDef; ok: boolean }[] = [];
    for (const q of this.defs.values()) {
      if (q.person !== person || this.isActive(p, q.id) || (p.quests.done.includes(q.id) && !q.repeatable)) continue;
      if (!this.prereqsMet(p, q)) continue;
      out.push({ q, ok: q.level <= p.level });
    }
    void conn;
    return out;
  }

  /** The job of this pilot's whose current step needs this person (a talk, or an arena fight to start) */
  stepFor(conn: PilotConn, p: PlayerProfile, person: string): { q: QuestDef; step: QuestStep } | null {
    for (const [id, st] of Object.entries(p.quests.active)) {
      const q = this.def(id);
      const s = q?.steps[st.stage];
      if (!q || !s) continue;
      if ((s.type === 'talk' && s.person === person) || (s.type === 'boss' && s.arena && s.person === person)) return { q, step: s };
    }
    void conn;
    return null;
  }

  /** A talk step is done (People.ts) */
  advanceStep(conn: PilotConn, id: string): void {
    const p = this.pilots.get(conn);
    const q = this.def(id);
    if (!p || !q || !p.quests.active[id]) return;
    this.advance(conn, p, q);
    this.pilots.markDirty(conn);
    this.send(conn);
  }

  /** Ready for an arena fight: down you go (null), or why not */
  fight(conn: PilotConn, id: string): string | null {
    const p = this.pilots.get(conn);
    const st = p?.quests.active[id];
    const s = st && this.def(id)?.steps[st.stage];
    if (!s || s.type !== 'boss' || !s.arena) return 'Not now';
    return this.host.enterArena?.(conn, s.arena, s.boss) ?? 'The way down is sealed';
  }

  /** Hear about a job (it joins the log as a lead) */
  reveal(conn: PilotConn, id: string, quiet = false): void {
    const p = this.pilots.get(conn);
    const q = this.defs.get(id);
    if (!p || !q || p.quests.known.includes(id)) return;
    p.quests.known.push(id);
    this.pilots.markDirty(conn);
    if (!quiet && !this.isActive(p, id) && !p.quests.done.includes(id)) {
      const where = q.person ? this.personPlace(conn, p, q.person) : undefined;
      this.pilots.toast(conn, `New lead: ${q.name}${q.person ? ` (${this.personName(q.person)}${where ? `, ${where.label}` : ''})` : ''}. L to see it`, 'good');
    }
    this.send(conn);
  }

  /** A job as offered (step text and rewards as the log will show them) */
  offerView(q: QuestDef): QuestView {
    return this.view(q, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  /** Logged in (or a guest arrived): tidy the log, hand over owed rewards, and send it */
  onLogin(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    // Drop quests whose definitions are gone (data changed) and stale bounty records
    for (const id of Object.keys(p.quests.active)) if (!this.def(id)) delete p.quests.active[id];
    // A job rewritten since it was taken (its `rev` moved on): it starts again from its first step
    for (const [id, st] of Object.entries(p.quests.active)) {
      const q = this.def(id)!;
      if ((q.rev ?? 0) === Number(st.data?.rev ?? 0)) continue;
      p.quests.active[id] = { stage: 0, progress: 0, data: { since: this.host.now(), ...(q.rev ? { rev: q.rev } : {}) } };
      this.pilots.markDirty(conn);
      this.pilots.toast(conn, `${q.name} has changed since you took it: it starts again from the first step`, 'info');
    }
    const window = Math.floor(this.host.now() / BOUNTY_WINDOW_MS);
    p.quests.done = p.quests.done.filter((id) => !Quests.generated(id) || Number(id.split(':')[2]) >= window - 1);
    // Beginner jobs are known from the start
    for (const q of this.defs.values()) if (q.starter && !p.quests.known.includes(q.id)) this.markNew(p, q.id);
    // Rewards added to jobs after a pilot finished them (plans, licences): hand them over now
    const owed = { plans: [] as string[], recipes: [] as string[], licences: [] as string[] };
    for (const id of p.quests.done) {
      const q = this.defs.get(id);
      if (!q) continue;
      owed.plans.push(...(q.rewards.plans ?? []).filter((f) => !p.plans.includes(f)));
      owed.recipes.push(...(q.rewards.recipes ?? []).filter((r) => !p.recipes.includes(r)));
      owed.licences.push(...(q.rewards.licences ?? []).filter((l) => !p.licences.includes(l)));
    }
    if (owed.plans.length || owed.recipes.length || owed.licences.length) {
      if (owed.plans.includes('prospector')) this.pilots.give(conn, { power_coupling: 1 }, { toStorage: true, quiet: true });
      this.pilots.grant(conn, owed);
      if (owed.plans.length) this.pilots.toast(conn, `New ship plans from jobs you finished: ${owed.plans.map((f) => this.host.names.plan(f)).join(', ')}`, 'good');
    }
    // Records added to jobs after they were finished
    const records = p.quests.done.flatMap((id) => this.defs.get(id)?.rewards.codex ?? []).filter((id) => !p.codex.found.includes(id));
    if (records.length) this.codex?.unlock(conn, records);
    // Jobs that follow on from ones already finished (saves from before they joined the log by themselves)
    for (const q of p.quests.done) this.revealNext(conn, p, q);
    this.checkReveals(conn, p, true);
    p.quests.fresh = p.quests.fresh?.filter((id) => p.quests.known.includes(id) && !this.isActive(p, id) && !p.quests.done.includes(id));
    if (!p.quests.fresh?.length) delete p.quests.fresh;
    this.send(conn);
    this.people?.sendPeople(conn, true);
  }

  tick(): void {
    if (++this.ticks % CHECK_EVERY) return;
    for (const conn of this.pilots.connections()) {
      const p = this.pilots.get(conn);
      if (p && Object.keys(p.quests.active).length) this.checkConditions(conn, p);
    }
  }

  /** Kills come from Enemies (by the killer's connection) */
  onKill(conn: PilotConn, enemy: string, faction: string, system: string | undefined): void {
    this.count(conn, (s) => {
      if (s.type === 'boss') return s.boss === enemy ? 1 : 0;
      if (s.type !== 'kill') return 0;
      if (s.enemy && s.enemy !== enemy) return 0;
      if (s.faction && s.faction !== faction) return 0;
      if (s.system && s.system !== system) return 0;
      return 1;
    });
  }

  private onEvent(conn: PilotConn, ev: PilotEvent): void {
    switch (ev.type) {
      case 'items': {
        const p = this.pilots.get(conn);
        if (p && this.reveals.length) this.checkReveals(conn, p);
        const step = ({ mined: 'mine', loot: 'loot', refined: 'refine', crafted: 'craft' } as Record<string, string>)[ev.source ?? ''];
        if (!step) return;
        this.count(conn, (s) => {
          if (s.type !== step) return 0;
          let n = 0;
          for (const [id, k] of Object.entries(ev.items)) {
            if ('item' in s && s.item && s.item !== id) continue;
            if (s.type === 'craft' && s.category === 'part' && !id.startsWith('part:')) continue;
            n += k;
          }
          return n;
        });
        return;
      }
      case 'earned':
        this.count(conn, (s) => (s.type === 'sell' ? ev.credits : 0));
        return;
      case 'stat': {
        // Kills, docks, events, ore mined: what reveals watch
        const p = this.pilots.get(conn);
        if (p && this.reveals.length) this.checkReveals(conn, p);
        return;
      }
      case 'level': {
        const p = this.pilots.get(conn);
        this.checkConditions(conn, p);
        if (p && !this.checkReveals(conn, p)) this.send(conn);
        return;
      }
      case 'refit':
        this.checkConditions(conn, this.pilots.get(conn));
        return;
      case 'login':
        this.onLogin(conn);
        return;
    }
  }

  /** Add to every active counted step this event matches */
  private count(conn: PilotConn, match: (s: QuestStep) => number): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    let changed = false;
    for (const [id, st] of Object.entries(p.quests.active)) {
      const q = this.def(id);
      const s = q?.steps[st.stage];
      if (!q || !s) continue;
      const n = match(s);
      if (n <= 0) continue;
      st.progress = Math.min(stepCount(s), st.progress + n);
      changed = true;
      if (st.progress >= stepCount(s)) this.advance(conn, p, q);
    }
    if (changed) {
      this.pilots.markDirty(conn);
      this.send(conn);
    }
  }

  private checkConditions(conn: PilotConn, p: PlayerProfile | undefined): void {
    if (!p) return;
    const station = this.host.stationAt(conn);
    const system = this.host.systemOf(conn);
    // Couriers who run out of time
    for (const [id, st] of Object.entries(p.quests.active)) {
      const s = this.def(id)?.steps[st.stage];
      if (s?.type === 'courier' && this.host.now() > Number(st.data?.since ?? 0) + s.seconds * 1000) this.fail(conn, id, 'The dispatch arrived too late');
    }
    let changed = false;
    for (const id of Object.keys(p.quests.active)) {
      // A quest may finish several condition steps at once (dock, then deliver, ...)
      for (let guard = 0; guard < 8; guard++) {
        const st = p.quests.active[id];
        const q = st && this.def(id);
        const s = q?.steps[st.stage];
        if (!q || !s || !this.conditionMet(conn, p, q, s, station, system)) break;
        this.advance(conn, p, q);
        changed = true;
      }
    }
    if (changed) this.send(conn);
  }

  private conditionMet(conn: PilotConn, p: PlayerProfile, q: QuestDef, s: QuestStep, station: string | null, system: string | undefined): boolean {
    switch (s.type) {
      case 'travel': return system === s.system;
      case 'dock': return station === s.station;
      case 'level': return p.level >= s.level;
      case 'refit': {
        const ship = this.host.ship(conn);
        if (!ship) return false;
        if (s.minParts && ship.parts < s.minParts) return false;
        if (s.material) return (ship.materials?.[s.fn ? `${s.fn}:${s.material}` : s.material] ?? 0) >= (s.count ?? 1);
        if (s.fn && (ship.fns[s.fn] ?? 0) < (s.count ?? 1)) return false;
        return true;
      }
      case 'slot': return p.hangar.some((r) => r?.plan === s.plan);
      case 'build': return p.hangar.some((r) => r?.plan === s.plan && !(r.ghosts ?? []).length);
      case 'fly': return p.ship.plan === s.plan && !(p.ship.ghosts ?? []).length;
      case 'courier': return station === s.station;
      case 'visit': {
        const w = this.host.where?.(conn);
        if (!w || w.system !== s.system || Math.hypot(w.x - s.x, w.y - s.y) > (s.radius ?? VISIT_RADIUS)) return false;
        if (s.give) {
          // Found there: into the hold (or storage, if it's full)
          const left = this.pilots.give(conn, s.give, { source: 'quest' });
          if (Object.keys(left).length) this.pilots.give(conn, left, { toStorage: true, source: 'quest' });
          this.pilots.toast(conn, `Found: ${Object.entries(s.give).map(([id, n]) => `${n > 1 ? `${n} ` : ''}${this.host.names.item(id)}`).join(', ')}`, 'good');
        }
        return true;
      }
      case 'deliver': {
        if (!q.giver || station !== q.giver) return false;
        if (!Object.entries(s.items).every(([id, n]) => this.pilots.available(conn, id) >= n)) return false;
        if (!this.pilots.take(conn, s.items)) return false;
        this.pilots.toast(conn, `Delivered to ${this.host.names.station(q.giver)}`, 'good');
        return true;
      }
      default: return false;
    }
  }

  private start(conn: PilotConn, p: PlayerProfile, q: QuestDef): void {
    p.quests.active[q.id] = { stage: 0, progress: 0, data: { since: this.host.now(), ...(q.rev ? { rev: q.rev } : {}) } };
    // What the job hands you to get on with it (its kit's recipes, a licence, items)
    if (q.onStart?.recipes?.length) this.pilots.grant(conn, { recipes: q.onStart.recipes });
    if (q.onStart?.items && Object.keys(q.onStart.items).length) this.pilots.give(conn, q.onStart.items, { toStorage: true, source: 'quest' });
    if (p.quests.fresh) { p.quests.fresh = p.quests.fresh.filter((id) => id !== q.id); if (!p.quests.fresh.length) delete p.quests.fresh; }
    if (!Quests.generated(q.id) && !p.quests.known.includes(q.id)) p.quests.known.push(q.id);
    this.enterStep(conn, q.steps[0]);
    this.pilots.saveNow(conn);
    this.pilots.toast(conn, `Job taken: ${q.name}`, 'good');
    this.checkConditions(conn, p);
    this.send(conn);
  }

  /** A step starts: a craft step teaches its job's own kit */
  private enterStep(conn: PilotConn, s: QuestStep | undefined): void {
    if (s?.type === 'craft' && s.teach) this.pilots.grant(conn, { recipes: [s.teach] });
  }

  private advance(conn: PilotConn, p: PlayerProfile, q: QuestDef): void {
    const st = p.quests.active[q.id];
    if (!st) return;
    const was = q.steps[st.stage];
    st.stage++;
    st.progress = 0;
    // (the job's revision stays with it, step to step)
    st.data = { since: this.host.now(), ...(q.rev ? { rev: q.rev } : {}) };
    const said = (was?.after ?? []).map((l) => ('say' in l ? l.say : '')).filter(Boolean).join(' ');
    if (said) this.pilots.toast(conn, `${this.who(q).name}: ${said}`, 'info');
    if (st.stage < q.steps.length) {
      this.enterStep(conn, q.steps[st.stage]);
      // Each step reached is saved straight away (counted progress is saved with the autosave)
      this.pilots.saveNow(conn);
      this.host.send(conn, { type: 'questStep', id: q.id, text: this.stepText(q.steps[st.stage]) });
      return;
    }
    delete p.quests.active[q.id];
    if (!p.quests.done.includes(q.id)) p.quests.done.push(q.id);
    // What it opens up joins the log, marked new: nobody calls, the player looks when they like
    const next = this.revealNext(conn, p, q.id) + this.checkReveals(conn, p, true);
    this.pay(conn, p, q);
    const r = q.rewards;
    const paid = [r.credits ? `+${r.credits.toLocaleString()} cr` : '', r.xp ? `+${r.xp.toLocaleString()} XP` : ''].filter(Boolean).join(' · ');
    this.pilots.toast(conn, `Job complete: ${q.name}${paid ? ` (${paid})` : ''}${next ? '. New work in your log (L)' : ''}`, 'good');
  }

  /** Jobs (people's) whose prerequisites this one finished: into the log as new leads. How many. */
  private revealNext(conn: PilotConn, p: PlayerProfile, done: string): number {
    let n = 0;
    for (const q of this.defs.values()) {
      if (!q.person || !(q.requires ?? []).includes(done) || p.quests.known.includes(q.id) || this.isActive(p, q.id) || p.quests.done.includes(q.id)) continue;
      // Jobs with a reveal wait for it (checkReveals)
      if (q.reveal || !this.prereqsMet(p, q)) continue;
      this.markNew(p, q.id);
      n++;
    }
    if (n) this.pilots.markDirty(conn);
    return n;
  }

  /** Jobs that show themselves when their condition holds */
  private get reveals(): QuestDef[] {
    return (this.revealCache ??= [...this.defs.values()].filter((q) => q.reveal));
  }
  private revealCache?: QuestDef[];

  /**
   * Jobs whose reveal now holds (and whose prerequisites are met) join the log
   * as new leads: a quiet note, never a call. How many; `quiet`: the caller
   * says so (and sends the log) itself.
   */
  checkReveals(conn: PilotConn, p: PlayerProfile, quiet = false): number {
    let n = 0;
    for (const q of this.reveals) {
      if (p.quests.known.includes(q.id) || this.isActive(p, q.id) || p.quests.done.includes(q.id) || !this.prereqsMet(p, q)) continue;
      if (!condHolds(q.reveal, this.condCtx(conn, p))) continue;
      this.markNew(p, q.id);
      n++;
    }
    if (!n) return 0;
    this.pilots.markDirty(conn);
    if (!quiet) {
      this.pilots.toast(conn, n > 1 ? `${n} new leads in your log (L)` : 'A new lead in your log (L)', 'info');
      this.send(conn);
    }
    return n;
  }

  private condCtx(conn: PilotConn, p: PlayerProfile): CondContext {
    return this.people?.ctx(conn, p) ?? {
      done: (id) => p.quests.done.includes(id),
      active: (id) => !!p.quests.active[id],
      known: (id) => p.quests.known.includes(id) || !!p.quests.active[id] || p.quests.done.includes(id),
      stage: (id) => p.quests.active[id]?.stage ?? -1,
      has: (items) => Object.entries(items).every(([id, k]) => this.pilots.available(conn, id) >= k),
      level: p.level,
      flag: (f) => p.quests.flags.includes(f),
      stat: (k) => p.stats[k] ?? 0,
      rep: (f) => p.reputation[f] ?? 0,
      seed: conn.username ?? String(conn.userId ?? ''),
    };
  }

  /** Where a job is to be had (its giver's system, or its person's) */
  private region(conn: PilotConn, p: PlayerProfile, q: QuestDef): string | undefined {
    return q.giver ? this.at(q.giver)?.system : q.person ? this.personPlace(conn, p, q.person)?.system : undefined;
  }

  /** Hidden jobs a pilot hasn't found or heard of */
  private hiddenFor(p: PlayerProfile): QuestDef[] {
    return this.reveals.filter((q) => !p.quests.known.includes(q.id) && !p.quests.rumours?.includes(q.id) && !p.quests.done.includes(q.id) && !this.isActive(p, q.id));
  }

  /**
   * Docked at a station: once a day it has a rumour for the pilot, of a job
   * hidden in its system (a hint of it, in the log; finding it is still theirs).
   */
  rumourAt(conn: PilotConn, station: string, system: string, day: number): void {
    const p = this.pilots.get(conn);
    if (!p || p.quests.rumourDay?.[station] === day) return;
    // A scanner array at your station hears of hidden jobs anywhere
    const anywhere = stationPerks(p.outpost).rumours;
    const q = this.hiddenFor(p).find((x) => x.rumour && this.prereqsMet(p, x) && (anywhere || this.region(conn, p, x) === system));
    if (!q) return;
    (p.quests.rumourDay ??= {})[station] = day;
    (p.quests.rumours ??= []).push(q.id);
    this.pilots.markDirty(conn);
    this.pilots.toast(conn, `Word around the station: ${q.rumour}`, 'info');
    this.send(conn);
  }

  /** Known, and flagged new until the log is looked at */
  private markNew(p: PlayerProfile, id: string): void {
    if (p.quests.rumours?.includes(id)) p.quests.rumours = p.quests.rumours.filter((r) => r !== id);
    if (!p.quests.known.includes(id)) p.quests.known.push(id);
    const fresh = (p.quests.fresh ??= []);
    if (!fresh.includes(id)) fresh.push(id);
  }

  /** The log was looked at: nothing's new any more */
  seen(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p?.quests.fresh) return;
    delete p.quests.fresh;
    this.pilots.markDirty(conn);
    this.send(conn);
  }

  private pay(conn: PilotConn, p: PlayerProfile, q: QuestDef): void {
    const r = q.rewards;
    if (r.credits) this.pilots.addCredits(conn, r.credits);
    if (r.items && Object.keys(r.items).length) this.pilots.give(conn, r.items, { toStorage: true, source: 'quest' });
    this.pilots.grant(conn, { plans: r.plans, recipes: r.recipes, licences: r.licences, reputation: r.reputation, skillPoints: r.skillPoints });
    if (r.xp) this.pilots.addXp(conn, r.xp);
    if (r.codex?.length) this.codex?.unlock(conn, r.codex);
    this.pilots.bumpStat(conn, 'quests');
    if (q.chain === 'fleet') this.pilots.bumpStat(conn, 'fleetOps');
    if (q.steps.some((s) => s.type === 'escort')) this.pilots.bumpStat(conn, 'escorts');
    if (q.steps.some((s) => s.type === 'defend')) this.pilots.bumpStat(conn, 'defences');
    this.host.completed?.(conn, q);
    this.pilots.saveNow(conn);
  }

  // ---------------------------------------------------------------------------
  // Operations (run by the Operations module)
  // ---------------------------------------------------------------------------

  /**
   * The structures this pilot has built or is building (construct steps):
   * finished steps' whole, the current one's built pieces. Nobody else sees them.
   */
  builds(p: PlayerProfile): BuildView[] {
    const out: BuildView[] = [];
    for (const q of this.defs.values()) {
      const st = p.quests.active[q.id];
      const done = p.quests.done.includes(q.id);
      if (!st && !done) continue;
      q.steps.forEach((s, i) => {
        if (s.type !== 'construct') return;
        const whole = done || (st && st.stage > i);
        const now = st && st.stage === i;
        if (!whole && !now) return;
        const pieces = s.pieces.map((pc) => ({ id: pc.id, built: !!whole || !!st?.data?.[`b:${pc.id}`] }));
        out.push({ id: `${q.id}:${i}`, system: s.system, x: s.x, y: s.y, label: s.label, structure: s.structure, pieces });
      });
    }
    return out;
  }

  /** This pilot's quests whose current step is an operation */
  opSteps(conn: PilotConn): { id: string; q: QuestDef; step: QuestStep; state: Progress }[] {
    const p = this.pilots.get(conn);
    if (!p) return [];
    const out = [];
    for (const [id, st] of Object.entries(p.quests.active)) {
      const q = this.def(id);
      const step = q?.steps[st.stage];
      if (q && step && OP_STEPS.includes(step.type)) out.push({ id, q, step, state: st });
    }
    return out;
  }

  /** A job's state changed outside a step (a construct piece): save it */
  markDirty(conn: PilotConn): void {
    this.pilots.markDirty(conn);
  }

  /** An operation step is done */
  opAdvance(conn: PilotConn, id: string): void {
    this.advanceStep(conn, id);
  }

  /** Count towards an operation step (scans) */
  opCount(conn: PilotConn, id: string, n = 1): void {
    const p = this.pilots.get(conn);
    const st = p?.quests.active[id];
    const q = this.def(id);
    const s = st && q?.steps[st.stage];
    if (!p || !st || !q || !s) return;
    st.progress = Math.min(stepCount(s), st.progress + n);
    if (st.progress >= stepCount(s)) this.advance(conn, p, q);
    this.pilots.markDirty(conn);
    this.send(conn);
  }

  /** The job failed: it's dropped (bounties can be taken again while they're posted; people offer theirs again) */
  fail(conn: PilotConn, id: string, reason: string): void {
    const p = this.pilots.get(conn);
    if (!p || !p.quests.active[id]) return;
    const q = this.def(id);
    delete p.quests.active[id];
    this.pilots.saveNow(conn);
    this.pilots.toast(conn, `Job failed: ${q?.name ?? id}. ${reason}`, 'bad');
    this.send(conn);
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  send(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    const active: QuestView[] = [];
    for (const [id, st] of Object.entries(p.quests.active)) {
      const q = this.def(id);
      if (q) active.push(this.view(q, st.stage, st.progress, conn));
    }
    const order = ['main', 'science', 'side', 'fleet', 'shipwright', 'guild', 'traders', 'patrol', 'bounty'];
    active.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
    const leads: QuestLead[] = [];
    for (const id of p.quests.known) {
      const q = this.defs.get(id);
      if (!q || this.isActive(p, id) || (p.quests.done.includes(id) && !q.repeatable)) continue;
      leads.push({ ...this.lead(conn, p, q), ...(p.quests.fresh?.includes(id) ? { fresh: true } : {}) });
    }
    // Rumours: a hint, no more
    for (const id of p.quests.rumours ?? []) {
      const q = this.defs.get(id);
      if (!q || p.quests.known.includes(id)) continue;
      leads.push({ id: q.id, name: q.name, chain: q.chain, level: q.level, who: '', where: '', state: 'rumour', needs: [], intro: q.rumour ?? '', rewards: {} as QuestLead['rewards'] });
    }
    const rank = { available: 0, locked: 1, rumour: 2 };
    // Jobs well beyond your level wait until you're nearly there (the log stays about what you can do)
    for (let i = leads.length - 1; i >= 0; i--) if (leads[i].state === 'locked' && leads[i].level > p.level + LEAD_LEVELS_AHEAD) leads.splice(i, 1);
    leads.sort((a, b) => (a.state === b.state ? a.level - b.level : rank[a.state] - rank[b.state]));
    // How many jobs each system still hides
    const hidden: Record<string, number> = {};
    for (const q of this.hiddenFor(p)) {
      const sys = this.region(conn, p, q);
      const name = sys ? this.host.names.system(sys) : 'Somewhere';
      hidden[name] = (hidden[name] ?? 0) + 1;
    }
    const finished = p.quests.done.filter((id) => !Quests.generated(id)).map((id) => this.defs.get(id)).filter((q): q is QuestDef => !!q)
      .map((q) => ({ id: q.id, name: q.name, chain: q.chain, outro: q.outro }));
    this.host.send(conn, {
      type: 'quests', active, done: p.quests.done.filter((id) => !id.startsWith('bounty:')).length, leads, finished, hidden, builds: this.builds(p),
      reputation: p.reputation, reputations: this.file.reputations,
    });
    this.people?.sendPeople(conn);
  }

  private lead(conn: PilotConn, p: PlayerProfile, q: QuestDef): QuestLead {
    const needs: string[] = [];
    if (q.level > p.level) needs.push(`pilot level ${q.level}`);
    for (const r of q.requires ?? []) if (!p.quests.done.includes(r)) needs.push(`finish ${this.defs.get(r)?.name ?? r}`);
    for (const [f, n] of Object.entries(q.minRep ?? {})) if ((p.reputation[f] ?? 0) < n) needs.push(`${n} standing with ${this.file.reputations[f]?.name ?? f}`);
    const at = q.person ? this.personPlace(conn, p, q.person) : undefined;
    return {
      id: q.id, name: q.name, chain: q.chain, level: q.level,
      who: q.person ? this.personName(q.person) : q.npc ?? (q.giver ? this.host.names.station(q.giver) : ''),
      where: at?.label ?? (q.giver ? this.host.names.station(q.giver) : ''),
      state: needs.length ? 'locked' : 'available', needs, intro: q.intro, rewards: this.rewardView(q.rewards),
      target: at ? { system: at.system, station: at.station, x: at.x, y: at.y, label: this.personName(q.person!) } : q.giver ? this.at(q.giver) : undefined,
    };
  }

  private view(q: QuestDef, stage: number, progress: number, conn?: PilotConn): QuestView {
    const p = conn && this.pilots.get(conn);
    const at = q.person && p ? this.personPlace(conn!, p, q.person) : undefined;
    return {
      id: q.id, name: q.name, chain: q.chain, npc: q.person ? this.personName(q.person) : q.npc, giver: q.giver,
      giverName: q.giver ? this.host.names.station(q.giver) : at?.label ?? '',
      person: q.person ? this.personName(q.person) : undefined, where: at?.label,
      level: q.level, intro: q.intro, stage, progress,
      steps: q.steps.map((s) => ({ text: this.stepText(s, q), need: stepCount(s), hint: stepHint(s) })),
      rewards: this.rewardView(q.rewards),
      target: q.steps[stage] ? this.target(q, q.steps[stage], conn) : undefined,
    };
  }

  private at(station: string): QuestTarget | undefined {
    const system = this.host.stationSystem(station);
    const name = this.host.names.station(station);
    return system ? { system, station: name, label: name } : undefined;
  }

  /** Where someone is, as a target */
  private personTarget(conn: PilotConn | undefined, person: string): QuestTarget | undefined {
    const p = conn && this.pilots.get(conn);
    const at = p ? this.personPlace(conn!, p, person) : undefined;
    return at ? { system: at.system, station: at.station, x: at.x, y: at.y, label: this.personName(person) } : undefined;
  }

  private target(q: QuestDef, s: QuestStep, conn?: PilotConn): QuestTarget | undefined {
    const n = this.host.names;
    switch (s.type) {
      case 'travel': return { system: s.system, label: n.system(s.system) };
      case 'dock': return this.at(s.station);
      case 'deliver': return q.giver ? this.at(q.giver) : undefined;
      case 'kill': return s.system ? { system: s.system, label: n.system(s.system) } : undefined;
      case 'boss': {
        if (s.arena && s.person) return this.personTarget(conn, s.person);
        const lair = this.host.bossLair?.(s.boss);
        return lair ? { ...lair, label: n.enemy(s.boss) } : undefined;
      }
      case 'talk': return this.personTarget(conn, s.person);
      case 'visit': return { system: s.system, x: s.x, y: s.y, label: s.label };
      case 'courier': return this.at(s.station);
      case 'scan': return (conn && this.host.opTarget?.(conn, q.id)) ?? { system: s.system, label: n.system(s.system) };
      case 'hold': case 'recover': case 'course': case 'construct': return (conn && this.host.opTarget?.(conn, q.id)) ?? { system: s.system, x: s.x, y: s.y, label: s.label };
      case 'escort': return (conn && this.host.opTarget?.(conn, q.id)) ?? this.at(s.from);
      case 'defend': case 'uplink': return (conn && this.host.opTarget?.(conn, q.id)) ?? this.at(s.near);
      default: return undefined;
    }
  }

  private stepText(s: QuestStep, q?: QuestDef): string {
    const t = stepText(s, { ...this.host.names, person: (id: string) => this.personName(id) });
    return s.type === 'deliver' && !s.text && q?.giver ? `${t} to ${this.host.names.station(q.giver)}` : t;
  }

  private rewardView(r: QuestRewards): RewardView {
    const n = this.host.names;
    const licence = (id: string) => Object.entries(this.file.restricted).find(([sys, x]) => (x.licence ?? sys) === id)?.[1].name ?? n.system(id);
    return {
      xp: r.xp ?? 0, credits: r.credits ?? 0, items: r.items ?? {},
      plans: (r.plans ?? []).map((f) => n.plan(f)), recipes: (r.recipes ?? []).map((id) => n.recipe(id)),
      licences: (r.licences ?? []).map(licence),
      reputation: Object.fromEntries(Object.entries(r.reputation ?? {}).map(([f, k]) => [this.file.reputations[f]?.name ?? f, k])), skillPoints: r.skillPoints ?? 0,
    };
  }

  private personName(id: string): string {
    return this.people?.name(id) ?? id;
  }

  private personPlace(conn: PilotConn, p: PlayerProfile, id: string): ReturnType<People['describe']> | undefined {
    const d = this.people?.def(id);
    return d && this.people!.describe(this.people!.placeOf(conn, p, d));
  }

  /** Who calls about a job: its person, or (board jobs) the station's office */
  private who(q: QuestDef): { name: string; title: string; color: string } {
    if (q.person && this.people) return this.people.who(q.person);
    return { name: q.npc ?? (q.giver ? this.host.names.station(q.giver) : 'Contracts'), title: q.giver ? this.host.names.station(q.giver) : '', color: '#9fb3cc' };
  }

  private isActive(p: PlayerProfile, id: string): boolean {
    return !!p.quests.active[id];
  }

  private prereqsMet(p: PlayerProfile, q: QuestDef): boolean {
    return (q.requires ?? []).every((r) => p.quests.done.includes(r)) && Object.entries(q.minRep ?? {}).every(([f, n]) => (p.reputation[f] ?? 0) >= n);
  }

  /** May this pilot enter a system? (licensed sectors): null, or why not */
  canEnter(conn: PilotConn, systemId: string): string | null {
    const licence = sectorLicence(this.file, systemId);
    if (!licence) return null;
    const p = this.pilots.get(conn);
    return p && p.licences.includes(licence) ? null : this.file.restricted[systemId].hint;
  }

}
