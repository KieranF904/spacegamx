# Mining strategy simulations, 2026-11-06

Player bot (`server/src/bench/playerBot.ts`, docs/areas/bots.md) mining Sol's belt from Sol Central Station with the starter-class Prospector's Mk I laser, 60 game minutes a run, every rock-picking strategy with the new Taenite rock on and off. Run with `npx tsx src/bench/miningSims.ts run <strategy> <on|off> <client|npc>` then `report`.

## What was run
- **Strategies** (`server/src/bots/tasks/rockStrategies.ts`): `nearest` (the old behaviour), `metal` (nearest Chondrite or Taenite), `taenite-on-sight` (nearest, but a Taenite within N units wins; N = 3000 as asked, and 30000 as an extra row), `needs` (the rock whose ore mix best fills what a Prospector is still short of, nearer preferred), `value` (richest by base sale value per ore unit within 4000 units).
- **Taenite off** = Sol belt weight 0 for the run (`FIELDS=sol_belt.rock_taenite=0` in the bench); the data files are untouched.
- **Variations**: `skip` = 0, 2, 4, 7, 11 (the bot passes over that many of the nearest rocks at the first pick of every trip). Client driver cells also include a run of 3 bots at once competing for rocks (3 more samples), so 8 samples a cell; NPC cells have the 5 skip runs. The world is deterministic, so without this every run was identical.
- **Goals** (the bench's own figures): a whole Prospector needs 56 iron, 28 nickel, 13 copper ore (about 97 ore; scrap electronics is not mineable and is left out); the Mk I laser 4 iron, 2 nickel, 1 copper. "run" = game minutes from the first trip's start until the ore deposited so far first covered every ore of the goal (quantised by trips, which last about 3 minutes and carry about 75 ore). "by rate" = the bench's usual extrapolation from ore per hour (the scarcest ore sets it). All times assume the ore is simply collected and deposited: no refining or build time.
- Cells show mean (min-max) over the samples. ore/h, iron/h etc. are per game hour of completed trips. Travel share = travelling over (mining + collecting + travelling).

## Client driver (real connection and inputs)

| strategy | Taenite | time to Prospector, run (min, mean (min-max)) | time to Prospector, by rate (min) | time to Mk I laser, run (min) | iron/h | nickel/h | copper/h | ore/h | travel share |
|---|---|---|---|---|---|---|---|---|---|
| nearest | on | 16.1 (8.3-31.8) | 16.7 (12.9-26.5) | 3.6 (2.4-6.2) | 374 (280-427) | 114 (85-142) | 51 (29-60) | 1,381 (1,202-1,507) | 40% (36-46) |
| nearest | off | 18.7 (5.4-32.4) | 20.4 (14.6-24.8) | 3.7 (2.1-5.2) | 382 (340-439) | 94 (69-126) | 41 (32-53) | 1,408 (1,214-1,548) | 39% (34-44) |
| metal | on | 7.2 (5.0-10.4) | 7.4 (6.2-9.2) | 3.5 (2.4-5.6) | 547 (384-639) | 249 (187-294) | 110 (85-127) | 1,078 (823-1,261) | 53% (46-64) |
| metal | off | 9.2 (5.0-17.1) | 9.4 (6.8-16.9) | 3.4 (2.4-5.6) | 568 (338-672) | 218 (126-265) | 95 (46-115) | 1,065 (661-1,259) | 54% (47-68) |
| taenite-on-sight | on | 16.1 (8.3-31.8) | 16.7 (12.9-26.5) | 3.6 (2.4-6.2) | 374 (280-427) | 114 (85-142) | 51 (29-60) | 1,381 (1,202-1,507) | 40% (36-46) |
| taenite-on-sight | off | 18.7 (5.4-32.4) | 20.4 (14.6-24.8) | 3.7 (2.1-5.2) | 382 (340-439) | 94 (69-126) | 41 (32-53) | 1,408 (1,214-1,548) | 39% (34-44) |
| taenite-on-sight@30000 | on | 11.6 (6.8-19.5) | 12.5 (9.7-15.7) | 4.0 (3.5-5.3) | 338 (303-388) | 143 (114-173) | 66 (50-81) | 1,241 (1,076-1,364) | 46% (42-51) |
| needs | on | 9.9 (6.0-14.2) | 14.2 (11.3-18.9) | 3.5 (2.5-5.2) | 393 (267-460) | 124 (89-149) | 64 (52-80) | 1,359 (1,086-1,492) | 41% (36-47) |
| needs | off | 10.0 (6.0-15.8) | 18.0 (15.4-23.7) | 3.4 (2.5-5.2) | 368 (282-412) | 98 (71-113) | 46 (35-52) | 1,348 (1,027-1,533) | 42% (34-53) |
| value | on | 15.6 (8.2-24.7) | 16.4 (12.4-24.8) | 3.5 (2.4-6.2) | 397 (293-496) | 111 (72-139) | 53 (31-67) | 1,387 (1,127-1,493) | 40% (36-47) |
| value | off | 22.4 (5.4-38.2) | 24.5 (17.6-36.6) | 4.9 (2.4-11.5) | 358 (308-421) | 81 (56-104) | 37 (21-49) | 1,376 (1,145-1,502) | 40% (35-49) |

## NPC driver (server pilotless ship; 5 samples a cell)

| strategy | Taenite | time to Prospector, run (min, mean (min-max)) | time to Prospector, by rate (min) | time to Mk I laser, run (min) | iron/h | nickel/h | copper/h | ore/h | travel share |
|---|---|---|---|---|---|---|---|---|---|
| nearest | on | 14.9 (7.9-19.8) | 14.5 (13.8-15.2) | 2.6 (2.4-2.7) | 415 (384-436) | 116 (110-122) | 58 (54-66) | 1,544 (1,502-1,581) | 34% (32-36) |
| nearest | off | 19.1 (13.6-24.4) | 18.7 (16.2-20.5) | 3.5 (2.5-4.8) | 397 (367-429) | 90 (82-104) | 44 (38-50) | 1,575 (1,530-1,618) | 33% (31-35) |
| metal | on | 5.9 (4.9-8.3) | 6.1 (5.7-6.6) | 2.5 (2.3-2.7) | 663 (641-683) | 304 (293-326) | 127 (119-136) | 1,304 (1,257-1,328) | 45% (44-47) |
| metal | off | 6.0 (4.9-8.2) | 6.9 (6.6-7.4) | 2.6 (2.3-2.9) | 695 (677-720) | 269 (259-279) | 112 (106-118) | 1,290 (1,281-1,296) | 45% (45-46) |
| taenite-on-sight | on | 14.9 (7.9-19.8) | 14.5 (13.8-15.2) | 2.6 (2.4-2.7) | 415 (384-436) | 116 (110-122) | 58 (54-66) | 1,544 (1,502-1,581) | 34% (32-36) |
| taenite-on-sight | off | 19.1 (13.6-24.4) | 18.7 (16.2-20.5) | 3.5 (2.5-4.8) | 397 (367-429) | 90 (82-104) | 44 (38-50) | 1,575 (1,530-1,618) | 33% (31-35) |
| taenite-on-sight@30000 | on | 9.5 (7.1-10.7) | 9.8 (9.5-10.3) | 4.9 (4.9-4.9) | 376 (345-392) | 172 (164-177) | 85 (83-88) | 1,373 (1,303-1,411) | 42% (40-45) |
| taenite-on-sight@30000 | off | 19.1 (13.6-24.4) | 18.7 (16.2-20.5) | 3.5 (2.5-4.8) | 397 (367-429) | 90 (82-104) | 44 (38-50) | 1,575 (1,530-1,618) | 33% (31-35) |
| needs | on | 8.2 (5.4-9.1) | 12.9 (11.3-15.9) | 2.5 (2.3-2.7) | 430 (396-451) | 132 (106-149) | 64 (51-72) | 1,534 (1,505-1,569) | 34% (33-36) |
| needs | off | 7.9 (5.4-9.1) | 17.8 (13.8-22.1) | 2.5 (2.3-2.7) | 418 (369-487) | 100 (81-121) | 47 (35-59) | 1,554 (1,529-1,576) | 33% (32-34) |
| value | on | 12.7 (7.9-14.5) | 14.2 (12.7-16.4) | 2.6 (2.4-2.7) | 423 (400-463) | 120 (102-132) | 58 (51-62) | 1,535 (1,515-1,559) | 34% (33-35) |
| value | off | 14.8 (7.8-25.3) | 18.8 (18.1-19.7) | 3.8 (2.5-5.6) | 402 (371-429) | 91 (85-100) | 44 (42-47) | 1,560 (1,548-1,577) | 33% (32-34) |

## Plain-language read
- **The target (about 10 minutes to a Prospector) is met only by picking rocks, not by taking what is nearest.** The old behaviour (`nearest`) takes 16 minutes on average, with a spread from 8 to 32 depending on which rocks it happens to start with and on luck with copper. A Prospector is only about 97 ore, so it is one or two trips; the clock is mostly the scarcest ore, copper (13 units), which Chondrite carries at about 9 percent and ice and carbonaceous rock not at all.
- **`metal` (Chondrite and Taenite only) is the clear winner: about 7 minutes (5-10) on the client driver, 6 on the NPC.** It mines less ore an hour (about 1,070 against 1,380) because it flies further between metal rocks (travel share 53 percent against 40), but nearly all of it is iron, nickel and copper. `needs` also lands at 10 (6-14) and, unlike `metal`, does not depend on knowing the rock types. `value` is no better than nearest (16 minutes): base value per unit favours rocks that are not what the Prospector needs.
- **Taenite on its own barely moves the result, because it is rare and far.** At weight 5 of 109 only about 1 rock in 22 is Taenite. The nearest one to the station is about 24,500 units away (the nearest rocks of any kind are about 3,000 away), so `taenite-on-sight` with a 3000-unit sight never fires and is identical to `nearest` in every column. With a 30,000-unit sight (a bot willing to fly a long way for it) the Prospector comes in at 11.6 minutes against 16.1 for nearest on the same world, and nickel and copper an hour rise by about a quarter to a third, at the price of more travel (46 percent) and fewer ore an hour. A player who is not hunting for it will meet a Taenite rarely.
- **Caution on on/off comparisons.** Turning Taenite off changes the random draw of the whole belt, so the world differs, not just the Taenite. `nearest` never picks a Taenite and still differs between on (16.1) and off (18.7), and the NPC driver shows 14.9 against 19.1. That is layout noise of two to four minutes, about as large as any Taenite effect seen here except the 30,000-unit diversion. Read Taenite on/off only within a strategy that goes after it, and weigh the `metal` row's 7.2 against 9.2 accordingly.
- **Density 1.5 is right for what it does, but a Taenite rock is small:** about 10-17 ore units each in the generated belt (1.5 times the ore per size, on size 25-45), so one rock is a fraction of a hold.
- **The Mk I laser** is about 3.5 minutes on the client driver whatever the strategy (7 ore: 4 iron, 2 nickel, 1 copper), always within the first trip or two.
- Variation between runs is large (the bot's first rocks decide one trip's copper), so single runs are not trustworthy: the Prospector time ranges from 5 to 38 minutes within one strategy. Competing bots (3 at once) are slower per bot (nearest: 17.7-31.8 minutes) as they share the nearest rocks.

## Limits
- God mode, perfect knowledge and steering (docs/areas/bots.md assumptions): a person would be slower, and a bot knows the type of every rock at once, which a player must scan for.
- NPC-driver bots block each other at the dock (3 at once: two of three never deposited), so competing runs are on the client driver only.
- Prospector cost excludes scrap electronics (not mineable); only ore is timed.
- Client rows for `taenite-on-sight@30000` are on-only (off is the same as `nearest` off).
