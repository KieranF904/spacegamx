/**
 * The look of the seven ordnance models (rework-2026-11 section 4: mortars, missiles, torpedoes), laid over their kinds'
 * styles by model id (weaponStyles MODEL_STYLES). A field named here replaces the kind's; the rest stay the kind's.
 * `muzzle` and `impact` are whole objects, so each names every field.
 *
 *   Lobber       olive shell that swells and shrinks over its arc, dust ring and flash where it lands
 *   Quake        heavy dark shells, ochre shock rings, the ground shaking for ships near the blast
 *   Dart         today's missile (no entry)
 *   Swarm        thin red-orange rockets weaving on short trails
 *   Hammerhead   big dark body, a blinking red nose light, a thick white trail, a guide to your cursor
 *   Eel          fat amber slug with a sonar ring that quickens as it closes, wake specks
 *   Leviathan    huge dark hull with a red pulsing beacon, and a warning for a pilot it is heading at
 *
 * (The landing rings come from the shell's endTick: WeaponFx.drawLandings. They are the same for every mortar model.)
 */

import type { WeaponStyle } from './weaponStyles';

export const ORDNANCE_STYLES: Record<string, Partial<WeaponStyle>> = {
  mortar_lobber: {
    coreColor: 0xdfe6a0, glowColor: 0x7d8a2c, glowAlpha: 0.38, coreWidth: 4.2, glowWidth: 9, headRadius: 3.4, haloRadius: 9,
    lob: 0.75,
    trail: { color: 0x8a8a62, size: 3.5, life: 22 },
    muzzle: { life: 9, size: 26, sparks: 4, color: 0xd6dc9a, smoke: 7, girth: 1.5 },
    impact: { sparks: 14, speed: 3, life: 24, color: 0xc8c888, flash: 46, ring: 0x9aa05a },
    smokeCloud: { color: 0xa39e7c, size: 15, life: 54 },
    landBurst: { shake: 0 },
  },
  mortar_quake: {
    coreColor: 0x8a7a5c, glowColor: 0xc8862a, glowAlpha: 0.4, coreWidth: 5.6, glowWidth: 12, headRadius: 4.6, haloRadius: 11,
    lob: 0.55,
    trail: { color: 0x3a3126, size: 6, life: 34 },
    muzzle: { life: 10, size: 30, sparks: 6, color: 0xe0a860, smoke: 8, girth: 1.7 },
    impact: { sparks: 22, speed: 3.6, life: 28, color: 0xe0a24a, flash: 62, ring: 0xc88a30 },
    smokeCloud: { color: 0x6c5a40, size: 20, life: 64 },
    landBurst: { shake: 1100 },
  },
  missile_swarm: {
    coreWidth: 2.4, glowWidth: 6, coreColor: 0xffe2cf, glowColor: 0xff5a2a, glowAlpha: 0.5, headRadius: 2, haloRadius: 7,
    wobble: { amp: 2.8, period: 16 },
    trail: { color: 0x8f7c74, size: 3.2, life: 24 },
    muzzle: { life: 7, size: 15, sparks: 2, color: 0xffa070, smoke: 5 },
    impact: { sparks: 7, speed: 3, life: 14, color: 0xff9a5a, flash: 15 },
  },
  missile_hammerhead: {
    coreWidth: 7.5, glowWidth: 15, coreColor: 0x59606c, glowColor: 0xff8a3c, glowAlpha: 0.45, headRadius: 3, haloRadius: 14, tracerTicks: 1.1,
    nose: { color: 0xff2a22, size: 7, period: 32, blink: true },
    guide: true,
    trail: { color: 0xf2f2ee, size: 10, life: 74 },
    muzzle: { life: 10, size: 30, sparks: 6, color: 0xffc080, smoke: 9, girth: 1.4 },
    impact: { sparks: 24, speed: 4.4, life: 22, color: 0xffb070, flash: 58, ring: 0xff8a3a },
  },
  torpedo_eel: {
    coreColor: 0xfff0cc, glowColor: 0xffb040, glowAlpha: 0.5,
    ringPulse: { color: 0xffd48a, size: 36, period: 30, closing: 800 },
    contrail: { color: 0xffc46b, size: 3, life: 44, step: 9 },
    trail: { color: 0x7a6a50, size: 5, life: 40 },
  },
  torpedo_leviathan: {
    coreWidth: 12, glowWidth: 28, coreColor: 0x2d2219, glowColor: 0xff5a1a, glowAlpha: 0.42, headRadius: 6, headColor: 0x120a06, haloRadius: 24, tracerTicks: 1.3,
    nose: { color: 0xff1a1a, size: 11, period: 40 },
    incoming: { radius: 340 },
    trail: { color: 0x3a2f28, size: 15, life: 80 },
    muzzle: { life: 14, size: 42, sparks: 10, color: 0xff9a5a, smoke: 12, girth: 1.9 },
    impact: { sparks: 44, speed: 5.5, life: 32, color: 0xff9a4a, flash: 100, ring: 0xff4a1a },
  },
};
