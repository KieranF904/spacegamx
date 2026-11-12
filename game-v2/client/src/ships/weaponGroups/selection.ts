/**
 * The pilot's weapon group selection (docs/design/groups-mines-docking.md, "Weapon groups"): the group the left button
 * fires and the group the right button fires, each "all" (0) or 1-5. Both start on "all", which fires as before groups.
 *
 * Client state only: it rides inputs (app/inputSend.ts sends it on the input it changes on, and on the first input after
 * a welcome or a respawn), and the server, your own prediction and everyone's gun lanes read it at that input's tick.
 * A module-level object, as viewMode is: keys, the wheel and the settings reach it from different places.
 */
import { WEAPON_GROUPS, cycleSel, packGroupSel, selLeft, selRight } from '@space-game/common';

export class GroupSelection {
  private left = 0;
  private right = 0;
  private listeners: (() => void)[] = [];

  /** The selection as one input byte (ships/weaponGroups.ts packGroupSel) */
  get packed(): number { return packGroupSel(this.left, this.right); }
  get leftGroup(): number { return this.left; }
  get rightGroup(): number { return this.right; }

  /** Either button off "all" */
  get custom(): boolean { return this.left !== 0 || this.right !== 0; }

  cycleLeft(dir: 1 | -1 = 1): void { this.set(cycleSel(this.left, dir), this.right); }
  cycleRight(dir: 1 | -1 = 1): void { this.set(this.left, cycleSel(this.right, dir)); }
  /** The left button's group (0 all, 1-5); anything else is ignored */
  pickLeft(g: number): void { if (validSel(g)) this.set(g, this.right); }
  /** The right button's group, the same */
  pickRight(g: number): void { if (validSel(g)) this.set(this.left, g); }
  /**
   * A group's key or its HUD icon (ui/hud/GroupRow.ts): that button fires group g; on the group it already fires, back to
   * "all". Returns true when it was a group (1-5)
   */
  press(button: 'left' | 'right', g: number): boolean {
    if (!validSel(g) || g === 0) return false;
    if (button === 'left') this.set(pressedSel(this.left, g), this.right);
    else this.set(this.left, pressedSel(this.right, g));
    return true;
  }

  // What the server was last told (a new connection starts it on all/all; undefined: since a welcome or a respawn, which start it afresh)
  private told: number | undefined = 0;
  /** Does the next input owe the server the selection (it changed, or it has not heard it since a welcome or respawn) */
  due(): boolean { return this.told !== this.packed; }
  /** An input carrying `packed` went */
  sent(packed: number): void { this.told = packed; }
  /** The server may hold another selection (a welcome, a respawn): the next input carries it */
  forget(): void { this.told = undefined; }

  /** Back to all/all (a fresh start) */
  reset(): void { this.set(0, 0); }

  /** Take a packed selection (a test, a restored session) */
  load(packed: number): void { this.set(selLeft(packed), selRight(packed)); }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  private set(l: number, r: number): void {
    if (l === this.left && r === this.right) return;
    this.left = l;
    this.right = r;
    for (const f of this.listeners) f();
  }
}

const validSel = (g: number): boolean => Number.isInteger(g) && g >= 0 && g <= WEAPON_GROUPS;

/** A button's selection after group g's key: g, or "all" when it was on g already */
export const pressedSel = (now: number, g: number): number => (now === g ? 0 : g);

export const groupSelection = new GroupSelection();

/** A selection's name: "all", or the group's number */
export const groupName = (g: number): string => (g === 0 ? 'all' : String(g));

/** The HUD chip's text: "L: 2  R: all" */
function chipText(left: number, right: number): string {
  return `L: ${groupName(left)}  R: ${groupName(right)}`;
}
