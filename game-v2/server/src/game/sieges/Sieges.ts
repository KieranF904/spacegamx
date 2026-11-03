/**
 * Moon sieges: a pilot's (or a party's) own copy of a moon (an instanced
 * surface with a `bastion`), held night after night. Solo or together: the
 * nights grow with the number of pilots down there.
 *
 *   day    rest. Spend the party's supplies on patching the bastion and
 *          turrets, building turrets on its pads, upgrading them (three
 *          marks each) or scrapping them for half back; anyone can refit
 *          their own ship for free. Everyone down on the moon clicks Ready
 *          to bring on the night, or claims their haul and leaves.
 *   dusk   a few seconds of failing light
 *   night  the night comes at the bastion from the dark (headlights on): in
 *          fronts, one after another, and a trickle streaming in between.
 *          Each night's budget grows (faster as the nights go on), its ships
 *          get tougher (hull × hpPerNight a night) and harder, rarer kinds
 *          mix in; some nights a boss comes with it. Out on the moon, small
 *          objectives come up (a supply drop to hold, a nest to burn out)
 *          that pay supplies and haul for leaving the bastion's guns.
 *
 * Each moon is its own siege (its `profile`, SiegeRules.profiles): who comes,
 * how hard, from where (all round, set lanes, an arc, a pincer), how much
 * streams in, which bosses and when, and which objectives come up.
 *
 * Clear a wave and it's day again: each pilot there adds to their haul (more
 * each night) and the party earns supplies (kills add a little more). The
 * haul is paid when you claim it and leave by day, with a bonus for every
 * five nights you held (haulBonus). Leave any other way (out past the edge
 * at night, shot down, disconnected) or lose the bastion and you get half,
 * with no bonus. Lose the bastion and the siege is over: everyone goes back
 * to orbit and the moon is cleared for the next party. A copy nobody's on
 * for a while is cleared too.
 *
 * Pilots on the moon get the `objective` banner (with `night`, which the
 * client turns into darkness) and `siegeState` (the day's panel: supplies,
 * the shop, who's ready).
 *
 * This file is the run loop (phases, entering and leaving, the messages); the
 * rest of the folder: rules.ts (tuning and text), plan.ts (the nights),
 * shop.ts (building), objectives/ (out on the moon, by kind).
 */

import type { ServerMessage, StarSystemData } from '@space-game/common';
import type { PilotConn } from '../Pilots.js';
import { mergeRules, texts, type RulesPatch, type StringsFile, type Texts } from '../../data/rules.js';
import { BASTION, DEFAULT_SIEGE_RULES, MARKS, SECOND, SIEGE_STRINGS, FRONT_WARN, type SiegeRules, type SiegeSpawn } from './rules.js';
import { frontPoint, haulBonus, planNight, siegeBoss, siegeProfile, waveRoster } from './plan.js';
import { buy, scrap, siegeShop, upgrade, type ShopItem } from './shop.js';
import { OBJECTIVES } from './objectives/index.js';
import type { PilotAt, Run, SiegeCtx, SiegeHost, SiegeText } from './types.js';

export class Sieges implements SiegeCtx {
  private runs = new Map<number, Run>();
  private solo = new Map<PilotConn, number>();

  readonly rules: SiegeRules;
  /** The day's shop, from the rules */
  readonly shop: ShopItem[];
  readonly t: Texts<SiegeText>;

  /** `rules`: data/rules.json `sieges` (over the defaults); `strings`: data/strings.json */
  constructor(readonly host: SiegeHost, rules?: RulesPatch<SiegeRules>, strings?: StringsFile) {
    this.rules = mergeRules(DEFAULT_SIEGE_RULES, rules);
    this.shop = siegeShop(this.rules);
    this.t = texts(SIEGE_STRINGS, strings);
  }

  /** Fortifications are built a grade better than what comes at them (Selene's: steel) */
  fortGrade(grade: number): number {
    return Math.min(this.rules.fortMaxGrade, grade + this.rules.fortGradeBonus);
  }

  turretName(label: string, mark: number): string {
    return this.t('sieges.turretName', { label, mark: MARKS[mark] });
  }

