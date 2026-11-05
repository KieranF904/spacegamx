/**
 * The scanner: with a powered scanner part (or for a while after a scanner
 * charge's pulse), the nearest asteroids in range are tagged with what they
 * hold: main ores by share, hardness, and any gem seam.
 */

import { clearIfDrawn } from '../rendering/gfx';
import { cameraView } from '../rendering/cameraView';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { EntityType, Economy } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';

const STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 15, fill: 0xd9f4ff, stroke: { color: 0x02060c, width: 4 }, lineHeight: 18 });
const MAX_TAGS = 14;
const GEM: Record<string, string> = { ruby: '♦ Ruby seam', sapphire: '♦ Sapphire seam', emerald: '♦ Emerald seam', void_opal: '♦ Void opal seam' };
const ORE_SHORT: Record<string, string> = {
  iron_ore: 'Iron', nickel_ore: 'Nickel', silicate: 'Silicate', ice: 'Ice', copper_ore: 'Copper', titanium_ore: 'Titanium',
  cobalt_ore: 'Cobalt', crystal: 'Crystal', helium3: 'He-3',
};

export class ScannerFx {
  private layer = new Container();
  private rings = new Graphics();
  private tags: Text[] = [];
  private pulseUntil = 0;
  private pulseAt = -1;
  private t = 0;

  constructor(parent: Container, private source: ShipSource, private state: GameState, private econ: Economy) {
    this.rings.blendMode = 'add';
    this.layer.addChild(this.rings);
    parent.addChild(this.layer);
  }

  /** A scanner charge was used: scan this far for a while */
  pulse(seconds: number): void {
    this.pulseUntil = this.t + seconds;
    this.pulseAt = this.t;
  }

  update(dt: number, zoom: number): void {
    this.t += dt;
    const g = this.rings;
    clearIfDrawn(g);
    const me = this.state.entities.get(this.state.playerId);
    const ship = this.source.get(this.state.playerId);
    const pulsing = this.t < this.pulseUntil;
    const range = Math.max(ship?.derived.scanRange ?? 0, pulsing ? 3200 : 0);
    let used = 0;
    if (me && range > 0) {
      // The pulse sweeping outwards
      if (this.pulseAt >= 0 && this.t - this.pulseAt < 1.6) {
        const k = (this.t - this.pulseAt) / 1.6;
        g.circle(me.renderX, me.renderY, range * k).stroke({ color: 0x80cbc4, width: 6 / Math.max(0.2, zoom), alpha: 0.6 * (1 - k) });
      }
      const near = [...this.state.entities.values()]
        .filter((e) => e.type === EntityType.Asteroid && e.composition)
        .map((e) => ({ e, d: Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) }))
        .filter((x) => x.d < range)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_TAGS);
      for (const { e } of near) {
        const c = e.composition!;
        const size = e.data?.[0] ?? 30;
        const ores = Object.entries(c.ores).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([id, w]) => `${ORE_SHORT[id] ?? this.econ.items.get(id)?.short ?? this.econ.items.name(id)} ${Math.round(w * 100)}%`).join(' · ');
        const hard = c.hardness >= 2 ? `  ${'▲'.repeat(c.hardness)}` : '';
        const label = `${ores}${hard}${c.seam ? `\n${GEM[c.seam.gem] ?? '♦ Seam'}` : ''}`;
        let tag = this.tags[used];
        if (!tag) { tag = new Text({ text: '', style: STYLE }); tag.anchor.set(0.5, 1); this.layer.addChild(tag); this.tags.push(tag); }
        if (tag.text !== label) tag.text = label;
        tag.visible = true;
        tag.scale.set(1 / Math.max(0.35, zoom));
        // Above it along the screen, upright, however the view is turned
        const up = size + 10 / Math.max(0.35, zoom), a = cameraView.angle;
        tag.x = e.renderX + Math.sin(a) * up;
        tag.y = e.renderY - Math.cos(a) * up;
        tag.rotation = a;
        tag.style.fill = c.seam ? 0xffd6f2 : 0xd9f4ff;
        g.circle(e.renderX, e.renderY, size + 8).stroke({ color: c.seam ? 0xff7ad9 : 0x4dd0e1, width: 2 / Math.max(0.35, zoom), alpha: 0.35 + 0.15 * Math.sin(this.t * 3) });
        used++;
      }
    }
    for (let i = used; i < this.tags.length; i++) this.tags[i].visible = false;
  }
}
