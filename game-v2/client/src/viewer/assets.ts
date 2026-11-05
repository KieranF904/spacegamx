/**
 * What the asset viewer can show, as ids:
 *   ship:<path>       a blueprint under data/ships/blueprints (ship:sparrow-t, ship:enemy/pirate_gunship, ship:dev/annihilator)
 *   boss:<name>       the same as ship:enemy/<name> (bespoke boss and giant designs)
 *   model:<id>[@F]    a part model (models.json) on a hull stub, or alone (stub=0); @N/E/S/W picks its facing
 *   material:<id>     a test block in that material
 *   piece:<id>        a piece alone, in alloy
 *   sheet:<what>      a grid of many: models, materials, pieces, ships, enemy, bosses, all-ships, facings:<model>
 * and several at once, comma separated (a grid, as a sheet). Pure: no Pixi, no Vite.
 */

export type AssetKind = 'ship' | 'model' | 'material' | 'piece' | 'sheet';

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  label: string;
  group: string;
  /** Lower-cased words it's found by */
  terms: string;
}

export interface AssetSources {
  /** Blueprints by path under blueprints/ (no .json), with their name and whether they're a bespoke or rigid design */
  blueprints: { path: string; name: string; bespoke?: boolean; rigid?: boolean; parts?: number }[];
  models: { id: string; name?: string; family?: string; mount?: string; category?: string; rarity?: string }[];
  materials: { id: string; name?: string; grade?: number }[];
  pieces: { id: string; tier?: number }[];
}

export const SHEETS: Record<string, string> = {
  models: 'Every part model',
  materials: 'Every material',
  pieces: 'Every piece',
  ships: 'Library ships',
  enemy: 'Enemy ships',
  bosses: 'Bosses and giants',
  'all-ships': 'Every blueprint',
};

/** The browse panel's group for a blueprint */
export function shipGroup(b: AssetSources['blueprints'][number]): string {
  const base = b.path.split('/').pop()!;
  if (b.bespoke || b.rigid || /^(boss|giant)_/.test(base)) return 'Bosses & giants';
  if (b.path.startsWith('enemy/')) return 'Enemy ships';
  if (b.path.startsWith('dev/')) return 'Dev blueprints';
  if (b.path.includes('/')) return `Blueprints · ${b.path.split('/')[0]}`;
  return 'Library ships';
}

/** Every asset, in browse order: sheets, ships by group, models by family, materials, pieces */
export function listAssets(src: AssetSources): AssetEntry[] {
  const out: AssetEntry[] = [];
  const add = (id: string, kind: AssetKind, label: string, group: string, extra = '') =>
    out.push({ id, kind, label, group, terms: `${id} ${label} ${group} ${extra}`.toLowerCase() });
  for (const [k, label] of Object.entries(SHEETS)) add(`sheet:${k}`, 'sheet', label, 'Sheets');
  const groupRank = (g: string) => ['Library ships', 'Dev blueprints', 'Enemy ships', 'Bosses & giants'].indexOf(g) + 1 || 9;
  const ships = [...src.blueprints].sort((a, b) => groupRank(shipGroup(a)) - groupRank(shipGroup(b)) || a.path.localeCompare(b.path));
  for (const b of ships) add(`ship:${b.path}`, 'ship', b.name || b.path, shipGroup(b), `${b.path} ${b.bespoke ? 'bespoke' : ''} ${b.rigid ? 'rigid' : ''}`);
  const models = [...src.models].sort((a, b) => (a.family ?? '').localeCompare(b.family ?? '') || a.id.localeCompare(b.id));
  for (const m of models) add(`model:${m.id}`, 'model', m.name ?? m.id, `Models · ${m.family ?? m.category ?? 'other'}`, `${m.mount ?? ''} ${m.category ?? ''} ${m.rarity ?? ''}`);
  for (const m of src.materials) add(`material:${m.id}`, 'material', m.name ?? m.id, 'Materials', `mk${m.grade ?? ''}`);
  for (const p of src.pieces) add(`piece:${p.id}`, 'piece', p.id, 'Pieces');
  return out;
}

/** Entries matching every word of `q` (any order, anywhere in its id, label or group) */
export function searchAssets(list: AssetEntry[], q: string): AssetEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter((e) => words.every((w) => e.terms.includes(w))) : list;
}

export interface AssetRef {
  kind: Exclude<AssetKind, 'sheet'>;
  /** Blueprint path, model id, material id or piece id */
  key: string;
  /** A model's facing, given in its id (model:x@E) */
  facing?: 'N' | 'E' | 'S' | 'W';
}

/** One id (not a sheet) as what to build; null if it isn't one */
export function parseAssetId(id: string): AssetRef | null {
  const m = /^(ship|boss|model|material|piece):([A-Za-z0-9_\-/.]+?)(?:@([NESW]))?$/.exec(id.trim());
  if (!m || m[2].includes('..')) return null;
  const [, kind, key, facing] = m;
  if (kind === 'boss') return { kind: 'ship', key: key.includes('/') ? key : `enemy/${key}` };
  if (facing && kind !== 'model') return null;
  return { kind: kind as AssetRef['kind'], key, ...(facing ? { facing: facing as AssetRef['facing'] } : {}) };
}

/**
 * What an asset param shows: each id it names, sheets expanded (unknown ids dropped). `list` is listAssets' answer.
 */
export function expandAsset(asset: string, list: AssetEntry[]): AssetRef[] {
  const out: AssetRef[] = [];
  const ofKind = (k: AssetKind, group?: (g: string) => boolean) => list.filter((e) => e.kind === k && (!group || group(e.group)));
  for (const raw of asset.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('sheet:')) {
      const what = raw.slice(6);
      const ids = what === 'models' ? ofKind('model')
        : what === 'materials' ? ofKind('material')
        : what === 'pieces' ? ofKind('piece')
        : what === 'ships' ? ofKind('ship', (g) => g === 'Library ships')
        : what === 'enemy' ? ofKind('ship', (g) => g === 'Enemy ships')
        : what === 'bosses' ? ofKind('ship', (g) => g === 'Bosses & giants')
        : what === 'all-ships' ? ofKind('ship')
        : what.startsWith('facings:') ? (['N', 'E', 'S', 'W'] as const).map((f) => ({ id: `model:${what.slice(8)}@${f}` }))
        : [];
      for (const e of ids) { const r = parseAssetId(e.id); if (r) out.push(r); }
      continue;
    }
    const r = parseAssetId(raw);
    if (r) out.push(r);
  }
  return out;
}

/** A label for one ref (sheets put it under each) */
export function refLabel(r: AssetRef, list: AssetEntry[]): string {
  const id = r.kind === 'ship' ? `ship:${r.key}` : `${r.kind}:${r.key}`;
  const e = list.find((x) => x.id === id);
  return `${e?.label ?? r.key}${r.facing ? ` ${r.facing}` : ''}`;
}
