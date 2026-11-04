# Optimisation before and after (2026-11-03 to 2026-11-04)

Two days of network and rendering work, measured from where it started to where it is now. Before is **56389a3**
(protocol 24): the parent of 248d482, the first network fix. It is also the tree the 11-03 network-fixes audit used as
its baseline. After is **235dc46** (protocol 35), the committed HEAD, with every capability the dev server turns on at
that commit (caps 255: HITS, SELF_HITS, PACKED, COALESCE, OWN_SHOTS, ROUGH, OWN_SIM, INPUTS). Both were checked out
as git worktrees and run with the **same probe and the same scenarios** (see Method). Network figures are measured.
The client frame figures are the ones recorded in the rendering audits; no browser was run for this report.

Raw numbers: `optimisation-before-after-2026-11-04.json`.

## Summary

- **Download in a fight is down 51-68%** on the deflated wire, the figure closest to what a player pays. The shooter in
  a heavy fight (Hammerhead, 12 Rattlers + 6 Pips) went from 3,338 to 1,247 B/s (-63%). Debris went from 5,800 to
  1,858 (-68%), Gale from 3,023 to 1,146 (-62%) and 2 Pips from 1,733 to 842 (-51%).
- **The payload itself is down 77-92% in shell fights**: Hammerhead 5,021 → 595 B/s, Gale 5,974 → 490, debris
  8,442 → 1,261. What is left on the wire is mostly headers.
- **Half as many messages.** A pilot in a fight receives about 10 WebSocket messages a second, down from 20. An idle
  pilot receives 7.9, down from 12.5.
- **Upload while fighting is down 32%** (4,270 → 2,913 B/s). Holding only the keys it is down 76% (4,378 → 1,063).
  Docked, nothing is sent (2,614 → 0). The server still flies exactly what the client predicted: 1,200 of 1,200 ticks,
  before and after.
- **Busy system:** with 20 pilots fighting heavy guns near each other, each pilot downloads about 11.1 KB/s, down from
  30.0 KB/s (-63%). The server sends about 221 KB/s for that crowd, down from 600 KB/s. This is a model built from the
  measured runs (see below).
- **Pilots elsewhere in the system** (60 km away) pay 54-71% less for other people's fights.
- **The price is server CPU**: +6 to +20% per tick in most scenarios (for example 0.38 → 0.40 ms in the heavy fight
  and 0.27 → 0.32 ms with 2 Pips), from the hit ledger, the packed encoder and the own-ship checks, with three capable
  clients. It is still under 0.61 ms of a 16.7 ms tick.
- **Rendering:** a heavy weapons fight renders in 2.5 ms (median, render + GPU), down from 3.6-4.2 ms. The fight's own
  cost over idle fell from about 2 ms to about 0.6 ms. Smaller passes (siege marks, weapon ring, nav markers, floating
  texts) each took 0.01-0.05 ms off.

## Download, per area

