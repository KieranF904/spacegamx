/**
 * Quest system utilities and helpers
 */

import { QuestData, QuestStage, QuestRewards } from '../data/schemas.js';

// Re-export for convenience
export type { QuestData, QuestStage, QuestRewards };

// Quest objective types (for runtime matching)
export enum QuestObjectiveType {
  TRAVEL = 'travel',
  KILL = 'kill',
  GATHER = 'gather',
  INTERACT = 'interact',
  ACTION = 'action',
  ACQUIRE = 'acquire',
}

// Quest runtime state
export interface QuestState {
  questId: string;
  stageIndex: number;
  progress: number;
  startedAt: number;
}

// Get all quests available from an NPC
export function getQuestsFromNPC(npcId: string, quests: QuestData[]): QuestData[] {
  return quests.filter(q => q.giver === npcId);
}

// Check if player meets prerequisites for a quest
export function canStartQuest(
  quest: QuestData, 
  playerLevel: number, 
  completedQuests: string[]
): boolean {
  // Check level requirement
  if (quest.level > playerLevel) return false;
  
  // Check prerequisites
  for (const prereq of quest.prerequisites) {
    if (!completedQuests.includes(prereq)) return false;
  }
  
  return true;
}
