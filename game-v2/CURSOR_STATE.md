# Cursor & Weapon State — Packed 32-bit Format

## Overview

Player entities transmit aim cursor and weapon state in a single 32-bit integer
packed into `entity.data[0]`. This eliminates per-fire effect messages for lasers
and provides a general-purpose cursor direction that all clients can use for
prediction, weapon rendering, and future modular weapon systems.

## Bit Layout

```
Bit:  [31--------19] [18------11] [10]    [9]     [8------0]
       aim angle      dist%        left    right   RESERVED
       13 bits         8 bits      1 bit   1 bit   9 bits
```

### Fields

| Field      | Bits  | Range      | Description |
|------------|-------|------------|-------------|
| aimAngle   | 31–19 | 0–8191     | Quantized aim direction. `angle = q / 8191 * 2π`. ~0.044° precision. |
| cursorDist | 18–11 | 0–255      | Distance from player to cursor as % of 500 radius. `dist = q / 255 * 500`. |
| leftActive | 10    | 0 or 1     | Left weapon slot is actively firing a continuous weapon (laser). |
| rightActive| 9     | 0 or 1     | Right weapon slot is actively firing a continuous weapon (laser). |
| RESERVED   | 8–0   | —          | **9 unused bits.** Available for future use. |

### Reserved Bits — Future Plans

These 9 bits are earmarked for modular weapon expansion:

- **Bits 8–7 (2 bits)**: Left weapon mount index (0–3) — which mount point the left weapon is on
- **Bits 6–5 (2 bits)**: Right weapon mount index (0–3)
- **Bit 4**: Shield active flag
- **Bit 3**: Boost active flag (visual trail indicator)
- **Bits 2–0 (3 bits)**: Free for future use

When we move to modular ships with N mount points, each mount can have its own
weapon and offset. The aim angle is shared (cursor position), but each mount
calculates its own firing angle from its world-space offset to the cursor position.
This works for both players and NPCs — NPCs use target position as "cursor".

## Quantization Contract

**The client quantizes the aim angle to 13 bits BEFORE using it for local prediction
or sending to the server.** This ensures client and server use the exact same angle
for hitscan calculations, making laser rendering perfectly predictable across all
clients without needing to transmit collision distance.

```typescript
// Quantize (client, before sending input)
const q = quantizeAngle(rawAngle);          // 13-bit integer
const snapped = dequantizeAngle(q);          // use this everywhere locally

// Pack (server, in snapshot builder)
const packed = packCursorWeaponState(angle, dist, leftActive, rightActive);

// Unpack (client, reading other player's entity.data[0])
const { aimAngle, cursorDist, leftActive, rightActive } = unpackCursorWeaponState(packed);
```

## Laser Rendering Pipeline

### Local Player
1. Client quantizes cursor angle → does local hitscan at that angle → renders beam instantly
2. Server receives same quantized angle → does authoritative hitscan → applies damage
3. No effect messages needed

### Other Players
1. Client reads `entity.data[0]` from snapshot → unpacks aim angle + active flags
2. If laser active: client does local hitscan from entity's `renderX/renderY` at unpacked angle
3. Renders beam at pixel-perfect precision (using local entity positions)
4. Falls back gracefully if entity not visible

### NPCs (future)
Same format — NPC AI writes `aimAngle` toward its target, sets active flags.
All clients render NPC lasers identically using local hitscan.

## Files

- `common/src/network/cursorState.ts` — pack/unpack/quantize utilities
- `common/src/index.ts` — re-exports cursor state
- `server/src/GameServer.ts` — packs into player data[], uses quantized angle for hitscan
- `client/src/Game.ts` — quantizes angle before sending, passes to renderer
- `client/src/rendering/Renderer.ts` — local prediction + remote laser rendering
