# Burst Strafer feature (Cut 6 of docs/refactor/plans/part-registry.json)

The second converted part feature, and the first that flies. A Burst Strafer gives no cruising thrust, only a dodge:
press the dodge key and the ship bursts the way the movement keys ask (any of 32 ways), with whichever strafers push
that way; a fixed burst, then a cooldown; energy is the only limit (rules in `strafer.ts`'s header). Its pieces:

| Half | File | What |
|---|---|---|
| shared | `common/src/ships/features/strafer/strafer.ts` | ways (`DODGE_DIRS`, `dodgeVec`, `chooseDodgeDir`), the counter (`stepDodge`, `dodgePhase`, `refuseDodge`), `strafeForce`, `dodgeLoad`, `burstEnergy`, `dodgeAffordable`, `pilotExtras`, `StrafeInfo` (was `ships/strafer.ts`; exported by the `ships` barrel) |
| shared | `.../strafer/index.ts` | the `PartFeature`: `applies` (`fn.strafe`), `burst: 'engine'`, `derive` (`derived.fx.strafe`), two flight hooks (thrustGate: step the counter, ask the burst's power; impulse: the push, or refuse a starved burst), `flightKey`, the `dodge` input (`DODGE_INPUT`, CTL bit 8192), `replicate` (pilotExtra 0-1, keyframe 16-17, ctl 8192, pinned in `features.wire.json`) |
| server | `server/src/ships/features/strafer/index.ts` | `wire`: the dodge counter and way in the pilot's own row |
| client | `client/src/ships/features/strafer/` | `index.ts` (the Dodge binding, the `dodge` control that latches and buffers a press, the chip, the jets), `DodgeIndicator.ts`, `jets.ts` |

Unchanged on purpose: `FlightBody.dodge`/`dodgeDir` and `ShipState`/`InterpolatedEntity` `dodge`/`dodgeDir` (body
state: keyframes, sync and prediction name them), `FlightControls.dodge` and the input message's `dodge` (the wire
names the held input travels under), `fns[i].strafe` (the data flag `applies` and `partStats` read), `PartStats.dodge`
and the tooltip/card/stats-row/Hangar text that reads it (the text snapshots pin it; its "On this ship" row needs the
ship), the field guide's prose, and the wire (protocol 16).
