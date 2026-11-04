/**
 * The boss tools (docs/bosses/rework-2026-11.md 10): Kieran playtests the staged fights himself, so these let him jump
 * to any stage or move, simulate a group with dummy pilots, slow a fight down and see what hit him. Dev servers and
 * admins only: the message handler refuses anyone else (GameServer `bossDevTool`), and none of it is ever saved.
 *
 *   panel     the bosses in your system (life, stage, move, window), kept fresh while the panel is open
 *   goto      to the outside of its barrier (or beside its lair)
 *   wake/sleep/heal/skip   its lifecycle forced on (bosses/Lifecycle.ts)
 *   stage n   shed to the start of stage n; move: play it next; window: open one now; personal: one on you now
 *   hold      it holds still, no moves
 *   dummies   n dummy pilots inside its arena: they count as present (personal rolls, the loose cap), orbit it, never
 *             die, and deal a set damage a second (off, starter, level 30) so window caps fill as a group's would
 *   slow      its system's clock at 30 or 15 ticks a second (crowd dilation, announced to clients as ever)
 *   log       every hit you took inside an arena: tick, what did it, who, damage
 *   summary   time per stage, windows and cracks, damage in and out of windows, personal attacks drawn per pilot
 */

import { Position, Velocity, InSystem, dcos, dsin, dhypot, datan2, type BossDevRow, type BossLogEntry, type ClientBossDevMessage, type ServerMessage, type Blueprint, type ShipState } from '@space-game/common';
import type { ShipBridge, PilotOrders } from '../../ships/ShipBridge.js';
import type { Bosses } from '../Bosses.js';
import type { ArenaGates } from '../arenas/ArenaGates.js';
import { devHooks } from '../brains/kit.js';

export interface BossDevConn { readonly playerId: number }

export interface BossDevHost<C extends BossDevConn> {
  tick(): number;
  readonly bosses: Bosses;
  readonly gates: ArenaGates;
  readonly ships: ShipBridge;
  send(conn: C, msg: ServerMessage): void;
  toast(conn: C, text: string, kind: 'info' | 'warn'): void;
  /** A pilot's name (the damage log) */
  nameOf(eid: number): string;
  /** Put a pilot somewhere in their system */
  teleport(eid: number, x: number, y: number): void;
  /** A system's clock at this many ticks a second (60: back to normal); false if this server can't */
  slow(num: number, rate: number): boolean;
  /** A system's clock rate now */
  rateOf(num: number): number;
  /** Is this connection still here */
  live(conn: C): boolean;
}

/** Damage a second (raw, before armour) a dummy deals by setting: the fight model's starter, a level-30 rig */
const DUMMY_DPS = { off: 0, starter: 112, l30: 450 } as const;
/** How far out dummies orbit, and how many log entries each pilot keeps */
const DUMMY_RANGE = 1600, LOG_KEEP = 60;
/** The ships dummies fly (the first the library has) */
const DUMMY_SHIPS = ['sparrow-t', 'arrow', 'lancer'];

interface Dummy { eid: number; boss: number; dps: number; phase: number }

export class BossDev<C extends BossDevConn> {
  private dummies: Dummy[] = [];
  private watchers = new Set<C>();
  private logs = new Map<number, BossLogEntry[]>();
  /** Per boss (by its ship): the tick each stage began */
  private stages = new Map<number, { stage: number; at: number }[]>();

  constructor(private host: BossDevHost<C>) {
    host.gates.extras = (num) => this.dummies.filter((d) => InSystem.systemId[d.eid] === num && host.ships.has(d.eid)).map((d) => d.eid);
  }

  /** The nearest boss in the pilot's system (by id, if given), or null */
  private pick(conn: C, id?: string): { id: string; eid: number; num: number } | null {
    const pid = conn.playerId, num = InSystem.systemId[pid];
    let best: { id: string; eid: number; num: number } | null = null, bd = Infinity;
    for (const r of this.host.bosses.devList(num)) {
      if (id && r.id !== id) continue;
      const d = r.eid >= 0 ? dhypot(Position.x[r.eid] - Position.x[pid], Position.y[r.eid] - Position.y[pid]) : 1e9;
      if (!best || d < bd) { bd = d; best = { id: r.id, eid: r.eid, num }; }
    }
    return best;
  }

