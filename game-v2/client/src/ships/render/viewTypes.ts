/**
 * @contract client.ship.render.view-types
 * owns:       the per-ship view records ShipRenderer keeps (BodyView, Turret, Barrel)
 * needs:      pixi Container/Graphics/Sprite/Text, LitMesh, GunAnimSpec; npm: @space-game/common, pixi.js
 * invariants: a view holds drawn state only; nothing here is decided by gameplay — none pinned
 * extend:     a new per-ship drawn thing is one more field on BodyView
 */

import type { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { ShipState } from '@space-game/common';
import type { LitMesh } from '../../rendering/lighting/Lighting';
import type { GunAnimSpec } from '../gunAnim';

export interface BodyView {
  id: number;
  /** Over the hull: its turrets (the hull itself is a slot in a ShipBatch chunk) */
  container: Container;
  /** Headlights: 0 off … 1 on (they come on by themselves where it's dark), and their visible beam */
  lamps: number;
  beam?: Sprite;
  flames: Container;
  /** Turret heads, drawn once (when the structure changes) and turned each frame */
  guns: Container;
  turrets: Turret[];
  /** Fixed guns' barrels (under every hull, so recoil slides them in), remade with the hull; placed with the container */
  barrels: Container;
  /** A bespoke hull's frame (frameBuild.ts), under it, remade with it; placed with the container. Its glow: 0 cold .. 1 white-hot */
  frame?: { c: Container; cold?: LitMesh; hot?: LitMesh; art: LitMesh[]; shows?: { m: LitMesh; sk: number; cover: number }[] };
  heat?: number;
  /** Shots seen from it (a gun with twin barrels flashes from each in turn: barrelTip) */
  salvo?: number;
  fixed: Barrel[];
  /**
   * The structure last drawn: the ship (a new design is a new one, whose
   * rebuild count may match the old one's), its rebuild count, and the hull it
   * got (HULLS key); and the same for the turrets
   */
  ship: ShipState | null;
  rebuilds: number;
  hullKey: string;
  turretShip: ShipState | null;
  turretRebuilds: number;
  /** What the health bar shows now (it's redrawn only when that changes) */
  barKey?: string;
  /** Named pilotless hulks (derelicts) get a label underneath */
  label?: Text;
  /** Its label is in the calm style (a passive hostile, unprovoked) */
  calmLabel?: boolean;
  /** Hostiles: a health bar under the label */
  bar?: Graphics;
  /** The pilot's own bank members glowing by their bank's charge (drawBankGlow), and what it last showed */
  bankGlow?: { g: Graphics; sig: number; ship: ShipState | null; rebuilds: number };
  /** How brightly the hull flashes white from a hit (the hull shader adds it), fading fast */
  flashLevel: number;
  /** Fading in on arrival, out on leaving (0..1) */
  fade: number;
  /** How much of it is drawn this frame: its fade, less what it's a ghost from far off (ghostOf: the focus grid) */
  vis?: number;
  /** When its hull was last built (ms) */
  builtAt?: number;
  /**
   * The ship the hull in its batch slot (and its barrels and frame) was built for, and the centre of mass it was built
   * about. While a new hull is built off the main thread the old one stays: shifted onto the ship's new centre (a part
   * lost), or not drawn at all if it was another ship's (a new design)
   */
  hullFor: ShipState | null;
  hullCom?: readonly number[];
  labelAlpha: number;
}

export interface Turret {
  part: number;
  /** Its weapon's index in ship.derived.weapons (fixed while the structure is) */
  weapon: number;
  /** Its head, turned per frame: its metal (gunhouse and barrels, in their tones, tinted by light), its lit bits (lenses, coils) */
  barrel: Container;
  metal: Graphics;
  lit?: Graphics;
  /** Where it sits on the hull (relative to the centre of mass, in pixels) and the barrel's length */
  x0: number;
  y0: number;
  len: number;
  /** Its shapes (shared: GUN_LOOKS), and the dark cracks over the barrel, made once its part is hurt enough to show them */
  look: string;
  crack?: Graphics;
  /** The tints last given (only set again when they change) */
  tm: number;
  tl: number;
  /** Recoil (1 just fired, easing back to 0) and barrel heat (builds with sustained fire) */
  kick: number;
  heat: number;
  /**
   * The drawn aim (offset from its window's centre), easing after the simulated one (ship.aim: turretEase.ts); a shot
   * just left it (`fired`): pulled within FIRE_GAP of it on the next draw
   */
  drawn: number;
  fired?: boolean;
  /** Its state-driven decor (gunAnim.ts), the Graphics it draws on and what that last showed, and a frame count for its vents */
  anim?: GunAnimSpec;
  deco?: Graphics;
  decoKey?: number;
  phase?: number;
  ventT?: number;
  reloading?: boolean;
}

export interface Barrel {
  /** It (slid back on recoil): its metal, tinted by light, and its lit bits */
  g: Container;
  metal: Graphics;
  lit?: Graphics;
  /** Its part, its shapes (shared: GUN_LOOKS), and the dark cracks over it (made once the part is hurt enough to show them) */
  part: number;
  look: string;
  crack?: Graphics;
  tm: number;
  tl: number;
  /** Base position (the edge it pokes out of), outward normal, length */
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  len: number;
  /** Where it points now: its gimbal's turn (radians, off its normal; ship.aim) and that turn's normal */
  rot: number;
  rx: number;
  ry: number;
  kick: number;
  heat: number;
  debris: boolean;
  /** Its state-driven decor (gunAnim.ts), the Graphics it draws on and what that last showed, and a frame count for its vents */
  anim?: GunAnimSpec;
  deco?: Graphics;
  decoKey?: number;
  phase?: number;
  ventT?: number;
  reloading?: boolean;
}