  /** A pilot going down to a siege moon: their party's copy, or their own if they're alone (made if need be), or why not */
  enter(conn: PilotConn, surface: StarSystemData): { num: number; x: number; y: number } | string {
    const name = surface.name;
    const party = this.host.partyId(conn);
    if (!party && !this.solo.has(conn)) this.solo.set(conn, -1 - this.solo.size);
    const key = party || this.solo.get(conn)!;
    let run = [...this.runs.values()].find((r) => r.key === key && r.sys.id === surface.id);
    if (run?.phase === 'lost') return this.t('sieges.fallenRetry', { name });
    if (!run) {
      const free = this.host.instances(surface.id).find((n) => !this.runs.has(n));
      if (free === undefined) return this.t('sieges.full', { name });
      run = this.open(key, free, surface);
    }
    const b = surface.surface!.bastion!;
    return { num: run.num, x: b.x + (Math.random() - 0.5) * 600, y: b.y + 1400 };
  }

  /** A pilot's request from the day's panel */
  handle(conn: PilotConn, msg: { action?: string; item?: string; pad?: number }, eid: number): void {
    const run = [...this.runs.values()].find((r) => this.host.pilots(r.num).some((p) => p.conn === conn));
    if (!run) return;
    if (run.phase !== 'day') return this.host.toast(conn, this.t('sieges.notAtNight'), 'warn');
    if (msg.action === 'claim') return this.claim(run, conn);
    if (msg.action === 'ready') run.ready.add(conn);
    else if (msg.action === 'unready') run.ready.delete(conn);
    else if (msg.action === 'refit') { this.host.refit(eid); this.host.toast(conn, this.t('sieges.refitted'), 'good'); }
    else if (msg.action === 'buy') buy(this, run, conn, String(msg.item ?? ''));
    else if (msg.action === 'upgrade') upgrade(this, run, conn, Number(msg.pad));
    else if (msg.action === 'scrap') scrap(this, run, conn, Number(msg.pad));
    this.sendState(run, true);
  }

  /** A pilot dropping out (disconnected): paid what they're owed, and lifted to orbit so they don't log back in to an empty moon */
  leave(conn: PilotConn): void {
    for (const run of this.runs.values()) {
      if (!run.haul.has(conn) && !run.shown.has(conn)) continue;
      const here = this.host.pilots(run.num).find((p) => p.conn === conn);
      this.settle(run, conn, run.phase === 'day');
      this.forget(run, conn);
      if (here) this.host.toOrbit(conn, run.sys, Math.atan2(here.y, here.x));
    }
    this.solo.delete(conn);
  }

  /** What a siege moon's early nights are rated (its third night, flown solo): for the maps and the descend hint */
  threat(sys: StarSystemData): number {
    const b = sys.surface?.bastion;
    if (!b) return 0;
    return this.host.rateShips(waveRoster(3 + (b.offset ?? 0), 1, () => 0.5, this.rules, siegeProfile(this.rules, b.profile)), b.grade ?? 1);
  }

  /** The siege a system copy holds (tests, admin) */
  runOf(num: number): Readonly<Run> | undefined {
    return this.runs.get(num);
  }

  tick(): void {
    const now = this.host.tick();
    if (now % 10 !== 0) return;
    for (const run of [...this.runs.values()]) this.step(run, now);
  }

  // ---------------------------------------------------------------------------

  private open(key: number, num: number, sys: StarSystemData): Run {
    const b = sys.surface!.bastion!;
    const grade = b.grade ?? 1;
    const run: Run = {
      key, num, sys, name: sys.name, grade, offset: b.offset ?? 0, phase: 'day', wave: 0, supplies: this.rules.startSupplies, ready: new Set(),
      bastion: this.host.spawnStructure(BASTION, num, b.x, b.y, this.t('sieges.bastionName', { name: sys.name }), this.fortGrade(grade)),
      turrets: b.slots.map(() => null), haul: new Map(), raiders: [], next: 0, lastPilots: this.host.tick(), shown: new Map(), banner: '',
      profile: siegeProfile(this.rules, b.profile), fronts: [], stream: [], nextStream: 0, side: 0, frontNo: 0, boss: '', extras: [], objective: null, nextObjective: 0,
    };
    this.runs.set(num, run);
    return run;
  }

