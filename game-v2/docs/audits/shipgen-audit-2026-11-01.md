# Ship generator audit (2026-11-01)

Five Opus reviewers (core, loop, security, fidelity to the game, tests and hygiene), each finding checked by an Opus verifier trying to refute it. 35 confirmed (some reported by two reviewers), 2 rejected. Read-only: nothing fixed yet.

## [high] Part-list decode can't read its own key section: key codes are looked up before the key: block is parsed

- **Where:** `scripts/shipgen/core/partlist.ts:114` (core)
- **Problem:** partsToBlueprint resolves each entry immediately (shapeFor -> book.get(code)) as it reads the line. blueprintToParts (and so designText in parts form) writes the `key:` block AFTER `end`. Any design with a code outside the legend fails with "XX isn't in the legend". That covers a model in a non-default material, a turret-mounted fixed gun or a bespoke piece. The grid reader doesn't have this problem because parseText collects the key first and solve() runs after.
- **Failure:** An evolve or start run in parts form (design.ts show() -> designText) from a seed or library ship with any non-legend part shows the model a key block. The model's faithful echo is then decoded with a fresh CodeBook (design.ts:279) and rejected as unreadable on every round.
- **Evidence:** Probe: wren with one gun switched to composite gives blueprintToParts text ending `end | key: | PP = fn=cannon_pip material=composite`. partsToBlueprint(text) returns [{"PP^ -1,0": "PP" isn't in the legend}], while gridToBlueprint of the same ship returns 0 errors. Across the 88 bundled blueprints, the parts round trip failed for 65. In 60 of them the only cause was key order: moving the key block before the parts fixed every one.
- **Fix:** Resolve entries in two passes: first collect name/key lines over the whole text, then parse the parts entries. Or keep the parsed entries and resolve them after the loop, as gridToBlueprint does. Add a test that round-trips blueprintToParts -> partsToBlueprint over the bundled ships.
- **Verifier:** Confirmed in partlist.ts:88-115: the single pass resolves each entry with shapeFor -> book.get(code) as it reads, while blueprintToParts (line 41-45) writes key: after end. Probe: wren with one cannon_pip set to composite gives 'PP isn't in the legend'; moving the key block before parts gives no errors. designText (prompt.ts:132) uses blueprintToParts for form 'parts', and design.ts:279 decodes replies with a fresh CodeBook, so a faithful echo of a seed/start ship with any non-legend part is rejected every round.

## [medium] Page selects a cloud model as Designer by default when no local model is enabled

- **Where:** `scripts/shipgen/ui/app.js:56` (security)
- **Problem:** loadModels() only sets the designer when a local model exists (`pick: prefs.model ?? local[0]?.id`, then `if (!prefs.model && local[0])`). If there is no enabled local model, nothing is selected. The HTML select then falls back to its first option that is not disabled. LM Studio options are rendered `disabled` while chat is off (fillModels line 39), so that first option is the first entry in the 'Cloud' optgroup: anthropic/claude-haiku-5-5 when ANTHROPIC_API_KEY is set, or an Ollama ':cloud' model. model2 (compare) has the same fallback (line 58). The same happens when prefs.model names a model that is no longer listed and the only enabled entries are cloud ones.
- **Failure:** Ollama is stopped (or has only ':cloud' models), LM Studio is running with chat off, and ANTHROPIC_API_KEY is in game-v2/.env. The user opens the page fresh (no saved form) and clicks Go. The run goes to the paid Anthropic API with claude-haiku-5-5, although the comment on line 55 says 'Never a cloud model by default'.
- **Evidence:** fillModels: `if (pick && list.some((m) => m.id === pick && !m.off)) select.value = pick;` and otherwise no value is set. The groups are ordered Ollama local, LM Studio local (each `disabled` when m.off), then Cloud. Under the HTML selectedness rules, a single-select with no selected option shows the first non-disabled option. The server-side runOptions/known() accepts any listed model, including cloud ones, and the CLI's defaultModel() does exclude cloud, so the page is the only place this can happen.
- **Fix:** In fillModels, when no pick applies, put a placeholder option first (`<option value="" disabled selected>(pick a model)</option>`) or set select.value = '' explicitly. Also have the server refuse a cloud designer unless the request carries an explicit flag such as `allowCloud: true`, which the page sets only after the user has changed the select.
- **Verifier:** Confirmed. In ui/app.js loadModels, the designer is only set when local[0] exists, and fillModels only sets select.value when pick matches a model that is not off. Cloud models (Anthropic when ANTHROPIC_API_KEY is set, Ollama :cloud/-cloud/remote_host) are never marked `off` (loop/llm.ts lines 133-174), while LM Studio models are `off` while chat is disabled. With no enabled local model and no saved form, the browser's select falls back to the first option that is not disabled, which is the first Cloud entry. formBody sends it and the server accepts any listed model, so Go starts a paid cloud run. That contradicts the comment on line 55 and the 'never cloud by default' rule. model2 has the same fallback. Medium fits: unintended paid outside calls, but only in that environment state.

## [medium] Anthropic client sends no thinking/effort setting, so Haiku 5.5's hidden adaptive thinking eats the reply budget, and a cut-off reply is reported as 'no grid found'

- **Where:** `scripts/shipgen/loop/llm.ts:475` (loop)
- **Problem:** Claude Haiku 5.5 thinks by default (adaptive, effort medium), and by default the thinking comes back as blocks with empty text. The Anthropic request sends no `thinking` or `output_config.effort`, so every reply spends thousands of hidden thinking tokens out of `max_tokens`. listAnthropic marks the model `thinking: false`, so Session gives it 8192 tokens instead of the 12288 meant for thinking models. Because `out.thinking` stays empty, the 'you spent the whole reply thinking' note never fires. `stop_reason` (and Ollama's `done_reason`) is never read either, so the loop cannot tell a reply cut off at max_tokens from one the model ended itself.
- **Failure:** A gunship with Haiku already uses about 5k of the 8192 tokens on hidden thinking (trial 3). Bigger roles (capital: 150-260 cells, 20x24) or a harder round can hit 8192 again. The text grid is then cut off before `end` and read as a partial ship ('no "end" line'), or 'no grid found'. The feedback tells the model to fix its design when it actually ran out of tokens, which wastes paid rounds.
- **Evidence:** out/haiku/evolve-kestrel/events.jsonl: replies of 5161, 5137 and 4558 output tokens hold only 222, 194 and 195 characters of text. out/haiku/gunship-oneshot round 1: 4096 tokens, 0 characters, and the feedback was "I couldn't find a design in your reply (no grid found...)". llm.ts:418 sets `thinking: false` for Anthropic models. llm.ts:497 reads only `usage.output_tokens` from message_delta and ignores `delta.stop_reason`. design.ts:274 adds the thinking note only when `reply.thinking.trim()` is non-empty.
- **Fix:** Record the stop reason in ChatResult (Anthropic `message_delta.delta.stop_reason`, Ollama `done_reason`, OpenAI `finish_reason`). When it is max_tokens/length, give the model a 'cut off at the token limit' note instead of design feedback. For Anthropic, set `thinking: {type:'disabled'}` (Haiku 5.5 allows it at effort high or below) or `output_config: {effort:'low'}`, and/or mark Anthropic models as thinking so they get the bigger budget.
- **Verifier:** Confirmed in code. The line numbers are stale; the code is at llm.ts:227-254. The Anthropic body has no thinking or output_config field. message_delta reads only usage.output_tokens, so stop_reason is ignored, and done_reason and finish_reason are not read either. listAnthropic (llm.ts:174) sets thinking:false, so Session (design.ts:180-182) uses 8192 instead of 12288. The thinking note at design.ts:274 needs non-empty reply.thinking. The recorded events in scripts/shipgen/out/haiku back this up. In evolve-kestrel, replies of 5161, 5137 and 4558 output tokens came back as roughly 200-character part lists with 0 thinking characters. In gunship-oneshot round 1, 4096 tokens produced 0 text and the feedback said 'no grid found'. I lowered severity to medium because the budget is now 8192 and the current gunship runs fit. The remaining risk is larger roles and misleading feedback, not a failure seen today.

## [medium] Evolve scores the seed without the brief penalty, so it beats identical or better children by up to 20 points

- **Where:** `scripts/shipgen/loop/evolve.ts:53` (loop)
- **Problem:** The seed's score is the raw `result.score`. Children are scored by Session.read with `scoreOf`, which subtracts 5 per unmet brief item (up to 20) and adds the 'every gun/engine powered' item. Survivors are ranked with `better()`, which falls back to score when neither ship passes the brief. A seed that doesn't fit the role keeps a full score with no penalty, and nothing warns that the seed's size doesn't match the role (the CLI still defaults `--role starter` when `--seed` is given, cli.ts:53).
- **Failure:** In evolve from a library ship, the seed stays top survivor (and 'best') unless a child fully meets the brief. Children that fix some brief items still rank below the unchanged seed. The evolve metrics' bestByGen shows the seed's inflated score. With a role whose size doesn't fit the seed, mutations push the model to shrink the ship while ranking still favours the oversized seed.
- **Evidence:** Probe: seed Kestrel, role gunship, child = the Kestrel itself sent back as a part list. Generation 1 population: seed 96.8 vs child g1#1 86.8. The child's score event showed `{check: 96.8, briefPenalty: 10}`, with unmet items 'needs at least 2 generator part(s)' and 'your own design: 100% ... worked example'. The seed carries the same unmet items but scores 96.8. With the default starter role, the Kestrel fails 'size: 14-40 cells (has 46)' with no warning.
- **Fix:** Score the seed the way Session.read does: briefCheck plus the unpowered item, scoreOf, and the asymmetry and weights rules when mirror is off. Warn, or fail, when the seed misses the role's size or band (or default the role from the seed's size), and drop the 'copy of the worked example' item when the seed is that example.
- **Verifier:** Confirmed at evolve.ts:50-54. The seed's score is result.score, with no scoreOf penalty and no unpowered brief item. Session.read (design.ts:309-320) applies both. better() (design.ts:381) checks validity, then passes(), then score. A child that fully meets the brief still outranks the seed, because the seed's brief comes from briefCheck and is usually unmet. That narrows the bias to children that are valid but still miss some brief items, and it only applies when a seed is given. cli.ts:53 still defaults the role to starter with no check against the seed's size. Real, but medium rather than high.

## [medium] CLI leaves the detached native renderer running when setup throws or on a second Ctrl+C

- **Where:** `scripts/shipgen/cli.ts:64` (loop)
- **Problem:** The renderer is started (a detached, unref'd service, client.mjs:30-31) at line 64, but the try/finally that closes it only starts at line 115. Everything between can throw: a bad `--contract` (68), a bad `--build` (70), no local model in pick() (50), a bad or unreadable `--seed` file in parseBlueprint (80), and compare with no `--models` (82). The second Ctrl+C calls `process.exit(130)` with no close either.
- **Failure:** `npx tsx scripts/shipgen/cli.ts --contract jsn` (or any run with no local model) starts the native render service (node plus a GL worker on port 5311), prints the error and exits. The service keeps running in the background, against the 'started and always stopped' rule and the dev process hygiene rule.
- **Evidence:** cli.ts:63-64 `renderer = await nativeRenderer(...)`; cli.ts:67-82 can throw; cli.ts:115-137 `try { ... } finally { await renderer?.close(); }`; cli.ts:59 `if (ac.signal.aborted) process.exit(130)`. native-render/client.mjs:30 spawns the service `detached: true` and calls `child.unref()`.
- **Fix:** Start the renderer after all options are checked, or move the try/finally up to just after nativeRenderer(). On the second SIGINT, call renderer.close() (or at least the service's /quit) before exiting.
- **Verifier:** Confirmed. The renderer starts at cli.ts:62-65. Several things can throw after that and before the try/finally at about line 115: parseContract (68), the --build check (70), pick() when no local model is found (80-81, since pick runs inside the opts expression), and the seed readFileSync/parseBlueprint and compare --models checks (80-82). main().catch only logs the error. The second SIGINT handler calls process.exit(130) without closing the renderer. render.ts close() only stops the service when it was not already running. That is still the normal case, so the service is left behind.

## [medium] A render has no timeout in practice: a hung native renderer stalls the run indefinitely

- **Where:** `scripts/shipgen/loop/render.ts:34` (loop)
- **Problem:** render() uses `signal ?? AbortSignal.timeout(60000)`. The loop always passes `o.signal` (the CLI's ac.signal, and the page's run signal), so the 60 s timeout never applies. Only a user cancel can end a render that hangs.
- **Failure:** If the GL worker wedges (a large capital, a driver hiccup), a CLI compare or evolve run left overnight stops at that render forever. No error event is emitted and no further rounds run.
- **Evidence:** render.ts:34 `signal: signal ?? AbortSignal.timeout(60000)`; design.ts:400 `deps.renderer.render(a.bp, path, o.signal)`; cli.ts:74 and web/options.ts:77 always set `signal`.
- **Fix:** Combine the two: `AbortSignal.any([signal, AbortSignal.timeout(60000)].filter(Boolean))`. A timeout should then give a non-fatal render error, as other render errors do.
- **Verifier:** Confirmed. render.ts uses `signal ?? AbortSignal.timeout(60000)`. design.ts:400 always passes o.signal. Both the CLI (ac.signal) and web/options.ts:77 always set it, and timelapse passes its own signal as well. The 60 s fallback therefore never applies in the loop, and a hung render waits until the user cancels.

## [medium] Two page runs can start at once (409 guard is check-then-await), and they share one output folder

- **Where:** `scripts/shipgen/web/app.ts:69` (tests)
- **Problem:** startRun checks runs.active() and then awaits models(true) (a fresh llm.list(), which can take up to the 5 s per-server timeouts) and deps.getRenderer() (up to 30 s when the native service has to start). The run is only registered in runs.start() after those awaits, so a second POST that arrives during them also passes the check. The output folder name is `${stamp()}-${mode}-${slug(role)}-page`, which only changes once a second, so both runs (or a quick Stop-then-Go) write the same events.jsonl, metrics.json, designs/ and renders/rN.png.
- **Failure:** A double-clicked Go, or two tabs, runs two models on the GPU together, which the Runs comment says must not happen. Each run's record on disk interleaves the other's events. metrics.json is overwritten, render files clobber each other so gallery and best URLs show the wrong ship, and the Watch view ends at whichever 'done' comes first.
- **Evidence:** Probe (fake LLM whose list() takes 200 ms, two concurrent POST /api/runs): `concurrent POSTs: [200,200]`, `running at once: 2`, and both runs reported outDir `2026-11-01T11-22-43-design-starter-page` with `starts in its events.jsonl 2`. The test 'runs one at a time' only sends the second POST after the first has returned.
- **Fix:** Reserve the slot synchronously before the first await (for example a `starting` flag or a placeholder Run set in runs.all, released on error). Make outDir unique with the run id, or with ms plus a counter, and create it with mkdirSync without recursive so a collision throws. Add a test that fires two POSTs with Promise.all against a slow list().
- **Verifier:** Confirmed in web/app.ts startRun: runs.active() is checked, then `await models(true)` (a fresh llm.list() with 5 s timeouts) and `await deps.getRenderer()` run before runs.start() calls all.set(). A second POST during those awaits also passes the check. stamp() is the ISO time cut to whole seconds, so two runs in the same second get the same outDir, and mkdirSync uses recursive. It is a real race, but it needs a double POST inside that window on a single-user localhost tool. That makes medium a better fit than high.

## [medium] Replies cut off at the token budget are never detected; the model gets misleading feedback

- **Where:** `scripts/shipgen/loop/llm.ts:227` (tests)
- **Problem:** None of the three providers reads the stop reason: Anthropic message_delta.delta.stop_reason ('max_tokens'), Ollama done_reason ('length') and OpenAI/LM Studio finish_reason ('length') are all ignored. ChatResult has no truncated flag, so Session.read treats a cut-off reply as complete. For grid-text and parts, the only sign is a 'no "end" line' note and a partial grid, so the feedback tells the model about missing markers or a broken grid instead of 'you ran out of tokens'. Only the grid-json path (fromCutJson) guesses at it.
- **Failure:** A capital-role run (or a thinking model at 12288) whose grid passes the budget is scored as unreadable or invalid every round. The model is told to fix markers or rows, and the metrics show it as a model failure, not a budget failure.
- **Evidence:** `grep stop_reason|done_reason|finish_reason` finds nothing in scripts/shipgen. TRIAL.md, Trial 3: 'the loop's reply budget of 4,096 tokens cut every mid-size grid off before "end" (now 8,192)'. This was found by hand after two failed runs. design.ts says 'a capital's more' than 4k tokens, so 8192 can still cut capital grids. No test covers the 8192/12288 budget or a max_tokens stop.
- **Fix:** Capture the stop reason in each provider branch into ChatResult (truncated: boolean), put it on the reply event and in the metrics, and have Session.read say 'your reply hit the N-token limit before end' in the feedback. Add llm tests that feed each provider's length or max_tokens stop, and a Session test that the budget is 8192 (12288 for thinking models) and reaches maxTokens.
- **Verifier:** A grep for stop_reason, done_reason and finish_reason finds nothing. ChatResult has no truncated flag. design.ts sets the budget to 8192 (12288 for thinking models) and its own comment says a capital's grid takes more than ~4k tokens. TRIAL.md records that this exact failure was misread earlier.

## [medium] CLI leaves the detached native-render service running when it throws after starting it

- **Where:** `scripts/shipgen/cli.ts:63` (tests)
- **Problem:** nativeRenderer() starts the service, which client.mjs spawns `detached: true` and `unref()`s, so it outlives the caller. The CLI starts it before several things that can throw outside the try/finally that calls renderer.close(): the `--contract` check, the `--build` check, `--seed` readFileSync/parseBlueprint, and the compare `--models` check. A second Ctrl+C calls process.exit(130) and skips the finally. Killing the CLI by PID (the user's process-hygiene rule) skips it as well, because only SIGINT is handled.
- **Failure:** `npx tsx scripts/shipgen/cli.ts --contract xml --role starter` (or a typo in a --seed path) exits with an error, and the native-render node service and its GL worker stay running on port 5311 with nobody to stop them.
- **Evidence:** cli.ts: `renderer = await nativeRenderer(...)`, then `if (!contract) throw new Error(...)` and `if (build !== 'oneshot' ...) throw` before `try { const r = await run(...) } finally { await renderer?.close(); }`. client.mjs: `spawn(process.execPath, args, { detached: true, ... }); child.unref();`. The SIGINT handler does `if (ac.signal.aborted) process.exit(130)`.
- **Fix:** Validate every flag (contract, build, seed, models) before starting the renderer, and put everything after nativeRenderer() inside the try/finally. On the second Ctrl+C, run close() with a short deadline before exiting. Consider having the service exit when its starter's pid is gone (pass the parent pid, poll it).
- **Verifier:** In cli.ts, nativeRenderer() is awaited before the --contract and --build throws, before the --seed parse and before the compare --models check, and all of these sit outside the try/finally that calls renderer.close(). client.mjs spawns the service detached and unref()s it. The second Ctrl+C calls process.exit(130) without closing. All confirmed.

## [medium] Key tests check fakes, not behaviour; important paths have no tests

- **Where:** `scripts/shipgen/web/app.test.ts:113` (tests)
- **Problem:** Several tests pass whatever the code does. 'lists models ... never sends a token' runs against fakeLlm, which has no token, so it cannot fail. 'anthropic refuses without a key, before any request' uses a fetch that throws, but chat() calls info() → list() first, which does fetch /api/tags and the LM Studio lists; list() swallows the throw, so the 'before any request' claim is untested (and false). Untested: watchStream (the SSE route: replay, Last-Event-ID skip, end on done, follower stop on client close); concurrent run starts; Anthropic error events mid-stream, HTTP errors, image blocks and the max_tokens value sent; the Session budget (8192/12288); staged rejection of removed earlier parts, of unpowered guns or engines, the 'skipped' step and cancellation mid-step; server.ts/cli.ts cleanup (renderer close on quit or error); /api/timelapse abort.
- **Failure:** Regressions in the security-relevant token handling of the real client, in staged acceptance, in the watch SSE route, or a budget change back to 4096 would all pass the suite.
- **Evidence:** app.test.ts:113-118 only greps the /api/models JSON for 'token|bearer' while using fakeLlm. llm.test.ts:211-214 uses `f = async () => { throw new Error('no network expected') }` with no assertion that f was never called. grep finds no 'you removed', 'gets no power' or 'skipped' in staged.test.ts. watch.test.ts tests followJsonl, listWatchRuns and watchFile, but not watchStream.
- **Fix:** Run the token-leak check through createApp with a real createLlm (fake fetch, token set). Assert the fetch spy was never called in the no-key test (or move the key check before info()). Add tests for watchStream over a real http server, staged lost or unpowered rejection, Anthropic stop_reason/error, and Session.budget.
- **Verifier:** app.test.ts:113-118 runs against fakeLlm, so the token check cannot fail. In the 'before any request' test the throwing fetch is actually called: chat() calls info() → list(), which calls listOllama, and the error is swallowed. That test has no assertion that fetch was not called. No test file references watchStream. staged.ts has the 'you removed' and 'gets no power' rejections but staged.test.ts never tests them.

## [medium] Power checks use the new touch-routed core, not the live energy system, and nothing tells the user

- **Where:** `scripts/shipgen/core/sim.ts:1` (fidelity)
- **Problem:** Every power result (fed/linked, pct, pctLong, unpowered, bottlenecks, the 0.3-weight power score, the brief item 'every gun, engine and tool powered', staged-step acceptance) comes from common/src/ships/power, the touch-routed core. Nothing in the live game uses that core yet. The game runs energy.ts/circuits.ts/rebuild.ts: one ship pool plus banks, with power carried by wires. A design without wires, which covers every generated design, is auto-wired over any cells, hull included. So the tool rejects ships the live game flies fully powered, and its percentages ('every gun at 100%') are numbers from the future system. TRIAL.md, the prompt, the legend and the page never say which system is being checked. The prompt states new-system rules as fact: 'hull and armour carry none', 'must touch a GENERATOR, STORE, CONDUIT, DIODE or the core'.
- **Failure:** gemma's compare-starter t2 ship flies with both guns and both engines powered in the live game. The tool scores it 55.1 with weapon sustain 0%, adds 'every gun, engine and tool powered (4 get none)' to unmet, and the compare tally counts it off-brief. The reverse also holds: the 100% / 45% sustain figures in TRIAL.md say nothing about how the ship performs in the current build.
- **Evidence:** Probe over the 5 review ships plus every saved design in scripts/shipgen/out that check() calls valid (55). For each consumer, tool linked/pct compared with live createShipState(...).derived.satisfaction. Disagreements in 4 of 55, all where the tool says unpowered and the live game says powered: trial/compare-starter/designs/gemma4_12b-t2.json had Pip#0, Pip#1, Ion Drive#11 and #12 at live sat=1.00 but tool linked=false, pct=0/0. trial/compare-starter gemma4_12b-t3 and trial/text-starter gemma4_12b-t1 each had 2 Pips the same way. trial2/contract-starter-parts gemma4_12b-t1 had Pip#3 and #4 at live sat=1.00, tool linked=false, pct 67.5/11.3. rebuild.ts:379: burst consumers get 'satisfaction = powered || stored || nearBank ? 1 : 0' per wire network. wires.ts header: 'A design without wires ... is auto-wired once'. grep of shipgen (TRIAL.md, ui, prompt) finds no statement of which energy system is used.
- **Fix:** Say it in TRIAL.md, the legend header and the page: 'power is checked on the touch-routed core (P2), not the live pool/wire system'. Better, add a live-game column to PowerReport from derived.satisfaction (and powerTick if wanted), so 'powered in today's game' and 'powered after the switch' are both visible. Until the switch lands, do not fail a brief on new-core-only darkness, or label it clearly.
- **Verifier:** Confirmed. sim.ts builds every power figure from common/src/ships/power (buildEnergyLayout/energyTick). Outside power/ and tests, nothing in common/server/client calls these. client/src/ui/shipStatus/source.ts says the touch-only core 'replaces it at the P2 switch-over', and rebuild.ts:379 still sets burst satisfaction per wire network, with wires.ts auto-wiring designs that have no wires. prompt.ts:266 says 'hull and armour carry none' as fact, and neither TRIAL.md, the legend nor the UI says which system is checked. I lowered it from high: sim.ts's header deliberately targets the touch-routed core ('as the review ships were checked'), and energy-routing-impl.md shows the project is moving to it. So designing for the upcoming system is defensible. The real defects are the missing label and briefs that fail ships which are powered in today's build. I did not re-run the reviewer's 4-of-55 probe.

## [medium] Worked examples break their own role's brief and band, and their out-of-band parts are added to the legend

- **Where:** `data/shipgen/roles.json:46` (fidelity)
- **Problem:** The gunship example dev/review-kestrel has 1 generator, but the role requires 2. It also uses power_overclock_reactor (Lv24 rare) in a role with band maxLevel 20. The beam_frigate example dev/review-heron has 2 generators against a requirement of 3, and uses lance_lance (Lv32 epic) in a maxLevel 26 band. briefLegend() (prompt.ts:148-155) adds every code the example uses to the legend, so the out-of-band parts are offered to the model. The prompt calls the example 'a good design'.
- **Failure:** The gunship model studies an example that fails the same brief it will be judged on, and is handed an Overclock Reactor a Lv20 pilot cannot fit.
- **Evidence:** Probe, briefCheck on each role's example: dev/review-kestrel gives 'needs at least 2 generator part(s) (has 1)', example parts outside band: power_overclock_reactor/titanium. dev/review-heron gives 'needs at least 3 generator part(s) (has 2)', outside band: lance_lance/cobalt. Wren, Mako and Monarch pass their briefs and bands.
- **Fix:** Either lower the requirements (gunship generator min 1, beam_frigate min 2) or pick examples that meet them. Raise those roles' maxLevel, or stop briefLegend adding out-of-band example codes. Add a test that every role's example passes briefCheck and stays inside its band.
- **Verifier:** Reproduced with a probe. briefCheck on dev/review-kestrel gives 'needs at least 2 generator part(s) (has 1)', and it uses power_overclock_reactor/titanium outside the gunship band (maxLevel 20). dev/review-heron gives 'needs at least 3 generator part(s) (has 2)' and uses lance_lance/cobalt outside the maxLevel 26 band. briefLegend (prompt.ts:148-155) adds every code the example uses to the shown legend.

## [medium] Pilot level band is shown but never enforced, and the level gating is re-implemented

- **Where:** `scripts/shipgen/core/roles.ts:71` (fidelity)
- **Problem:** briefCheck checks counts, size and sameness, but never checks that parts fall inside the role's band. CodeBook (grid.ts:24-31) resolves any code in the full legend, so a design can use parts above its level and still count as valid and on brief. Separately, legendFor/buildLegend rebuild the licensing rule by hand (f.unlock?.level ?? 99, MATERIAL_LEVEL[m] ?? 99, STARTER_MATERIALS, JOB_MATERIALS) instead of calling econ partLicensed/modelLicensed/materialLicensed. That copy misses STARTER_FUNCTIONS and the core's licence. The server's Hangar refits use partLicensed (Hangar.ts:73, 'you aren't licensed to fit ...').
- **Failure:** A 'Starter fighter' (maxLevel 5) reply that uses a Fusion Plant (Lv18) or a Lance passes check() and briefCheck. Saved to the library, it is a ship a Lv5 pilot cannot fit in the hangar.
- **Evidence:** roles.ts briefCheck has no band test. grep 'band' in core/loop gives only legendFor/briefLegend/options. grid.ts CodeBook.get falls back to legend.byCode, which holds all entries. legend.ts:102,110 compute level from MATERIAL_LEVEL and fn.unlock directly.
- **Fix:** Add an unmet item in briefCheck for parts outside legendFor(role.band), with the band check built on econ partLicensed / modelLicensed / materialLicensed (passing the band's level), so the gating follows the game's rule.
- **Verifier:** Confirmed. briefCheck (roles.ts:73-100) has no band test, and grep finds legendFor/band used only by the legend, prompt and web options. CodeBook.get (grid.ts:28) resolves any code from the full legend, so out-of-band parts pass check() and briefCheck. On the re-implementation point: legend.ts does import MATERIAL_LEVEL, STARTER_MATERIALS and JOB_MATERIALS from econ, so the constants are shared. Only the composition is hand-built. It misses the core's First Light licence and the fn: licence for non-starter structure. The structure functions are only core, hull, armor and cargo, so that part matters little. The missing band check is the substantive defect.

## [medium] The 'thruster' selector counts Gyros and Burst Strafers as engines

- **Where:** `scripts/shipgen/core/partPower.ts:72` (fidelity)
- **Problem:** PowerRole comes from the power core's ROLE_THRUSTER, which includes non-engines: Gyro and Heavy Gyro (only gyro/demand, no thrust) and Burst Strafer. roles.json uses { role: thruster, min N } to mean engines: the starter summary says 'two engines', and others ask for 'a wall of engines'. In one-shot and evolve, briefCheck counts any ROLE_THRUSTER part. The staged engine step only escapes this because it also needs facing S.
- **Failure:** A gunship with 1 Ion Drive and 2 Gyros meets 'needs at least 3 thruster part(s)', yet has one engine and poor thrust.
- **Evidence:** Probe: legend gives utility_gyro role thruster (GY, Lv6) and utility_heavy_gyro role thruster (HG, Lv20). The gunship thruster selector, inside band 20, matches 8 parts including Burst Strafer@10 and the Gyros. models.json: utility_gyro has 'gyro':250, 'demand':6 and no thrust. isEngine() (grades.ts:93) is thrust > 0.
- **Fix:** Add an 'engine' selector (isEngine) next to 'thruster' and use it in roles.json and the staged engines step. Keep 'thruster' for anything the core drives.
- **Verifier:** A probe shows legend power.role 'thruster' for utility_gyro (GY, Lv6), utility_heavy_gyro (HG, Lv20) and engine_burst_strafer (BS, Lv10) next to the real engines. matches() uses partPower().role, so { role: thruster, min N } counts Gyros and Strafers toward the 'engines' requirements in roles.json.

## [medium] Grid rows after a blank line are silently dropped

- **Where:** `scripts/shipgen/core/grid.ts:211` (core)
- **Problem:** In parseText, an empty line inside the grid sets mode='top'. Every later row is then skipped by `if (mode !== 'grid' && hasGridHead) continue`, with no error or warning. Local models often put a blank line between rows.
- **Failure:** The model's lower rows (often the engines) vanish. The check then reports missing engines and thrust, or unreachable parts, for a ship the model actually drew correctly. Nothing in the feedback says rows were ignored.
- **Evidence:** Probe: 'grid:\n -1 0 1\n0 HA CA HA\n\n1 HA HA HA\n2 HA HA HA\nend' decodes to 3 parts with errors [] and warnings []. Without the blank line it decodes to 9 parts.
- **Fix:** Treat a blank line as the end of the grid only when the following non-blank line is not a grid row. Otherwise keep reading grid rows until `end`, or at least warn when grid-shaped rows appear after the grid was closed.
- **Verifier:** grid.ts:211 sets mode='top' on a blank line once rows exist, and line 224 skips every later line when a grid: head is present. Probe reproduced it: 3 parts, no errors, no warnings, versus 9 without the blank line.

## [medium] Part-list form drops paint, drive, rigid, mods/gems and shared-cell pieces

- **Where:** `scripts/shipgen/core/partlist.ts:38` (core)
- **Problem:** blueprintToParts writes only name and parts. It has no paint/drive/rigid header and no raw: section like the grid's, and parts with mods or gems are written as plain entries. On the way back, partsToBlueprint parses only name:. Two shaped pieces sharing one cell (legal in the game, e.g. two complementary wedges) are written as two entries. The reader then refuses or drops one, because it checks overlap by whole cells.
- **Failure:** Evolving or editing a library ship in parts form silently strips its paint, drive split, rigid flag and part mods/gems, and can lose hull pieces. The child is then scored and saved as if that were the design.
- **Evidence:** Probe: bundled 'bulwark' round-trips through blueprintToParts/partsToBlueprint with 28 of 30 parts and the warnings '"HAt3 -2,2" is under another part: dropped' and 'hull under "ASt4 2,2": dropped'. The grid round trip of the same ship succeeds because those pieces go to raw:. Code: partsToBlueprint matches only /^name\s*:/ in the header and builds the blueprint with name, catalogVersion and parts only.
- **Fix:** Carry paint/drive/rigid header lines and a raw: section in the part list, as blueprintToGrid does, and parse them back. For pieces that share a cell, route them to raw: or check overlap by polygon area (as the validator does) rather than by cell.
- **Verifier:** blueprintToParts writes only name and parts, with no paint, drive, rigid or raw: section. partsToBlueprint builds only {name, catalogVersion, parts}. Probe: bulwark round-trips to 28 of 30 parts with exactly the reported 'under another part: dropped' warnings, even with the key-order bug removed. The grid path keeps all 30. Bulwark has no paint, drive or mods, so that part of the claim comes from reading the code, which plainly omits those fields.

## [low] CSRF Origin check accepts every localhost origin on any port

- **Where:** `scripts/shipgen/web/app.ts:258` (security)
- **Problem:** POST requests are refused only when an Origin is present and does not match `^(127.0.0.1|localhost|[::1])(:\d+)?$`. Any page served from any localhost port, such as the game's own dev client, another project's dev server, or a local tool's web UI, can therefore send state-changing POSTs. These include /api/settings (turn LM Studio chat on), /api/runs (start a run, including with an LM Studio or cloud model), /api/save (write into the committed data/ships/blueprints/dev), /api/lab (spawn the exporter) and /api/quit.
- **Failure:** A page on http://localhost:3000 that renders untrusted content (or is compromised) runs `fetch('http://127.0.0.1:5320/api/settings',{method:'POST',body:'{"lmstudioChat":true}'})` followed by a POST to /api/runs with an lmstudio/ model. LM Studio then loads a model without the user ticking the toggle.
- **Evidence:** Probe: LOCAL_HOST.test('http://localhost:5173'.replace(/^https?:\/\//, '')) is true, and the same holds for 'https://127.0.0.1:1'. The Host check stops DNS rebinding (rebinding Host values fail the regex), and 'null' and foreign origins are rejected correctly.
- **Fix:** Compare the Origin with the request's own Host (`origin === 'http://' + req.headers.host`) or with the exact port the server bound, and require Content-Type: application/json on POSTs. A cross-origin JSON POST then needs a CORS preflight, which the server never grants.
- **Verifier:** Confirmed at app.ts line 116. LOCAL_HOST allows any port, so Origin http://localhost:3000 passes. readJson does not check Content-Type, so a simple text/plain cross-origin POST from any localhost page can reach /api/settings (it can turn LM Studio chat on, which the tests show) and /api/runs. The attacker has to be a page already served from localhost, so low severity is right.

## [low] Page runs keep every event in memory, token events included, and two runs can start at once

- **Where:** `scripts/shipgen/web/runs.ts:705` (security)
- **Problem:** Runs.start's emit pushes every event, including each streamed 'token' delta, into run.events, and Runs.all never drops finished runs. A long page session therefore grows memory without bound. Separately, startRun checks `runs.active()` and then awaits `models(true)` (an HTTP listing) before runs.start registers the run. Two POST /api/runs requests that overlap can both pass the 409 guard and run in parallel on the GPU, which defeats the stated one-run-at-a-time rule.
- **Failure:** A day of evolve runs on one server holds hundreds of thousands of token objects. A double-click on Go, or two tabs, starts two concurrent runs.
- **Evidence:** runs.ts: `const emit = (e) => { const pe = enrich(e); run.events.push(pe); ... }` with no filter on type 'token'. app.ts startRun: `if (runs.active()) throw ...409` then `const list = await models(true);` and only after that `runs.start(...)`.
- **Fix:** Do not keep 'token' events in run.events (send them live only), or cap the replay buffer and evict old finished runs. Reserve the run slot synchronously, before the first await in startRun (for example with a `starting` flag).
- **Verifier:** Confirmed. In runs.ts start(), emit pushes every event, token deltas included, into run.events. Runs.all is never pruned. Only events.jsonl filters out tokens (app.ts line 82). startRun checks runs.active() at line 69 and then awaits models(true) (a fresh HTTP listing) and possibly deps.getRenderer() before runs.start registers the run. The page's Go button is not disabled before the POST resolves (form.onsubmit, ui/app.js lines 345-355), so a double-click or two tabs can get past the 409 guard. This is a resource and robustness issue in a local dev tool, so low.

## [low] Claude critic gets 300 max tokens, which adaptive thinking uses up, so the verdict is usually empty

- **Where:** `scripts/shipgen/loop/critic.ts:83` (loop)
- **Problem:** critique() asks for `maxTokens: 300`. anthropic/claude-haiku-5-5 is listed as `vision: true`, so it can be picked as the critic, and it thinks by default (hidden). The thinking alone will usually use the 300 tokens, leaving `r.text` empty. parseVerdict('') returns looks null with no error. comparePair has the same problem (2000), and its fallback to `r.thinking` gets nothing because the thinking text is empty.
- **Failure:** `--critic anthropic/claude-haiku-5-5` costs one paid request per valid design, and the critic events show 'looks ?/10' with an empty reason. Nothing reports the critic as broken, unlike the error path.
- **Evidence:** critic.ts:83 `temperature: 0.2, maxTokens: 300`; llm.ts:418 Anthropic models are `vision: true`; the Haiku runs above spend 4.5-5k hidden tokens before writing about 200 characters.
- **Fix:** Turn thinking off or lower effort for Anthropic critic requests, raise maxTokens for Claude, and emit an error when the verdict comes back with looks null.
- **Verifier:** The code matches the claim. critic.ts critique() uses maxTokens:300 and parses only r.text. parseVerdict('') returns looks:null with no error. comparePair falls back to r.thinking, which is always empty for Anthropic. The recorded Haiku runs show thousands of hidden thinking tokens per reply, so a 300-token cap will very likely produce an empty verdict. However, no critic run with Haiku was observed. The critic is also opt-in and off by default, and its weight defaults to 0, so the main cost is a wasted paid request. Low.

## [low] Staged-build metrics count the power-only skeleton as a valid design

- **Where:** `scripts/shipgen/loop/staged.ts:242` (loop)
- **Problem:** In a staged build, `firstValidRound` is set by the first valid try of any step. The power step on the skeleton is valid almost every time. When later steps fail, `out.best` is the accepted power-only ship, so `designMetrics.valid` is true and `firstValidRound` is 1. TRIAL.md had to count staged 'Valid' by hand ('only ships that got power and at least one more system'). The DesignMetrics and the page's per-run valid figures don't do that.
- **Failure:** metrics.json for a staged gunship whose weapons and engines steps both failed reports `valid: true, firstValidRound: 1`. That looks like a success in the page's metrics and anything that aggregates metrics.json.
- **Evidence:** staged.ts:242 `if (a.valid && out.firstValidRound === null) out.firstValidRound = round;`; staged.ts:273-274 `out.best = shipAttempt`; run.ts:195 `valid: !!r.best?.valid`. TRIAL.md trial 2: 'the skeleton alone is always valid'. The best qwen staged gunship was 'power round the core... no guns, no engines'.
- **Fix:** For staged builds, set firstValidRound and valid only once a step after power is accepted (or report which steps were accepted in the metrics). Keep firstPassRound as it is.
- **Verifier:** Confirmed. staged.ts:242 sets firstValidRound on the first valid try of any step, including power. out.best = shipAttempt is the last accepted step, which can be power-only. run.ts sets valid: !!r.best?.valid. The skeleton is valid in game terms, so this is a misleading metric rather than a wrong check. firstPassRound, the brief-level success figure, is computed correctly. Low.

## [low] Tokens of a reply stopped as a runaway are not counted

- **Where:** `scripts/shipgen/loop/design.ts:254` (loop)
- **Problem:** When the loop stops a runaway reply, chat() returns `{ text: sofar, thinking: '', ms, notes }` with no `outputTokens`. The aborted stream never reaches Ollama's `done` or Anthropic's `message_delta` usage. designMetrics sums `outputTokens` over attempts, so stopped replies count as 0 tokens, and those are the longest replies.
- **Failure:** Token totals and tokens/s in metrics (and the cost of a paid Anthropic run) are under-reported for exactly the runs that ran away (trial 1: gemma's 4096-token rows).
- **Evidence:** design.ts:254; run.ts:197 `outputTokens: r.attempts.reduce((a, x) => a + (x.outputTokens ?? 0), 0)`.
- **Fix:** Estimate tokens from the number of streamed chunks or from `sofar.length / 4` and mark the figure as an estimate, or keep a running count of emitted deltas in the client and return it in the abort error.
- **Verifier:** Confirmed. The runaway path in design.ts returns { text: sofar, thinking: '', ms, notes } with no outputTokens, and run.ts sums outputTokens ?? 0. Stopped replies therefore count as 0 tokens in the metrics. This only affects reporting.

## [low] Compare's ms includes a cancelled trial but its trial count does not

- **Where:** `scripts/shipgen/loop/compare.ts:121` (loop)
- **Problem:** When a trial is cancelled, `done` is not increased but `ms = now() - t0` still includes that trial's time. validPerMinute (which is on-brief per minute, despite its name) is therefore lowered for the model that was running when the user stopped the run.
- **Failure:** Stopping a compare halfway through model B gives B a lower ships-per-minute figure than its finished trials earned.
- **Evidence:** compare.ts:114 `if (r.cancelled) { cancelled = true; break; }` before `done++`; compare.ts:121 ms includes it.
- **Fix:** Record the time at the end of the last finished trial and compute ms from that.
- **Verifier:** Confirmed. In compare.ts, a cancelled trial breaks before done++, but ms = now() - t0 is taken after the loop and includes the cancelled trial's time. The model's stats are still pushed. This only skews validPerMinute for the model that was running when the user cancelled. Trivial.

## [low] Model-info cache in createLlm is filled once and never refreshed (newly pulled thinking models think on every reply)

- **Where:** `scripts/shipgen/loop/llm.ts:174` (tests)
- **Problem:** info() memoises `cache ??= list().catch(() => [])` for the life of the client. The page server keeps one client for its whole session. A model pulled after the first chat, or every model if the first listing failed transiently (cached as []), has no info. chat then assumes structured=true and leaves out Ollama's `think` field (`...(mi?.thinking ? { think: !!req.think } : {})`), so a thinking model runs with its default (thinking on) even though the run asked for think=false.
- **Failure:** In a long-running `npm run shipgen` session, a thinking model pulled mid-session spends its budget thinking (TRIAL.md, trial 1: qwen3-vl used the whole budget thinking, 'no grid found'). A model without schema support gets `format` sent anyway.
- **Evidence:** Probe: after one chat with gemma4:12b, a qwen3:8b with ['completion','thinking'] was added to /api/tags. `llm.list()` sees thinking: true, but the /api/chat body for qwen3:8b with think:false had `'think' in body` = false. The page's own models(true) refresh never resets this separate cache, and POST /api/settings (lmstudioChat) doesn't either.
- **Fix:** Give the cache a short time-to-live (as app.ts does with 5 s), or refresh it when the id isn't found, and never cache a failed or empty listing. Alternatively pass the ModelInfo the loop already has (deps.models) into chat.
- **Verifier:** llm.ts:185 sets `cache ??= list().catch(() => [])` and nothing ever resets it. A missing model means mi is undefined, so `think` is left out and structured defaults to true. It only bites with a model pulled during a session, or when the first listing failed, so low severity.

## [low] Page runs (with every token event) are kept in memory forever and replayed in full

- **Where:** `scripts/shipgen/web/runs.ts:296` (tests)
- **Problem:** Runs.all is never pruned. Each run keeps every event, including one 'token' event per streamed chunk and a partial 'grid' event per completed row, each carrying the whole grid so far. New SSE clients and reconnects replay all of it.
- **Failure:** A day of page runs grows the server by hundreds of MB, and reopening a finished run streams megabytes of token events to the browser.
- **Evidence:** Probe: a 342-char reply over 3 rounds retained 300 events (264 token, 15 partial grids), 58 KB JSON, about 56 bytes per reply character. A real 8192-token round (~25-30k chars) is about 1.5 MB, so a staged run (4 steps x 3 tries) or a compare run (2 models x 2 trials x 4 rounds) is roughly 15-25 MB. That memory is held until the server quits.
- **Fix:** Drop token events (and superseded partial grids) from run.events once a round's reply event arrives, or keep tokens only for the running round. Cap finished runs kept in memory (say the last 10) and serve older ones from their events.jsonl through the watch stream.
- **Verifier:** runs.ts pushes every enriched event, tokens included, onto run.events. Runs.all is never pruned (no delete anywhere), and the SSE events() route replays r.events.slice(i). The growth is real, but this is a local dev tool that is restarted often, so low.

## [low] Shipgen tests only run because of an uncommitted vitest.config.ts change

- **Where:** `vitest.config.ts:11` (tests)
- **Problem:** At HEAD, the vitest include list has no 'scripts/shipgen/**/*.test.ts'. The working tree adds it but the change is uncommitted, so the committed shipgen code (commits bcc43a3..8c10522) has 198 tests that a plain `npx vitest run` at HEAD never collects.
- **Failure:** If the working-tree change is lost, or someone runs the suite from a clean checkout, shipgen regressions go unnoticed.
- **Evidence:** `git diff vitest.config.ts` shows only that include entry being added.
- **Fix:** Commit the include change with the shipgen work.
- **Verifier:** git diff vitest.config.ts shows that 'scripts/shipgen/**/*.test.ts' is added only in the working tree.

## [low] Timelapse and still renders ignore the one-run-at-a-time rule and can't be stopped

- **Where:** `scripts/shipgen/web/app.ts:180` (tests)
- **Problem:** /api/timelapse renders up to 80 frames one after another with no AbortSignal tied to the request. Neither it nor /api/render checks runs.active(), so a timelapse runs alongside a model run (GPU shared with the LLM, and the render service queue shared with the run's per-round renders). A closed tab keeps it rendering, and two timelapse clicks render twice.
- **Failure:** During a long model run, a timelapse click slows both, delays the run's renders behind 80 frames, and keeps going after the page is closed.
- **Evidence:** `const t = await renderTimelapse(renderer, buildUp(ctx, bp, Number(b.maxFrames) || 80), dir);` has no signal argument, although renderTimelapse accepts one. There is no active-run check on either route.
- **Fix:** Pass an AbortController aborted on req 'close' into renderTimelapse, and refuse (409) or queue while a run is active or another timelapse is going.
- **Verifier:** In app.ts, /api/timelapse calls renderTimelapse(renderer, buildUp(...), dir) with no signal. Neither /api/timelapse nor /api/render checks runs.active().

## [low] Renderer start failure blocks every run start for ~30 s and leaks a log fd each time

- **Where:** `scripts/shipgen/server.ts:22` (tests)
- **Problem:** getRenderer() clears its cached promise on failure, so every POST /api/runs with renders on retries nativeRenderer() → client.start(). That polls health 300 x 100 ms (30 s) before failing. Each attempt also opens native-render.log with openSync and never closes the descriptor in this process. The 30 s await happens before the run is registered, so it widens the double-start window in the first finding.
- **Failure:** With the native renderer broken, each Go hangs 30 s and then runs without renders. Repeated attempts accumulate open fds in the page server.
- **Evidence:** server.ts: `renderer ??= nativeRenderer().catch(... renderer = null; return undefined; })`. client.mjs start(): `const log = openSync(LOG, 'a'); ... spawn(..., { stdio: ['ignore', log, log] })` with no closeSync, then `for (let i = 0; i < 300; i++) { await sleep(100); ... }`.
- **Fix:** Remember a failed start for a while (back off), close the log fd after spawn, and register the run before awaiting the renderer.
- **Verifier:** server.ts sets renderer = null on failure, so every later call retries. client.mjs start() does openSync(LOG) with no closeSync and then polls 300 x 100 ms. The parent keeps the fd after spawn.

## [low] Watch stream of a run that never wrote 'done' polls forever

- **Where:** `scripts/shipgen/web/watch.ts:454` (tests)
- **Problem:** watchStream ends only when a 'done' event arrives or the client leaves. A CLI run that crashed or was killed (no 'done') keeps a 500 ms stat/read poll per open tab indefinitely. The page shows 'running, watching ...' forever, and listWatchRuns marks the run unfinished for good.
- **Failure:** Watching an aborted CLI run never resolves. Status stays 'running' and the poll timer lives until the tab closes.
- **Evidence:** `if (e.type === 'done') end();` is the only end condition besides req 'close'. describe() sets finished from metrics.json or a 'done' in the tail.
- **Fix:** End (or mark stale) when the file hasn't grown for N minutes, and show the run as 'stopped/unknown' in the list when its mtime is old and it has no done.
- **Verifier:** In watch.ts, watchStream calls end() only on a 'done' event; req 'close' only stops it. describe() sets finished only from a done in metrics or the tail, so a killed CLI run is shown as running indefinitely.

## [low] Roles and legend push Diodes and Conduits, which do nothing in the live game

- **Where:** `data/shipgen/roles.json:82` (fidelity)
- **Problem:** roles.json has capital encourage { role: diode, min 2 } ('Diodes between the grids keep the engines' reserve'). Its style says 'joined by Diodes and Conduits', and beam_frigate's style says 'Use Diodes to keep an engine or shield reserve'. The legend sells CD and DI as 'power line' and 'one way' relays (legend.ts powerWords). In the live old system they hold nothing and route nothing.
- **Failure:** A capital design gets a brief penalty for lacking 2 Diodes. The model is told to spend cells on parts that are dead weight in today's game.
- **Evidence:** rebuild.ts: '(Energy routing's relays, the Conduit and Diode, store nothing for the old flow: circuits.ts leaves them out of the pool)'. Wire networks carry power, not touch. A probe shows the legend gives power_conduit role conduit (Lv0) and power_diode role diode (Lv4).
- **Fix:** Mark the relay advice as new-system only (same note as the finding above), or move Diode/Conduit advice behind an option until the power core goes live.
- **Verifier:** Confirmed. rebuild.ts:366 says Conduit and Diode store nothing for the old flow, and the beam_frigate style asks for Diodes. This follows from the same deliberate choice to target the touch-routed core, where relays matter, so it is the same missing-label issue as finding 1, not a separate high-impact defect. The fix is the same note.

## [low] 'tool' selector used where roles mean shields

- **Where:** `data/shipgen/roles.json:52` (fidelity)
- **Problem:** Gunship encourage { role: tool, why: 'a shield keeps it in the fight' }, beam_frigate { role: tool, min 2, why: 'shields' } and capital require tool min 2 ('shields') all match any ROLE_TOOL part.
- **Failure:** A gunship with a Mining Laser satisfies 'a shield keeps it in the fight'. A capital with two Scanners meets its shield requirement.
- **Evidence:** Probe: the tool selector inside band 20 matches Mining Laser@0, Bore@10, Siphon@12, Scanner@5, Long-Range Array@20, Constructor@2 ... (11 parts). The catalog has a 'shield' family.
- **Fix:** Use { family: 'shield' } (or feature-based) for those selectors.
- **Verifier:** A probe shows the tool role covers mining_laser, bore, siphon, scanner, long_range_array, constructor, jump_coil, heavy_coil and tow_beam as well as the 4 shield-family parts. So 'shields' requirements and encouragements are met by non-shields. A family: shield selector exists in the data. Low, because most of these are encourage items and only the capital requirement is affected.

## [low] sim.ts copies the power core's test-only blueprint input instead of importing a game builder

- **Where:** `scripts/shipgen/core/sim.ts:20` (fidelity)
- **Problem:** shipEnergy() is a copy of common/src/ships/power/testData.ts blueprintInput(), which is test-only and not exported. The copy includes the 'undo old satisfaction' interval fix and the core-index rule. When P2's real rebuild builds EnergyLayoutInput (with weapon mods, dead parts and so on), shipgen keeps its own glue and drifts without any error.
- **Failure:** After P2 changes how intervals or core/alive are fed, the tool's power numbers differ silently from the game's.
- **Evidence:** sim.ts:24-29 match testData.ts blueprintInput line for line. The comment admits it: 'as the power core's P2 rebuild will (power/testData.ts blueprintInput)'.
- **Fix:** Export a non-test blueprintEnergyInput(catalog, tuning, bp) from common/src/ships/power (or from rebuild once P2 lands), and have both testData and shipgen import it.
- **Verifier:** Confirmed. sim.ts:20-30 matches power/testData.ts blueprintInput (lines 57-66) line for line, including the interval undo and the core-index rule. testData is not exported from power/index.ts. The drift risk is real but is a future maintenance issue.

## [low] A one-column ship can't be encoded or decoded (blueprintToGrid throws)

- **Where:** `scripts/shipgen/core/grid.ts:226` (core)
- **Problem:** The header line is recognised only when it has more than one integer (`toks.length > 1`). A single-column grid's header (e.g. '   0') is therefore read as a grid line and rejected. blueprintToGrid checks its own output by reading it back, so it then retries 8 passes and throws 'could not encode'. gridLines' empty-ship output has the same one-integer header, so an empty blueprint also throws.
- **Failure:** The design loop's gridOf catches the throw. web/app.ts designView (line 64), web/options.ts:94, evolve.ts:50 and designText -> blueprintToGrid do not. Any of those given a one-column design (e.g. a model's part list in a single column, or a mirror half that is only the core column) throws instead of showing the ship. A model that draws a 1-wide grid gets a misleading parse error.
- **Evidence:** Probe: blueprintToGrid of a core-only ship, of a vertical core+hull line and of an empty ship each throw 'could not encode c'. gridToBlueprint('grid:\n   0\n0  CA\n1  HA\nend') returns the error: can't read grid line "0".
- **Fix:** Accept a single-integer line as the header when it is the first line of the grid section and the next line starts with a row label. Alternatively, have gridLines always emit a header the reader accepts. Make the empty case decode to an empty ship rather than throw.
- **Verifier:** Confirmed: the header needs toks.length > 1 (grid.ts:226), so a one-integer header is read as a bad grid line. Probe: a core-only ship and an empty ship both throw 'could not encode', and decoding 'grid:\n   0\n0  CA\n1  HA' errors. The streaming preview (design.ts:240) and gridOf are wrapped in try. Only the unguarded paths (app.ts:64, options.ts:94, evolve.ts:50, designText) throw, and those need a one-column start or seed ship. That is rare in practice, so I lowered this to low.

## [low] Hull 'under' a part drops the whole multi-cell hull piece, leaving holes or cutting parts off

- **Where:** `scripts/shipgen/core/partlist.ts:123` (core)
- **Problem:** When a new entry overlaps hull, every hull part under it is dropped whole. If a 1x1 part sits on one cell of a 2x2 (or 2x1) hull block, the other 3 cells disappear too, with only a warning.
- **Failure:** The validator reports 'unreachable' for a part the model joined correctly, and the model is told to fix a fault it didn't make.
- **Evidence:** Probe: 'CA 0,0 / HA -2,0 2x2 / PI^ -2,0' reads as [core@0,0, cannon_pip@-2,0] with the warning 'hull under "PI^ -2,0": dropped'. The cell -1,0 that joined the gun to the core is gone, so the gun is now disconnected.
- **Fix:** Only drop hull that lies wholly under the new part. Otherwise replace it with hull pieces for the uncovered cells (or report an overlap error naming both entries).
- **Verifier:** partlist.ts:121-125 drops every hull part that overlaps, whole. Probe 'CA 0,0 / HA -2,0 2x2 / PI^ -2,0' gives [core@0,0, cannon_pip@-2,0] with a 'hull under' warning. The 2x2 hull is gone, so the gun is disconnected.

## [low] Role 'thruster' counts gyros and strafers, so engine requirements can be met with no engines

- **Where:** `scripts/shipgen/core/roles.ts:54` (core)
- **Problem:** Brief requirements select by power role from partPower. The power core gives utility_gyro, utility_heavy_gyro and engine_burst_strafer ROLE_THRUSTER, even though they have no thrust (isEngine false). roles.json uses {role: thruster, min: N} to mean engines ('two engines at the back').
- **Failure:** A gunship with three gyros and zero engines passes the 'needs at least 3 thruster part(s)' check (enginesAft then scores 0, but the brief counts as met).
- **Evidence:** Probe classification by partPower: thruster role = engine_ion_drive...engine_fusion_torch, engine_burst_strafer, utility_gyro, utility_heavy_gyro. utility_gyro unlocks at level 6 and engine_burst_strafer at level 10, both inside the gunship/hauler bands (maxLevel 20) that require thruster min 3.
- **Fix:** Add a selector the game defines (e.g. an 'engine' role derived from isEngine, or role thruster plus a thrust>0 filter) and use it in roles.json for engine counts.
- **Verifier:** roles.ts matches() selects by partPower role. The probe shows utility_gyro, utility_heavy_gyro and engine_burst_strafer all match {role:'thruster'}. roles.json requires thruster min 2-6 in its roles, and sim.ts itself separates engines with isEngine, so the brief can be met with no main engines.

## [low] Power input built by copying a test helper rather than importing a game function

- **Where:** `scripts/shipgen/core/sim.ts:25` (core)
- **Problem:** shipEnergy re-implements common/src/ships/power/testData.ts blueprintInput: the `interval * max(satisfaction, minWeaponSatisfaction)` undo of the old flow, the core index and the joins. runEnergy also writes its own gun cadence loop (cooldown, then gunReady/spendShot). Both are rules copied from game code instead of taken from it. When P2 drops the satisfaction division from rebuild, this copy will double-correct the fire interval.
- **Failure:** Once rebuild stops dividing the interval by satisfaction, every gun's beat in shipgen is multiplied by satisfaction again. Fire % and the legend's 'uses E/s firing' figures then drift from the game without any test failing.
- **Evidence:** sim.ts:25 `interval: w.interval * Math.max(w.satisfaction, minSat)` duplicates testData.ts:64 verbatim. blueprintInput is not exported from power/index.ts.
- **Fix:** Export a non-test blueprint-to-EnergyLayoutInput function from the power core (and a gun-cadence helper, if the core gains one) and import it in sim.ts.
- **Verifier:** sim.ts:25 repeats testData.ts:64 (interval * max(satisfaction, minWeaponSatisfaction)), and sim.ts's own comment says it mirrors power/testData.ts blueprintInput. rebuild.ts:474 currently divides by satisfaction, so the copy works today. The drift is a future risk, and it runs against the derive-from-game-code rule, so low fits.

## Rejected

- /out/ serves any file under out/, including dotfiles and non-image files (security): The code does what the finding says: http.ts inside() has no extension or dotfile filter, and app.ts line 191 serves anything under paths.out. But nothing in the tool writes secrets into out/. Run output is events.jsonl (tokens and secrets are not in events), designs, metrics and renders. The exploit only works if the user copies .env into the gitignored output folder by hand. Traversal is blocked, and the Host check plus no CORS keep it limited to local callers. This is a hardening suggestion, not a reachable vulnerability.
- armourOutside score re-derives 'vital vs shell' from a hand-picked field list (fidelity): The concrete evidence is wrong. power_diode in models.json has oneWay:true and no facing field, so isShell does not count a Diode as shell. The parts that do have facing:true (mining laser, bore, siphon, tow beam, burst strafer) point outward, which the function's comment says is intended ('anything that points out'). What remains is only that a future field might be missed, and the code does not confirm any present misbehaviour.

## What the reviewers checked and found fine

### security

Checked and found fine:
- Bind: server.ts listens on HOST='127.0.0.1' only, including the port-retry loop.
- Host header check on every route blocks DNS rebinding. Cross-site POSTs (browsers always send Origin) and Origin 'null' are rejected.
- No CORS headers anywhere, so other origins cannot read GET responses or SSE.
- The UI loads no external resources.
- Path traversal: inside() decodes, rejects NUL and checks the resolved path against base+sep; probes with %2e%2e, ..%5c and leading-slash forms all returned null.
- /lab/ only serves .html/.js inside prototypes/energy-lab.
- /api/library/<id> is constrained by the regex ^(dev|enemy/)?[\w.-]+$ with no leading dot.
- watchFile goes through inside(). The double decode of the run= param is harmless because containment is still checked.
- Save: saveGenerated runs check(), which wraps the game's validateBlueprint, refuses invalid designs (422), builds the file name only from slug(role) plus a counter, and writes with flag 'wx'. blueprintFrom goes through parseBlueprint.
- /api/lab with a client-supplied `saved` skips the save and only reruns the exporter: no write.
- Render and timelapse file names come from slug(bp.name).
- startRun builds outDir from form.mode before it is validated. This is safe only because runOptions throws before mkdirSync; it would break if the code were reordered.
- Secrets: loop/secrets.ts reads LM_API_TOKEN and ANTHROPIC_API_KEY, and they are used only in the Authorization and x-api-key headers. /api/models rows carry no token; app.test asserts that.
- Upstream error messages echo up to 300 chars of the HTTP body. Anthropic, LM Studio and Ollama error bodies do not echo credentials. No URL or header is put into a message.
- events.jsonl (CLI and page) holds no token events and no credentials. The start event's options drop signal and seed.
- No secret strings in tracked files: the only matches are fake values in llm.test.ts. out/ is gitignored (scripts/shipgen/.gitignore) and game-v2/.env is gitignored.
- data/ships/blueprints/dev is tracked, so saved gen-*.json files will be committed if added. That is by design.
- LM Studio chat: llm.chat throws before any request when provider is lmstudio and lmsChat() is false. This covers the design, staged, evolve, compare and critic paths, plus critic-check.ts. run.ts and the page's known() also refuse 'off' models up front. The page toggle is read on every call. Listing calls only /api/v1/models (no load).
- Cloud: the CLI's defaultModel() excludes cloud models and 'off' models. Compare and critic require explicit names, and the CLI prints a CLOUD note. The page's critic defaults to none. The page Designer default is the gap reported above.
- SSE cleanup: both events() and watchStream clear their ping interval and listener or follower on req 'close'. A probe on Node v26.5.1 confirmed req 'close' fires on client disconnect, not early. Listeners are cleared in Runs.start's finally, and app.close aborts the active run.
- UI rendering: every model, LLM-derived string (names, reasons, errors, replies) and id goes through esc(), or textContent in pane.js.
- Tests: npx vitest run scripts/shipgen --maxWorkers=3 passed, 198 tests in 11 files.
- Temporary probe scripts in the scratchpad were deleted, and no servers or browsers were started.

### loop

I checked these and found them fine. Ollama and LM Studio request shapes are right: the Ollama `options` (num_predict, num_ctx, seed, temperature), `format` for the schema, and `think` sent only to models that report thinking; LM Studio `response_format` json_schema strict and `stream_options.include_usage`. The NDJSON and SSE parsers are fine, `lines()` handles CRLF and a final unterminated line, and usage counting is right for all three providers (Anthropic `message_delta.usage.output_tokens` is cumulative and is assigned, not added). No temperature is sent to Anthropic, so the stuck-model heat() has no effect there. That is harmless, but the temperature bump simply doesn't happen for Claude. LM Studio chat is refused before any request unless LMSTUDIO_CHAT=1 or the toggle is set, and run() refuses `off` models up front. defaultModel skips cloud and `off` models, so the CLI never picks Anthropic or :cloud by default. Secrets appear only in request headers. The CLI's start event drops `signal` and `seed`, and no event, error or log path includes the key (HTTP error bodies are the provider's own text). Timeouts: whole-request and idle timers are cleared in finally, the abort listener is removed, and an outer cancel maps to 'cancelled' while a timeout counts toward the 2-failure stop. The Session retry/fail counter resets on success. Runaway stops (row too wide, too many rows, part list running far off) are handled, and the reply returns as text plus a note. Cut-off JSON is read. Reply parsing per contract (grid-text, grid-json, parts, cross-reading) is tolerant and matches the tests. The 8192 budget is ample for local models' grids: even a 20x24 capital grid is about 1k tokens. The pressure comes only from hidden thinking (finding 1). Staged step acceptance (valid, nothing lost, step lacks nothing, everything powered) and the frame-hull merge look right. The review ships are exactly symmetric, so mirror mode loses nothing from them. Evolve children always run one-shot with their own Session, so temperature resets per child. Compare uses firstPassRound (on brief) for passes and rounds. The renderer is stopped on close only if this process started it, and server.ts closes it on exit. Tests: 198/198 pass in scripts/shipgen (3 workers), and `tsc -p scripts/shipgen/tsconfig.json` is clean. The one probe test file I added under scripts/shipgen was removed, and no process was left running.

### tests

Ran `npx vitest run scripts/shipgen` with at most 3 workers: 11 files, 198 tests, all passing in 3.8 s. Ran `npx tsc --noEmit -p scripts/shipgen/tsconfig.json`: clean. The tests left no files behind: the web tests use mkdtemp folders and remove them, the run tests' 'mem' outDir is only seen by a fake renderer, and data/ships/blueprints/dev is untouched. Probe scripts went in a scratchpad subfolder and were deleted. The probe servers were closed and no process I started is still running.

Checked and fine:
- **Tests don't depend on the real .env.** Every createLlm in the tests overrides anthropicKey and token, and LMSTUDIO_CHAT/LM_API_TOKEN are saved and restored around the env tests. The other suites use fakeLlm only, so a real key in game-v2/.env (which has both key names) can't change results. OLLAMA_URL in the environment would only redirect calls that the fake fetches match by suffix.
- **Secrets.** The key and token appear only in request headers. /api/models rows carry no secret. The start event's options strip the signal, and error messages hold only the provider's response body.
- **Network exposure.** The server listens on 127.0.0.1 with a Host allowlist (blocks DNS rebinding) and an Origin check on POST.
- **LM Studio.** Chat is gated in chat() before any request, and also in run() and runOptions(). Listing uses GET only.
- **Cloud models.** defaultModel excludes cloud and off models. Anthropic is listed only when a key is set, and marked cloud.
- **CRLF.** stripChatter removes \r for all three contracts, lines() strips \r for streams, and .env is split on /\r?\n/. A probe confirmed that a CRLF grid reply decodes as valid through the page path.
- **Paths with spaces or '#'.** urlOf encodes each segment, sendFile/inside decode once, then resolve and prefix-check (traversal tests pass). The lab exporter is spawned without a shell, and the renderer client is imported through pathToFileURL. inside() decodes the watch run id a second time, so a folder name with '%' is unreachable, but this is not exploitable.
- **Mirror clashes and part overlaps** are tested (core/mirror.test.ts).
- **Cancellation and timeouts.** withTimeouts and the abort, idle and total timeouts are tested. Session's runaway stop uses its own AbortSignal.any, so a runaway isn't reported as a cancel.
- **Page-server cleanup.** SSE listeners and ping timers are cleaned on client close and cleared when a run finishes. followJsonl opens and closes its fd on every read, so no handle leak. The gallery is capped at 40. The server's Ctrl+C path aborts the run and closes the renderer it started (but not on a second Ctrl+C, on TerminateProcess, or for the lab exporter child, which is killed only by its own 120 s timeout).
- **Staged render filenames** don't collide, because round numbers keep counting across steps and evolve and compare runs use per-lane tags.

The main risks are the double-start race (confirmed: two concurrent POSTs gave 200/200, two runs going, one shared outDir with two start events) and replies cut off at the token limit going unnoticed.

### fidelity

Checked and fine:
- Rules: check() calls the game's validateBlueprint(catalog, bp, tuning, null, {mounting}) with mounting on. That is the same call HangarUI makes, and the server's validate() differs only in ownership. So a design the tool calls valid passes the game's validation. Messages are re-labelled only.
- Shapes (shapes.ts) come from getVariant/polygons. Facing rules come from partNeedsFacing/partFacingRule/facingProblem through the validator. Mounting text comes from mountingWords, stats from describePart, mass from partMass, thrust-to-mass from rebuild's derived maxThrust, cost from econ recipes. No piece shape, part list or number is hard-coded. The only fn-id literals are 'core', 'hull' and 'armor' (skeleton, staged armour step, partlist hull-under-part), all real catalog ids.
- New parts flow through with no edits: power_conduit becomes role conduit (CD, Lv0), power_diode role diode (DI, Lv4), utility_gyro/heavy_gyro role thruster (GY/HG). The legend, categories and power report pick them up from the power core's one-part layouts. The legacy 'conduit' structure fn is correctly left out (legacy:true).
- roles.json: every fn (armor, cargo, point_defence_turret) and family (laser, pulse, missile, torpedo, tow, mining) exists, and every require/encourage has at least one match inside its band. Sizes fit the examples: Wren 26 cells 10x5, Kestrel 46 10x7, Heron 76 10x10, Mako 58 10x8, Monarch 228 16x19, all within size.cells and maxWidth/maxHeight. Wren, Mako and Monarch meet their briefs.
- Generation numbers agree with the live game's supply to eu rounding: Cell Reactor 34.9 vs 35.0. Live 'spare' is lower on ships with steady loads, as expected.
- sim.ts drives the power core the same way the core's own tick.test.ts Gun harness does: cooldown, then gunReady/spendShot, and beamStep for beams. The only gap is that a charge gun's timer keeps counting while not ready, and the core's own test harness has the same gap.
- npx vitest run scripts/shipgen (3 workers): 11 files, 198 tests passed. tsc -p scripts/shipgen/tsconfig.json is clean.
- Probes were throwaway tsx scripts in the scratchpad, now deleted. No servers, browsers or LLM calls were started.

Which energy system the checks reflect: the new touch-routed power core (common/src/ships/power). The live game still runs the pool/bank/wire system (energy.ts, circuits.ts, rebuild.ts, wires.ts autoWire). TRIAL.md, the prompts, the legend and the page do not say so.

### core

I ran the shipgen tests (198 pass, 3 workers) and probed the core with throwaway vite-node scripts. The scripts are deleted and nothing was left running.

Checked and fine:
- Grid round trip (blueprintToGrid -> gridToBlueprint) preserves the parts (partKey multiset) for all 88 bundled blueprints, bosses with bespoke pieces included.
- The exact-cover solver's reading-order pruning is sound, because anchors are top-left in reading order. The lenient capital-cell repair and the shape-mark retry passes also work.
- Shape classes come from the catalog's getVariant/polygons. The facing mark 'v' is kept out of the shape letters. mirrorShape mirrors cells and polygon consistently (x -> -x-1 for cells, -x for vertices).
- mirrorPart axis maths (x' = axis2 - x - 1) and coreAxis2 are correct, including for even-width (2x1) cores such as the Wren's.
- mirrorHalf: a centre-line part that isn't symmetric (e.g. a gun facing >) is an error. A right-drawn part whose mirror cells are free is mirrored, and an exact duplicate of a mirrored left part is counted and dropped. A left part whose mirror lands on a centre part is an error. E/W facings swap. The review ships equal mirrorHalf(halfOf(ship)) and have no asymmetric cells.
- briefCheck runs on the whole mirrored ship in design.ts, so mirrored counts are right and match the prompt's 'counts twice / once' wording. Size, width and length use placed cells. The copy-of-example detector reports the Wren as 100% of its own example.
- check() uses the game's validateBlueprint (mounting on), createShipState/rebuild for thrust/mass and the econ recipes for cost. Power runs on the power core's energyTick against a paired ideal layout.
- Sustained % (60 s run with a 10 s early snapshot, including the seconds == longSeconds edge), bottleneck thresholds and weights look right. Unknown weight keys are skipped and gunsOut null is excluded. Invalid designs keep 30% of their score.
- Scores read the catalog's own fields. isShell agrees with partPower roles for every legend entry; it uses raw fields, but they line up.
- Legend levels, materials and job licences come from econ constants. The core's legend numbers (240 E, 720 E/s) come from the power core.

Minor, not raised as findings:
- legendFor hard-codes the default rarity list instead of using econ RARITIES minus legendary.
- The symmetry score uses the best axis, while asymmetricCells and the asymmetry penalty use the core axis. A ship symmetric about another axis would score symmetry 1 but still lose points per cell.
- armourOutside counts the edges of interior holes as outside.
- sameness() ignores piece shape, so wedge t1 and t4 in the same cell count as the same part.
- mirrorLeft/mirrorGridLeft (grid.ts) keep centre parts without the symmetry check mirrorHalf does. They are only exported and not used by the loops.

