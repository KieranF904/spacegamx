/**
 * @contract server.bots.task-registry
 * owns:       the bot tasks by name
 * needs:      TaskDef (tasks/types.ts), the task modules
 * invariants: mine and deposit and random flight are listed and found by their names, a registered task too — server/src/bots/tasks/registry.test.ts
 * extend:     a new task is tasks/<name>.ts exporting a TaskDef and one entry in the defs list
 */

/** The tasks by name. Add a task: write tasks/<name>.ts exporting a TaskDef and list it here. */
import type { TaskDef } from './types.js';
import { mineAndDeposit } from './mineAndDeposit.js';
import { randomFlight } from './randomFlight.js';

const defs: TaskDef[] = [mineAndDeposit, randomFlight];
const byName = new Map(defs.map((d) => [d.name, d]));

export const taskNames = (): string[] => [...byName.keys()];
export const taskDef = (name: string): TaskDef | undefined => byName.get(name);
export function registerTask(def: TaskDef): void { byName.set(def.name, def); }