Columns: payload (decoded bytes), deflated (through the server's permessage-deflate), WebSocket messages a second,
wire = payload + 66 B × messages/s, deflated wire = deflated + 66 × messages/s. The last column is HEAD with every
client on the base protocol (caps 0). It shows how much came from the fixes every client gets (248d482, protocol 26)
and how much from the capability work.

### The shooter (A)

| scenario | payload B/s | change | deflated B/s | change | WS msgs/s | wire B/s | change | deflated wire B/s | change | HEAD caps 0: deflated wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Idle (parked, nothing near) | 302 → **145** | -52% | 300 → 145 | -52% | 12.5 → 7.85 | 1,127 → 663 | -41% | 1,125 → **663** | -41% | 1,103 |
| Cruising beside a freighter | 871 → **163** | -81% | 867 → 163 | -81% | 16.3 → 8.05 | 1,946 → 695 | -64% | 1,942 → **695** | -64% | 1,211 |
| 2 Pips on a freighter | 1,236 → **234** | -81% | 621 → 234 | -62% | 16.9 → 9.2 | 2,348 → 841 | -64% | 1,733 → **842** | -51% | 1,945 |
| Hammerhead (12 Rattlers + 6 Pips) | 5,021 → **595** | -88% | 2,045 → 590 | -71% | 19.6 → 9.95 | 6,315 → 1,251 | -80% | 3,338 → **1,247** | -63% | 3,001 |
| Gale (2 Sparks + 2 Chainsaws) | 5,974 → **490** | -92% | 1,703 → 486 | -71% | 20 → 10 | 7,294 → 1,150 | -84% | 3,023 → **1,146** | -62% | 2,720 |
| Pirates (Corsair vs 5-7) | 1,268 → **706** | -44% | 1,091 → 703 | -36% | 20 → 10 | 2,588 → 1,366 | -47% | 2,411 → **1,363** | -43% | 2,419 |
| Scrap Mother boss (Hammerhead) | 5,372 → **2,056** | -62% | 3,511 → 1,877 | -47% | 21.2 → 13.8 | 6,767 → 2,964 | -56% | 4,907 → **2,784** | -43% | 4,270 |
| Debris (4 freighters breaking up) | 8,442 → **1,261** | -85% | 4,480 → 1,202 | -73% | 20 → 9.95 | 9,762 → 1,918 | -80% | 5,800 → **1,858** | -68% | 3,742 |
| Beam (Heron on a freighter) | 1,317 → **307** | -77% | 967 → 280 | -71% | 17.9 → 9 | 2,495 → 901 | -64% | 2,145 → **874** | -59% | 1,619 |
| Mining (Prospector on a rock) | 276 → **129** | -53% | 275 → 129 | -53% | 10.9 → 7.05 | 992 → 594 | -40% | 991 → **594** | -40% | 987 |


### An observer near the fight (B), per observer

| scenario | payload B/s | change | deflated B/s | change | WS msgs/s | wire B/s | change | deflated wire B/s | change | HEAD caps 0: deflated wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Idle (parked, nothing near) | 324 → **141** | -56% | 320 → 141 | -56% | 12.4 → 7.8 | 1,142 → 656 | -43% | 1,138 → **656** | -42% | 1,109 |
| Cruising beside a freighter | 895 → **162** | -82% | 889 → 162 | -82% | 16.1 → 8 | 1,954 → 690 | -65% | 1,949 → **690** | -65% | 1,231 |
| 2 Pips on a freighter | 1,177 → **238** | -80% | 558 → 238 | -57% | 16.9 → 9.2 | 2,289 → 845 | -63% | 1,670 → **846** | -49% | 1,885 |
| Hammerhead (12 Rattlers + 6 Pips) | 4,519 → **617** | -86% | 1,612 → 608 | -62% | 19.4 → 9.9 | 5,800 → 1,271 | -78% | 2,893 → **1,262** | -56% | 2,621 |
| Gale (2 Sparks + 2 Chainsaws) | 5,556 → **495** | -91% | 1,435 → 496 | -65% | 20 → 10 | 6,876 → 1,155 | -83% | 2,755 → **1,156** | -58% | 2,471 |
| Pirates (Corsair vs 5-7) | 1,305 → **768** | -41% | 1,133 → 745 | -34% | 20 → 10 | 2,625 → 1,428 | -46% | 2,453 → **1,405** | -43% | 2,475 |
| Scrap Mother boss (Hammerhead) | 4,320 → **2,103** | -51% | 2,698 → 1,933 | -28% | 15 → 14.6 | 5,307 → 3,067 | -42% | 3,685 → **2,897** | -21% | 4,220 |
| Debris (4 freighters breaking up) | 8,077 → **1,317** | -84% | 4,124 → 1,249 | -70% | 20 → 9.95 | 9,397 → 1,974 | -79% | 5,444 → **1,906** | -65% | 3,323 |
| Beam (Heron on a freighter) | 1,227 → **244** | -80% | 965 → 245 | -75% | 17.4 → 8.75 | 2,375 → 822 | -65% | 2,114 → **822** | -61% | 1,550 |
| Mining (Prospector on a rock) | 268 → **125** | -53% | 267 → 125 | -53% | 10.8 → 6.95 | 978 → 584 | -40% | 977 → **584** | -40% | 972 |


### A pilot elsewhere in the system (C, 60 km away)

| scenario | payload B/s | change | deflated B/s | change | WS msgs/s | wire B/s | change | deflated wire B/s | change | HEAD caps 0: deflated wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Idle (parked, nothing near) | 186 → **93** | -50% | 184 → 92 | -50% | 7.5 → 5.5 | 681 → 456 | -33% | 679 → **455** | -33% | 676 |
| Cruising beside a freighter | 765 → **234** | -69% | 763 → 234 | -69% | 12.5 → 6.6 | 1,586 → 669 | -58% | 1,585 → **669** | -58% | 1,322 |
| 2 Pips on a freighter | 583 → **110** | -81% | 483 → 110 | -77% | 11.3 → 5.75 | 1,326 → 489 | -63% | 1,225 → **489** | -60% | 738 |
| Hammerhead (12 Rattlers + 6 Pips) | 2,192 → **183** | -92% | 968 → 182 | -81% | 17.7 → 6.7 | 3,360 → 625 | -81% | 2,136 → **625** | -71% | 1,140 |
| Gale (2 Sparks + 2 Chainsaws) | 3,249 → **228** | -93% | 776 → 228 | -71% | 18.4 → 7.55 | 4,464 → 727 | -84% | 1,991 → **726** | -64% | 1,318 |
| Pirates (Corsair vs 5-7) | 216 → **100** | -54% | 211 → 100 | -53% | 9 → 6.3 | 810 → 516 | -36% | 805 → **516** | -36% | 732 |
| Scrap Mother boss (Hammerhead) | 1,299 → **318** | -76% | 850 → 318 | -63% | 17.2 → 9 | 2,434 → 912 | -63% | 1,985 → **912** | -54% | 1,567 |
| Debris (4 freighters breaking up) | 2,418 → **258** | -89% | 1,172 → 258 | -78% | 19.1 → 7 | 3,679 → 720 | -80% | 2,433 → **720** | -70% | 1,373 |
| Beam (Heron on a freighter) | 765 → **234** | -69% | 764 → 234 | -69% | 12.5 → 6.6 | 1,590 → 669 | -58% | 1,589 → **669** | -58% | 1,322 |
| Mining (Prospector on a rock) | 39 → **26** | -33% | 38 → 26 | -32% | 0.65 → 0.65 | 82 → 69 | -16% | 81 → **69** | -15% | 77 |


Reading it:
- **Shell fights gained the most** (Hammerhead, Gale, Pips, debris). In those fights the gains came from confirmed and
  client-detected hits, exact own shells and bit-packed frames. The plain-slug, damage-sum and debris fixes of 11-03
  came before them.
- **Idle and cruising**: payload halved (packing), and messages fell from 12.5-16 to about 8 a second (coalescing).
  Here the headers are now three quarters of the wire.
- **Pirates and the boss gained least** (-43%): most of their bytes are AI ships' control rows and keyframes, and the
  boss is still keyframed often. The boss decision-inputs work in progress targets exactly that.
- **Mining** carries almost no traffic of its own in either tree. The beam ran, but the rock's HP didn't move in the
  probe (see Caveats). Its figures are idle plus a Prospector.
- **HEAD with caps 0 is not much better than before** outside the fights the 11-03 fixes targeted (idle 1,125 → 1,103,
  pirates 2,411 → 2,419). Most of the saving needs the capabilities. That is fine on the dev server. In production they
  are off until the deploy freeze ends.

## Upload

What the pilot sends, through the client's real input path (`inputSend.ts tickInput`), with a scripted mouse and keys,
20 s per scenario (`scripts/net/inputProbe.ts`; a copy with its HEAD-only imports made optional ran on the baseline).
Before = the baseline layout and rules (11 B per input, sent on any change). After = compact inputs and their send
rules. The last column is what this pilot's control rows cost one nearby observer: base format before, packed after.

| scenario | inputs/s | change | payload B/s | wire B/s | change | its control rows to one observer B/s (base → packed) | server flew the prediction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle | 0 → 0 | 0% | 0 → 0 | 0 → **0** | 0% | 0 → 0 | 1200/1200 → 1200/1200 |
| keys | 56.9 → 15.3 | -73% | 625 → 56.3 | 4,378 → **1,063** | -76% | 177.3 → 59 | 1200/1200 → 1200/1200 |
| steer | 54.9 → 29.6 | -46% | 604 → 91.5 | 4,227 → **2,045** | -52% | 160.9 → 82.5 | 1200/1200 → 1200/1200 |
| fight | 55.5 → 42.4 | -24% | 610 → 115 | 4,270 → **2,913** | -32% | 159.8 → 93.2 | 1200/1200 → 1200/1200 |
| docked | 34 → 0 | -100% | 374 → 0 | 2,614 → **0** | -100% | 0 → 0 | 0/0 → 0/0 |

The baseline figures are identical to the input-compaction audit's "before" (9aaa1dc): nothing changed how inputs were
sent between the two. **Riders** (main probe, shooter, in the parked fights the probe flies): debris acks, hit reports
and own-state checks now ride inputs. In those fights they add 4.9-7.1 messages a second up (350-570 B/s of wire)
where there were none. The input probe above does not include them. They are the cost of the client working out its
own hits and its own ship.

| scenario | msgs/s before → after | payload B/s | wire B/s | acks/s | hit reports/s | own checks/s |
| --- | --- | --- | --- | --- | --- | --- |
| Idle (parked, nothing near) | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Cruising beside a freighter | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 2 Pips on a freighter | 0 → 4.9 | 0 → 31 | 0 → 354 | 0 → 0 | 0 → 2.15 | 0 → 3.25 |
| Hammerhead (12 Rattlers + 6 Pips) | 1.45 → 7.1 | 16 → 102 | 112 → 571 | 0 → 0.1 | 0 → 3.55 | 0 → 4.3 |
| Gale (2 Sparks + 2 Chainsaws) | 0 → 6.95 | 0 → 45 | 0 → 504 | 0 → 0 | 0 → 4 | 0 → 4.05 |
| Pirates (Corsair vs 5-7) | 60 → 60 | 660 → 678 | 4620 → 4638 | 0 → 0 | 0 → 0.2 | 0 → 5.65 |
| Scrap Mother boss (Hammerhead) | 55.9 → 58.05 | 615 → 684 | 4304 → 4515 | 0 → 0 | 0 → 2.9 | 0 → 12.25 |
| Debris (4 freighters breaking up) | 14.4 → 18.9 | 158 → 244 | 1109 → 1491 | 0 → 2.4 | 0 → 3.9 | 0 → 5 |
| Beam (Heron on a freighter) | 2.1 → 5.35 | 23 → 69 | 162 → 422 | 0 → 0 | 0 → 0 | 0 → 3.4 |
| Mining (Prospector on a rock) | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

## Server tick

`GameServer.step` per tick, mean / p50 / p95 ms, with three clients (all capable after). Single runs on one desktop
machine; a few hundredths of a ms is noise.

| scenario | stepMs mean | change | p50 | p95 |
| --- | --- | --- | --- | --- |
| Idle (parked, nothing near) | 0.248 → 0.272 | +10% | 0.208 → 0.229 | 0.495 → 0.57 |
| Cruising beside a freighter | 0.259 → 0.31 | +20% | 0.218 → 0.255 | 0.508 → 0.654 |
| 2 Pips on a freighter | 0.27 → 0.315 | +17% | 0.232 → 0.27 | 0.543 → 0.658 |
| Hammerhead (12 Rattlers + 6 Pips) | 0.38 → 0.401 | +6% | 0.298 → 0.336 | 0.831 → 0.894 |
| Gale (2 Sparks + 2 Chainsaws) | 0.341 → 0.403 | +18% | 0.28 → 0.338 | 0.681 → 0.841 |
| Pirates (Corsair vs 5-7) | 0.329 → 0.373 | +13% | 0.272 → 0.301 | 0.692 → 0.79 |
| Scrap Mother boss (Hammerhead) | 0.497 → 0.471 | -5% | 0.343 → 0.375 | 1.257 → 1.025 |
| Debris (4 freighters breaking up) | 0.509 → 0.602 | +18% | 0.436 → 0.498 | 1.009 → 1.224 |
| Beam (Heron on a freighter) | 0.337 → 0.342 | +1% | 0.265 → 0.279 | 0.709 → 0.713 |
| Mining (Prospector on a rock) | 0.22 → 0.201 | -9% | 0.164 → 0.176 | 0.387 → 0.431 |

## Client frame (recorded, not re-run)

From docs/audits/weapon-fx-audit-2026-11-04.md (16 guns in a ring, about 120 shells a second, 1280×800, headless
Chrome on the real GPU, three runs each) and docs/audits/client-perf-2026-11-04.md (in-page A/B pairs, 1440×900).

| what | before | after | change |
|---|---|---|---|
| Heavy fight, render + GPU, median | 3.6 / 4.2 / 3.6 ms | 2.5 / 2.5 / 2.5 ms | -31 to -40% |
| Heavy fight, render + GPU, mean | 4.2 / 6.3 / 3.9 ms | 3.0 / 3.1 / 2.8 ms | -28 to -51% |
| Heavy fight, render + GPU, p95 | 7.1 / 12.7 / 5.8 ms | 5.3 / 5.0 / 4.7 ms | -19 to -61% |
| The fight's cost over idle (idle 1.85 ms) | about 2 ms | about 0.6 ms | -70% |
| Siege night: SiegeMarks.update (db74ff9, 56e4351) | 0.064 / 0.048 / 0.037 ms | 0.013 / 0.006 / 0.009 ms | -76 to -88% |
| Siege night: BastionView.update | 0.088 / 0.076 / 0.064 ms | 0.055 / 0.044 / 0.039 ms | -38 to -42% |
| Siege night: pixi render | 0.50 / 0.44 / 0.40 ms | 0.46 / 0.34 / 0.32 ms | -8 to -23% |
| WeaponRing.update (261f4dc) | 0.013 / 0.016 / 0.010 ms | 0.002 / 0.003 / 0.001 ms | about -85% |
| NavMarkersUI.update (eed1a07) | 0.075 / 0.071 / 0.068 ms | 0.065 / 0.065 / 0.060 ms | about -10% |
| FloatingRewardsUI.draw, ~30 texts (bdd6c68) | 0.213 / 0.214 / 0.186 ms | 0.193 / 0.184 / 0.190 ms | about -7% |

In the heavy fight, WeaponFx's own JS stayed at about 0.3 ms. Almost all of the saving was overdraw from the old
warhead discs and launch flashes. The new network code adds client work that these figures don't include (the hit
finder, the packed reader, the own tick). The 11-04 client profile put network `onMessage` at 0.29 ms and
`SelfHits.detect` at about 0.14 ms a frame in a heavy fight.

