/**
 * Proto-only ship tools, on top of the normal ShipClient (rendering, HUD,
 * hangar, helm controls). These reach into the in-process server directly.
 *
 *   K  damage the part under the cursor by tuning.debug.damageFraction
 *   U  restore the ship (J is the jump drive)
 *   B  spawn a dummy ship (blueprint chosen in the admin panel) at the cursor
 */

import type { Application } from 'pixi.js';
import { Position, InSystem, Blueprint } from '@space-game/common';
import type { GameServer } from '../../../server/src/GameServer';
import type { ShipBridge } from '../../../server/src/ships/ShipBridge';
import type { ProtoServerOptions } from '../../../server/src/proto/createProtoServer';
import type { Renderer } from '../rendering/Renderer';
import type { InputManager } from '../input/InputManager';
import { listBlueprints, loadBlueprint } from './blueprintApi';

export interface ProtoToolsDeps {
  server: GameServer;
  bridge: ShipBridge;
  getPlayerId(): number;
  /** Everything the determinism worker needs to build its own servers */
  replayConfig: { files: ProtoServerOptions['files']; ships: ProtoServerOptions['ships'] };
}

export class ProtoTools {
  private renderer: Renderer | null = null;
  private input: InputManager | null = null;
  private dummyBlueprint: Blueprint;
  private panel: HTMLDivElement | null = null;
  private replayResult = '';
  private lastPanelUpdate = 0;

  constructor(private deps: ProtoToolsDeps) {
    this.dummyBlueprint = deps.bridge.playerBlueprint;
  }

  onInit(ctx: { app: Application; renderer: Renderer; input: InputManager }): void {
    this.renderer = ctx.renderer;
    this.input = ctx.input;
  }

  /** Once per frame. */
  update(): void {
    this.updatePanel();
  }

  onKeyPressed(code: string): boolean {
    const { bridge } = this.deps;
    const pid = this.deps.getPlayerId();
    switch (code) {
      case 'KeyK': {
        const m = this.mouseWorld();
        const hit = m && bridge.partAt(m.x, m.y);
        if (hit) bridge.damagePartFraction(hit.eid, hit.part, bridge.tuning.debug.damageFraction);
        return true;
      }
      case 'KeyU':
        bridge.repair(pid);
        return true;
      case 'KeyB': {
        const m = this.mouseWorld();
        if (m) {
          const angle = Math.atan2(Position.y[pid] - m.y, Position.x[pid] - m.x);
          bridge.spawnDummy(this.dummyBlueprint, m.x, m.y, angle, InSystem.systemId[pid]);
        }
        return true;
      }
    }
    return false;
  }

  private mouseWorld(): { x: number; y: number } | null {
    if (!this.renderer || !this.input) return null;
    return this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY);
  }

  // -------------------------------------------------------------------------
  // Admin panel section
  // -------------------------------------------------------------------------

  private updatePanel(): void {
    const host = document.getElementById('adminPanel');
    if (!host) return;
    if (!this.panel || !host.contains(this.panel)) this.panel = this.buildPanel(host);
    const now = performance.now();
    if (now - this.lastPanelUpdate < 250) return;
    this.lastPanelUpdate = now;

    const { bridge } = this.deps;
    const ship = bridge.get(this.deps.getPlayerId());
    const body = this.panel.querySelector('#protoShipsBody')!;
    if (!ship) { body.innerHTML = '<div style="color:#888">no ship</div>'; return; }
    const d = ship.derived;
    const alive = d.alive.filter(Boolean).length;
    let html = `<div>last rebuild  ${bridge.stats.lastRebuildMs.toFixed(3)} ms</div>`;
    html += `<div>rebuilds      ${bridge.stats.rebuildCount}</div>`;
    html += `<div>parts         ${alive} / ${ship.blueprint.parts.length}</div>`;
    html += `<div>debris        ${bridge.stats.debrisCount}</div>`;
    html += `<div style="margin-top:4px;color:#aaa">satisfaction</div>`;
    ship.blueprint.parts.forEach((p, i) => {
      if (!(bridge.catalog.functions.get(p.fn)?.demand)) return;
      const s = d.alive[i] ? d.satisfaction[i] : 0;
      const color = s >= 0.999 ? '#4ade80' : s > 0.5 ? '#f2d24b' : '#f87171';
      html += `<div>  ${p.fn.padEnd(8)} #${String(p.uid).padEnd(3)} <span style="color:${color}">${d.alive[i] ? Math.round(s * 100) + '%' : 'gone'}</span></div>`;
    });
    if (this.replayResult) html += `<div style="margin-top:4px">${this.replayResult}</div>`;
    body.innerHTML = html;
  }

  private buildPanel(host: HTMLElement): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = 'margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,100,100,0.3);';
    el.innerHTML = `
      <div style="color:#ffb547; font-weight:bold; margin-bottom:6px;">🚀 MODULAR SHIPS</div>
      <div id="protoShipsBody"></div>
      <div style="margin-top:6px;">B spawns: <select id="protoDummySelect" style="background:#111;color:#eee;border:1px solid #444"></select></div>
      <button id="protoReplayBtn" style="margin-top:6px;background:#1a2540;color:#eee;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer">Run determinism check</button>
      <div style="margin-top:6px;color:#777">H hangar · K damage · J repair · B dummy · V controls</div>`;
    host.appendChild(el);
    const select = el.querySelector('#protoDummySelect') as HTMLSelectElement;
    select.addEventListener('keydown', (e) => e.stopPropagation());
    listBlueprints().then((names) => {
      select.innerHTML = names.map((n) => `<option value="${n}" ${n === 'sparrow-t' ? 'selected' : ''}>${n}</option>`).join('');
    }).catch(() => { select.innerHTML = '<option>(dev API unavailable)</option>'; });
    select.addEventListener('change', async () => {
      try { this.dummyBlueprint = await loadBlueprint(select.value); } catch (e) { console.error(e); }
    });
    (el.querySelector('#protoReplayBtn') as HTMLButtonElement).onclick = () => this.runDeterminismCheck();
    return el;
  }

  private runDeterminismCheck(): void {
    const t = this.deps.bridge.tuning.debug;
    this.replayResult = `replaying ${t.replayTicks} ticks × ${t.replayRuns}…`;
    const worker = new Worker(new URL('./replayWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress) {
        this.replayResult = `replaying… ${e.data.progress}/${e.data.runs}`;
        return;
      }
      const hashes: number[] = e.data.hashes;
      const ok = new Set(hashes).size === 1;
      this.replayResult = ok
        ? `<span style="color:#4ade80">✓ ${hashes.length} runs match (${hashes[0].toString(16)}) in ${Math.round(e.data.ms)} ms</span>`
        : `<span style="color:#f87171">✗ hashes differ: ${[...new Set(hashes)].map((h) => h.toString(16)).join(', ')}</span>`;
      worker.terminate();
    };
    worker.onerror = (e) => { this.replayResult = `<span style="color:#f87171">worker error: ${e.message}</span>`; };
    worker.postMessage({ ...this.deps.replayConfig, seed: 1234, ticks: t.replayTicks, runs: t.replayRuns });
  }
}