  private close(run: Run): void {
    // Whoever's still owed (the bastion fell): half
    for (const c of [...run.haul.keys()]) this.settle(run, c, false);
    for (const r of run.raiders) this.host.removeHostile(r);
    this.endObjective(run, null);
    for (const r of run.extras) this.host.removeHostile(r);
    for (const t of run.turrets) if (t !== null) this.host.removeStructure(t.eid);
    this.host.removeStructure(run.bastion);
    for (const p of this.host.pilots(run.num)) this.host.toOrbit(p.conn, run.sys, Math.atan2(p.y, p.x));
    for (const c of run.shown.keys()) this.host.send(c, { type: 'siegeState', active: false } as ServerMessage);
    this.runs.delete(run.num);
  }

  private step(run: Run, now: number): void {
    const R = this.rules;
    const pilots = this.host.pilots(run.num);
    if (pilots.length) run.lastPilots = now;
    else if (now - run.lastPilots > R.emptySeconds * SECOND) return this.close(run);
    for (const p of pilots) if (!run.haul.has(p.conn)) run.haul.set(p.conn, { xp: 0, credits: 0, nights: 0 });
    // Left the moon (out past the edge, or shot down): paid (in full only by day) and no longer counted
    for (const c of new Set([...run.shown.keys(), ...run.haul.keys()])) {
      if (pilots.some((p) => p.conn === c)) continue;
      this.settle(run, c, run.phase === 'day');
      this.forget(run, c);
    }
    // Shot down: the pad's free again (and the wreck forgotten)
    run.turrets = run.turrets.map((t) => {
      if (t === null || this.host.shipAt(t.eid)) return t;
      this.host.removeStructure(t.eid);
      return null;
    });
    // Kills pay a little into the supplies
    const alive = run.raiders.filter((e) => this.host.hostileAlive(e));
    const extras = run.extras.filter((e) => this.host.hostileAlive(e));
    run.supplies += (run.raiders.length - alive.length + run.extras.length - extras.length) * R.killSupplies;
    run.raiders = alive;
    run.extras = extras;
    const bastion = this.host.shipAt(run.bastion);

    if (run.phase === 'lost') {
      if (now >= run.next) this.close(run);
      return;
    }
    if (!bastion) {
      run.phase = 'lost';
      run.next = now + R.lostSeconds * SECOND;
      for (const p of pilots) this.host.toast(p.conn, this.t('sieges.lost', { name: run.name, nights: run.wave - 1, s: run.wave === 2 ? '' : 's' }), 'bad');
      this.sendState(run, true);
      this.sendBanner(run, now);
      return;
    }

    switch (run.phase) {
      case 'day': {
        const here = pilots.map((p) => p.conn);
        if (here.length && here.every((c) => run.ready.has(c))) {
          run.phase = 'dusk';
          run.next = now + R.duskSeconds * SECOND;
          run.wave++;
          const boss = siegeBoss(run.profile, run.wave + run.offset);
          run.boss = boss ? this.host.shipName(boss.ship) : '';
          for (const c of here) this.host.toast(c, boss ? this.t('sieges.duskBoss', { night: run.wave, boss: run.boss }) : this.t('sieges.dusk', { night: run.wave }), 'warn');
          this.sendState(run, true);
        }
        break;
      }
      case 'dusk':
        if (now >= run.next) {
          run.phase = 'night';
          planNight(this.rules, run, pilots.length, now);
        }
        break;
      case 'night': {
        // A front shows where it's coming in a few seconds before it does
        for (const f of run.fronts) if (!f.pos && now >= f.at - FRONT_WARN) {
          f.pos = frontPoint(run);
          this.host.effect?.(run.num, f.pos.x, f.pos.y, 'warning');
        }
        while (run.fronts.length && now >= run.fronts[0].at) { const f = run.fronts.shift()!; this.spawnFront(run, f.ships, f.pos); }
        if (run.stream.length && now >= run.nextStream) {
          this.spawnFront(run, [run.stream.shift()!]);
          run.nextStream = now + run.profile.stream.everySeconds * SECOND * (0.6 + Math.random() * 0.8);
        }
        this.stepObjective(run, pilots, now);
        if (!run.fronts.length && !run.stream.length && !run.raiders.length) this.dawn(run, pilots);
        break;
      }
    }
    this.sendBanner(run, now);
    this.sendState(run, false);
  }

