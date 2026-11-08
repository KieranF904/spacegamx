/**
 * @contract server.data.game-data
 * owns:       loading and indexing the game data JSON files into GameData
 * needs:      @space-game/common data shapes and terrain builders
 * invariants: the real data indexes without errors — server/src/data/validateGameData.test.ts
 * extend:     a new data file is a field on GameDataFiles, an index in GameData and a read in loadGameDataFromDisk.ts
 */

/**
 * Data Loader - Loads and indexes game data from JSON files
 */

import { buildTerrain, withArenaGates, type Terrain, type TerrainFile } from '@space-game/common';
import {
  ItemDef,
  RecipesFile,
  MiningTable,
  StarSystemData,
  StationData,
  ItemsFile,
  SystemsFile,
  StationsFile,
  QuestsFile,
  PeopleFile,
  CodexFile,
  UnlockTable,
  setUnlockTable,
  HazardRules,
  registerRockTypes,
  registerAmmo,
  GemsFile,
  StationFile,
  setStationTable,
} from '@space-game/common';
import { checkGameData } from './validateGameData.js';
import type { RulesFile, StringsFile } from './rules.js';

/** Parsed contents of the data JSON files. Node loads them from disk; proto mode bundles them. */
export interface GameDataFiles {
  items: ItemsFile;
  recipes: RecipesFile;
  mining: MiningTable;
  factions: unknown;
  bosses?: unknown;
  /** Single-body enemies (data/mobs.json) */
  mobs?: unknown;
  /** Surfaces' rock, by surface id (data/terrain/<id>.json) */
  terrain?: Record<string, TerrainFile>;
  systems: SystemsFile;
  stations: StationsFile;
  quests: QuestsFile;
  /** Who you can talk to (data/people.json) */
  people?: PeopleFile;
  /** Records: lore found as documents and testimony (data/codex.json) */
  codex?: CodexFile;
  /** Ribbons (data/achievements.json) */
  achievements?: unknown;
  /** Tuning for sieges, surfaces, events and operations (data/rules.json) */
  rules?: RulesFile;
  /** Player-facing text (data/strings.json) */
  strings?: StringsFile;
  /** What each level opens up (data/unlocks.json) */
  unlocks?: Partial<UnlockTable>;
  /** Hazard rules: where ratings rise, what builds tolerate (data/hazards.json) */
  hazards?: HazardRules;
  /** Cut gems and sockets (data/gems.json) */
  gems?: GemsFile;
  /** Your station: charter, sites, tracks (data/station.json) */
  station?: StationFile;
}

export class GameData {
  // Indexed by ID for O(1) lookup
  private items: Map<string, ItemDef> = new Map();
  /** The raw item and recipe files (the economy is built from these plus the ship catalogue) */
  readonly itemsFile: ItemsFile;
  readonly recipesFile: RecipesFile;
  readonly miningTable: MiningTable;
  readonly factionsFile: unknown;
  readonly bossesFile: unknown;
  readonly mobsFile: unknown;
  private terrainFiles: Record<string, TerrainFile>;
  private terrains = new Map<string, Terrain>();
  private systems: Map<string, StarSystemData> = new Map();
  private stations: Map<string, StationData> = new Map();
  /** Quest definitions (the Quests module indexes them) */
  readonly questsFile: QuestsFile;
  readonly peopleFile: PeopleFile;
  readonly codexFile: CodexFile;
  readonly achievementsFile: unknown;
  /** data/rules.json: each module merges its section over its own defaults */
  readonly rulesFile: RulesFile;
  readonly hazardRules: HazardRules;
  readonly gemsFile: GemsFile;
  readonly stationFile: StationFile | undefined;
  /** data/strings.json: each module's text over its own defaults */
  readonly stringsFile: StringsFile;

  // Numeric ID mappings for ECS
  private itemIdToNum: Map<string, number> = new Map();
  private numToItemId: Map<number, string> = new Map();
  private systemIdToNum: Map<string, number> = new Map();
  private numToSystemId: Map<number, string> = new Map();
  private stationIdToNum: Map<string, number> = new Map();
  private instances: Map<string, number[]> = new Map();
  private numToStationId: Map<number, string> = new Map();

