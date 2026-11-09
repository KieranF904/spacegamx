/**
 * @contract client.ui.resource-thumbs
 * owns:       the small pictures the guide's source icons use: a rock drawn from its type (outline, ore colour, hardness rim) and an enemy's ship silhouette from its blueprint, each drawn on first view and cached
 * needs:      common/ (getAsteroidPolygon, hashString), the enemy blueprints (data/ships/blueprints/enemy), a ship-silhouette drawer from the host (ResourceDeps.shipIcon), DOM canvas (nothing is drawn without one)
 * invariants: a thumbnail is drawn at most once per id; with no canvas or no blueprint it returns '' and the view shows a colour swatch — client/src/ui/resources/resourceDictionary.test.ts
 * extend:     a new kind of source icon is one more function here and one more chip kind in guideChips.ts
 */

import { getAsteroidPolygon, hashString } from '@space-game/common';
import type { EnemyEntry, RockEntry } from './sourceIndex';

type Parts = { piece: string; rot: number; flip: boolean; x: number; y: number }[];
interface Bp { parts: Parts }

const blueprintFiles = import.meta.glob('../../../../data/ships/blueprints/enemy/*.json', { eager: true, import: 'default' }) as Record<string, Bp>;
const BLUEPRINTS = new Map(Object.entries(blueprintFiles).map(([path, bp]) => [path.split('/').pop()!.replace(/\.json$/, ''), bp]));

const SIZE = 56;
const cache = new Map<string, string>();

function mix(hex: string, to: number, k: number): string {
  const v = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = (shift: number) => Math.round(((v >> shift) & 255) * (1 - k) + ((to >> shift) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** A rock's picture: its own lumpy outline, tinted by its main ore (`oreColor`), harder rock darker with a bright rim */
export function rockThumb(r: RockEntry, oreColor: string): string {
  const hit = cache.get(`rock:${r.id}`);
  if (hit !== undefined) return hit;
  let url = '';
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    if (g) {
      g.translate(SIZE / 2, SIZE / 2);
      const base = mix(oreColor, 0x6b6b6b, 0.3);
      if (r.gas) {
        const grad = g.createRadialGradient(0, 0, 2, 0, 0, 24);
        grad.addColorStop(0, mix(oreColor, 0xffffff, 0.3)); grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad; g.beginPath(); g.arc(0, 0, 24, 0, Math.PI * 2); g.fill();
      } else {
        const poly = getAsteroidPolygon(hashString(`guide-rock:${r.id}`) % 100000, 0, 0, 24);
        g.beginPath();
        poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        const grad = g.createLinearGradient(-20, -20, 20, 20);
        grad.addColorStop(0, mix(oreColor, 0xffffff, 0.4)); grad.addColorStop(0.5, base); grad.addColorStop(1, mix(oreColor, 0x000000, 0.6));
        g.fillStyle = grad; g.fill();
        g.lineWidth = r.hardness > 1 ? 2.5 : 1.5;
        g.strokeStyle = r.hardness > 1 ? mix(oreColor, 0xffffff, 0.55) : mix(oreColor, 0x000000, 0.65);
        g.stroke();
      }
      url = c.toDataURL();
    }
  }
  cache.set(`rock:${r.id}`, url);
  return url;
}

/** An enemy's ship silhouette from its blueprint ('' when it has none, or the host can't draw one) */
export function enemyThumb(e: EnemyEntry, shipIcon: ((parts: Parts, size: number) => string) | undefined): string {
  const hit = cache.get(`enemy:${e.id}`);
  if (hit !== undefined) return hit;
  const bp = e.blueprint ? BLUEPRINTS.get(e.blueprint) : undefined;
  let url = '';
  if (bp && shipIcon) {
    try { url = shipIcon(bp.parts, 40); } catch { url = ''; }
  }
  if (url) cache.set(`enemy:${e.id}`, url);
  return url;
}
