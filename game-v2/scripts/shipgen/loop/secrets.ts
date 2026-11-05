// The LM Studio bearer token: from the environment (LM_API_TOKEN) or game-v2/.env. It is only ever put in a request
// header: never printed, logged, returned in an event or written anywhere.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ENV_FILE = join(__dirname, '../../../.env');

/** The Anthropic API key (ANTHROPIC_API_KEY, in the environment or game-v2/.env): only ever put in a request header */
export function anthropicKey(envFile = ENV_FILE): string | undefined {
  const v = process.env.ANTHROPIC_API_KEY?.trim();
  if (v) return v;
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

export function lmStudioToken(envFile = ENV_FILE): string | undefined {
  const v = process.env.LM_API_TOKEN?.trim();
  if (v) return v;
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?LM_API_TOKEN\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}
