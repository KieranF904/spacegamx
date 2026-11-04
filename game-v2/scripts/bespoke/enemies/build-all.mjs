/**
 * Builds every design of the custom enemy roster (DESIGN ONLY) into docs/enemies/designs/: runs each
 * scripts/bespoke/enemies/<id>.mjs in turn.   node scripts/bespoke/enemies/build-all.mjs
 */
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).filter((f) => f.endsWith('.mjs') && !['kit.mjs', 'build-all.mjs', 'render.mjs'].includes(f)).sort()) await import(pathToFileURL(join(here, f)).href);
