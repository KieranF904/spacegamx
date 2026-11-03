# Netcode Lab: handoff for a separate session

This file is the briefing for a Claude session that works on the netcode lab on its own with Kieran. The main session
has gone back to the game. Read it first, then the documents it points to.

## What the lab is for

Kieran is deciding whether the game should move from its current networking (server snapshots, your own ship predicted)
to **server-paced deterministic lockstep**. The lab exists to answer that by feel and by numbers.

He has **not** committed to lockstep. It has to prove itself against the current system, which works and is paid for.
If it does, it would come into the game a piece at a time, not as a switch-over (see the dual-mode audit below). The
lab is where the design gets refined and tested first. Treat it as a research tool: measure, compare, and report
honestly, including where lockstep loses.

It is a small standalone 2D space game with a real Node server. It imports nothing from the game's `client/`,
`server/` or `common/`.

## Read these, in this order

1. [README.md](README.md): how to run it, the controls, every readout, and the file map.
2. [docs/design/netcode-lockstep.md](../../docs/design/netcode-lockstep.md): the design as built. It covers the wire
   format, measurements, decisions taken while building, and **open questions** (the work list).
3. [docs/audits/netcode-dual-mode-2026-11-03.md](../../docs/audits/netcode-dual-mode-2026-11-03.md): whether the game
   could run both styles side by side, and the staged path to lockstep "islands". This is why the lab matters for the
   game.
4. [docs/audits/network-weapons-lockstep-2026-11-03.md](../../docs/audits/network-weapons-lockstep-2026-11-03.md) and
   [docs/audits/network-fixes-impact-2026-11-03.md](../../docs/audits/network-fixes-impact-2026-11-03.md): the game's
   own network costs, before and after the fixes made on 2026-11-03. Use these for comparisons with the real game.

## Kieran's design principles

These came out of a long discussion with Kieran. Most are in the design doc, but the reasons are only here. When the
lab changes, keep to them, or bring him the case for changing one; don't quietly drift from them.

- **Server-paced.** The server ticks on its own clock and never waits for anyone. A lagging player affects only
  themselves. Their client buffers bundles and catches up by simulating faster, or gets snapshots if it falls too far
  behind. No one else freezes or slows down.
- **No fixed batching delay.** Inputs are stamped for the tick they will run on at the server: the client knows its
  tick offset, and adds a small margin so messages arrive in time. Nothing waits for a 20 Hz send window.
- **The server decides what each client is aware of.** Clients simulate only that, never the whole system. The server
  knows each client's set, so entities entering or leaving it are handled explicitly: a snapshot on entry, an exit
  record on leaving.
- **Interactions pull entities in.** Example: you are fighting near a freighter at the edge of your awareness, and the
  ship attacking it is just outside. The attacker is pulled in, because it affects something you hold. The lab does
  one hop of this.
- **Identity by slot, not by data.** Each client has a slot number for each entity it holds, given on entry. Entry and
  exit are stamped with ticks, and a freed slot waits out a quarantine before reuse. Slots are varints, so there is no
  256-entity limit. Kieran rejected hashing entity data to identify entities, because a mismatch then can't say which
  entity it was.
- **Detect desyncs with small, event-driven hashes, not scheduled ones.**
  - Clients send an 8-bit hash of each event they saw (8 bits is enough; anything wrong spreads to whatever it
    touches, and the next check catches it).
  - The server compares them with its own record. A wrong, missing or unexpected event gets a snapshot of the entities
    involved, and only those.
  - The 2-second background hash is a backstop.
- **Asteroids:** an override table for rocks that differ from the seed, and a broadcast when one is destroyed. That way
  a rock destroyed out of your sight is gone when it drifts in.
- **Corrections are cheap compared with what they replace.** Even frequent snapshots cost less than the current
  style's constant overhead.
- **No traffic that carries no information.** For example, your own input isn't echoed back (removed on 2026-11-03;
  see section 3 of the design doc).

How Kieran wants to work:
- **A question is a question.** Answer it, with numbers where you have them. Don't turn it into a plan or start
  building unless he asks.
- **He corrects assumptions quickly, so state yours plainly.** He is precise about how lockstep should work. If the lab
  does something differently from what he expects, explain exactly why. Several earlier "problems" were the lab's
  choices, not the design's.

## Recent state (2026-11-03)