  /** Some of the night, from the dark, for the bastion (`pos`: where it was seen coming) */
  private spawnFront(run: Run, ships: SiegeSpawn[], pos = frontPoint(run)): void {
    const b = run.sys.surface!.bastion!;
    this.host.effect?.(run.num, pos.x, pos.y, 'warpIn');
    run.raiders.push(...this.host.spawnHostiles(run.num, ships, pos.x, pos.y, { x: b.x, y: b.y }, run.grade));
  }

  // ---------------------------------------------------------------------------
  // Objectives out on the moon (their kinds: objectives/)
  // ---------------------------------------------------------------------------

  private stepObjective(run: Run, pilots: PilotAt[], now: number): void {
    const P = run.profile, O = this.rules.objectives, b = run.sys.surface!.bastion!;
    const night = run.wave + run.offset;
    const o = run.objective;
    if (!o) {
      const kinds = P.objectives.kinds.filter((k) => OBJECTIVES[k]);
      if (night < P.objectives.from || now < run.nextObjective || !kinds.length) return;
      const kind = OBJECTIVES[kinds[Math.floor(Math.random() * kinds.length)]];
      const a = Math.random() * Math.PI * 2, d = O.distance[0] + Math.random() * (O.distance[1] - O.distance[0]);
      const x = b.x + Math.cos(a) * d, y = b.y + Math.sin(a) * d;
      const eid = kind.start(this, run, x, y, now);
      if (eid === null) { run.nextObjective = now + P.objectives.everySeconds * SECOND; return; }
      run.objective = { kind: kind.id, x, y, until: now + kind.pay(this.rules).lifeSeconds * SECOND, held: 0, eid, release: now + O.nest.releaseSeconds * SECOND };
      for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.up', { what: kind.title(this), how: kind.how(this) }), 'info');
      return this.sendObjective(run, now);
    }
    const done = OBJECTIVES[o.kind]?.step(this, run, o, pilots, now);
    if (done) return this.endObjective(run, done);
    if (now >= o.until) return this.endObjective(run, null);
    this.sendObjective(run, now);
  }

  /** An objective's over: done (paying `by`, the pilots who did it), or lost/gone (null) */
  private endObjective(run: Run, by: PilotConn[] | null): void {
    const o = run.objective;
    if (!o) return;
    run.objective = null;
    run.nextObjective = this.host.tick() + run.profile.objectives.everySeconds * SECOND * (0.7 + Math.random() * 0.6);
    if (o.eid >= 0) this.host.removeHostile(o.eid);
    const pilots = this.host.pilots(run.num);
    for (const p of [...pilots.map((q) => q.conn), ...run.shown.keys()]) this.host.send(p, { type: 'objectiveEnd', id: `moonobj:${run.num}` } as ServerMessage);
    const kind = OBJECTIVES[o.kind];
    if (!kind) return;
    const what = kind.title(this);
    if (!by) {
      if (run.phase === 'night') for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.lost', { what }), 'warn');
      return;
    }
    const O = kind.pay(this.rules);
    const night = run.wave + run.offset;
    const supplies = Math.round(O.supplies + O.suppliesPerNight * night);
    const credits = Math.round(O.credits * this.host.gradeReward(run.grade) * (1 + night * 0.1));
    run.supplies += supplies;
    for (const c of by) {
      const h = run.haul.get(c);
      if (h) h.credits += credits;
    }
    for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.done', { what, supplies, credits }), 'good');
    this.sendState(run, true);
  }

