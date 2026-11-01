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
