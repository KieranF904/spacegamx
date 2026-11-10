# Cursor & Weapon State: packed 32-bit word

Each player entity in a snapshot carries one packed integer in `entity.data[0]`: the aim angle, how far the
mining/laser beam reaches, and whether the two beam slots are firing. Code: `common/src/network/cursorState.ts`
(`packCursorWeaponState`, `unpackCursorWeaponState`, `quantizeCursorAngle`, `dequantizeCursorAngle`).

## Bit layout

```
Bit:  [31--------19] [18------11] [10]    [9]      [8------0]
       aim angle      hit dist     left    right    RESERVED
       13 bits         8 bits      1 bit   1 bit    9 bits
```

| Field       | Bits  | Range  | Meaning |
|-------------|-------|--------|---------|
| aimAngle    | 31-19 | 0-8191 | Quantized aim direction: `angle = q / 8191 * 2pi` (about 0.044 degree steps). |
| hitFraction | 18-11 | 0-255  | Where the beam ends, as a fraction (0..1) of its range; 0 means full range / no hit. Server-authoritative (`beam.hit`). |
| leftActive  | 10    | 0 or 1 | First beam slot is firing (`weaponBeamState(eid).on`). |
| rightActive | 9     | 0 or 1 | Second beam slot is firing (`beam.on`). |
| RESERVED    | 8-0   | -      | Nine unused bits. Nothing is planned for them; weapon mounts now come from the ship blueprint, not this word. |

## Where it is written and read

- Written for real players by `server/src/net/snapshot/rows/player.ts` (`data[0]`), and for replicas by
  `client/src/ships/replicas/ReplicaPlacement.ts`.
- Read by `client/src/ships/MiningBeamFx.ts` (remote beams and mining lasers) and
  `client/src/ships/guns/TurretVisuals.ts` (turret aim of other ships).
- Other `data[]` slots on the player row (charge, cursor distance, jump counter, shield, EMP...) are listed beside the
  pack call in `player.ts`; the wire contract is in `docs/areas/networking.md`.

## Quantization contract

The client quantizes the aim angle to 13 bits before using it for local prediction or sending it
(`client/src/app/inputSend.ts`: `quantizeCursorAngle` then `dequantizeCursorAngle`), so client and server use the
same angle and beams line up without sending the collision distance of every shot. Changing the bit layout changes
the wire format: run `npm run wire:bump "reason"` and see `docs/areas/networking.md`.