  private sendObjective(run: Run, now: number): void {
    const o = run.objective;
    const kind = o && OBJECTIVES[o.kind];
    if (!o || !kind) return;
    const { text, meter, danger } = kind.banner(this, run, o, now);
    const msg = { type: 'objective', id: `moonobj:${run.num}`, title: kind.title(this), text, ...(danger ? { danger } : {}), meter, at: { x: o.x, y: o.y } };
    for (const p of this.host.pilots(run.num)) this.host.send(p.conn, msg as ServerMessage);
  }

  private dawn(run: Run, pilots: { conn: PilotConn }[]): void {
    run.phase = 'day';
    run.ready.clear();
    run.boss = '';
    // Whatever's out on the moon goes with the dark
    this.endObjective(run, null);
    for (const r of run.extras) this.host.removeHostile(r);
    run.extras = [];
    // Pay goes with how hard the night was: the roster's night, and the moon's grade
    const d = this.rules.dawn;
    const w = run.wave, rw = run.wave + run.offset, gk = this.host.gradeReward(run.grade);
    const xp = Math.round((d.xpBase + d.xpPerNight * rw) * gk), credits = Math.round((d.creditsBase + d.creditsPerNight * rw) * gk), supplies = d.suppliesBase + d.suppliesPerNight * w;
    run.supplies += supplies;
    for (const p of pilots) {
      const h = run.haul.get(p.conn) ?? { xp: 0, credits: 0, nights: 0 };
      h.xp += xp; h.credits += credits; h.nights++;
      run.haul.set(p.conn, h);
      const milestone = h.nights % this.rules.haulBonus.every === 0 ? this.t('sieges.dawnMilestone', { nights: h.nights, bonus: haulBonus(h.nights, this.rules) }) : '';
      this.host.toast(p.conn, this.t('sieges.dawn', { night: w, supplies, credits, milestone }), 'good');
    }
    this.sendState(run, true);
  }

  /** Pay a pilot their haul: in full (with the bonus) when they claim it by day, half otherwise */
  private settle(run: Run, conn: PilotConn, full: boolean): void {
    const h = run.haul.get(conn);
    run.haul.delete(conn);
    if (!h || (!h.xp && !h.credits)) return;
    const k = full ? haulBonus(h.nights, this.rules) : this.rules.partialHaul;
    const xp = Math.round(h.xp * k), credits = Math.round(h.credits * k);
    this.host.reward(conn, xp, credits, `siege:${run.name}`);
    this.host.toast(conn, full
      ? this.t('sieges.claimed', { name: run.name, nights: h.nights, s: h.nights === 1 ? '' : 's', bonus: k > 1 ? this.t('sieges.claimedBonus', { bonus: k }) : '', credits, xp })
      : this.t('sieges.halfSaved', { name: run.name, credits, xp }), full ? 'good' : 'warn');
  }

  /** No longer on the moon: off the ready list, the panel and the banner */
  private forget(run: Run, conn: PilotConn): void {
    run.shown.delete(conn);
    run.ready.delete(conn);
    this.host.send(conn, { type: 'siegeState', active: false } as ServerMessage);
    this.host.send(conn, { type: 'objectiveEnd', id: `moon:${run.num}` } as ServerMessage);
    this.host.send(conn, { type: 'objectiveEnd', id: `moonobj:${run.num}` } as ServerMessage);
  }

  /** By day: take the haul (with its bonus) and go back to orbit; the last one out ends the siege */
  private claim(run: Run, conn: PilotConn): void {
    const me = this.host.pilots(run.num).find((p) => p.conn === conn);
    this.settle(run, conn, true);
    this.forget(run, conn);
    if (me) this.host.toOrbit(conn, run.sys, Math.atan2(me.y, me.x));
    if (!this.host.pilots(run.num).some((p) => p.conn !== conn)) this.close(run);
    else this.sendState(run, true);
  }

  announce(run: Run, conn: PilotConn, what: string): void {
    for (const p of this.host.pilots(run.num)) this.host.toast(p.conn, this.t('sieges.announce', { who: this.host.name(conn), what }), 'info');
  }