- Live at https://space.brotherk3d.com/netlab/ (in-page styles at `/netlab/offline.html`). Last deployed from commit
  `7493f68`.
- `node test.mjs` passes. Determinism: 0 differing entity-ticks across 3 client copies, other than "unseen" hits from
  outside the set, which are corrected by design.
- **Last change:**
  - your own input is no longer echoed;
  - inputs are sent as changes (aim and distance as signed steps, sequence numbers implied by order);
  - aim-only changes go at most at 30 Hz;
  - cursor distance is rounded to 32 units.

  With the mouse moving and one other player, inputs went from 1.3 KB/s to 0.31 KB/s, and the total including headers
  from 10.0 to 5.5 KB/s. Tables are in the design doc under "Input changes".

## Open threads

Not started unless marked. Ask Kieran which he wants; several were only offered.

1. ~~"Lab" bandwidth row~~: done 2026-11-03. The page's own JSON (info panel twice a second, debug commands) is no
   longer metered, so it is gone from the panel and from msg/s.
2. **A strict lockstep display mode (offered).** With own prediction off, the screen still runs a few ticks past the
   confirmed tick over quiet stretches, assuming nothing changed. A late bundle then causes a small correction that is
   not a desync. A strict mode would never draw past the confirmed tick, plus an optional playout delay, to show pure
   lockstep's feel and its correction count.
3. **Forward inputs early.** Inputs are stamped for a future tick, but the server relays them only when that tick
   runs. Relaying on arrival would shorten how far other clients have to guess, and so shrink prediction corrections
   of other ships.
4. **Smooth prediction corrections.** The lab snaps; the game blends (`ShipReplicaSet`). Other ships' visible pops in
   the lab look worse than they would in the game.
5. **Option: draw other ships at the confirmed tick** and predict only your own: today's trade, for comparison.
6. **Bot inputs dominate download around fights** (~1.1 KB/s in the 8-bot probe; each AI brain's output goes out at
   15 Hz).
7. **Header overhead.** About 66 B per message is more than the payload. Options: coalesce ticks per message, or
   UDP/WebTransport (open question 2 in the design doc).
8. **Design doc open questions 1-9:**
   - one-hop "unseen" hits;
   - per-message cost;
   - Firefox and Safari determinism (connect them to the VPS lab and watch the counters);
   - 8-bit hash window;
   - the rare spurious rock report (~1 per 90 client-seconds; 2 appeared in the last probe run);
   - the margin policy under bursty jitter;
   - hash coverage.
9. **The lab server isn't on the VPS monitor** (`npm run monitor`, deploy/vps/monitor). Add it only if Kieran wants.

## How to work on it

- **Run locally:** `cd server && npm install && node server.js`, then open http://localhost:3120/. Or use the
  in-page server on the page, which needs no server.
- **Check:** `node test.mjs` (or `--server`). Run it after every change. It must pass, and there must be no new
  desyncs other than "unseen".
- **Measure the real link:** `node server/probe.js wss://space.brotherk3d.com/netlab/ws [secs] [added ms]`.
- **Deploy:** `bash prototypes/netcode-lab/deploy.sh`. Redeploying the lab is allowed whenever it helps Kieran test.
- **Keep the docs in step with the code:**
  - the design doc: wire format table, measurements, decisions, open questions;
  - the README: readouts and controls.
- **Commit** your own files only; other sessions have uncommitted work in the tree. End commit messages with the
  attribution line in use for this project.

## Hard rules

- **Don't touch the game.** No edits to `game-v2/client`, `server`, `common`, `data` or the site from this thread. The
  game is in a deploy freeze: never run `deploy/vps/deploy.sh`. Only the lab's own deploy is allowed.
- **The VPS is shared** (`root@brotherk3d.com`, key `~/.ssh/bk3d_deploy`).
  - Touch only the lab: `/opt/spacegame-netlab`, the `spacegame-netlab` unit, `/etc/nginx/snippets/spacegame-netlab.conf`.
  - Run `nginx -t` before any reload. No Docker.
  - Leave the game and the other sites alone.
- **Git:** never run `checkout`, `restore`, `stash`, `reset` or `clean`. The working tree holds a lot of uncommitted
  work from other sessions.
- **Processes:** kill only the processes you start, by PID. One headless browser at a time, always closed. Don't run
  tests alongside browser runs.
- **No model calls:** never send prompts to any model (Anthropic or local) unless Kieran asks.
