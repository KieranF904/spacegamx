/**
 * People (data/people.json): who you can talk to, where they are, and the
 * conversations themselves (econ/dialogue.ts has the shapes).
 *
 * Talking to someone (docked at their station, or flown close to them in
 * space or on a planet) opens the hub: a greeting, then what you can ask
 * about. That's the step of a job of yours that needs them, the jobs they
 * have for you (offered: Accept or Not now), and their own topics. A topic
 * runs its lines to the end, or to a question, where it waits for your
 * answer; then it's back to the hub, until you say goodbye.
 *
 * Quests never call you (job news is a toast, new work a badge on the log);
 * `call` remains for anything that must reach you over comms. A call that
 * comes while you're talking waits for you to finish.
 *
 * Talking to someone tells you about every job they could give you now (they
 * join your log as leads), even those you aren't experienced enough for yet.
 */

import {
  PersonDef, PersonPlace, PeopleFile, Line, Cond, CondContext, TalkView, PersonView, PlayerProfile, QuestDef, QuestStep, Bag, ServerMessage,
  condHolds, marksAdvance, dhypot,
} from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';
import type { Quests } from './Quests.js';
import type { Codex } from './Codex.js';
import { texts, type StringsFile, type Texts } from '../data/rules.js';

export interface PeopleHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  /** Where the pilot is flying (system id: a surface's own), or null */
  where(conn: PilotConn): { system: string; x: number; y: number } | null;
  /** The station the pilot is at (in range or docked) */
  stationAt(conn: PilotConn): string | null;
  stationName(id: string): string;
  stationSystem(id: string): string | undefined;
  itemName(id: string): string;
  random(): number;
}

/** Fly this close to someone out in space to talk */
export const TALK_RANGE = 900;
const DEFAULT_COLOR = '#9fb3cc';

type Who = { name: string; title: string; color: string };

/** People's stock replies (data/strings.json; these are the defaults) */
export const PEOPLE_STRINGS = {
  'people.outInSpace': 'out in space',
  'people.dockToTalk': '{name} is at {station}: dock there to talk',
  'people.flyCloser': 'Fly closer to {name} to talk',
  'people.greeting': 'Yes?',
  'people.comeBackLater': "Come back when you've more flying behind you (pilot level {level}). I'll have work for you then.",
  'people.goodbye': 'Goodbye.',
  'people.anythingElse': 'Anything else?',
  'people.fight.ask': 'Are you ready to go down?',
  'people.fight.ready': "I'm ready!",
  'people.fight.notYet': 'Let me get ready first.',
  'people.fight.comeBack': 'Come back when you are.',
  'people.short': "You haven't got everything yet. I need {items}{where}.",
  'people.short.item': '{n} {item}',
  'people.short.inHold': ' in your hold: your station storage is no use to me out here',
  'people.short.gone': 'Wait: where did it go? Come back when you have it.',
  'people.accept': 'Accept',
  'people.notNow': 'Not now.',
  'people.showMeTheWay': 'Show me the way',
  'people.later': 'Later.',
  'people.collect': 'Collect',
  'people.ok': 'OK',
};

interface Frame {
  lines: Line[];
  i: number;
  done?: () => void;
}

interface Pick {
  text: string;
  tone?: 'quest' | 'go' | 'bye';
  track?: string;
  act(): void;
}

interface Convo {
  n: number;
  conn: PilotConn;
  /** Face to face: who (for the hub); a call has none */
  person?: PersonDef;
  who: Who;
  comms: boolean;
  title?: string;
  frames: Frame[];
  said: { you?: boolean; text: string }[];
  picks: Pick[];
  offer?: TalkView['offer'];
  paid?: TalkView['paid'];
  /** Hang up once the lines run out (rather than back to the hub) */
  ending: boolean;
  /** What { advance } and { fight } do in this topic */
  advance?: () => void;
  fight?: () => void;
  /** A call's last answer: follow this job */
  track?: string;
}

