# Overnight run, 2026-11-06/07

Everything below is merged into refactor/split, protocol 61, and running on the dev server (refresh the game).

## Landed

- **Aim distance on gun timers.** While a trigger is held, a pilot's guns take the cursor distance only on the tick a gun
  fires and halfway to its next shot (`distDue`, common/src/ships/guns.ts). Server, lanes and own prediction all use it.
  Crowd gun-row bytes: ball 20 1332 → 1055 B/s, ball 50 5903 → 3993 (before bit-packing). Other pilots' shots still
  exact (88/88, 203/203).
- **Hauler guns one cell out.** Chainsaw windows 128° → 186°, Rattler 76° → 180°. Panels:
  docs/panels/2026-11-06/hauler-guns/.
- **Freighters fire back.** Traffic freighters and the escort ward keep flying their route; when hit they lock onto
  the attacker (only it), go quiet 30 s after its last sourced hit. Through the AI body path (no extra traffic vs
  players). Pilots can't damage wards, so an escort never turns on its escorter.
- **Bit-packing** (docs/audits/bitpack-2026-11-06.md). Gun rows ride in the packed snapshot (gunCtl message gone);
  status-row cursor distance follows the idle rule; gunSync, pulls, mapDots, debrisSplit, boss beams/telegraphs/blows
  packed. Per-probe bytes: ball 20 3729 → 2801, ball 50 13297 → 11454, boss 20 4162 → 3619.
- **Profile deltas.** Only changed profile fields after the first full send: ball 20 115 → 1.4 B/s, ball 50 285 → 3.8.
- **Desync fixes.** Debris HP stale after a core blast (sent whole now); move shell drawn twice when its ship died the
  next tick; held debris hit before its ack drifting (sent in full now); freighter lock refreshed by hazard damage.
- **Post-merge failures.** The hauler's new parts shifted entity ids by 3 and exposed: the Pyreclast's personal attack
  roll doing nothing on a broken limb (now moves to an attack it can still make, per the boss rework doc: a small
  gameplay change), destroyed AI ships' bodies never forgotten (a client stepped their moves a tick after death; fixed
  with an ENDED_OFF decision), and two test setups that relied on luck.

Full suite: 348 files pass (one vitest worker crashed with no failing test; Node segfaults have shown up a few times
tonight). Targeted suites re-run after the last merge pass. Production `vite build` succeeds.

## For Kieran to decide

- **Gun-row frames coalescing.** Letting snapshots with gun rows wait like other frames cuts messages by a third and
  saves 270–670 B/s per client; other pilots' trigger changes arrive up to 3 ticks later (shots stay exact). One line
  in PackedLink `urgentFor`.
- **Derelict haulers shed debris at world start** with the new layout (battered wrecks now have loose parts). Harmless,
  but you may want the derelict damage pattern looked at.
- Still open from before: tow beam / flash power on ports, strafer exhaust rule, map click-only jump lock, mining
  proposals, social block list and party-invite leak, news items, boss balance reviews, dev designs affected by the
  power rules, the ship design-update migration for deploy.

## Known, not fixed

- System-memory evict path (Enemies.ts ~1288) skips `pilots.forget`, same leak as the destroyed-ship one.
- netTable pirates bytes vary between identical runs (1127 vs 1146 B/s): something in that bench isn't repeatable.
- A few hpCheck mismatches on the measured pilot's own ship in netTable pirates (its own hits near the check).
- `profile`-like big plain messages left: none over ~70 B/s except gunSync's `z` list (66 → 59 B/s).
