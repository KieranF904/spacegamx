/**
 * Sim tools (dev builds only: app/devTools.ts makes it; F7 opens it). Three blocks for testing the netcode in the Rockery:
 *
 *   Network simulator   ping, jitter and loss added on this client's connection, both ways (client dev/netSim.ts). Off until
 *                       "Enabled" is ticked; the sliders do nothing while it is off. Loss drops inputs going out and snapshots
 *                       coming in, nothing else.
 *   Prediction mode     how other ships (and yours) are drawn, switched live (dev/predict/modes.ts): A today, B prediction
 *                       off, C1 AI ahead, C2 PT/ST rubber band, C3 C2 + touch register; the ease time for C2/C3.
 *   Overlay             the ST ghost, PT pose, correction vectors and counters (dev/simOverlay); also Shift+F7.
 *   Rockery             warp there, and spawn test traffic beside you: a Helios drone pack, a still dummy, 1-4 bot players
 *                       on random flight (calm to twitchy, optionally shooting back at you). These send `/rockery ...` chat
 *                       lines; the dev server (server/src/bots/rockeryTools.ts) answers admins only, and it makes every guest an admin.
 */
import type { NetSim } from '../dev/netSim';
import type { SimOverlay } from '../dev/simOverlay/SimOverlay';

/** The prediction-mode switch (dev/predict/PredictController.ts) as the panel uses it */
export interface DevPredictModes {
  readonly modes: readonly { id: string; label: string; blurb: string }[];
  readonly mode: { id: string; blurb: string };
  set(id: string): boolean;
  lerpMs: number;
  onChange: ((m: { id: string; blurb: string }) => void) | null;
}

export interface DevSimDeps {
  net: NetSim | null;
  overlay: SimOverlay;
  /** The prediction modes (null: not in this client) */
  predict?: DevPredictModes | null;
  /** Chat lines as the player (the server's `/` commands) */
  say: (text: string) => void;
  warp: (systemId: string, x: number, y: number) => void;
}

const BTN = { padding: '4px 8px', cursor: 'pointer', background: '#16304a', border: '1px solid #2c4a66', borderRadius: '4px', color: '#cfe3f5', font: '11px Segoe UI, sans-serif' };