export class People {
  private defs = new Map<string, PersonDef>();
  private talks = new Map<PilotConn, Convo>();
  /** Calls waiting for a conversation to end */
  private waiting = new Map<PilotConn, (() => void)[]>();
  /** The last people list sent (only changes are sent) */
  private shown = new Map<PilotConn, string>();
  private seq = 0;

  private t: Texts<keyof typeof PEOPLE_STRINGS>;
  /** Records a conversation can hand over (set once Codex is built) */
  codex: Codex | null = null;

  /** `strings`: data/strings.json (over the stock replies here) */
  constructor(private host: PeopleHost, private pilots: Pilots, private quests: Quests, readonly file: PeopleFile, strings?: StringsFile) {
    this.t = texts(PEOPLE_STRINGS, strings);
    for (const p of file.people) this.defs.set(p.id, p);
  }

  def(id: string): PersonDef | undefined {
    return this.defs.get(id);
  }

  name(id: string): string {
    return this.defs.get(id)?.name ?? id;
  }

  who(id: string): Who {
    const d = this.defs.get(id);
    return d ? { name: d.name, title: d.title, color: d.color ?? DEFAULT_COLOR } : { name: id, title: '', color: DEFAULT_COLOR };
  }

  // ---------------------------------------------------------------------------
  // Where people are
  // ---------------------------------------------------------------------------

  ctx(conn: PilotConn, p: PlayerProfile): CondContext {
    return {
      done: (id) => p.quests.done.includes(id),
      active: (id) => !!p.quests.active[id],
      known: (id) => p.quests.known.includes(id) || !!p.quests.active[id] || p.quests.done.includes(id),
      stage: (id) => p.quests.active[id]?.stage ?? -1,
      has: (items) => Object.entries(items).every(([id, n]) => this.pilots.available(conn, id) >= n),
      level: p.level,
      flag: (f) => p.quests.flags.includes(f),
      stat: (k) => p.stats[k] ?? 0,
      rep: (f) => p.reputation[f] ?? 0,
      seed: conn.username ?? String(conn.userId ?? ''),
    };
  }

  holds(conn: PilotConn, p: PlayerProfile, c: Cond | undefined): boolean {
    return condHolds(c, this.ctx(conn, p));
  }

  /** Where someone is for this pilot (people move as a job goes on) */
  placeOf(conn: PilotConn, p: PlayerProfile, d: PersonDef): PersonPlace {
    for (const m of d.moves ?? []) if (this.holds(conn, p, m.if)) return m.at;
    return d.at;
  }

  /** A place as a system, a point or a station, and in words */
  describe(at: PersonPlace): { system: string; station?: string; stationId?: string; x?: number; y?: number; label: string } {
    if ('station' in at) {
      const name = this.host.stationName(at.station);
      return { system: this.host.stationSystem(at.station) ?? '', station: name, stationId: at.station, label: name };
    }
    return { system: at.system, x: at.x, y: at.y, label: at.label ?? this.t('people.outInSpace') };
  }

