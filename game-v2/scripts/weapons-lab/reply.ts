// A model's reply to a weapon prompt -> a checked weapon row: strip the wrapping a chatty model adds (think blocks,
// code fences, prose around the object), parse the JSON, force the draft's id, then run the game's own validators.
import { validateModel, type Verdict } from './validate';

/** The JSON object in a reply, or an error message */
export function extractJson(text: string): { value?: any; error?: string } {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return { error: 'the reply has no JSON object' };
  try {
    const value = JSON.parse(body.slice(a, b + 1));
    return Array.isArray(value) || typeof value !== 'object' ? { error: 'the reply is not a JSON object' } : { value };
  } catch (e) { return { error: `the reply is not valid JSON (${(e as Error).message})` }; }
}

export interface Interpreted extends Verdict { model?: Record<string, any> }

/** Parse and validate; `id` is the draft's id (a model that answers with another id is renamed, not rejected) */
export function interpretReply(text: string, id: string, dir?: string): Interpreted {
  const { value, error } = extractJson(text);
  if (error) return { ok: false, problems: [error] };
  const model = { ...value, id };
  const v = validateModel(model, dir);
  return { ...v, model };
}
