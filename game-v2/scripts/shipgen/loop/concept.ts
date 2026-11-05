// The concept step: one short call before a design's first round. The reply is a small JSON object (where the model
// takes a schema) or a strict text block; one that cannot be read falls back to the role's silhouette, never fails the run.
import { type Concept, type ConceptHint, type Role, CONCEPT_SCHEMA, CONCEPT_TOKENS, conceptKey, conceptLine, conceptRequest, fallbackConcept, parseConcept } from '../core/index';
import type { DesignOptions, LoopDeps } from './design';
import { numCtxFor, roleOf } from './design';
import type { Emit } from './events';
import { AbortedError } from './llm';

const fullId = (model: string) => (model.includes('/') ? model : `ollama/${model}`);

/** The hint for a design: the brief's silhouette, a seed, and the concepts already used */
export function hintFor(o: DesignOptions): ConceptHint {
  return { ...(o.brief.shape ? { shape: o.brief.shape } : {}), ...(o.conceptSeed !== undefined ? { seed: o.conceptSeed } : {}), ...(o.usedConcepts?.length ? { used: o.usedConcepts.slice(-6) } : {}) };
}

/** Asks for the concept (or uses a given one); emits a 'concept' event. undefined: none wanted, or cancelled */
export async function conceptStep(deps: LoopDeps, o: DesignOptions, emit: Emit): Promise<Concept | undefined> {
  if (!o.concept) return undefined;
  const role: Role | undefined = roleOf(deps.ctx, o.brief);
  const hint = hintFor(o);
  if (typeof o.concept === 'object') {
    emit({ type: 'concept', concept: o.concept, line: conceptLine(o.concept), ms: 0, hint });
    return o.concept;
  }
  const now = deps.now ?? Date.now;
  const t0 = now();
  deps.models ??= await deps.llm.list().catch(() => []);
  const mi = deps.models.find((m) => m.id === fullId(o.model));
  const json = !!mi?.structured;
  const req = conceptRequest(role, o.brief.text, hint, json);
  const thinks = !!mi?.thinking || !!o.think;
  // (Room to think first: a reasoning model spends tokens before the few it writes)
  const maxTokens = thinks ? CONCEPT_TOKENS + (o.think ? 6000 : 4000) : CONCEPT_TOKENS + 100;
  const messages = [{ role: 'system' as const, content: req.system }, { role: 'user' as const, content: req.user }];
  let concept: Concept | null = null;
  let note: string | undefined;
  try {
    const reply = await deps.llm.chat({
      model: o.model, messages, ...(json ? { schema: CONCEPT_SCHEMA } : {}), temperature: Math.max(o.temperature ?? 0.6, 0.8), think: o.think,
      numCtx: o.numCtx ?? numCtxFor(messages, maxTokens), maxTokens, timeoutMs: o.timeoutMs, idleMs: o.idleMs, signal: o.signal,
    });
    concept = parseConcept(reply.text, role);
    if (!concept) note = `concept reply unreadable${reply.truncated ? ' (cut off)' : ''}; using the role's silhouette`;
  } catch (e) {
    if (o.signal?.aborted || (e instanceof Error && (e.name === 'AbortError' || e instanceof AbortedError))) return undefined;
    note = `concept request failed (${(e as Error).message}); using the role's silhouette`;
    emit({ type: 'error', message: `model: concept: ${(e as Error).message}`, fatal: false });
  }
  concept ??= fallbackConcept(role, o.brief.shape);
  if (!concept) {
    emit({ type: 'error', message: `concept: ${note ?? 'none'}; going on without`, fatal: false });
    return undefined;
  }
  emit({ type: 'concept', concept, line: conceptLine(concept), ms: now() - t0, hint, ...(note ? { note } : {}) });
  return concept;
}

export { conceptKey };