## Per player in a busy system

What each pilot downloads when N pilots near each other all fight, built from the measured runs (deflated payload,
then headers):

- **alone** = the far pilot C in the idle run (a pilot with nobody near);
- **own fight** = shooter A in the fight run, minus A in the idle run;
- **each other pilot nearby** = (A idle − C idle: an idle pilot nearby) + (observer B in the fight run − B in the idle
  run: what that pilot's fight adds);
- **headers** = 66 B × the fighting shooter's messages a second. Coalescing keeps this about flat as traffic grows.

per player(N) = alone + own fight + (N − 1) × each other pilot + headers. Server egress = N × that.

#### Download only (deflated payload + headers), B/s per player

| fight | side | N=1 | N=2 | N=5 | N=10 | N=20 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 Pips on a freighter | before | 1,617 | 1,971 | 3,033 | 4,803 | 8,343 |
|  | after | **788** (-51%) | **938** (-52%) | **1,388** (-54%) | **2,138** (-55%) | **3,638** (-56%) |
| Hammerhead (12 Rattlers + 6 Pips) | before | 3,223 | 4,631 | 8,855 | 15,895 | 29,975 |
|  | after | **1,194** (-63%) | **1,714** (-63%) | **3,274** (-63%) | **5,874** (-63%) | **11,074** (-63%) |
| Pirates (Corsair vs 5-7) | before | 2,295 | 3,224 | 6,011 | 10,656 | 19,946 |
|  | after | **1,310** (-43%) | **1,967** (-39%) | **3,938** (-34%) | **7,223** (-32%) | **13,793** (-31%) |

#### Download + upload (fight inputs, 2,913 B/s after, 4,270 before), B/s per player

| fight | side | N=1 | N=2 | N=5 | N=10 | N=20 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 Pips on a freighter | before | 5,887 | 6,241 | 7,303 | 9,073 | 12,613 |
|  | after | **3,701** (-37%) | **3,851** (-38%) | **4,301** (-41%) | **5,051** (-44%) | **6,551** (-48%) |
| Hammerhead (12 Rattlers + 6 Pips) | before | 7,493 | 8,901 | 13,125 | 20,165 | 34,245 |
|  | after | **4,107** (-45%) | **4,627** (-48%) | **6,187** (-53%) | **8,787** (-56%) | **13,987** (-59%) |
| Pirates (Corsair vs 5-7) | before | 6,565 | 7,494 | 10,281 | 14,926 | 24,216 |
|  | after | **4,223** (-36%) | **4,880** (-35%) | **6,851** (-33%) | **10,136** (-32%) | **16,706** (-31%) |

| per-player inputs (deflated payload B/s) | before | after |
|---|---|---|
| alone | 184 | 92 |
| own fight: Pips / Hammerhead / pirates | 321 / 1,745 / 791 | 89 / 445 / 558 |
| each other nearby pilot: Pips / Hammerhead / pirates | 354 / 1,408 / 929 | 150 / 520 / 657 |
| headers down: Pips / Hammerhead / pirates | 1,112 / 1,294 / 1,320 | 607 / 657 / 660 |

Server egress for the whole crowd, download only:

| N pilots fighting | Pips before → after | Hammerhead before → after | pirates before → after |
|---|---|---|---|
| 5 | 15 → 7 KB/s | 44 → 16 KB/s | 30 → 20 KB/s |
| 10 | 48 → 21 KB/s | 159 → 59 KB/s | 107 → 72 KB/s |
| 20 | 167 → 73 KB/s | 600 → 221 KB/s | 399 → 276 KB/s |

The scaling story: before, every extra heavy fighter nearby cost each pilot 1.4 KB/s. Now it costs 0.52 KB/s. Egress
grows with N², so cutting the per-neighbour cost is what lets a system hold a crowd. The pirate fight gains least
(-31% at 20): its per-neighbour cost is mostly the NPC ships' control rows, which this work didn't touch.

## For the dev blog

Headline figures:

1. **A big gunfight costs 63% less to watch.** 3.3 KB/s → 1.2 KB/s on the wire for the pilot doing the shooting
   (Hammerhead: 12 Rattlers + 6 Pips), and 88% less data before compression (5.0 → 0.6 KB/s).
2. **Half the messages.** About 10 a second in a fight instead of 20, and 8 instead of 12 when idle.
3. **Your inputs: 76% less** while flying on the keys, 32% less in a fight, and **nothing at all while docked**. The
   server still flies exactly what your client predicted, tick for tick.
4. **20 pilots in one fight:** 30 KB/s → 11 KB/s each, and the server's outgoing traffic for that crowd 600 → 221 KB/s.
5. **A heavy weapons fight renders 35% faster:** 3.6-4.2 ms → 2.5 ms per frame, almost all of it overdraw from
   oversized explosions and muzzle flashes.

Chart-ready tables (B/s unless named):

```csv
scenario,before_wire_deflated,after_wire_deflated,change_pct
Idle,1125,663,-41
Cruising,1942,695,-64
2 Pips,1733,842,-51
Hammerhead,3338,1247,-63
Gale,3023,1146,-62
Pirates,2411,1363,-43
Scrap Mother boss,4907,2784,-43
Debris,5800,1858,-68
Beam,2145,874,-59
```

```csv
scenario,before_payload,after_payload,change_pct
Idle,302,145,-52
Cruising,871,163,-81
2 Pips,1236,234,-81
Hammerhead,5021,595,-88
Gale,5974,490,-92
Pirates,1268,706,-44
Scrap Mother boss,5372,2056,-62
Debris,8442,1261,-85
Beam,1317,307,-77
```

```csv
scenario,before_msgs_per_sec,after_msgs_per_sec
Idle,12.5,7.85
Cruising,16.3,8.05
2 Pips,16.85,9.2
Hammerhead,19.6,9.95
Gale,20,10
Pirates,20,10
Scrap Mother boss,21.15,13.75
Debris,20,9.95
```

```csv
upload,before_inputs_per_sec,after_inputs_per_sec,before_wire,after_wire
Keys only,56.9,15.3,4378,1063
Mouse steering,54.9,29.6,4227,2045
Fighting,55.5,42.4,4270,2913
Docked,34,0,2614,0
```

```csv
pilots_fighting,hammerhead_before_per_player,hammerhead_after_per_player,pips_before_per_player,pips_after_per_player
1,3223,1194,1617,788
2,4631,1714,1971,938
5,8855,3274,3033,1388
10,15895,5874,4803,2138
20,29975,11074,8343,3638
```

```csv
pilots_fighting,hammerhead_before_server_kbps,hammerhead_after_server_kbps
5,44,16
10,159,59
20,600,221
```

```csv
render,before_ms,after_ms
Idle,1.85,1.85
Heavy fight (median),3.8,2.5
Heavy fight (p95),8.5,5.0
```

(The heavy-fight "before" here is the mean of the three runs' medians, 3.6/4.2/3.6. The p95 is the mean of
7.1/12.7/5.8. The after values are 2.5/2.5/2.5 and 5.3/5.0/4.7.)

What made the difference, in the order it landed:
- **11-03, protocol 25:** plain slugs stop detonating; effects go only to nearby pilots; damage is summed per target;
  ships ignore debris; engine power is replicated; clients work out debris themselves.
- **Protocol 26:** quick wins (hot messages in compact form).
- **27:** confirmed hits. The server says "shell s hit part p" and the client works out the rest.
- **28:** clients detect their own hits. A 1-byte hash checks them.
- **29:** bit-packed frames, and coalescing (frames wait up to 3 ticks to share a message).
- **30:** the weapons range readout sent as changes only.
- Then: own hits are no longer urgent; own shells are exact, built from fire events; rough adaptive validation; zero
  disagreements.
- **34:** the own ship is stepped by its client (no echoed control rows).
- **35:** compact inputs.

## Method

- **Download probe** (`scratchpad net/ba/netAuditBA.ts`, copied into each worktree's `server/src/bench`, run with tsx,
  deleted after):
  - It uses the scenarios of the later impact audits: a real `GameServer`, `Math.random` seeded, 3 s warm-up, then 20 s
    measured, 3 ticks of latency.
  - Three pilots: A the shooter; B an observer that keeps 500-900 units from A (1,300-1,700 for the boss); C 60 km away
    in the same system.
  - Every pilot flies by input messages, sent when its keys or 13-bit aim change or when something rides them. The rule
    is the same on both trees, so both fly the same fight.
  - Before 248d482 nothing a client sends changes what the server sends it, so on the baseline the clients are plain
    sockets that count bytes.
  - At HEAD they are the netcode tests' `FakeHitsClient` (the client's own store, replicas, confirmed and self-found
    hits, own tick), announcing caps 255. The probe also derives debris splits and acks them on the next input, as
    `ShipClient` does.
  - Every byte counted is the server's real encoder output.
