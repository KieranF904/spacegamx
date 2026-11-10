# Networking: Decision inputs and bodies' moves
(Part of [networking](../networking.md); the other parts are listed there.)

### Decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md)
With `OWN_SIM` (a body reads its own ship there): a boss with a body (common bodies/registry.ts: the Scrap Mother, the Brood Mother) is flown on the client's tick layer by the same body the server's brain flies it with. A snapshot's `decisions` (`d`, index 11; packed: `decisionsIO`, 2-3 bytes a record) are `[id, dt, op, ...args]`, dt the decision's tick less the snapshot's: SYNC (the whole state, with a keyframe), OFF, TARGET, SIDE, STAGE, WANT. A client running a boss gets no control rows of it, and a keyframe only when the server's bodied shadow (Replication `Shadow.bodied`, its own versions counting down from -1) leaves the ship, or its target's replica was off on that client this window. Its check rides inputs: base layout the first flags byte's 0x80 (3 bytes after the own check), compact `CI_EXTRA.BODY_CHECK`; off, it is synced again. Hits on a boss it runs are told (`HitLedger` 'body'; the client leaves them to the records) until bodies have their hit rules.

### Bodies' moves (`CAPS.MOVES` 1048576, with BODIES; decision-inputs stage 4, no wire change)
The staged bosses' moves (the Scrap Mother's, the Pyreclast's) and the custom enemies' moves and guns live in common
bodies/moves/ (generators and steps over a `MoveHost`), run once on the server for real and on every client's tick
layer from decisions (client ships/bodies/MoveRunner.ts; common `StagedTrack`, `CustomTrack`), each tick of a snapshot's
window once, after the bodies were stepped again. New ops ride the same `d` rows, only to such a client (`MOVE_OPS`):
MOVE [move, seed, rage], HARASS [target + 1], CAP [k, mask] (the density cap read every pilot near), WINDOW [ticks,
cap], HOLD [mode] (a stagger or the dev tools hold its moves; a stage beaten stops them), PART [part, state] (a staged
boss's part gone or wrecked on the tick: part damage is the server's), GONE [bits] (a custom enemy's pieces); PERSONAL
carries [slot, attack, seed, target + 1, name]. A custom enemy's move already rides its order. Such a client is sent no
`bossTelegraph`, `bossBeam`, strike `detonation`, launch `effect`, window opening, or row (nor removal) of a move's
straight shell (seeded `m<owner>:<tick>:<n>`, so its spread is the same; drawn with an id of the client's own) for a
move decided after it began running the body (`BodyNet.derives`: a personal attack or a harassing shot only for its own
pilot). The server's GameServer.moveFx / moveShot do the leaving out. Their hits are told the old way (projectileHit
takes the nearest such shell with it). docs/audits/boss-moves-shared-2026-11-05.md.

