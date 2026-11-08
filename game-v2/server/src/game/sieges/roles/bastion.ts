import type { Run } from '../types.js';

/** The bastion's place */
export function bastionAt(run: Run): { x: number; y: number } {
  const b = run.sys.surface!.bastion!;
  return { x: b.x, y: b.y };
}
