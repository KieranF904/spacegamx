# Netcode next pass: derived hits, decisions ahead, lag cap

Status: planned 2026-11-11 by Kieran, not started. Run as an overnight pass when he says go. Opus for design, core and integration; Sonnet only for independent plumbing and UI.

## Goal
Remove the per-hit traffic that the shared stepper already makes redundant, especially in Scrap Mother fights and group mining. Clients derive hits and damage from inputs and decisions. The server only:
- sends decisions,
- validates with state hashes,
- sends corrections for real gaps.

## Rules (from Kieran, standing)
- **What gets sent:** deterministic things send no records, only decisions, inputs and corrections. See the area guide `docs/areas/networking/`.
- **Mispredictions:** these are fixed by the inputs already relayed. The client sees a changed input and rolls back from that tick through the stepper and touch register. No extra "you mispredicted" message.
- **Corrections:** only for real gaps. That means a target entering view, paths that are still server-only, or a hash mismatch.
- **Latency:** never add fire or input latency to anyone except the laggy player's own inputs (stage 1, item 5).
- **Scale:** judge on realistic loads, at most about 100 per system. Crowds shrink the focus radius.
- **Code rules:** deterministic shared code only (`common/src/math/detTrig.ts`, integer hashing, no `Math.random` or float trig in the sim).
- **Protocol:** bump through the wire scripts (`npm run wire:sync` / `wire:bump`), never hand-edit `wire-dictionary.json`. Plain JSON message changes get a changelog line.
- **Goldens:** re-pin frameHash only for an explained, direct cause (`UPDATE_GOLDEN=1` on `frameHash.test.ts` only). Never `UPDATE_GOLDEN` on `structure.test.ts`.
- **Mining:** already done (2026-11-11). Chunk timing is seeded and derived; per hit and per chunk send nothing.

## Stage 0: measure (before)
Run the netcode bench (`server/src/bench/netTable`, crowdBench) to get bytes per second per message type, plus client CPU for the contact pass and rollback, in three scenarios:
- a Scrap Mother fight with 4 and 10 pilots,
- group mining on a belt with 4 pilots,
- a 50 to 100 ship crowd.

Save the numbers in this file.

## Stage 1: lower risk, most of the savings
1. **Boss decisions ahead:**
   - The server schedules move, window, harass, cap, hold and personal-attack decisions at T + k, with k at least the prediction cap (about 100 ms).
   - Clients never predict a boss choice. A client lagging beyond k rolls back as now.
   - The reaction delay applies to AI only, not players.
2. **Rock and terrain stops derived:** a shell stopped by a rock or terrain wall sends no removal. Every client works out the stop from the deterministic rock orbits and the terrain.
3. **Boss shells hitting players derived:** drop `projectileHit` for move shells. Clients find those hits as they find their own (SelfHits and the stepper).
4. **Leftover hit records:**
   - Audit `HitLedger`, `projectileHit`, `hitFix`, `hpCheck` and the other hit paths.
   - Remove whatever the stepper already covers. Keep only real gaps.
   - List each kept path with why.
5. **Prediction cap and own-input delay:**
   - **Cap:** prediction is capped at about 100 ms.
   - **Laggy players:** a player whose latency exceeds the cap gets their own inputs stamped ahead by the excess, so their inputs reach the server and the other clients before the tick they apply to.
   - **Smoothing:** smoothed ping with hysteresis; the delay changes in small steps and never drops or duplicates an input.
   - **Server:** accepts inputs stamped up to the cap ahead. Late inputs still apply, with a correction.
6. **Ping indicator:**
   - A small dot only, no text banner.
   - Green within the cap, orange slightly over with a small delay, red when delay is noticeable.

## Stage 2: heavy part, full parity suite
7. **Damage on bosses derived:**
   - Covers part damage, wrecks, damage windows and their caps, and stage changes.
   - These come from all pilots' derived hits, summed identically on every client.
   - The per-hit and PART records for these go.
   - Personal luck attacks stay on the secret dice but are sent ahead as decisions.
8. **State hashes:**
   - Periodic small hashes for each boss, the ships near it and the rocks in view, extending the own-ship head hash.
   - A mismatch triggers one correction of that entity's real state.
   - Log mismatches so desync bugs surface.

## Tests (parity first)
- **Client and server agree tick by tick:**
  - in a Scrap Mother fight,
  - with Pyreclast moves,
  - with players hitting boss parts through a damage window and its cap,
  - with rock and terrain stops,
  - for clients at 0, 80 and 250 ms, the last being over the cap.
- **Laggy pilot:** another client never rolls back for a laggy pilot's inputs.
- **Message counts:** zero per-hit messages for boss shells, boss damage and rock stops in the bench scenarios.
- **Corrections:** a forced desync is detected by a hash and fixed by one correction.
- **Ping dot:** the colour follows latency against the cap.

## Stage 3: measure (after)
Run the same scenarios as stage 0. Report bytes per message type before and after, and client CPU, including rollback cost at 250 ms.

## Out of scope
- New gameplay.
- Regional servers.
- Changes to mining (done).