  constructor(files: GameDataFiles) {
    // Shape and cross-reference checks (throws in dev/test, logs in production)
    checkGameData(files);
    this.itemsFile = files.items;
    this.recipesFile = files.recipes;
    this.miningTable = files.mining;
    this.factionsFile = files.factions;
    this.bossesFile = files.bosses ?? { rules: { creditRange: 5000, creditWindowTicks: 3600, barRange: 7000 }, bosses: {} };
    this.mobsFile = files.mobs ?? { mobs: {} };
    this.terrainFiles = files.terrain ?? {};
    this.loadItems(files.items);
    this.loadSystems(files.systems);
    this.loadStations(files.stations);
    this.questsFile = { quests: files.quests.quests ?? [], reputations: files.quests.reputations ?? {}, restricted: files.quests.restricted ?? {} };
    this.peopleFile = { people: files.people?.people ?? [] };
    this.codexFile = { entries: files.codex?.entries ?? [] };
    this.achievementsFile = files.achievements ?? { ribbons: [] };
    this.rulesFile = files.rules ?? {};
    this.stringsFile = files.strings ?? {};
    setUnlockTable(files.unlocks);
    registerRockTypes(files.mining);
    registerAmmo(files.items.items);
    this.hazardRules = files.hazards ?? {};
    this.stationFile = files.station;
    setStationTable(files.station);
    this.gemsFile = files.gems ?? { sockets: { byGrade: [], levelByGrade: [], largeArea: 2, legendary: [0, 0] }, cuts: {}, types: {} };
  }

  private loadItems(data: ItemsFile): void {
    let numId = 1;
    for (const item of data.items) {
      this.items.set(item.id, item);
      this.itemIdToNum.set(item.id, numId);
      this.numToItemId.set(numId, item.id);
      numId++;
    }
    console.log(`Loaded ${this.items.size} items`);
  }

  private loadSystems(data: SystemsFile): void {
    let numId = 0;
    for (const system of data.systems) {
      this.systems.set(system.id, system);
      this.systemIdToNum.set(system.id, numId);
      this.numToSystemId.set(numId, system.id);
      this.instances.set(system.id, [numId]);
      numId++;
    }
    // Instanced systems (a party's own copy of a moon): more numbers for the same system.
    // Clients are only ever told the system's id, so a copy looks just like the original.
    for (const system of data.systems) {
      for (let k = 1; k < (system.instance?.slots ?? 1); k++) {
        this.numToSystemId.set(numId, system.id);
        this.instances.get(system.id)!.push(numId);
        numId++;
      }
    }
    console.log(`Loaded ${this.systems.size} star systems`);
  }

  /** Every copy of a system (its own number first; more for instanced systems) */
  getSystemInstances(id: string): number[] {
    return this.instances.get(id) ?? [];
  }

  private loadStations(data: StationsFile): void {
    let numId = 1;
    for (const station of data.stations) {
      this.stations.set(station.id, station);
      this.stationIdToNum.set(station.id, numId);
      this.numToStationId.set(numId, station.id);
      numId++;
    }
    console.log(`Loaded ${this.stations.size} stations`);
  }


  // ============================================
  // GETTERS
  // ============================================

  getItem(id: string): ItemDef | undefined {
    return this.items.get(id);
  }

  getItemByNum(num: number): ItemDef | undefined {
    const id = this.numToItemId.get(num);
    return id ? this.items.get(id) : undefined;
  }

  getItemNum(id: string): number {
    return this.itemIdToNum.get(id) ?? 0;
  }

  getAllItems(): ItemDef[] {
    return Array.from(this.items.values());
  }

  /** A surface's rock (built once), or undefined where there's none */
  terrain(systemId: string): Terrain | undefined {
    let t = this.terrains.get(systemId);
    if (t) return t;
    // (A boss arena's barrier is part of its rock: world/gates.ts)
    const file = withArenaGates(this.terrainFiles[systemId], this.systems.get(systemId)?.arena);
    if (file) this.terrains.set(systemId, (t = buildTerrain(file)));
    return t;
  }

  getSystem(id: string): StarSystemData | undefined {
    return this.systems.get(id);
  }

  getSystemByNum(num: number): StarSystemData | undefined {
    const id = this.numToSystemId.get(num);
    return id ? this.systems.get(id) : undefined;
  }

  getSystemNum(id: string): number {
    return this.systemIdToNum.get(id) ?? 0;
  }

  getAllSystems(): StarSystemData[] {
    return Array.from(this.systems.values());
  }

  getStation(id: string): StationData | undefined {
    return this.stations.get(id);
  }

  getStationByNum(num: number): StationData | undefined {
    const id = this.numToStationId.get(num);
    return id ? this.stations.get(id) : undefined;
  }

  getStationNum(id: string): number {
    return this.stationIdToNum.get(id) ?? 0;
  }

  getAllStations(): StationData[] {
    return Array.from(this.stations.values());
  }


  // ============================================
  // QUERIES
  // ============================================

  getSystemStations(systemId: string): StationData[] {
    return this.getAllStations().filter(s => s.system === systemId);
  }

}
