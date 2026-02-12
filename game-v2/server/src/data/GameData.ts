/**
 * Data Loader - Loads and indexes game data from JSON files
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ItemData,
  StarSystemData,
  EnemyTypeData,
  NPCData,
  StationData,
  QuestData,
  ItemsFile,
  SystemsFile,
  EnemiesFile,
  NPCsFile,
  StationsFile,
  QuestsFile,
} from '@space-game/common';

export class GameData {
  // Indexed by ID for O(1) lookup
  private items: Map<string, ItemData> = new Map();
  private systems: Map<string, StarSystemData> = new Map();
  private enemies: Map<string, EnemyTypeData> = new Map();
  private npcs: Map<string, NPCData> = new Map();
  private stations: Map<string, StationData> = new Map();
  private quests: Map<string, QuestData> = new Map();

  // Numeric ID mappings for ECS
  private itemIdToNum: Map<string, number> = new Map();
  private numToItemId: Map<number, string> = new Map();
  private systemIdToNum: Map<string, number> = new Map();
  private numToSystemId: Map<number, string> = new Map();
  private enemyIdToNum: Map<string, number> = new Map();
  private numToEnemyId: Map<number, string> = new Map();
  private stationIdToNum: Map<string, number> = new Map();
  private numToStationId: Map<number, string> = new Map();

  constructor(dataPath: string) {
    this.loadItems(join(dataPath, 'items.json'));
    this.loadSystems(join(dataPath, 'systems.json'));
    this.loadEnemies(join(dataPath, 'enemies.json'));
    this.loadNPCs(join(dataPath, 'npcs.json'));
    this.loadStations(join(dataPath, 'stations.json'));
    this.loadQuests(join(dataPath, 'quests.json'));
  }

  private loadItems(path: string): void {
    const data: ItemsFile = JSON.parse(readFileSync(path, 'utf-8'));
    let numId = 1;
    for (const item of data.items) {
      this.items.set(item.id, item);
      this.itemIdToNum.set(item.id, numId);
      this.numToItemId.set(numId, item.id);
      numId++;
    }
    console.log(`Loaded ${this.items.size} items`);
  }

  private loadSystems(path: string): void {
    const data: SystemsFile = JSON.parse(readFileSync(path, 'utf-8'));
    let numId = 0;
    for (const system of data.systems) {
      this.systems.set(system.id, system);
      this.systemIdToNum.set(system.id, numId);
      this.numToSystemId.set(numId, system.id);
      numId++;
    }
    console.log(`Loaded ${this.systems.size} star systems`);
  }

  private loadEnemies(path: string): void {
    const data: EnemiesFile = JSON.parse(readFileSync(path, 'utf-8'));
    let numId = 1;
    for (const enemy of data.enemies) {
      this.enemies.set(enemy.id, enemy);
      this.enemyIdToNum.set(enemy.id, numId);
      this.numToEnemyId.set(numId, enemy.id);
      numId++;
    }
    console.log(`Loaded ${this.enemies.size} enemy types`);
  }

  private loadNPCs(path: string): void {
    const data: NPCsFile = JSON.parse(readFileSync(path, 'utf-8'));
    for (const npc of data.npcs) {
      this.npcs.set(npc.id, npc);
    }
    console.log(`Loaded ${this.npcs.size} NPCs`);
  }

  private loadStations(path: string): void {
    const data: StationsFile = JSON.parse(readFileSync(path, 'utf-8'));
    let numId = 1;
    for (const station of data.stations) {
      this.stations.set(station.id, station);
      this.stationIdToNum.set(station.id, numId);
      this.numToStationId.set(numId, station.id);
      numId++;
    }
    console.log(`Loaded ${this.stations.size} stations`);
  }

  private loadQuests(path: string): void {
    const data: QuestsFile = JSON.parse(readFileSync(path, 'utf-8'));
    for (const quest of data.quests) {
      this.quests.set(quest.id, quest);
    }
    console.log(`Loaded ${this.quests.size} quests`);
  }

  // ============================================
  // GETTERS
  // ============================================

  getItem(id: string): ItemData | undefined {
    return this.items.get(id);
  }

  getItemByNum(num: number): ItemData | undefined {
    const id = this.numToItemId.get(num);
    return id ? this.items.get(id) : undefined;
  }

  getItemNum(id: string): number {
    return this.itemIdToNum.get(id) ?? 0;
  }

  getAllItems(): ItemData[] {
    return Array.from(this.items.values());
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

  getEnemy(id: string): EnemyTypeData | undefined {
    return this.enemies.get(id);
  }

  getEnemyByNum(num: number): EnemyTypeData | undefined {
    const id = this.numToEnemyId.get(num);
    return id ? this.enemies.get(id) : undefined;
  }

  getEnemyNum(id: string): number {
    return this.enemyIdToNum.get(id) ?? 0;
  }

  getAllEnemies(): EnemyTypeData[] {
    return Array.from(this.enemies.values());
  }

  getNPC(id: string): NPCData | undefined {
    return this.npcs.get(id);
  }

  getAllNPCs(): NPCData[] {
    return Array.from(this.npcs.values());
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

  getQuest(id: string): QuestData | undefined {
    return this.quests.get(id);
  }

  getAllQuests(): QuestData[] {
    return Array.from(this.quests.values());
  }

  // ============================================
  // QUERIES
  // ============================================

  getSystemStations(systemId: string): StationData[] {
    return this.getAllStations().filter(s => s.system === systemId);
  }

  getSystemNPCs(systemId: string): NPCData[] {
    return this.getAllNPCs().filter(n => n.system === systemId);
  }

  getSystemEnemies(systemId: string): EnemyTypeData[] {
    return this.getAllEnemies().filter(e => e.spawnInfo.systems.includes(systemId));
  }

  getNPCQuests(npcId: string): QuestData[] {
    const npc = this.npcs.get(npcId);
    if (!npc) return [];
    return npc.quests.map(qid => this.quests.get(qid)).filter((q): q is QuestData => q !== undefined);
  }

  getItemsByType(type: string): ItemData[] {
    return this.getAllItems().filter(i => i.type === type);
  }

  getWeaponsByType(weaponType: string): ItemData[] {
    return this.getAllItems().filter(i => i.weaponType === weaponType);
  }
}
