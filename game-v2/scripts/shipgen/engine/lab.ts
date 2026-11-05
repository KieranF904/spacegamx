// "Open in Energy Lab": the lab reads prototypes/energy-lab/ships.js, which its own exporter writes from the blueprint
// folders. A saved design is in data/ships/blueprints/dev, so re-running the exporter puts it in the lab, and
// index.html#ship=<name> opens it.
import { spawn } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';

/** Runs the lab's exporter in a child Node with this process's TypeScript loader (tsx); resolves with its output */
export function runLabExporter(exporter: string, cwd: string, timeoutMs = 120000): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, exporter], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); fail(new Error('the lab exporter timed out')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) ok(out.trim()); else fail(new Error(`the lab exporter failed (${code}): ${out.trim().slice(-400)}`));
    });
  });
}

/** The lab's page for a ship, opened from disk */
export const labUrl = (lab: string, name: string) => `${pathToFileURL(join(lab, 'index.html')).href}#ship=${encodeURIComponent(name)}`;
