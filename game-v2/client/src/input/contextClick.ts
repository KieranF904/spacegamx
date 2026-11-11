/**
 * The right-click menu, the pure part (ContextActions.ts drives it):
 *   pressing     the menu modifier (Z, rebindable) + right-click opens
 *                the menu; a plain right-click is the mining laser and the
 *                right-hand guns, firing at once
 *   picking      everything under the cursor, nearest kind first: people, then
 *                ships, pods and wrecks, then rocks, then stations, gates,
 *                rifts, cave mouths and nests' ways in, then planets and moons
 *   options      what each kind of thing offers, which is the default, and why
 *                an option can't be taken now
 *   placing      where the menu goes so it stays on screen (flipping at edges)
 *   orders       when a flown-to target's action is due, and how a jump lines
 *                up, charges and fires
 *
 * No DOM, no game state.
 */

/** What a right press is: the menu (its modifier held, in flight) or the right-hand guns and the mining laser */
export function rightPress(s: { modifier: boolean; enabled: boolean }): 'menu' | 'fire' {
  return s.modifier && s.enabled ? 'menu' : 'fire';
}

/**
 * The right fire, press by press. A plain press fires at once; a press that
 * opened the menu holds the right fire back until it's let go, so closing
 * the menu with the button still down (Esc, the cursor wandering off) never
 * flashes the guns or the mining laser.
 */
export class RightClick {
  private menuPress = false;

  /** The button went down; `menu`: this press opened the menu */
  down(menu: boolean): void {
    this.menuPress = menu;
  }

  up(): void {
    this.menuPress = false;
  }

  /** Is the right fire held back now (the press that opened the menu, still down)? */
  get withholding(): boolean {
    return this.menuPress;
  }