- **Cross-check against the 11-03 audit's baseline** (a different probe, same tree): 2 Pips 1,236 here vs 1,236 there,
  Hammerhead 5,021 vs 5,017, Gale 5,974 vs 5,974, boss 5,372 vs 5,332, idle 302 vs 293. Debris differs (8,442 vs
  7,578), because this probe's observer flies differently. Within one probe the before and after are like for like.
- **Upload probe:** `scripts/net/inputProbe.ts`, as in the input-compaction audit. The baseline ran a copy whose
  HEAD-only imports (`CAPS`, `PK_CONTROL`, `PackedDecoder`) are looked up at run time. Its "packed observer" is
  therefore a base-format one before.
- **Scenarios:**
  - Idle: parked far from anything.
  - Cruising: the Pips ship near a parked freighter, not firing.
  - 2 Pips, Hammerhead, Gale, Beam (Heron): each against a parked freighter.
  - Pirates: a Corsair against 5-7 pirate ships, with packs respawning.
  - Boss: the Scrap Mother against a Hammerhead.
  - Debris: a Hammerhead against 4 freighters that each lose a part every 8 ticks.
  - Mining: a Prospector 450 units from the nearest large rock, mining laser held.
- **Wire** = payload + 66 B a WebSocket message (IP + TCP + TLS + WS headers). **Deflated** uses the server's deflate
  settings frame by frame.

