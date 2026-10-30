/**
 * Proto mode entry (npm run proto → /?proto).
 *
 * Hosts the authoritative GameServer in this browser tab behind a
 * LocalTransport. No server process, no login, no client prediction: the
 * client reads simulation state directly from the shared ECS arrays.
 */

import { Position, Velocity, Rotation, Blueprint, ShipTuning, InventoryStub } from '@space-game/common';
import { Game } from '../Game';
import type { GameState } from '../state/GameState';
import { createProtoServer } from '../../../server/src/proto/createProtoServer';
import { LocalTransport } from '../../../server/src/net/LocalTransport';
import { ProtoTools } from '../ships/ProtoTools';

import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import mining from '../../../data/mining.json';
import factions from '../../../data/factions.json';
import bosses from '../../../data/bosses.json';
import mobs from '../../../data/mobs.json';
import systems from '../../../data/systems.json';
import stations from '../../../data/stations.json';
import quests from '../../../data/quests.json';
import people from '../../../data/people.json';
import codex from '../../../data/codex.json';
import rules from '../../../data/rules.json';
import strings from '../../../data/strings.json';
import pieces from '../../../data/ships/pieces.json';
import functions from '../../../data/ships/functions.json';
import models from '../../../data/ships/models.json';
import materials from '../../../data/ships/materials.json';
import tuning from '../../../data/ships/tuning.json';
import inventory from '../../../data/ships/inventory.json';
import sparrowT from '../../../data/ships/blueprints/sparrow-t.json';

/** Every enemy design, by id (data/ships/blueprints/enemy) */
async function enemyDesigns(): Promise<Record<string, Blueprint>> {
  const mods = import.meta.glob('../../../data/ships/blueprints/enemy/*.json', { import: 'default' });
  const out: Record<string, Blueprint> = {};
  await Promise.all(Object.entries(mods).map(async ([path, load]) => { out[path.split('/').pop()!.replace(/\.json$/, '')] = (await load()) as Blueprint; }));
  return out;
}

export async function startProto(container: HTMLElement): Promise<void> {
  const files = { items, recipes, mining, factions, bosses, mobs, systems, stations, quests, people, codex, rules, strings } as any;
  // ?proto&scene=sectors: the whole world (enemies, asteroids, bosses) instead of the empty scene
  const scene = new URLSearchParams(location.search).get('scene') === 'sectors' ? 'sectors' : 'empty';
  const ships = {
    catalog: { pieces, functions, materials, models, bespoke: Object.values(import.meta.glob('../../../data/ships/bespoke/*.json', { eager: true, import: 'default' })) } as any,
    tuning: tuning as ShipTuning,
    starter: sparrowT as Blueprint,
    inventory: inventory as InventoryStub,
    // The world's hostiles (only loaded for it)
    ...(scene === 'sectors' ? { enemies: await enemyDesigns() } : {}),
  };
  const server = createProtoServer({ files, ships, scene });
  const transport = new LocalTransport(server);
  const bridge = server.getShips();

  const tools = new ProtoTools({
    server,
    bridge,
    getPlayerId: () => transport.getPlayerId(),
    replayConfig: { files, ships },
  });

  const game = new Game(container, {
    transport,
    proto: {
      onInit: (ctx) => tools.onInit(ctx),
      afterInterpolate: (state) => {
        readSimulationState(state);
        tools.update();
      },
      onKeyPressed: (code) => tools.onKeyPressed(code),
    },
    // No stations in the empty scene; the hangar pauses the local simulation
    ships: {
      editAnywhere: true,
      onHangarOpen: () => server.setPaused(true),
      onHangarClose: () => server.setPaused(false),
    },
  });
  await game.init();
  game.start();

  console.log('[proto] modular ships · H hangar · K damage · J repair · B dummy · V controls');
  // Handy for poking at things from the devtools console.
  (window as any).proto = { server, transport, game, bridge };
}

/** Overwrite interpolated positions with the live simulation values (same process, same arrays). */
function readSimulationState(state: GameState): void {
  for (const e of state.entities.values()) {
    e.x = e.renderX = Position.x[e.id];
    e.y = e.renderY = Position.y[e.id];
    e.vx = Velocity.x[e.id];
    e.vy = Velocity.y[e.id];
    e.angle = e.renderAngle = Rotation.angle[e.id];
  }
}