  reset(): void {
    this.menuPress = false;
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export type ContextKind =
  // Places
  | 'station' | 'gate' | 'rift' | 'cave' | 'pocket'
  /** A planet or moon with a surface to go down to */
  | 'surface'
  /** A planet or moon with none */
  | 'planet'
  // Someone to talk to (a quest giver out in space)
  | 'person'
  // Ships
  | 'pilot' | 'hostile' | 'boss' | 'derelict' | 'civilian' | 'ship'
  // Things
  | 'rock' | 'loot' | 'wreck';

/** Something under a right-click, where it is now (world units) */
export interface ContextTarget {
  kind: ContextKind;
  /** Stable while it's the same thing (a station's name, a gate's id, an entity id) */
  key: string;
  name: string;
  x: number;
  y: number;
  /** How far round it the cursor counts as on it */
  r: number;
}

/** Small and specific first; big places (planets) last */
const TIER: Record<ContextKind, number> = {
  person: 0,
  pilot: 1, hostile: 1, boss: 1, derelict: 1, civilian: 1, ship: 1, loot: 1, wreck: 1,
  rock: 2,
  station: 3, gate: 3, rift: 3, cave: 3, pocket: 3,
  surface: 4, planet: 4,
};

/** At most this many things in one menu */
const MAX_GROUPS = 4;

/**
 * Everything under the cursor, the menu's sections in order: by tier, then
 * nearest the cursor. `slack` (world units) widens everything a little, so
 * small things far out are still easy to hit.
 */
export function pickTargets<T extends ContextTarget>(at: { x: number; y: number }, targets: T[], slack = 0, max = MAX_GROUPS): T[] {
  const hits: { t: T; d: number; tier: number }[] = [];
  for (const t of targets) {
    const d = Math.hypot(t.x - at.x, t.y - at.y) - t.r;
    if (d <= slack) hits.push({ t, d, tier: TIER[t.kind] });
  }
  hits.sort((a, b) => a.tier - b.tier || a.d - b.d);
  return hits.slice(0, max).map((h) => h.t);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type ActionId =
  | 'dock' | 'travel' | 'flyInto' | 'enter' | 'land' | 'talk'
  | 'flyTo' | 'approach' | 'collect' | 'recover'
  | 'target' | 'untarget' | 'inspect' | 'invite' | 'trade' | 'mark'
  | 'flyHere' | 'jumpHere'
  | 'stop';

export interface MenuOption {
  id: ActionId;
  /** Its icon (ContextMenuUI's set) */
  icon: string;
  label: string;
  /** Grey, after the label: how far, what happens */
  hint?: string;
  /** Can't be taken now: why (shown greyed, the reason as its tooltip) */
  disabled?: string;
  /** The default: highlighted, and what Enter takes */
  primary?: boolean;
}

/** What the menu needs to know about one thing */
export interface TargetFacts {
  kind: ContextKind;
  /** From the ship to it (its edge), world units */
  dist: number;
  /** Its action can be done from here, now (in the docking ring, in talking range) */
  inRange?: boolean;
  /** Barred (a licence): why */
  lock?: string;
  /** A siege moon: you go down beside it, not by the route */
  siege?: boolean;
  /** It's your target now */
  targeted?: boolean;
  /** A pilot in your party */
  partyMate?: boolean;
  /** You are in the gun range (no trading there: nothing in it may leave) */
  gunRange?: boolean;
}

/** Trading reaches this far (the server's) */
export const TRADE_RANGE = 2500;

export const km = (d: number) => (d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)} km` : `${Math.round(d)} m`);

const opt = (id: ActionId, icon: string, label: string, more: Partial<MenuOption> = {}): MenuOption => ({ id, icon, label, ...more });

/** "autopilot" when it's a flight, nothing when it's right here */
const how = (f: TargetFacts) => (f.inRange ? 'now' : 'autopilot');

/** What a right-click on one thing offers, the default marked */
export function targetOptions(f: TargetFacts): MenuOption[] {
  const fly = (label = 'Fly to', hint = 'autopilot') => opt('flyTo', 'fly', label, { hint });
  const tgt = () => (f.targeted ? opt('untarget', 'target', 'Clear target') : opt('target', 'target', 'Target', { hint: 'T' }));
  let out: MenuOption[];
  switch (f.kind) {
    case 'station': out = [opt('dock', 'dock', 'Dock', { hint: how(f) }), fly()]; break;
    case 'gate': out = [opt('travel', 'gate', 'Travel through', { hint: how(f), disabled: f.lock }), fly()]; break;
    case 'rift': out = [opt('flyInto', 'gate', 'Fly into the rift', { hint: 'it takes you' }), fly('Fly to the edge')]; break;
    case 'cave':
    case 'pocket': out = [opt('enter', 'enter', 'Enter', { hint: how(f) }), fly()]; break;
    case 'surface': out = [opt('land', 'land', f.siege ? 'Descend (siege)' : 'Land', { hint: how(f) }), fly()]; break;
    case 'planet': out = [fly()]; break;
    case 'person': out = [opt('talk', 'talk', 'Hail', { hint: f.inRange ? 'X' : 'autopilot' }), fly()]; break;
    case 'pilot': out = [
      fly('Fly to', 'autopilot · follows them'), tgt(), opt('inspect', 'inspect', 'Inspect pilot'),
      opt('trade', 'trade', 'Trade', { disabled: f.gunRange ? 'No trading in the gun range' : f.dist > TRADE_RANGE ? `Too far: trading reaches ${km(TRADE_RANGE)}` : undefined }),
      ...(f.partyMate ? [] : [opt('invite', 'invite', 'Invite to party', { hint: 'P' })]),
    ]; break;
    case 'hostile':
    case 'boss': out = [tgt(), fly('Approach'), opt('mark', 'mark', 'Mark for attack', { hint: 'ping' })]; break;
    case 'derelict': out = [tgt(), fly('Approach')]; break;
    case 'civilian':
    case 'ship': out = [fly(), tgt()]; break;
    case 'rock': out = [opt('approach', 'mine', 'Approach to mine', { hint: 'then hold RMB' })]; break;
    case 'loot': out = [opt('collect', 'collect', 'Collect', { hint: 'fly close, then the pickup panel (F)' })]; break;
    case 'wreck': out = [opt('recover', 'collect', 'Recover cargo', { hint: 'fly close, then the pickup panel (F)' })]; break;
  }
  const first = out.find((o) => !o.disabled);
  if (first) first.primary = true;
  return out;
}

export interface DriveFacts {
  phase: 'ready' | 'charging' | 'burn' | 'cooldown';
  /** How far it reaches here (0: no drive) */
  reach: number;
  /** Seconds left cooling down */
  cool: number;
}

/** Closer than this, flying there is nothing to do (the autopilot's own arrival radius) */
export const MIN_FLY = 350;

/** Why the drive can't jump `dist` now, or null */
export function jumpBlocked(dist: number, d: DriveFacts): string | null {
  if (d.phase === 'cooldown') return `Cooling down · ${Math.max(1, Math.ceil(d.cool))} s`;
  if (d.phase !== 'ready') return 'The drive is already charging';
  if (dist < MIN_FLY) return "You're already here";
  if (dist > d.reach) return `Out of range: the drive reaches ${km(d.reach)} from here`;
  return null;
}

/** What a right-click on open space offers: fly there, jump there (a drive fitted), mark it */
export function openSpaceOptions(dist: number, drive: DriveFacts | null): MenuOption[] {
  const out: MenuOption[] = [opt('flyHere', 'fly', 'Fly here', { hint: `${km(dist)} · autopilot`, disabled: dist < MIN_FLY ? "You're already here" : undefined })];
  if (drive && drive.reach > 0) {
    const why = jumpBlocked(dist, drive);
    const state = drive.phase === 'ready' ? 'ready' : drive.phase === 'cooldown' ? `cooling ${Math.max(1, Math.ceil(drive.cool))} s` : 'charging';
    out.push(opt('jumpHere', 'jump', 'Jump here', { hint: `${km(dist)} · reach ${km(drive.reach)} · ${state}`, disabled: why ?? undefined }));
  }
  out.push(opt('mark', 'mark', 'Mark here', { hint: 'ping · your party sees it' }));
  const first = out.find((o) => !o.disabled);
  if (first) first.primary = true;
  return out;
}

/** Where Enter starts: the default, else the first that can be taken (-1: none can) */
export function defaultIndex(options: MenuOption[]): number {
  const p = options.findIndex((o) => o.primary && !o.disabled);
  return p >= 0 ? p : options.findIndex((o) => !o.disabled);
}

/** The arrow keys: the next option that can be taken, `dir` (±1) from `from`, round the ends */
export function stepIndex(options: MenuOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!options[i].disabled) return i;
  }
  return from;
}

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

/** Off the cursor by this much, and this far in from the screen's edges (px) */
export const MENU_GAP = 4;
export const MENU_MARGIN = 8;

/**
 * Where the menu's top-left goes for a click at `at`: down and right of the
 * cursor, flipped left or up where it would run off the screen, and kept
 * inside it if it's bigger than the room either side.
 */
export function placeMenu(at: { x: number; y: number }, size: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number; flipX: boolean; flipY: boolean } {
  let x = at.x + MENU_GAP, y = at.y + MENU_GAP, flipX = false, flipY = false;
  if (x + size.w > view.w - MENU_MARGIN) { x = at.x - MENU_GAP - size.w; flipX = true; }
  if (y + size.h > view.h - MENU_MARGIN) { y = at.y - MENU_GAP - size.h; flipY = true; }
  x = Math.max(MENU_MARGIN, Math.min(x, view.w - MENU_MARGIN - size.w));
  y = Math.max(MENU_MARGIN, Math.min(y, view.h - MENU_MARGIN - size.h));
  return { x: Math.round(x), y: Math.round(y), flipX, flipY };
}

/** The cursor this far outside the menu's box (px): it's done with it */
export const MENU_LEAVE_PX = 180;

/** How far (px) a point is outside a box (0 inside) */
export function outsideBy(p: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
  const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * A flown-to target, each tick: 'act' (its action is due: in range while the
 * autopilot's on it, or it's just arrived in range), 'done' (the autopilot did
 * it itself, or was stopped), or 'wait'. `selfActing`: the autopilot does the
 * action on arrival itself (docking, going down to a planet).
 */
export function orderStep(o: { selfActing: boolean }, s: { autopilot: boolean; arrived: boolean; inRange: boolean }): 'act' | 'done' | 'wait' {
  if (o.selfActing) return s.autopilot ? 'wait' : 'done';
  if (s.inRange && (s.autopilot || s.arrived)) return 'act';
  return s.autopilot ? 'wait' : 'done';
}

/** Line up this close (radians) before charging, as the autopilot does: the jump goes along the nose */
const JUMP_ALIGN = 0.04;
/** Give up lining up after this long (ticks) */
export const JUMP_ALIGN_TICKS = 60 * 5;

export type JumpStep =
  | { jump: boolean; state: 'aligning' | 'charging' }
  | { jump: false; state: 'fired' | 'interrupted' | 'stuck' };

/** Asked for the charge and still not charging after this long (ticks; well past any input delay): it isn't coming */
export const JUMP_ASK_TICKS = 45;

/**
 * A menu jump, each tick: turn to the point (the drive off), then hold the
 * drive on until the burn starts. Once asked for, the drive stays on (the
 * input delay: the charge shows a few ticks on). The charge collapsing (an
 * EMP, the server saying no) ends it, as does not lining up in time; it never
 * starts again by itself. `ticks`: since the order; `asked`: ticks since the
 * drive was first switched on (-1: not yet); `charged`: seen charging.
 */
export function jumpStep(s: { phase: 'ready' | 'charging' | 'burn' | 'cooldown'; facingErr: number; angVel: number; ticks: number; asked: number; charged: boolean }): JumpStep {
  if (s.phase === 'burn' || s.phase === 'cooldown') return s.charged ? { jump: false, state: 'fired' } : { jump: false, state: 'interrupted' };
  if (s.phase === 'charging') return { jump: true, state: 'charging' };
  if (s.charged) return { jump: false, state: 'interrupted' };
  if (s.asked >= 0) return s.asked > JUMP_ASK_TICKS ? { jump: false, state: 'interrupted' } : { jump: true, state: 'aligning' };
  if (Math.abs(s.facingErr) < JUMP_ALIGN && Math.abs(s.angVel) < 0.02) return { jump: true, state: 'aligning' };
  if (s.ticks > JUMP_ALIGN_TICKS) return { jump: false, state: 'stuck' };
  return { jump: false, state: 'aligning' };
}
