/**
 * The sound effects' names, variant counts and reverb sends. Kept apart from
 * the recipes (sfx.ts, the synthesis code) so the audio manager can read them at
 * startup and load the rendering code only when audio actually starts.
 * sfxMeta.test.ts checks this table lists exactly the recipes.
 */

/** Per effect: [variants rendered as id, id#1, id#2, ..., send to the shared reverb 0..1] */
export const SFX_TABLE: Record<string, readonly [variants: number, reverb: number]> = {
  shot: [4, 0.3],
  hit: [4, 0.3],
  mine_tick: [4, 0.08],
  mining_pulse: [3, 0.25],
  boss_charge: [2, 0.35],
  magma_charge: [3, 0.3],
  magma_shot: [3, 0.3],
  magma_burst: [3, 0.35],
  boss_beam: [2, 0.3],
  laser_pulse: [3, 0.3],
  hurt: [2, 0.2],
  explosion_small: [3, 0.55],
  explosion_large: [2, 0.7],
  jump_charge: [1, 0.2],
  gun_charge: [1, 0.15],
  gun_clack: [2, 0.1],
  gun_vent: [1, 0.25],
  gun_spin: [1, 0.12],
  jump_launch: [1, 0.6],
  jump_arrive: [1, 0.5],
  warp: [1, 0.6],
  dock: [1, 0.4],
  undock: [1, 0.4],
  credits: [1, 0.2],
  level_up: [1, 0.5],
  error: [1, 0],
  warning: [1, 0],
  ui_click: [1, 0],
  ui_hover: [1, 0],
  ui_open: [1, 0.15],
  ui_close: [1, 0.15],
  jump_ready: [1, 0.35],
  tutorial_step: [1, 0.25],
  tutorial_one: [1, 0.25],
  tutorial_two: [1, 0.25],
};

/** How many variants each effect has */
export const SFX_VARIANTS: Record<string, number> = Object.fromEntries(Object.entries(SFX_TABLE).map(([id, t]) => [id, t[0]]));
/** Each effect's send to the shared reverb */
export const SFX_REVERB: Record<string, number> = Object.fromEntries(Object.entries(SFX_TABLE).map(([id, t]) => [id, t[1]]));

/** A looping sound: the engine, boost and mining hums, and each held beam's (its part's sfxLoop) */
export type LoopId = 'engine' | 'boost' | 'mining' | (string & {});

export function variantKey(id: string, v: number): string {
  return v === 0 ? id : `${id}#${v}`;
}