## Caveats

- **One run per scenario and tree.** The world is seeded, so a rerun gives the same bytes. Scenario coverage is still
  limited: parked targets, one shooter, three pilots.
- **HEAD with every cap on is the dev server's configuration.** Production runs caps 0 until the deploy freeze ends.
  That is the "HEAD caps 0" column, mostly close to before.
- **Not quite the dev server today:** the dev server now also runs the uncommitted boss decision-inputs work
  (protocol 36, CAPS.BODIES), which this does not include. The boss figures will move when that lands.
- **The fake client is an ideal predictor.** Its own pose is the server's. A real client is exact only while its
  prediction holds. The zero-disagreement audit measured that with the prediction off by up to 5 units: no change in
  bytes.
- **Main-probe upload is not the client's send rule.** It sends on every 13-bit aim change, which is the baseline rule.
  Pirates and boss send 56-60 inputs a second either way. Use the input probe for upload. Use the main probe only for
  what rides along.
- **Server CPU:** the after runs have three capable clients, each paying the ledger, the packed encoder and the own-ship
  check. Those costs grow with capable players. One desktop machine, single runs.
- **The busy-system model is linear and approximate.** It adds each neighbour's measured cost. It doesn't model shared
  targets (N pilots on one freighter pay for the freighter once), deflate improving with bigger frames, or more urgent
  frames in a crowd. Treat it as the shape of the curve, not a forecast.
- **Mining:** the laser's beam was on (one beam) but the rock's HP didn't move in 20 s, in both trees. Either the
  probe's aim misses the rock's cutting edge or mining takes ore without lowering HP; it wasn't investigated. Mining
  sends little either way.
- **Client frame figures are from the rendering audits** (different machines' loads, headless Chrome pacing). They are
  not re-measured here, and don't include the new network work on the client.
- **Worktrees:** `baseline-wt` (56389a3) and `head-wt` (235dc46), with the main tree's node_modules linked in. Both
  were removed afterwards.