  /** The banner: the phase, and the bastion's hull */
  private sendBanner(run: Run, now: number): void {
    const b = this.host.shipAt(run.bastion);
    const pilots = this.host.pilots(run.num);
    const left = run.raiders.length + run.stream.length + run.fronts.reduce((n, f) => n + f.ships.length, 0);
    const ready = pilots.filter((p) => run.ready.has(p.conn)).length;
    const dusk = this.rules.duskSeconds * SECOND;
    const text = run.phase === 'day' ? this.t('sieges.banner.day', { day: run.wave + 1, ready, pilots: pilots.length })
      : run.phase === 'dusk' ? this.t('sieges.banner.dusk', { night: run.wave, secs: Math.max(0, Math.ceil((run.next - now) / SECOND)) })
      : run.phase === 'night' ? this.t(run.boss ? 'sieges.banner.nightBoss' : 'sieges.banner.night', { night: run.wave, boss: run.boss, left, s: left === 1 ? '' : 's' })
      : this.t('sieges.banner.lost');
    const night = run.phase === 'night' || run.phase === 'lost' ? 1 : run.phase === 'dusk' ? 1 - Math.max(0, (run.next - now) / dusk) : 0;
    const bs = run.sys.surface!.bastion!;
    const msg = {
      type: 'objective', id: `moon:${run.num}`, title: this.t('sieges.banner.title', { name: run.name }), text,
      meter: { label: this.t('sieges.banner.meter'), value: Math.round((b?.hull ?? 0) * 100), max: 100 },
      danger: run.phase === 'night' || run.phase === 'lost', at: { x: bs.x, y: bs.y }, night: Math.round(night * 20) / 20,
    } as ServerMessage;
    const key = JSON.stringify(msg);
    if (key === run.banner) {
      // Newcomers still need it
      for (const p of pilots) if (!run.shown.has(p.conn)) this.host.send(p.conn, msg);
      return;
    }
    run.banner = key;
    for (const p of pilots) this.host.send(p.conn, msg);
  }

  /** The day's panel, to each pilot on the moon (when something changed, or `force`) */
  sendState(run: Run, force: boolean): void {
    const pilots = this.host.pilots(run.num);
    const ready = pilots.map((p) => ({ name: this.host.name(p.conn), ready: run.ready.has(p.conn) }));
    const free = run.turrets.filter((t) => t === null).length;
    const turrets = run.turrets.map((t) => {
      if (!t) return null;
      const def = this.rules.turrets[t.kind];
      return {
        label: this.turretName(def.label, t.mark), mark: t.mark + 1, hull: Math.round((this.host.shipAt(t.eid)?.hull ?? 0) * 100),
        upgrade: def.marks[t.mark + 1]?.cost, refund: Math.floor(t.spent * this.rules.scrapBack),
      };
    });
    const every = this.rules.haulBonus.every;
    // By day: whether tonight brings a boss
    const boss = run.phase === 'day' ? siegeBoss(run.profile, run.wave + 1 + run.offset) : null;
    const comingBoss = boss ? this.host.shipName(boss.ship) : undefined;
    for (const p of pilots) {
      const h = run.haul.get(p.conn) ?? { xp: 0, credits: 0, nights: 0 };
      const nextBonusAt = (Math.floor(h.nights / every) + 1) * every;
      const msg = {
        type: 'siegeState', active: true, title: run.name, phase: run.phase, wave: run.wave, supplies: run.supplies,
        profile: { name: run.profile.name, about: run.profile.about }, nextBoss: comingBoss,
        ready, youReady: run.ready.has(p.conn), pads: { free, total: run.turrets.length }, shop: this.shop, turrets,
        haul: { xp: h.xp, credits: h.credits, nights: h.nights, bonus: haulBonus(h.nights, this.rules), nextBonusAt, nextBonus: haulBonus(nextBonusAt, this.rules) },
      } as ServerMessage;
      const key = JSON.stringify(msg);
      if (!force && run.shown.get(p.conn) === key) continue;
      run.shown.set(p.conn, key);
      this.host.send(p.conn, msg);
    }
  }
}
