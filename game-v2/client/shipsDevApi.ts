/**
 * Dev-server-only API for the proto hangar: list, read and write blueprint
 * JSON files in data/ships/blueprints/. Not part of any production build.
 *
 *   GET  /__ships/blueprints            → ["sparrow-t", ...]
 *   GET  /__ships/blueprints/<name>     → file contents
 *   POST /__ships/blueprints/<name>     → write body to <name>.json
 */

import type { Plugin } from 'vite';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function shipsDevApi(): Plugin {
  const dir = resolve(__dirname, '../data/ships/blueprints');
  return {
    name: 'ships-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__ships/blueprints', (req, res) => {
        const name = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\.json$/, ''));
        const send = (code: number, body: string, type = 'application/json') => {
          res.statusCode = code;
          res.setHeader('Content-Type', type);
          res.end(body);
        };
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (req.method === 'GET' && name === '') {
            const names = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
            return send(200, JSON.stringify(names));
          }
          if (!NAME.test(name)) return send(400, JSON.stringify({ error: 'bad blueprint name' }));
          const file = resolve(dir, `${name}.json`);
          if (req.method === 'GET') {
            return existsSync(file) ? send(200, readFileSync(file, 'utf-8')) : send(404, JSON.stringify({ error: 'not found' }));
          }
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
              try {
                const parsed = JSON.parse(body);
                if (typeof parsed?.name !== 'string' || !Array.isArray(parsed.parts)) return send(400, JSON.stringify({ error: 'not a blueprint' }));
                writeFileSync(file, body);
                send(200, JSON.stringify({ ok: true, name }));
              } catch {
                send(400, JSON.stringify({ error: 'invalid JSON' }));
              }
            });
            return;
          }
          send(405, JSON.stringify({ error: 'method not allowed' }));
        } catch (e) {
          send(500, JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}