export class DevSimPanel {
  private el = document.createElement('div');
  private stats = document.createElement('div');
  private timer = 0;
  private twitch = 'mid';
  private shoot = false;
  private near = true;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F7' || e.shiftKey) return;
    e.preventDefault();
    this.toggle();
  };

  constructor(private d: DevSimDeps) {
    Object.assign(this.el.style, {
      position: 'fixed', left: '16px', top: '70px', width: '300px', maxHeight: '86vh', overflowY: 'auto', padding: '12px 14px', zIndex: '9000', display: 'none',
      background: 'rgba(8, 14, 24, 0.94)', border: '1px solid #2c4a66', borderRadius: '6px', color: '#cfe3f5', font: '12px Segoe UI, sans-serif', userSelect: 'none',
    });
    this.el.dataset.simPanel = '1';
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    const title = this.text('SIM TOOLS · F7 (dev only)', { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', marginBottom: '8px' });
    this.el.appendChild(title);

    // --- Network simulator
    this.head('Network simulator (this client, both ways)');
    if (d.net) {
      const net = d.net;
      this.check('Enabled', false, (on) => { net.config.enabled = on; });
      this.slider('Ping (round trip)', 0, 600, 10, 0, 'ms', (v) => { net.config.ping = v; });
      this.slider('Jitter (+/-)', 0, 200, 5, 0, 'ms', (v) => { net.config.jitter = v; });
      this.slider('Loss', 0, 30, 1, 0, '%', (v) => { net.config.loss = v; });
      this.el.appendChild(this.stats);
      Object.assign(this.stats.style, { color: '#9bb6cc', margin: '2px 0 6px', fontSize: '11px' });
    } else {
      this.el.appendChild(this.text('Not available (no browser transport here).', { color: '#9bb6cc', marginBottom: '6px' }));
    }

    // --- Prediction mode
    if (d.predict) {
      const pm = d.predict;
      this.head('Prediction mode (drawing only: the server is the same)');
      const buttons = new Map<string, HTMLButtonElement>();
      const blurb = this.text('', { fontSize: '11px', color: '#9bb6cc', margin: '2px 0 6px', whiteSpace: 'normal' });
      const show = (m: { id: string; blurb: string }) => {
        for (const [id, b] of buttons) Object.assign(b.style, id === m.id ? { background: '#2f6a9a', borderColor: '#7fb3d9', color: '#fff' } : { background: BTN.background, borderColor: '#2c4a66', color: BTN.color });
        blurb.textContent = m.blurb;
      };
      this.row(pm.modes.map((m) => { const b = this.button(m.id, () => pm.set(m.id)); b.title = m.label; buttons.set(m.id, b); return b; }));
      this.el.appendChild(blurb);
      this.slider('C2/C3 ease (old PT -> new)', 0, 500, 10, pm.lerpMs, 'ms', (v) => { pm.lerpMs = v; });
      pm.onChange = show;
      show(pm.mode);
    }

    // --- Overlay
    this.head('Overlay (ST ghost, PT pose, corrections, counters)');
    const ov = d.overlay;
    const onOff = this.button('Overlay: off', () => ov.setOn(!ov.enabled));
    ov.onChange = (on) => { onOff.textContent = on ? 'Overlay: ON (Shift+F7)' : 'Overlay: off'; };
    this.row([onOff]);
    this.row([['ST ghost', 'st'], ['PT pose', 'pt'], ['Drawn ring', 'drawn'], ['Lines', 'lines'], ['Corrections', 'vectors'], ['Counters', 'counters']].map(([label, key]) =>
      this.checkBox(label, true, (on) => { (ov.show as Record<string, boolean>)[key] = on; })));

    // --- Rockery
    this.head('Rockery');
    this.row([this.button('Warp to Rockery', () => d.warp('dev_rockery', 6500, 0)), this.button('Back to Sol', () => d.warp('sol', 50000, 0))]);
    this.label('Helios drone pack');
    this.row([3, 5, 10].map((n) => this.button(`${n} drones`, () => d.say(`/rockery drones ${n}`))));
    this.label('Still dummy ship');
    this.row([this.button('Halberd', () => d.say('/rockery dummy halberd')), this.button('Arrow', () => d.say('/rockery dummy arrow')), this.button('Drum', () => d.say('/rockery dummy drum'))]);
    this.label('Bot players on random flight');
    const sel = document.createElement('select');
    for (const t of ['calm', 'mid', 'twitchy']) { const o = document.createElement('option'); o.value = o.textContent = t; if (t === this.twitch) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { this.twitch = sel.value; });
    Object.assign(sel.style, { background: '#0e2236', color: '#cfe3f5', border: '1px solid #2c4a66', borderRadius: '4px', padding: '3px' });
    this.row([sel, this.checkBox('shoot back', false, (on) => { this.shoot = on; }), this.checkBox('stay near', true, (on) => { this.near = on; })]);
    this.row([1, 2, 3, 4].map((n) => this.button(`+${n} bot${n > 1 ? 's' : ''}`, () => d.say(`/rockery bots ${n} ${this.twitch}${this.shoot ? ' shoot' : ''}${this.near ? ' near' : ''}`))));
    this.row([this.button('Clear everything spawned', () => d.say('/rockery clear')), this.button('List', () => d.say('/rockery list'))]);

    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
  }

  toggle(): void {
    const open = this.el.style.display === 'none';
    this.el.style.display = open ? 'block' : 'none';
    clearInterval(this.timer);
    if (open) { this.refresh(); this.timer = window.setInterval(() => this.refresh(), 500); }
  }

  private refresh(): void {
    const n = this.d.net;
    if (!n) return;
    this.stats.textContent = n.active
      ? `On: ${n.config.ping} ms ping, ${n.config.jitter} ms jitter, ${n.config.loss}% loss · dropped ${n.stats.dropped}`
      : 'Off: the connection is untouched';
  }

  // --- small builders
  private text(t: string, style: Partial<CSSStyleDeclaration> = {}): HTMLElement {
    const e = document.createElement('div');
    e.textContent = t;
    Object.assign(e.style, style);
    return e;
  }
  private head(t: string): void { this.el.appendChild(this.text(t.toUpperCase(), { margin: '10px 0 5px', paddingTop: '6px', borderTop: '1px solid #1f3a52', fontSize: '10px', letterSpacing: '1px', color: '#7fb3d9' })); }
  private label(t: string): void { this.el.appendChild(this.text(t, { fontSize: '10px', color: '#9bb6cc', margin: '6px 0 3px' })); }
  private button(t: string, click: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = t;
    Object.assign(b.style, BTN);
    b.addEventListener('click', click);
    return b;
  }
  private row(items: HTMLElement[]): void {
    const r = document.createElement('div');
    Object.assign(r.style, { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' });
    r.append(...items);
    this.el.appendChild(r);
  }
  private checkBox(label: string, on: boolean, change: (on: boolean) => void): HTMLElement {
    const l = document.createElement('label');
    Object.assign(l.style, { display: 'inline-flex', alignItems: 'center', gap: '3px', cursor: 'pointer', marginRight: '6px' });
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = on;
    c.addEventListener('change', () => change(c.checked));
    l.append(c, document.createTextNode(label));
    return l;
  }
  private check(label: string, on: boolean, change: (on: boolean) => void): void { this.row([this.checkBox(label, on, change)]); }
  private slider(label: string, min: number, max: number, step: number, value: number, unit: string, set: (v: number) => void): void {
    const wrap = document.createElement('label');
    Object.assign(wrap.style, { display: 'block', marginBottom: '6px' });
    const name = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    Object.assign(input.style, { width: '100%' });
    const show = () => { name.textContent = `${label}: ${input.value} ${unit}`; };
    input.addEventListener('input', () => { set(Number(input.value)); show(); });
    show();
    wrap.append(name, input);
    this.el.appendChild(wrap);
  }

  destroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }
}
