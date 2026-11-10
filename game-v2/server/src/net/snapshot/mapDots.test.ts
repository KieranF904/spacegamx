// Pins the contract invariant of mapDots.ts with a small fake MapHost: a dot is sent again only when its route changes or it strays MAP_DOT_SLACK
import { describe, it, expect } from 'vitest';
import { createWorld, addEntity, addComponent } from 'bitecs';
import { Position, Velocity, InSystem, Player, MAP_DOT_SLACK, type ServerMessage } from '@space-game/common';
import { sendMapDots, type MapHost } from './mapDots.js';

type Leg = { x: number; y: number; vx: number; vy: number; wx: number; wy: number; thrust: number };
const at = (x: number, vx = 0): Leg => ({ x, y: 0, vx, vy: 0, wx: vx, wy: 0, thrust: -1 });

describe('server.snapshot.map-dots', () => {
  const setup = () => {
    const world = createWorld();
    const pilot = addEntity(world), ship = addEntity(world);
    for (const e of [pilot, ship]) {
      addComponent(world, Position, e); addComponent(world, Velocity, e); addComponent(world, InSystem, e);
      InSystem.systemId[e] = 1; Position.x[e] = 0; Position.y[e] = 0; Velocity.x[e] = 0; Velocity.y[e] = 0;
    }
    addComponent(world, Player, pilot);
    const sent: ServerMessage[] = [];
    const ticks = { currentTick: 100 };
    const conn = {
      ws: { isOpen: () => true }, playerId: pilot, mapOpen: true, mapDotsDue: false, mapFresh: true,
      mapNamed: new Set<number>(), shipView: new Set<number>(), focus: false,
    };
    const state = { leg: at(1000), seq: 5 };
    const host = {
      world,
      gameData: { getSystemByNum: () => ({}) },
      clients: new Map([[{}, conn]]),
      ships: { bodies: new Map([[ship, { kind: 'ship' }]]) },
      enemies: { info: () => undefined, isCalm: () => false },
      lod: { track: () => ({ leg: state.leg, seq: state.seq }) },
      focus: { ghost: () => null },
      send: (_ws: unknown, m: ServerMessage) => { sent.push(m); },
      namedBody: () => ({ name: 'Drifter', kind: 1 }),
      flying: () => false,
      ticks,
    } as unknown as MapHost;
    // One map round: the dots sent in it (null when nothing was sent)
    const round = () => {
      sent.length = 0; ticks.currentTick += 60; sendMapDots(host, true);
      return sent.length ? (sent[0] as unknown as { dots: number[] }).dots.length : null;
    };
    return { round, state };
  };

  it('a far ship is sent again only when its route changes', () => {
    const t = setup();
    expect(t.round()).toBeGreaterThan(0);                 // new: sent once
    expect(t.round()).toBeNull();                         // same route: nothing
    expect(t.round()).toBeNull();
    t.state.leg = at(1000, 5); t.state.seq = 6;
    expect(t.round()).toBeGreaterThan(0);                 // new route: sent again
  });

  it('a live ship is sent again only once it strays MAP_DOT_SLACK from where the client has it', () => {
    const t = setup();
    t.state.seq = -1;
    expect(t.round()).toBeGreaterThan(0);
    t.state.leg = at(1000 + MAP_DOT_SLACK - 50);
    expect(t.round()).toBeNull();
    t.state.leg = at(1000 + MAP_DOT_SLACK + 50);
    expect(t.round()).toBeGreaterThan(0);
  });
});
