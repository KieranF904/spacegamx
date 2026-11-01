# Ship generator: first end-to-end trial (2026-11-01)

Headless CLI, local Ollama models only (no cloud, LM Studio not tried: no `LM_API_TOKEN`). Compare mode: 3 trials per
model and role, up to 5 rounds each, a trial stopping at its first valid design. Nothing was saved to the library.
Raw runs (events, renders, designs) are in `scripts/shipgen/out/trial/` (gitignored); `pre-fix/` holds the runs from
before the fixes below.

## Results

"Valid" = the game's validator accepts it. "On brief" = valid, every brief requirement met, every gun and engine
powered, and not a copy of the role's worked example. Mean score = mean of each trial's best score (0 if it read nothing).
Gen s/round = model time per reply.

| Role | Model | Reply format | 1st-round valid | Valid in 5 rounds | On brief | Rounds per valid | Gen s/round | Valid/min | Mean score | Commonest failures |
|---|---|---|---|---|---|---|---|---|---|---|
| gunship | gemma4:12b | JSON schema | 0/3 | 0/3 | 0/3 | - | 7.0 | 0 | 15.2 | gun front blocked (7/15 rounds), multi-cell parts drawn the wrong shape (HB, OR), no core |
| gunship | gemma4:12b | text | 0/3 | 0/3 | 0/3 | - | 8.0 | 0 | 0 | unreadable (11/15): `#` placeholders, empty grids; no core |
| gunship | gemma4:12b | text + "no empty canvas" line | 0/3 | 0/3 | 0/3 | - | 9.7 | 0 | 5.3 | multi-cell parts wrong shape (10/15), no core (5/15) |
| gunship | qwen2.5-coder:14b | JSON schema | 0/3 | 0/3 | 0/3 | - | 37.4 | 0 | 0 | every grid all `..` or a 4096-token row (15/15) |
| gunship | qwen2.5-coder:14b | text (both prompt versions) | 0/6 | 0/6 | 0/6 | - | 14 | 0 | 0 | every grid an empty 25x18 canvas of `..` (30/30) |
| gunship | qwen3-vl:8b | JSON schema | 0/1 | 0/1 | 0/1 | - | 118 | 0 | 0 | thinks all 12 288 tokens, writes nothing (5/5) |
| starter | gemma4:12b | JSON schema | 1/3 | 2/3 | 0/3 | 1.5 | 3.6 | 4.1 | 47.9 | parts not joined to the core (5/8); its valid ships leave a gun or both engines unpowered |
| starter | gemma4:12b | text | 0/3 | 1/3 | 0/3 | 4 | 5.4 | 0.7 | 41.8 | not joined to the core (12/15), gun mounted wrong (6/15) |
| starter | qwen2.5-coder:14b | JSON schema | 2/3 | 2/3 | 0/3 | 1 | 6.1 | 2.8 | 66.7 | both "valid" ships are the Wren, part for part |
| starter | qwen2.5-coder:14b | text | 1/3 | 2/3 | **2/3** | 3 | 2.3 | **4.6** | 65.9 | gun mounted wrong (5/11), multi-cell parts wrong shape |
| starter | qwen3-vl:8b | JSON schema | 0/1 | 0/1 | 0/1 | - | 123 | 0 | 0 | thinks all 12 288 tokens, writes nothing (5/5) |
| starter | gemma4:12b + critic qwen3-vl:8b | text, design mode | 0/1 | 0/1 | 0/1 | - | 4.2 | 0 | 23.3 | not joined to the core (5/5); the critic was never asked (it only scores valid ships) |

qwen3-vl:8b got 1 trial per role, not 3: every round is 2 minutes of thinking that never reaches an answer, and
Ollama's `think: false` has no effect on this thinking build.

### Critic check

I gave the qwen3-vl:8b critic four stills directly: the coder's tidy starter, gemma's hollow box gunship (guns facing
into armour), gemma's lopsided starter, and the evolve run's child. **It scored all four 8/10** with near-identical
reasons ("symmetrical, tidy hull..."). It does not tell good from bad yet, so its 10% weight only adds noise.