  /** Everyone, where they are and whether they want this pilot (only changes are sent) */
  sendPeople(conn: PilotConn, force = false): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    const people: PersonView[] = [];
    for (const d of this.defs.values()) {
      const at = this.describe(this.placeOf(conn, p, d));
      const mark = this.quests.stepFor(conn, p, d.id) ? 'step' : this.quests.offersFrom(conn, p, d.id).some((o) => o.ok) ? 'offer' : undefined;
      people.push({ id: d.id, name: d.name, title: d.title, color: d.color ?? DEFAULT_COLOR, ...at, mark });
    }
    const json = JSON.stringify(people);
    if (!force && this.shown.get(conn) === json) return;
    this.shown.set(conn, json);
    this.host.send(conn, { type: 'people', people });
  }

  /** Can this pilot talk to them face to face right now: null, or why not */
  private reach(conn: PilotConn, p: PlayerProfile, d: PersonDef): string | null {
    const at = this.placeOf(conn, p, d);
    if ('station' in at) {
      return this.host.stationAt(conn) === at.station ? null : this.t('people.dockToTalk', { name: d.name, station: this.host.stationName(at.station) });
    }
    const w = this.host.where(conn);
    if (!w || w.system !== at.system || dhypot(w.x - at.x, w.y - at.y) > TALK_RANGE) return this.t('people.flyCloser', { name: d.name });
    return null;
  }

  /** The person out in space (or on a surface) within talking range, if any (X talks to them) */
  nearby(conn: PilotConn): PersonDef | null {
    const p = this.pilots.get(conn);
    const w = this.host.where(conn);
    if (!p || !w) return null;
    for (const d of this.defs.values()) {
      const at = this.placeOf(conn, p, d);
      if (!('station' in at) && at.system === w.system && dhypot(w.x - at.x, w.y - at.y) <= TALK_RANGE) return d;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  handle(conn: PilotConn, msg: { person?: string; n?: number; choice?: number; close?: boolean }): void {
    if (typeof msg.person === 'string') return this.talkTo(conn, msg.person);
    const c = this.talks.get(conn);
    if (!c || c.n !== msg.n) return;
    if (msg.close) return this.close(conn);
    const pick = c.picks[Math.floor(Number(msg.choice))];
    if (!pick) return;
    c.picks = [];
    pick.act();
    if (this.talks.get(conn) === c) this.run(c);
  }

  talkTo(conn: PilotConn, personId: string): void {
    const p = this.pilots.get(conn);
    const d = this.defs.get(personId);
    if (!p || !d) return;
    const why = this.reach(conn, p, d);
    if (why) return this.pilots.toast(conn, why, 'warn');
    // Walking up to someone ends what was on screen (calls still waiting come after this conversation)
    this.talks.delete(conn);
    const c = this.open(conn, this.who(d.id), false);
    c.person = d;
    this.hub(c, d.greeting[Math.floor(this.host.random() * d.greeting.length)] ?? this.t('people.greeting'));
  }

  /** Someone calls (a job's news): their lines, then OK (or Show me the way, for a lead) */
  call(conn: PilotConn, who: Who, lines: Line[], opts: { title?: string; paid?: TalkView['paid']; track?: string } = {}): void {
    if (!this.pilots.get(conn) || !lines.length) return;
    if (this.talks.has(conn)) {
      const q = this.waiting.get(conn) ?? [];
      q.push(() => this.call(conn, who, lines, opts));
      this.waiting.set(conn, q);
      return;
    }
    const c = this.open(conn, who, true);
    c.title = opts.title;
    c.paid = opts.paid;
    c.track = opts.track;
    c.ending = true;
    c.frames.push({ lines, i: 0 });
    this.run(c);
  }

  /** Walk away (or the connection ended) */
  close(conn: PilotConn, quiet = false): void {
    if (!this.talks.delete(conn)) return;
    if (!quiet) this.host.send(conn, { type: 'talk', view: null });
    const next = this.waiting.get(conn)?.shift();
    if (next) next();
  }

  leave(conn: PilotConn): void {
    this.talks.delete(conn);
    this.waiting.delete(conn);
    this.shown.delete(conn);
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  private open(conn: PilotConn, who: Who, comms: boolean): Convo {
    const c: Convo = { n: ++this.seq, conn, who, comms, frames: [], said: [], picks: [], ending: false };
    this.talks.set(conn, c);
    return c;
  }

  /** The hub: what you can ask this person about */
  private hub(c: Convo, greeting?: string): void {
    const p = this.pilots.get(c.conn);
    const d = c.person;
    if (!p || !d) return this.close(c.conn);
    c.title = undefined;
    c.advance = c.fight = undefined;
    if (greeting) c.said.push({ text: greeting });
    // Hearing what they could give you: every such job joins the log
    const offers = this.quests.offersFrom(c.conn, p, d.id);
    for (const o of offers) this.quests.reveal(c.conn, o.q.id, true);
    const later = offers.filter((o) => !o.ok).map((o) => o.q.level);
    if (greeting && later.length && !offers.some((o) => o.ok)) {
      c.said.push({ text: this.t('people.comeBackLater', { level: Math.min(...later) }) });
    }
    const picks: Pick[] = [];
    // A job of yours that needs them
    const step = this.quests.stepFor(c.conn, p, d.id);
    if (step) picks.push({ text: step.q.name, tone: 'quest', act: () => this.stepTopic(c, step.q, step.step) });
    for (const o of offers.filter((x) => x.ok)) {
      picks.push({ text: `${o.q.name}`, tone: 'quest', act: () => this.offerTopic(c, o.q) });
    }
    for (const t of d.topics ?? []) {
      const heard = t.once && t.id ? p.quests.flags.includes(`${d.id}:${t.id}`) : false;
      if (heard || !this.holds(c.conn, p, t.if)) continue;
      picks.push({ text: t.label, act: () => {
        if (t.once && t.id) this.flag(c.conn, p, `${d.id}:${t.id}`);
        c.frames.push({ lines: t.lines, i: 0 });
      } });
    }
    picks.push({ text: this.t('people.goodbye'), tone: 'bye', act: () => this.close(c.conn) });
    if (!c.said.length) c.said.push({ text: this.t('people.anythingElse') });
    c.picks = picks;
    this.show(c);
  }

  /** A job on offer: what they say about it, then Accept or Not now */
  private offerTopic(c: Convo, q: QuestDef): void {
    c.title = q.name;
    c.frames.push({ lines: [...(q.offer ?? [{ say: q.intro }]), { offer: q.id }], i: 0 });
  }

  /** The step of a job that needs them: talk (lines, hand-overs) or an arena fight */
  private stepTopic(c: Convo, q: QuestDef, s: QuestStep): void {
    const p = this.pilots.get(c.conn);
    if (!p) return;
    c.title = q.name;
    const stage = p.quests.active[q.id]?.stage ?? -1;
    if (s.type === 'boss' && s.arena) {
      c.fight = () => {
        const err = this.quests.fight(c.conn, q.id);
        if (err) { c.said.push({ text: err }); return; }
        c.frames = [];
        c.ending = true;
        c.said = [];
      };
      c.frames.push({ lines: [...(s.lines ?? []), { ask: this.t('people.fight.ask'), choices: [
        { text: this.t('people.fight.ready'), then: [{ fight: true }] },
        { text: this.t('people.fight.notYet'), then: [{ say: this.t('people.fight.comeBack') }] },
      ] }], i: 0 });
      return;
    }
    if (s.type !== 'talk') return;
    // Short of what they need: they say so, and the step waits
    if (s.take) {
      const short = Object.entries(s.take).filter(([id, n]) => this.pilots.available(c.conn, id) < n);
      if (short.length) {
        const docked = 'station' in this.placeOf(c.conn, p, c.person!);
        c.said.push({ text: this.t('people.short', {
          items: short.map(([id, n]) => this.t('people.short.item', { n, item: this.host.itemName(id) })).join(', '),
          where: docked ? '' : this.t('people.short.inHold'),
        }) });
        return;
      }
    }
    let done = false;
    const advance = () => {
      if (done) return;
      done = true;
      // Still that step? (a conversation can outlast a change)
      if (p.quests.active[q.id]?.stage !== stage) return;
      if (s.take && !this.pilots.take(c.conn, s.take)) {
        c.said.push({ text: this.t('people.short.gone') });
        return;
      }
      if (s.give) this.give(c.conn, s.give);
      this.quests.advanceStep(c.conn, q.id);
    };
    c.advance = advance;
    c.frames.push({ lines: s.lines ?? [], i: 0, done: marksAdvance(s.lines) ? undefined : advance });
  }

  /** Run the lines until they wait for an answer, or run out */
  private run(c: Convo): void {
    const p = this.pilots.get(c.conn);
    if (!p) return this.close(c.conn);
    while (c.frames.length) {
      if (this.talks.get(c.conn) !== c) return;
      const f = c.frames[c.frames.length - 1];
      if (f.i >= f.lines.length) {
        c.frames.pop();
        f.done?.();
        continue;
      }
      const l = f.lines[f.i++];
      if ('say' in l) c.said.push({ you: l.who === 'you', text: l.say });
      else if ('if' in l && 'then' in l) c.frames.push({ lines: this.holds(c.conn, p, l.if) ? l.then : l.else ?? [], i: 0 });
      else if ('choices' in l) {
        if (l.ask) c.said.push({ text: l.ask });
        const opts = l.choices.filter((ch) => this.holds(c.conn, p, ch.if));
        c.picks = opts.map((ch) => ({ text: ch.text, act: () => { c.frames.push({ lines: ch.then ?? [], i: 0 }); } }));
        if (c.picks.length) return this.show(c);
      } else if ('offer' in l) {
        const q = this.quests.def(l.offer);
        if (!q || !this.quests.offersFrom(c.conn, p, q.person ?? '').some((o) => o.ok && o.q.id === q.id)) continue;
        this.quests.reveal(c.conn, q.id, true);
        c.offer = this.quests.offerView(q);
        c.picks = [
          { text: this.t('people.accept'), tone: 'go', act: () => {
            const err = this.quests.acceptFrom(c.conn, q.id);
            if (err) c.said.push({ text: err });
          } },
          { text: this.t('people.notNow'), act: () => {} },
        ];
        return this.show(c);
      } else if ('reveal' in l) this.quests.reveal(c.conn, l.reveal);
      else if ('give' in l) this.give(c.conn, l.give);
      else if ('flag' in l) this.flag(c.conn, p, l.flag);
      else if ('codex' in l) this.codex?.unlock(c.conn, [l.codex]);
      else if ('advance' in l) c.advance?.();
      else if ('fight' in l) c.fight?.();
      else if ('end' in l) { c.frames = []; c.ending = true; }
    }
    if (this.talks.get(c.conn) !== c) return;
    // Out of lines: back to the hub, or (calls, goodbyes) hang up
    if (c.person && !c.ending) return this.hub(c);
    if (!c.said.length && !c.paid) return this.close(c.conn);
    c.picks = c.track
      ? [{ text: this.t('people.showMeTheWay'), tone: 'go', track: c.track, act: () => this.close(c.conn) }, { text: this.t('people.later'), tone: 'bye', act: () => this.close(c.conn) }]
      : [{ text: c.comms ? (c.paid ? this.t('people.collect') : this.t('people.ok')) : this.t('people.goodbye'), tone: 'bye', act: () => this.close(c.conn) }];
    this.show(c);
  }

  private show(c: Convo): void {
    const view: TalkView = {
      n: c.n, who: c.who, comms: c.comms || undefined, title: c.title, lines: c.said,
      choices: c.picks.map((x) => ({ text: x.text, tone: x.tone, track: x.track })),
      offer: c.offer, paid: c.paid,
    };
    this.host.send(c.conn, { type: 'talk', view });
    c.said = [];
    c.offer = undefined;
    c.paid = undefined;
  }

  private give(conn: PilotConn, items: Bag): void {
    const left = this.pilots.give(conn, items, { source: 'quest' });
    if (Object.keys(left).length) this.pilots.give(conn, left, { toStorage: true, source: 'quest' });
  }

  private flag(conn: PilotConn, p: PlayerProfile, f: string): void {
    if (p.quests.flags.includes(f)) return;
    p.quests.flags.push(f);
    this.pilots.markDirty(conn);
    this.quests.checkReveals(conn, p);
  }
}
