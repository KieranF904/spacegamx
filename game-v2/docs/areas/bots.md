# Player bots
Dev-only bots that fly a task on the real server and keep stats: a framework to test ships and loops ("how much does this ship gather, how long would a player take"). Two drivers run the same task and keep the same stats: a simulated player (real connection, real input and station messages) and a server NPC (the server's own pilotless-ship API, no connection). Never in production: `BotManager` throws if `NODE_ENV=production`, and `index.ts` builds one only in dev mode.

## Files (what each owns)
| path | owns |
|---|---|
| `server/src/bots/core/types.ts` | `PilotDriver` (what a task may do: observe, pose, hold, set controls, dock, undock, deposit), `Controls`, `Phase` |
| `server/src/bots/core/world.ts` | `BotWorld`: stations, rocks, the laser's reach, pods, prices, read from the server's world |
| `server/src/bots/core/steering.ts` | `flyTo`/`hold`: the four screen-relative move keys with hysteresis, pure |
| `server/src/bots/core/Bot.ts`, `BotManager.ts` | one bot (observe, think, act, stats each tick); the manager (spawn/stop, the `afterTick` hook, `/bot`, stats files, the production guard) |
| `server/src/bots/core/mineTap.ts` | counts the chunks a bot's laser throws (wraps `LootPods.spawnChunk`) |
| `server/src/bots/drivers/clientDriver.ts` | the simulated player: `server.connect`, `join`, then only `input`, `dock`, `undock`, `itemStore`, `marketSellAll`/`marketSell`. Setup (`devShip`, `/god on`, `/goto`) uses the dev tools |
| `server/src/bots/drivers/npcDriver.ts` | the server NPC: `ShipBridge.spawnDummy` + `setController`; laser through `stepWeapons`, LootPods' tractor numbers, `Market.sell` |
| `server/src/bots/tasks/` | `types.ts` (`BotTask`, `TaskDef`), `registry.ts` (by name), `mineAndDeposit.ts` |
| `server/src/bots/stats/BotStats.ts`, `targets.ts` | trips, phases, rates, JSON lines and the table; ore cost of a target in minutes of the loop |
| `server/src/bench/playerBot.ts` | the accelerated bench (no real time) |

Seams used in the rest of the server: `GameServer.afterTick` (hooks run at the end of each main tick), `AdminTools.extensions` (the `/bot` command), `GameServer.pods` and `.mining` made public.

## Running it
- **Bench** (the main tool): `cd server && npx tsx src/bench/playerBot.ts [minutes=30]`. Env: `DRIVER=client|npc|both`, `BOTS=n`, `TASK=name`, `MODE=store|sell`, `OPTS="dockWait=10 standoff=0.55 ..."`, `STATS=<dir>`, `QUIET=1`, `SEED`. 60 game minutes take about 40-60 s wall for the client driver and about 5 s for the NPC. It prints the table, the ore cost of a Mk I mining laser and a whole Prospector in minutes of the loop, and writes JSON lines to `server/stats/bots/` (gitignored: one `trip` line per trip and a closing `summary`).
- **Dev server**: as an admin in chat `/bot spawn mine-and-deposit [n] [client|npc] [key=value ...]`, `/bot list`, `/bot stats [id]`, `/bot stop [id|all]`, `/bot tasks`; or start with `BOTS=mine-and-deposit:1:npc,mine-and-deposit:1:client`. The client bot is an ordinary player with a ship; the NPC bot an ordinary AI-style ship.
- Tests: `npx vitest run server/src/bots` (task state machine with a fake driver, stats accounting, and one full trip per driver on a test server).

## Add a task
1. `server/src/bots/tasks/<name>.ts`: a class implementing `BotTask` (`phase`, `status()`, `step(ctx)`; fly with `flyTo`/`hold`, act through `ctx.driver`, tell `ctx.stats` of trips with `beginTrip`/`endTrip` and of deposits) and a `TaskDef` (`name`, `description`, default `ship`, `station`, `create(opts)`).
2. List it in `tasks/registry.ts`. Options arrive as `key=value` strings (`num`/`str` in `tasks/types.ts`).
3. Test it with a fake driver as `mineAndDeposit.test.ts` does. Anything a new task needs from the world goes into `BotWorld`; anything new a pilot can do goes into `PilotDriver` and both drivers.

## Mine-and-deposit
Starts docked at Sol Central Station, waits 10 s, undocks, flies to the nearest rock of hardness 1 (not a gas pocket, 8 or more ore units left; the Mk I laser works it at full yield), stands off at 0.55 of the laser's range, mines, and the tractor pulls the chunks in. With the hold within 10 volume of full it waits up to 6 s for the last chunks, flies home, docks, deposits (`store`: the quick-store "ores" sweep, the way ore goes to the refinery; `sell`: Sell All, then the gems and volatiles one stack at a time, the rest stored) and repeats. A trip runs from the dock (so it includes the wait) to the next dock; the first approach is `setup` and not in a trip.

## Assumptions (faster or slower than a person)
- Perfect knowledge: it knows every rock's place, type and ore at once, no scanning or hunting; takes the nearest suitable rock, not the richest; no gem-seam hunting.
- Perfect aim and steering, straight lines, no detours or misclicks, no pauses to look at a screen, acts one tick after it sees. A person is slower on all of these: the numbers are the upper edge of the loop.
- God mode and Sol: nothing can hurt it, no repair stops, no fuel. A person would have some of these.
- Setup is not timed: the dev tools place it at the station and give it the ship.
- Rates are per game hour of completed trips. The market saturates when ore is sold (`Market.sell`): repeated selling pays less, so credits per hour fall over a long run; `value if sold` is the unsaturated base price.
- The NPC differs: not a Player (no profile, skills, XP, quests), engines not power-limited (a pilotless ship flies on a full battery), it holds still at the dock point instead of berthing, not in god mode (Sol is safe), the pod pickup count per tick approximates "chunks collected". It adds no per-tick traffic: its controls replicate as AI ships' do, only when they change.
