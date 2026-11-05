# Backlog: content to refine after the architecture refactor

Recorded 2026-10-31 after the owner's playtest of waves 1 and 2. New content waits for the refactor (the parts
registry makes it cheaper); cuts may happen before it (see `docs/audits/simplification.md` once it exists).

## Guiding principle
"We prioritise understandable mechanics." There are too many strange, poorly thought-out mechanics. Prefer fewer,
clearer rules over more special cases. A new mechanic has to be explainable in one sentence in the hangar.

## Owner feedback
- **Stabiliser Anchor:** removed ("lame"). Done in e49f815.
- **Burst Strafer:** reworked to any direction, short cooldown, stronger, energy as the only limit. Done in e49f815;
  needs a playtest.
- **Rail Driver** becomes a **semi-automatic rifle** (confirmed): fires quickly, a clip of about 5-6, then reloads
  from energy. Drop Surge from it. Longbarrel stays the sniper (see the brief below).
- **Wiring is a little convoluted.** Simplify.
- **The hangar still shows legacy material categories.** Remove or replace them.
- **Hauler mechanics are boring.** Cargo mass plus towing gives no decisions. Brainstorm hauling that is interesting
  (cargo worth protecting, fragile or volatile loads, towing that matters in a fight).
- **New content in general needs a lot of refining.**

## Decisions on the simplification audit (2026-10-31)
- No cuts before the refactor. Most legacy content stays; all guns stay as a framework and will change a lot later.
- **Energy is to be redesigned after the refactor:** wiring and auto-wiring are very confusing, so simplify or remove
  them, possibly with energy modifier parts. Keep the idea of variable discharge rates and storage capacity, but
  rethink how they work.
- Surge's future is undecided (it is new content, not legacy).

## Owner brief for the post-refactor rework (2026-10-31, evening)
- **Weapons and parts: rework all of them, remove none.** Each gets a distinct character, without weird mechanics
  like the Anchor. Firing models vary by weapon: some have a clip and reload, some use ammo, some use power. Every
  one gets its own custom visuals and visual character.
- **Longbarrel is the sniper:** hold the click for 2 seconds, it charges, fires automatically when the charge
  completes, then has a cooldown.
- **Rail Driver becomes the semi-automatic rifle:** fires quickly, a clip of about 5-6, then reloads from energy.
  No Surge.
- **Wiring:** go back to how it was before the energy/circuit changes (before 5896116), which the owner liked.
- **Capacitors, discharge rates and capacities:** keep the idea but not the current implementation. Layout should
  matter, but intuitively; the current local-circuit rules are too unintuitive to be fun.
- Do all of it once the refactor is done; clean up and refine the next day.
- **End the run with an audit and fix step** (owner request), so rough edges are found and fixed before the morning,
  not left for the owner to discover.

## Open design calls carried over
- Additive weapon blending.
- Charged-shot visuals (needs a protocol bump).
- Surge on beams (moot if Surge is cut).
- Towing friendlies.
- Support-credit threshold.
- The 5 parts skipped from the wire dictionary (pulse dynamo, flash screen, rail driver, repair beam, point defence).