## Best stills (looked at)

- **qwen2.5-coder:14b**: `out/trial/text-starter/renders/qwen2.5-coder_14b-t1-r1.png`. A valid, on-brief starter,
  score 89.7: a domed nose, two Pips flanking the core, a Cell Reactor, a Battery and another Reactor in a row, two Ion
  Drives aft and swept hull wings. Every gun and engine is at 100%. It is clearly a Wren variant (17% of parts in the
  same places) and lopsided: the right wing is a cell longer because one row has extra tokens (symmetry 0.56). It is
  the only ship in the trial I'd call usable.
- **gemma4:12b**: `out/trial/compare-starter/renders/gemma4_12b-t3-r2.png`. Valid, score 76.3, but not usable. It is a
  4x5 "H": two Pips on hull pillars, the core and battery between them, and engines in a staggered column. One Pip has
  no power and it is asymmetric. Its gunship best (`out/trial/compare-gunship/renders/gemma4_12b-t2-r5.png`, invalid)
  is a hollow armour box with six guns facing into its own nose plating.
- **qwen3-vl:8b**: no design to render.

## Verdict

**Not yet, beyond the smallest ships.** For the starter (about 20 parts on a 5x7 grid), qwen2.5-coder:14b with the text
reply format gets an original, valid, fully powered ship in 2 of 3 tries, at about 4.6 per minute. The Wren-derived
starter is plain but sound. For the gunship (35-90 cells, 12 kinds of part), **nothing came out valid in 95 rounds
across three models and two reply formats.** The models can't hold a 2D layout in their head:
- they draw an empty canvas, or pad rows to a made-up width so the columns drift;
- they write multi-cell parts as a horizontal run (`HB hb hb hb` for a 2x2);
- they leave out the core or put the guns behind armour;
- and they resend the same broken grid round after round even when the feedback names the cells.

Feedback helps with join-to-core and facing errors on small ships. It does not fix layout.

Reply format matters a lot, and differently per model. JSON schema replies were worse for qwen2.5-coder (empty or
runaway grids, and copying the example) and slightly better for gemma. `--contract auto` picks JSON for every
Ollama model, so it is the wrong default for the coder.

## Fixed during the trial (small, targeted)

1. **Runaway replies.** gemma wrote rows until the 4096-token cap (around 20 s each). The reply was then truncated
   JSON, and the feedback said "no grid found". The loop now stops a reply once it is about twice the brief's height or
   width (`loop/design.ts`), reads cut-off JSON anyway (`loop/reply.ts`), and tells the model why it was stopped.
2. **Thinking models.** qwen3-vl used the whole 4096-token budget thinking, and the feedback said "no grid found".
   Models that report thinking now get 12 288 tokens, and the feedback says "you spent the whole reply thinking".
   It didn't rescue qwen3-vl.
3. **Feedback for a multi-cell part drawn the wrong shape** now shows the part's real footprint
   (`it is 2x2: "HB hb" over "hb hb"`) (`core/grid.ts`). Row-width warnings now come with read errors, not only after a
   successful read (`core/prompt.ts`).
