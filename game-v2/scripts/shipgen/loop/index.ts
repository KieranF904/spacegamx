// Ship generator model loop: local LLM clients, the design/evolve/compare loops and their events.
export * from './events';
export { type ChatMessage, type ChatRequest, type ChatResult, type Llm, type LlmOptions, type ModelInfo, type Provider, AbortedError, TimeoutError, LMSTUDIO_OFF, createLlm, defaultModel, isCloudName, lmStudioChatFromEnv, splitId } from './llm';
export { DESIGN_SCHEMA, type Extracted, extractDesign, partialGrid, stripChatter } from './reply';
export { CONTRACTS, CONTRACT_IDS, CONTRACT_TEXT, PARTS_SCHEMA, type Contract, type ContractDef, extractParts, parseContract } from './contracts';
export { MODEL_PREFS, type ModelPref, autoContract, prefFor } from './modelPrefs';
export { STEPS, type Step, skeleton, stagedLoop, suggestCells } from './staged';
export { type Mutation, mutationsFor, pickMutation, rngOf } from './mutations';
export { type Renderer, type NativeRenderOptions, nativeRenderer } from './render';
export { CRITIC_PROMPT, CRITIC_SCHEMA, PAIR_PROMPT, PAIR_SCHEMA, type PairVerdict, type Verdict, comparePair, critique, parseVerdict } from './critic';
export { type Attempt, type DesignOptions, type DesignOutcome, type LoopDeps, better, contractFor, designLoop, passes, scoreOf, Session, NO_MIRROR_SYMMETRY_WEIGHT } from './design';
export { type EvolveOptions, type EvolveOutcome, type Individual, evolveLoop } from './evolve';
export { type CompareOptions, type CompareOutcome, compareLoop } from './compare';
export { type RunOptions, type RunOutcome, designMetrics, run, runEvents } from './run';
export { type BatchOptions, type BatchDeps, type BatchSummary, type ShipRecord, BUILD_BY_ROLE, DEFAULT_ROLES, buildFor, galleryHtml, nextNumber, runBatch, scanShips } from './batch';
export { conceptStep, hintFor } from './concept';
