/**
 * Ship swap (dev server only: Game makes it only in a Vite dev build; F9 opens
 * it): every ship in the plan library (data/ships/blueprints) as a button, to
 * fly it right now wherever you are, nothing spent, and a button for your own
 * ship back. A button takes you to the weapons range (F10). The server (devShip) never saves the borrowed one. Each row says
 * what the ship carries, so the ones with a mining laser are easy to find.
 */

interface Plan { name: string; parts: { fn: string }[]; group?: string }
/** The order the groups are listed in (anything else after them) */
const GROUPS = ['Ports energy', 'Library', 'Dev test ships'];

/** What a ship carries that isn't just structure, for its row */
const KIT_NAMES: Record<string, string> = {
  miner: 'mining laser', weapon: 'cannon', laser: 'beam laser', lance: 'lance', flak: 'flak', missile: 'missile', railgun: 'railgun',
  autocannon: 'autocannon', mortar: 'mortar', torpedo: 'torpedo', emp: 'EMP', hive: 'hive', frostbite: 'frostbite', jumpcoil: 'jump coil', shield: 'shield',
  utility_tow_beam: 'tow beam', engine_burst_strafer: 'strafer', power_pulse_dynamo: 'dynamo',
  railgun_rail_driver: 'rail driver', shield_flash_screen: 'flash screen', utility_repair_beam: 'repair beam',
  point_defence_turret: 'point defence', power_capacitor: 'capacitor',
};

function kit(bp: Plan): { text: string; mines: boolean } {
  const n: Record<string, number> = {};
  for (const p of bp.parts) if (KIT_NAMES[p.fn]) n[p.fn] = (n[p.fn] ?? 0) + 1;
  const text = Object.entries(n).map(([fn, c]) => `${c} ${KIT_NAMES[fn]}${c > 1 && fn !== 'shield' ? 's' : ''}`).join(' · ');
  return { text: `${bp.parts.length} parts${text ? ' · ' + text : ''}`, mines: !!n.miner };
}

export class DevShipPanel {
  private el = document.createElement('div');
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F9' || e.shiftKey) return;
    e.preventDefault();
    this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none';
  };

  /** `ships`: the plan library by file name; `swap`: fly one of them (or, with none, your own); `boss`: wear the nearest boss down, or reset it; `range`: go to the weapons range (F10 has its panel) */
  constructor(ships: Record<string, Plan>, private swap: (ship?: string) => void, boss?: (wear?: number, reset?: boolean) => void, range?: () => void, bossTools?: () => void) {
    Object.assign(this.el.style, {
      position: 'fixed', left: '16px', top: '70px', width: '330px', maxHeight: '70vh', overflowY: 'auto', padding: '12px 14px', zIndex: '9000', display: 'none',
      background: 'rgba(8, 14, 24, 0.94)', border: '1px solid #2c4a66', borderRadius: '6px', color: '#cfe3f5',
      font: '12px Segoe UI, sans-serif', userSelect: 'none',
    });
    const title = document.createElement('div');
    title.textContent = 'SHIP SWAP · F9 (dev only)';
    Object.assign(title.style, { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', marginBottom: '4px' });
    const sub = document.createElement('div');
    sub.textContent = 'Fly any library ship now. Nothing is saved: your own ship comes back on request or when you leave.';
    Object.assign(sub.style, { color: '#8aa5bc', marginBottom: '10px', lineHeight: '1.4' });
    this.el.append(title, sub);
    // The weapons range: its own panel on F10
    if (range) {
      const go = this.button('Go to Weapons Range', 'Dev system with stationary target dummies. F10 opens the weapon picker and readout.', false, range);
      go.style.borderColor = '#b08a3a';
      go.style.marginBottom = '12px';
    }

    const rows = Object.entries(ships).map(([id, bp]) => ({ id, bp, ...kit(bp) }));
    // By group, each under its heading; in a group mining ships first, then the smaller ships first
    const rank = (g: string | undefined) => { const i = GROUPS.indexOf(g ?? ''); return i < 0 ? GROUPS.length : i; };
    rows.sort((a, b) => rank(a.bp.group) - rank(b.bp.group) || Number(b.mines) - Number(a.mines) || a.bp.parts.length - b.bp.parts.length);
    let group: string | undefined;
    for (const r of rows) {
      if (r.bp.group && r.bp.group !== group) {
        group = r.bp.group;
        const head = document.createElement('div');
        head.textContent = group.toUpperCase();
        Object.assign(head.style, { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', margin: '10px 0 6px' });
        this.el.appendChild(head);
      }
      this.button(r.bp.name, r.text, r.mines, () => this.swap(r.id));
    }
    const own = this.button('My own ship', 'Back to the ship you really have', false, () => this.swap());
    own.style.marginTop = '10px';
    own.style.borderColor = '#4a7a5a';

    // The nearest boss: into its later phases, or back fresh
    if (boss) {
      const head = document.createElement('div');
      head.textContent = 'NEAREST BOSS';
      Object.assign(head.style, { letterSpacing: '2px', fontSize: '11px', color: '#d9a07f', margin: '14px 0 6px' });
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
      for (const [label, wear, reset] of [['70%', 0.7, false], ['40%', 0.4, false], ['10%', 0.1, false], ['Reset', undefined, true]] as const) {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.style, { flex: '1', padding: '6px 0', cursor: 'pointer', background: '#3a2218', border: '1px solid #8a4a2a', borderRadius: '4px', color: '#ffd8c0', font: '12px Segoe UI, sans-serif' });
        b.addEventListener('click', () => boss(wear, reset));
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        row.appendChild(b);
      }
      this.el.append(head, row);
      // (the boss tools: stages, moves, windows, dummies, slow motion, the damage log: DevBossPanel, Shift+F9)
      if (bossTools) this.button('Boss tools (Shift+F9)', 'Stage and move jumps, windows, dummy pilots, slow motion, damage log', false, bossTools).style.marginTop = '8px';
    }

    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
  }

  private button(name: string, detail: string, highlight: boolean, click: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    const top = document.createElement('div');
    top.textContent = (highlight ? '⛏ ' : '') + name;
    Object.assign(top.style, { fontSize: '13px', color: highlight ? '#7fe3ff' : '#e2effa' });
    const sub = document.createElement('div');
    sub.textContent = detail;
    Object.assign(sub.style, { fontSize: '11px', color: '#8aa5bc', marginTop: '2px' });
    b.append(top, sub);
    Object.assign(b.style, {
      display: 'block', width: '100%', textAlign: 'left', marginBottom: '6px', padding: '6px 10px', cursor: 'pointer',
      background: highlight ? '#12344a' : '#16304a', border: `1px solid ${highlight ? '#3d8fb0' : '#2c4a66'}`, borderRadius: '4px',
    });
    b.addEventListener('click', click);
    // (the game's keys shouldn't fire from a click here)
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.appendChild(b);
    return b;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }
}
