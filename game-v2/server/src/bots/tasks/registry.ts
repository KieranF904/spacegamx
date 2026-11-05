/** The tasks by name. Add a task: write tasks/<name>.ts exporting a TaskDef and list it here. */
import type { TaskDef } from './types.js';
import { mineAndDeposit } from './mineAndDeposit.js';

const defs: TaskDef[] = [mineAndDeposit];
const byName = new Map(defs.map((d) => [d.name, d]));

export const taskNames = (): string[] => [...byName.keys()];
export const taskDef = (name: string): TaskDef | undefined => byName.get(name);
export function registerTask(def: TaskDef): void { byName.set(def.name, def); }
