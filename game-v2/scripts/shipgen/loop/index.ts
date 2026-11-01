// Ship generator model loop: local LLM clients, the design/evolve/compare loops and their events.
export * from './events';
export { type ChatMessage, type ChatRequest, type ChatResult, type Llm, type LlmOptions, type ModelInfo, type Provider, AbortedError, TimeoutError, createLlm, defaultModel, isCloudName, splitId } from './llm';
export { CONTRACT_TEXT, type Contract, DESIGN_SCHEMA, type Extracted, extractDesign, partialGrid, stripChatter } from './reply';
export { type Mutation, mutationsFor, pickMutation, rngOf } from './mutations';
export { type Renderer, type NativeRenderOptions, nativeRenderer } from './render';
export { CRITIC_PROMPT, CRITIC_SCHEMA, type Verdict, critique, parseVerdict } from './critic';
export { type Attempt, type DesignOptions, type DesignOutcome, type LoopDeps, better, contractFor, designLoop, passes, scoreOf } from './design';
export { type EvolveOptions, type EvolveOutcome, type Individual, evolveLoop } from './evolve';
export { type CompareOptions, type CompareOutcome, compareLoop } from './compare';
export { type RunOptions, type RunOutcome, designMetrics, run, runEvents } from './run';
