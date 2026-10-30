/**
 * Blueprint storage for the proto hangar: data/ships/blueprints/ through the
 * Vite dev API (client/shipsDevApi.ts).
 */

import { Blueprint, parseBlueprint, serializeBlueprint } from '@space-game/common';

const BASE = '/__ships/blueprints';

export function blueprintFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'ship';
}

export async function listBlueprints(): Promise<string[]> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(`list failed: ${r.status}`);
  return r.json();
}

export async function loadBlueprint(file: string): Promise<Blueprint> {
  const r = await fetch(`${BASE}/${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(`load ${file} failed: ${r.status}`);
  return parseBlueprint(await r.text());
}

export async function saveBlueprint(bp: Blueprint): Promise<string> {
  const file = blueprintFileName(bp.name);
  const r = await fetch(`${BASE}/${file}`, { method: 'POST', body: serializeBlueprint(bp) });
  if (!r.ok) throw new Error(`save failed: ${r.status} ${await r.text()}`);
  return file;
}
