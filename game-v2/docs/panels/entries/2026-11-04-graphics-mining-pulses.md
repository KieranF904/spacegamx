---
date: "2026-11-04"
category: "graphics"
topic: "mining-pulses"
files:
- "graphics/mining-pulses-before.png"
- "graphics/mining-pulses-after.png"
- "graphics/mining-pulses.png"
---
The Wren (a ports dev ship with two Mining Lasers; for these shots its right laser had no reactor behind it, only its own one-second buffer) mining with the button held, frames left to right about 0.2-0.3 s apart. Before, on a ports ship the lasers drew nothing that mattered: the starved right beam burned exactly as bright as the fed left one, and nothing round the cursor said anything about mining. Now each laser fires fixed 0.9 s pulses (a Bore 1.2 s) that chain while held and run to their end when let go, draws its power constantly while a pulse runs, and cuts by the share of that draw it gets: the right beam dims and thins once its buffer is spent (it mines nothing), the left one burns on. The weapon ring gets a mining segment: the pulse sweeping along it, cyan when fed, yellow then red as the fulfilment drops, and the laser's buffer as a thin arc inside.