  handle(conn: C, msg: ClientBossDevMessage): void {
    const a = msg.action;
    if (a === 'panel') { if (msg.on === false) this.watchers.delete(conn); else this.watchers.add(conn); this.sendPanel(conn); return; }
    if (a === 'log') { if (msg.on === false) this.logs.delete(conn.playerId); this.sendPanel(conn); return; }
    const b = this.pick(conn, msg.boss);
    if (!b) { this.host.toast(conn, 'No boss in this system', 'warn'); return; }
    const bosses = this.host.bosses, brain = bosses.brainOf(b.eid), hooks = devHooks(brain), say = (t: string) => this.host.toast(conn, t, 'info');
    switch (a) {
      case 'goto': {
        const p = bosses.devOutside(b.id);
        if (p) { this.host.teleport(conn.playerId, p.x, p.y); say('Outside its barrier'); }
        break;
      }
      case 'wake': case 'sleep': case 'heal':
        say(bosses.life.force(b.id, a) ? `${b.id}: ${a}` : 'Not kept by a lifecycle (no arena), or not there');
        break;
      case 'skip': say(bosses.life.skip(b.id) ? 'Clock skipped' : 'Nothing to skip (not recovering or healing)'); break;
      case 'stage':
        if (hooks) { hooks.devToStage(Math.max(1, Math.round(Number(msg.n) || 1))); say(`To stage ${msg.n}`); }
        else if (brain?.forceShed) { brain.forceShed(Math.max(0, Math.round(Number(msg.n) || 0))); say(`Shed ${msg.n} steps`); }
        break;
      case 'move': if (hooks && msg.move) { hooks.devPlay(msg.move); say(`Next: ${msg.move}`); } break;
      case 'window': if (hooks) { hooks.devWindow(msg.move); say('Window open'); } break;
      case 'personal':
        if (hooks) say(hooks.devPersonalOn(msg.move || 'mark', conn.playerId) ? `Personal attack ${msg.move || 'mark'} on you` : `It has no personal attack ${msg.move}`);
        break;
      case 'hold': if (hooks) { hooks.devHold = msg.on ?? !hooks.devHold; say(hooks.devHold ? 'Holding still' : 'Fighting again'); } break;
      case 'dummies': this.setDummies(b, Math.max(0, Math.min(12, Math.round(Number(msg.n) || 0))), DUMMY_DPS[msg.dps ?? 'off'] ?? 0); say(`${msg.n ?? 0} dummy pilots`); break;
      case 'slow': {
        const rate = [60, 30, 15].includes(Number(msg.n)) ? Number(msg.n) : 60;
        say(this.host.slow(b.num, rate) ? `Clock at ${rate} ticks a second` : 'This server has no per-system clocks (crowd fallbacks off)');
        break;
      }
      case 'summary': this.sendPanel(conn, this.summary(b.eid, b.id)); return;
    }
    this.sendPanel(conn);
  }

  /** N dummy pilots on this boss (its ship must be up), any others on it taken away */
  private setDummies(b: { eid: number; num: number }, n: number, dps: number): void {
    for (const d of this.dummies.filter((x) => x.boss === b.eid)) this.drop(d);
    if (b.eid < 0 || !this.host.ships.has(b.eid)) return;
    const bp = this.dummyShip();
    if (!bp) return;
    for (let i = 0; i < n; i++) {
      const phase = (i / Math.max(1, n)) * Math.PI * 2;
      const x = Position.x[b.eid] + dcos(phase) * DUMMY_RANGE, y = Position.y[b.eid] + dsin(phase) * DUMMY_RANGE;
      const eid = this.host.ships.spawnDummy(bp, x, y, phase + Math.PI, b.num);
      this.host.bosses.unhurt.add(eid);
      const d: Dummy = { eid, boss: b.eid, dps, phase };
      this.host.ships.setController(eid, (id, ship) => this.orbit(d, id, ship));
      this.dummies.push(d);
    }
  }

  private dummyShip(): Blueprint | undefined {
    for (const n of DUMMY_SHIPS) { const bp = this.host.ships.library.get(n); if (bp) return bp; }
    return this.host.ships.library.values().next().value;
  }

  private drop(d: Dummy): void {
    this.host.bosses.unhurt.delete(d.eid);
    if (this.host.ships.has(d.eid)) this.host.ships.removeShip(d.eid);
    this.dummies = this.dummies.filter((x) => x !== d);
  }

  /** A dummy's orders: round its boss at DUMMY_RANGE, facing it */
  private orbit(d: Dummy, id: number, _ship: ShipState): PilotOrders | null {
    const bx = Position.x[d.boss], by = Position.y[d.boss];
    d.phase += 0.0025;
    const tx = bx + dcos(d.phase) * DUMMY_RANGE, ty = by + dsin(d.phase) * DUMMY_RANGE;
    const mx = tx - Position.x[id] - Velocity.x[id] * 20, my = ty - Position.y[id] - Velocity.y[id] * 20, l = dhypot(mx, my) || 1;
    const ux = l > 80 ? mx / l : 0, uy = l > 80 ? my / l : 0;
    return {
      controls: { forward: uy < -0.38, backward: uy > 0.38, left: ux < -0.38, right: ux > 0.38, boost: false, targetAngle: datan2(by - Position.y[id], bx - Position.x[id]) },
      firing: false,
    };
  }

