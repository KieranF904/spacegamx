/**
 * @contract common.tutorial
 * owns:       the tutorial's shared surface: types, saved-state helpers and the data validator (see README.md)
 * needs:      types, state, data
 * invariants: the real tutorial data validates — common/src/tutorial/tutorial.test.ts
 * extend:     export a new tutorial module here
 */
export * from './types.js';
export * from './state.js';
export * from './data.js';
