/** Dev-only bots (docs/areas/bots.md). Entry points: BotManager (spawn, step, `/bot`), the tasks registry, BotStats. */
export { BotManager, assertDev, type DriverKind } from './core/BotManager.js';
export { Bot } from './core/Bot.js';
export { BotStats, summaryTable, type Summary, type TripStats } from './stats/BotStats.js';
export { taskDef, taskNames, registerTask } from './tasks/registry.js';
export type { BotTask, TaskDef, TaskOpts } from './tasks/types.js';
export type { PilotDriver, Controls, Phase } from './core/types.js';