  /** Every tick: dummies deal their damage (once a second), stage times, the panel kept fresh */
  tick(): void {
    const now = this.host.tick();
    for (const d of [...this.dummies]) {
      if (!this.host.ships.has(d.eid) || !this.host.ships.has(d.boss)) { this.drop(d); continue; }
      if (d.dps > 0 && (now + d.eid) % 60 === 0) {
        // (round its standing parts, a second at a time: spread like a group's fire)
        const ship = this.host.ships.get(d.boss);
        const alive = ship ? ship.hp.flatMap((h, i) => (h > 0 && ship.derived.alive[i] ? [i] : [])) : [];
        if (alive.length) this.host.ships.damagePartBy(d.boss, alive[(Math.floor(now / 60) + d.eid) % alive.length], d.dps, d.eid);
      }
    }
    for (const r of this.host.bosses.devLive()) {
      const st = devHooks(this.host.bosses.brainOf(r))?.stageNow;
      if (st === undefined) continue;
      const list = this.stages.get(r) ?? [];
      if (!list.length || list[list.length - 1].stage !== st) list.push({ stage: st, at: now });
      this.stages.set(r, list);
    }
    if (now % 30 === 0) for (const c of [...this.watchers]) { if (this.host.live(c)) this.sendPanel(c); else this.watchers.delete(c); }
  }

  /** A hit a pilot took (GameServer notifyDamage): logged when they're inside an arena */
  onDamage(target: number, amount: number, source: number): void {
    if (!this.host.gates.inside(target) || this.host.bosses.isBossShip(target)) return;
    const boss = this.host.bosses.isBossShip(source) ? source : -1;
    const cause = boss >= 0 ? this.host.bosses.brainOf(boss)?.fight?.cause ?? '' : '';
    const personal = /^personal:([^>]*)>(\d+)$/.exec(cause);
    const who = boss >= 0
      ? `${this.host.bosses.of(boss)?.def.name ?? 'boss'}${personal ? ` (${this.host.nameOf(Number(personal[2]))}'s)` : ''}`
      : source >= 0 ? this.host.nameOf(source) : 'the world';
    const list = this.logs.get(target) ?? [];
    list.push({ tick: this.host.tick(), attack: personal ? `personal ${personal[1]}` : cause, source: who, raw: Math.round(amount), dealt: Math.round(amount) });
    if (list.length > LOG_KEEP) list.splice(0, list.length - LOG_KEEP);
    this.logs.set(target, list);
  }

  private sendPanel(conn: C, summary?: string): void {
    const pid = conn.playerId, num = InSystem.systemId[pid], now = this.host.tick();
    const rows: BossDevRow[] = this.host.bosses.devList(num).map((r) => {
      const brain = r.eid >= 0 ? this.host.bosses.brainOf(r.eid) : undefined, hooks = devHooks(brain);
      return {
        id: r.id, name: r.name, eid: r.eid, life: r.life, stage: hooks?.stageNow ?? 0, move: hooks?.moveName ?? '',
        moves: hooks?.devMoves() ?? [], personal: hooks?.devPersonal() ?? [], window: hooks?.fight.devWindow(now) ?? null,
        hold: hooks?.devHold ?? false, dummies: this.dummies.filter((d) => d.boss === r.eid).length, rate: this.host.rateOf(num),
      };
    });
    this.host.send(conn, { type: 'bossDev', bosses: rows, log: (this.logs.get(pid) ?? []).slice(-20), ...(summary ? { summary } : {}) });
  }

  /** The fight so far, as text */
  private summary(eid: number, id: string): string {
    const hooks = devHooks(this.host.bosses.brainOf(eid)), now = this.host.tick();
    if (!hooks) return `${id}: no fight rules (not a staged boss, or not up)`;
    const st = this.stages.get(eid) ?? [];
    const per = st.map((s, i) => `stage ${s.stage}: ${(((st[i + 1]?.at ?? now) - s.at) / 60).toFixed(1)} s`).join(', ');
    const f = hooks.fight.stats;
    const drawn = [...f.drawn].map(([p, n]) => `${this.host.nameOf(p)} ${n}`).join(', ') || 'none';
    return `${id}: ${per || 'no stage times yet'}. Windows ${f.windows}, cracked ${f.cracks}. Damage in windows ${Math.round(f.insideDamage)}, outside ${Math.round(f.outsideDamage)}. Personal attacks drawn: ${drawn}.`;
  }

  /** A pilot left (the panel stops) */
  forget(conn: C): void {
    this.watchers.delete(conn);
  }
}
