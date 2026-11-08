/**
 * @contract client.render.entity-parts
 * owns:       the small pieces drawn over an entity: name tag and health bar (Tag), a jump gate's rings (Gate), and placing them upright on a turned view
 * needs:      pixi Container, Graphics and Text; npm: pixi.js
 * invariants: the health bar redraws only when what it shows changes — none pinned
 * extend:     a new overlay part is one more build function here and one field on Renderer's per-entity maps
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js';

/** A name tag and health bar over an entity (kept, not looked up by name each frame) */
export interface Tag {
  name: Text | null;
  bar: Graphics | null;
  /** What the bar shows now (it's redrawn only when that changes) */
  barKey: string;
}

/** A jump gate's moving parts */
export interface Gate { outer: Graphics; inner: Graphics; core: Graphics; phase: number; pulse: number }

/** A screen-aligned offset (ox, oy) in an entity's turned frame (c, sn: the cos and sin of `up`, the roll that keeps `o` upright) */
export function placeUpright(o: Container, c: number, sn: number, up: number, ox: number, oy: number): void {
  o.position.set(c * ox - sn * oy, sn * ox + c * oy);
  o.rotation = up;
}

export function buildPlayerParts(container: Container): Tag {
  // The ship itself is drawn by the ship renderer; this container carries
  // the health bar and name tag

  // Health bar (above ship): drawn from its left edge, so it empties from the right (see updateHealthBar)
  const bar = new Graphics();
  bar.label = 'healthBar';
  bar.visible = false;  // Only show when damaged
  container.addChild(bar);

  // Nametag (below ship), rastered at 2x so it stays crisp zoomed in
  const nameTag = new Text({
    text: '',
    resolution: 2,
    style: new TextStyle({
      fontFamily: 'Arial, sans-serif',
      fontSize: 11,
      fill: 0xffffff,
      align: 'center',
      dropShadow: {
        color: 0x000000,
        blur: 2,
        distance: 1,
        alpha: 0.8,
      },
    }),
  });
  nameTag.anchor.set(0.5, 0);
  nameTag.position.set(0, 38);
  nameTag.label = 'nameTag';
  container.addChild(nameTag);
  return { name: nameTag, bar, barKey: '' };
}

/** A jump gate: a glowing core in two counter-rotating broken rings, breathing slowly (see updateEffects) */
export function buildPortalParts(container: Container, id: number): Gate {
  const g = new Graphics();
  g.circle(0, 0, 150);
  g.fill({ color: 0x4400aa, alpha: 0.3 });
  g.circle(0, 0, 100);
  g.fill({ color: 0x6600cc, alpha: 0.5 });
  container.addChild(g);

  // Rings broken into arcs, so their turning shows
  const arcs = (r: number, n: number, gap: number, color: number, width: number, alpha: number) => {
    const ring = new Graphics();
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / n) * (1 - gap);
      ring.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1);
    }
    ring.stroke({ color, width, alpha });
    ring.blendMode = 'add';
    container.addChild(ring);
    return ring;
  };
  const outer = arcs(138, 6, 0.28, 0xa98bff, 6, 0.65);
  const inner = arcs(84, 4, 0.35, 0xc9b6ff, 4, 0.7);

  const core = new Graphics();
  core.circle(0, 0, 50);
  core.fill({ color: 0x8800ff, alpha: 0.7 });
  core.circle(0, 0, 20);
  core.fill({ color: 0xffffff });
  container.addChild(core);
  return { outer, inner, core, phase: (id * 1.618) % (Math.PI * 2), pulse: 1 };
}

/** A pilot's health bar and shield strip, redrawn only when what it shows changes; shown once damaged */
export function updateHealthBar(tag: Tag, entity: { hp: number; maxHp: number; data?: number[] }): void {
  const bar = tag.bar!;
  if (entity.hp === undefined || !entity.maxHp) return;
  const f = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
  // Shield (data[4], 0..100): a strip over the bar while it's partly down
  const sh = Math.max(0, Math.min(1, (entity.data?.[4] ?? 0) / 100));
  const show = f < 1 || (sh > 0 && sh < 1);
  bar.visible = show;
  if (!show) return;
  const key = `${f.toFixed(3)}|${sh.toFixed(2)}`;
  if (key === tag.barKey) return;
  tag.barKey = key;
  const w = 35;
  bar.clear();
  bar.rect(-0.5, -0.5, w + 1, 5).fill({ color: 0x000000, alpha: 0.5 }).stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
  // Red-orange, amber below half, deep red below a quarter (as the hostiles' bars)
  bar.rect(0, 0, w * f, 4).fill({ color: f > 0.5 ? 0xff6b5a : f > 0.25 ? 0xffa94d : 0xff3b3b });
  if (sh > 0) bar.rect(0, -3, w * sh, 2).fill({ color: 0x7dd3fc });
}
