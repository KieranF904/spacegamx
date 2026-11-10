/**
 * @contract client.ship.render.constants
 * owns:       tuning numbers and text styles for drawing ships (fades, recoil, headlights, labels)
 * needs:      pixi TextStyle; npm: pixi.js
 * invariants: values and text styles only, no functions or state — client/src/ships/render/renderValues.test.ts
 * extend:     a new draw constant is added here and imported where used
 */

import { TextStyle } from 'pixi.js';

/** Seconds to fade a ship in as it arrives or out as it goes */
export const FADE = 0.25;
/** Beyond the hull, how far off screen a ship still draws its engines, lamps and guns (their light reaches in) */
export const OFFSCREEN_MARGIN = 600;
/** How far a barrel slides back when it fires (fraction of its length), and how fast it returns and cools (per 60 Hz frame) */
export const RECOIL = 0.28;
export const RECOIL_RETURN = 1 / 9;
export const HEAT_PER_SHOT = 0.22;
/** Guns' metal is drawn in its own tones; tinted by light, damage and heat (blocked turrets darker) */
export const GUN_TINT = 0xffffff, GUN_BLOCKED = 0x8f8582;
/** The smallest a cell is on screen (px) for guns to be drawn */
export const GUN_MIN_PX = 3;
/** Where another pilot's status row keeps its weapon statuses (features.wire.json status "statuses") */
export const STATUS_SLOT = 7;
export const HEADLIGHT = 0xfff0d6;
/** Headlights come on below this much ambient and sunlight */
export const LAMPS_BELOW = 0.5;
/** A big hull (a boss's) is built at most this often (ms: parts breaking together, one build) */
export const BIG_HULL = 60, BUILD_EVERY = 200;
export const COOL = 1 / 130;
export const LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 26, fill: 0xd9c9a3, letterSpacing: 2 });
/** Civilian traffic (snapshot data[0] = 2) */
export const TRAFFIC_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0x9fd8ff, letterSpacing: 2 });
/** Hostiles (data[0] = 3), and their elites */
export const HOSTILE_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0xff8a7a, letterSpacing: 2, fontWeight: '600' });
/** Hostiles that'll leave you be (a passive pack nobody's provoked: data[9] = 1) */
export const CALM_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0xb4bcc8, letterSpacing: 2 });
export const ELITE_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 26, fill: 0xffc857, letterSpacing: 2, fontWeight: '700' });
/** Bosses (data[4] = 2): their health is the big bar at the top */
export const BOSS_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 40, fill: 0xffcf7a, letterSpacing: 8, fontWeight: '800', dropShadow: { color: 0xff6a1a, blur: 12, distance: 0, alpha: 0.8 } });