4. **Repeated grids.** The model is told "You sent this same grid before". This was not enough to unstick gemma.
5. **Copying the worked example.** It now counts as an unmet brief item ("your own design: N% of its parts are the
   worked example's", at 85% or more). `roles.ts` has `sameness()` and `exampleShip()`. Before this, the coder's two
   "valid" starters were the Wren itself.
6. **Unpowered guns or engines** now count as an unmet brief item. The game accepts such a ship, and gemma's "valid"
   starters had dead Pips or engines.
7. **Compare counts only on-brief ships** (`firstPassRound`) and keeps asking after a valid copy or an off-brief ship.
8. **Smaller fixes:**
   - "Power: everything powered" no longer shows for a ship with nothing to power.
   - The heading "Read with guesses" is now "How your reply was read".
   - The format now asks for "no empty canvas".
   - `--mode compare` takes a single model.

All 167 shipgen tests pass, including new ones for the runaway stops, cut-off JSON, repeat notice and copy check.
`tsc -p scripts/shipgen/tsconfig.json` is clean.

## Next (most value first)

1. **Have the model place parts instead of drawing cells.** A list like `CA at 0,0; PI^ at -1,-2; HB at 1,0 (2x2)`,
   which the tool turns into a grid. The model never has to align columns or draw multi-cell parts, and those were most
   failures. Show it back as a grid for context only.
2. **Build in stages from a skeleton.** Start from a valid core-and-frame (or a mirrored half the tool completes, which
   `mirrorGridLeft` already does). Ask for one system at a time: power, guns, engines, armour, each checked. Small
   models handle "add 4 guns to this valid ship" far better than a whole gunship. Evolve from the review ships already
   does this and gave a valid child at once.
3. **Pick the reply format and settings per model by measuring them,** and replace the critic. Store each model's best
   format (the coder: text; gemma: JSON) and temperature. Raise the temperature on a repeated grid. Replace the
   always-8 critic with a calibrated prompt or pairwise "which is better" judging, or drop it.

# Trial 2: mirror mode, part lists, staged build (2026-11-01, evening)

Same machine, Ollama only (gemma4:12b, qwen2.5-coder:14b; no cloud models, nothing sent to LM Studio). Compare mode,
2 trials per cell, mirror mode ON throughout. Raw runs: `scripts/shipgen/out/trial2/` (gitignored). Small samples:
2 trials a cell is enough to see big effects, not to rank close ones.

## What changed before it

- **Mirror mode (default on).** The model writes the left half and the parts on the centre line (the line down the
  middle of the core); `core/mirror.ts` adds the right half (`mirrorHalf`: E/W facings swap, handed shapes swap via
  `mirrorShape`). A part across the line must be its own mirror image. Forgiving: a right-half part that is already
  the mirror is ignored, one with free mirror cells is mirrored to the left too, one that clashes is dropped (the left
  half wins); every case is a note in the feedback. `--no-mirror` / the page's checkbox turns it off; then the
  feedback lists every cell without a twin (`asymmetricCells`: "row 2: col -4 is HA, but its mirror col 5 is empty"),
  symmetry weighs 0.6 and each such cell costs 4 points (up to 40).
- **Part-list contract** (`--contract parts`, `core/partlist.ts`): `CODE col,row [WxH]`, placed by the top-left
  cell; overlaps are refused by name (`"BT -1,0" overlaps "CR -1,0": both cover col -1 row 0`); hull listed under a
  part is dropped with a note. Contracts are a registry (`loop/contracts.ts`: grid-text, grid-json, parts; the old
  names text/json still work). Feedback now always shows the ship as built, as a grid (whole, after mirroring).
- **Staged build** (`--build staged`, `loop/staged.ts`): a valid symmetric skeleton (core on column 0, a hull spine
  and a cross beam sized to the brief), then power, weapons, engines, armour, one step each. A step is accepted only
  if the ship stays valid, keeps every earlier part, has what the step asks for and every gun and engine is powered;
  otherwise the check goes back and the step is retried (`--rounds` = tries per step). Each ask names free cells that
  touch power (with a clear lane for guns and engines). With `--contract auto` a staged build uses the part list:
  each step's reply is only the new parts.
- **Per-model contract table** (`loop/modelPrefs.ts`), used by `--contract auto` and shown on the page.
- **Shapes.** Every one-shot design is now asked for a silhouette from `roles.json` (`shapes`, one per trial),
  because with the example shown as a half grid qwen copied the Wren 10 times out of 10 in a first try.
- A model resending the same design gets +0.3 temperature (up to 1.2). A part list running far outside the brief
  ("HA -1,-1 ... HA -86,-1") is stopped. Critic weight 0 by default (recorded, not scored). LM Studio is list-only
  unless `LMSTUDIO_CHAT=1` or the page toggle; a test checks no chat request goes to it by default.

## Reply format per model (starter, one-shot, mirror on, 2 trials x 5 rounds)

| Model | grid-text | grid-json | parts |
|---|---|---|---|
| qwen2.5-coder:14b | 0/2 valid (resends one broken grid) | **2/2 valid, 1 on brief** | 0/2 (hull listed under parts, guns blocked) |
| gemma4:12b | **2/2 valid**, 0 on brief (a gun on the centre line counts once) | 0/2 | 1/2 valid |

This is the opposite of trial 1 for both models (there: coder best with text, gemma with JSON). With 2-3 trials a
cell the format effect is within the noise; the table now says qwen: grid-json, gemma: grid-text, and staged builds
always use parts. The part list did not help one-shot designs (the models still stack parts and put guns behind
hull); it did help staged steps (below).

## Results (mirror on, 2 trials each, contract auto)

"Valid" for staged runs counts only ships that got power and at least one more system in (the skeleton alone is
always valid). On brief = valid, every requirement met, every gun and engine powered, not the worked example.
One-shot: up to 5 rounds. Staged: 4 steps, up to 2 tries each.

| Role | Model | Build | Contract | Valid | On brief | Replies | Gen s/reply | Minutes | On brief / min | Best score | Commonest failures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| starter | qwen2.5-coder:14b | one-shot | grid-json | 1/2 | 0/2 | 5/5 | 2.8 | 0.47 | 0 | 95.2 (a copy of the Wren) | copied the example, cells nobody owns |
| starter | gemma4:12b | one-shot | grid-text | 1/2 | 0/2 | 5/5 | 4.1 | 0.68 | 0 | 87.9 (one engine) | two cores, empty grid |
| starter | qwen2.5-coder:14b | staged | parts | **2/2** | **2/2** | 5/5 | 1.0 | 0.18 | **11.2** | 88.7 | a part on a part placed before |
| starter | gemma4:12b | staged | parts | 2/2 | 0/2 | 5/6 | 2.7 | 0.51 | 0 | 79.2 | guns facing into hull: the weapons step fails |
| gunship | qwen2.5-coder:14b | one-shot | grid-json | 0/2 | 0/2 | 5/5 | 15.1 | 2.52 | 0 | - | every grid empty (10/10) |
| gunship | gemma4:12b | one-shot | grid-text | 0/2 | 0/2 | 5/5 | 2.2 | 0.38 | 0 | - | cells nobody owns, two cores |
| gunship | qwen2.5-coder:14b | staged | parts | 0/2 | 0/2 | 7/8 | 1.4 | 0.38 | 0 | 38 (power and armour only) | guns and engines facing into the frame |
| gunship | gemma4:12b | staged | parts | 0/2 | 0/2 | 6/7 | 1.3 | 0.30 | 0 | 22.6 | turrets with no facing, or facing into parts |

Overall: one-shot 2/8 valid, 0/8 on brief; staged 4/8 with real systems in, 2/8 on brief (both qwen starters).
Valid per minute (any valid ship): about 2 a minute for one-shot starters, 0 for gunships.

A first staged run used each model's one-shot contract (the whole half grid redrawn every step): 0/8 on brief; the
models redrew the half with new rows below it, unattached, or added a second core. That is why staged builds now ask
for new parts only. One more fix between the staged runs: the power step also lists the ring of cells one further
out (the gunship needs 2 generators and 2 stores and the core has one free side cell on the left).

## Stills (native renderer), judged

- **Best staged starter** (qwen2.5-coder:14b):
  `out/trial2/main/starter-staged_parts2-qwen2_5-coder_14b/renders/qwen2.5-coder_14b-t1-r3.png`. Valid, on brief,
  score 88.7, exactly symmetric. A cross: four Pips in a stepped row at the front, batteries either side of the core,
  a reactor under it and three Ion Drives at the back, with flat hull arms (the skeleton's cross beam) sticking out
  at the sides. Functional and tidy but blocky; the arms look like left-over scaffolding and the armour step never
  landed, so it has no nose or wing shape. The other qwen trial built the same kind of ship. Gemma's
  (`.../starter-staged_parts2-gemma4_12b/renders/gemma4_12b-t1-r3.png`) is the same cross with one gun on the centre
  line and two beside it.
- **Best one-shot starter** (qwen2.5-coder:14b, grid-json):
  `out/trial2/contract-starter-grid-json-qwen2_5-coder_14b/renders/qwen2.5-coder_14b-t2-r1.png`. On brief, score
  94.8: a Wren with longer swept wings and wedge tips. Symmetric, and the best-looking ship of the trial, but clearly
  Wren-derived.
- **Gemma one-shot starter**: `out/trial2/main/starter-oneshot-gemma4_12b/renders/gemma4_12b-t2-r2.png`. Symmetric
  but a squat U-shaped box with one engine: off brief and not good-looking.
- **Best staged gunship** (qwen):
  `out/trial2/main/gunship-staged_parts2-qwen2_5-coder_14b/renders/qwen2.5-coder_14b-t2-r8.png`. Not usable: power
  round the core, then two big armour slabs (the armour step accepts any valid armour), no guns, no engines.

Symmetry is solved: no ship made in mirror mode has a lopsided wing. Looks are now limited by the models' shapes
(and, in staged ships, by the skeleton's cross beam showing through).

## Pairwise critic (qwen3-vl:8b)

`critic-check.ts` showed it 20 pairs of valid stills (scores 10+ points apart), each pair both ways round (5-18 s a
pair). It agreed with the higher score 11 times, disagreed 2 times, and 7 times picked whichever image came first
(or second) both ways round. It agrees when one ship plainly lacks guns or engines, which the score already knows; on
closer pairs it answers by position, and its reasons repeat the prompt's words. Not informative enough: the critic
stays optional at weight 0, and pairwise judging is an experiment script only.

## Verdict and next

- **Mirror mode**: on by default; it removes the lopsided-wing problem and costs nothing.
- **Staged + part list** is the first setup that makes on-brief ships reliably, but only for the starter and only
  with qwen2.5-coder (2/2, about 11 a minute). For the gunship both models fail the weapons and engines steps: they
  place guns and engines facing into the frame or other parts. Next: offer exact legal cells for a gun or engine
  (free, touching power, the faced cell free, mounting met) and have the model pick from that list; make the armour
  step require the earlier steps to have landed; give the skeleton a nose and drop the cross beam once wings exist.
- **One-shot** is still poor for anything but a starter, and the starter still copies the worked example in some
  trials even when asked for another shape.

## Trial 3: Claude Haiku 5.5 (2026-11-01, via the Anthropic API; `--model anthropic/claude-haiku-5-5`)

The key is `ANTHROPIC_API_KEY` in game-v2/.env. Claude models take no temperature setting and no JSON schema (plain text replies). Gunship role, mirror on, 1 attempt each:

| Build | Rounds | Valid | Output tokens | Time | Score | Brief |
|---|---|---|---|---|---|---|
| Staged (parts) | 4 (one per step, no retries) | yes, from step 1 | 4,030 | 22 s | 86.8 | one cell short of the size range (34 of 35-90) |
| One-shot (grid-text) | 3 (round 1 had no readable grid) | yes, round 3 | 9,669 | 47 s | 96.8 | met |

The local models made no valid gunship in any trial. Haiku's staged ship is a symmetric cross with four Pips, two Rattlers on the flanks and four Ion Drives; its one-shot ship is a blocky "M" with four Pips and four engines. Renders: out/haiku/gunship-staged/renders/r4.png, out/haiku/gunship-oneshot/renders/r3.png.

Evolve, Haiku, seed Kestrel (44 parts), role gunship, 1 generation, 3 children, mirror on: 3/3 valid on round 1 (scores 94.6, 95.2, 95.3 against the seed's 96.8), 22-24 s each, 4.6-5.2k output tokens. Two earlier attempts failed for settings reasons, both fixed: the default role is starter (its brief asked to shrink the ship to 14-40 cells), and the loop's reply budget of 4,096 tokens cut every mid-size grid off before "end" (now 8,192). Renders: out/haiku/evolve-kestrel/renders/g1#1-r1.png, g1#2-r1.png, g1#3-r1.png. The children are new symmetric designs in the Kestrel's role more than edits of it: they drop its Overclock/Capacitor/Diode layout for Cell Reactors and Batteries.
