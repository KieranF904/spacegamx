# JS maths determinism across engines (research, 2026-11-01)

Goal: server (Node/V8) and every client (V8, SpiderMonkey, JSC) must produce bit-identical sim state per tick.
Caveat: several findings come from search summaries and third-party GitHub PRs/blogs, not engine source. Treat them as "unverified until the harness in section 5 confirms".

## 1. Does it diverge?

### (a) + - * / and Math.sqrt: identical
- ECMAScript Number arithmetic is IEEE 754 binary64, round-to-nearest-even. + - * / and sqrt are correctly rounded, so results are bit-identical on every engine and CPU. JS has no FMA contraction (each operation is defined separately by the spec), no x87 extended precision in 64-bit engines (SSE2/NEON), and no flush-to-zero for denormals. The C/C++ problems in Gaffer's article (x87, FP modes, FMA, compiler flags) do not apply to JS arithmetic.
- Watch: NaN payload/sign bits and -0. Avoid producing NaN (assert Number.isFinite in debug builds). -0 is observable via Object.is, 1/x, Float64Array bytes and atan2(+-0, ...). Normalise with `x + 0` before hashing or serialising.
- Exactly specified, safe: Math.fround, imul, clz32, abs, floor, ceil, round, trunc, min, max, sign.

### (b) Transcendentals: spec allows divergence, and they do diverge
- ECMA-262 Math object: sin, cos, tan, asin, acos, atan, atan2, exp, expm1, log, log1p, log10, log2, pow, cbrt, hypot, sinh/cosh/tanh and inverses are "implementation-approximated". fdlibm is recommended for sin/cos/tan, not required.
- Engine split (MacWright 2020, recent PRs): V8 and SpiderMonkey use different fdlibm ports. JavaScriptCore uses the platform libm (Apple libsystem_m, glibc, UCRT). So Safari/iOS can differ from Chrome/Firefox, and JSC differs between OSes.
- Concrete cases:
  - V8 issue 3006: a V8 roll with a table-interpolation sin/cos changed `Math.cos(2**120)` from 0.47796506772457525 to 0. V8 later moved to an fdlibm port.
  - Node version drift (MacWright): `Math.tanh(0.1)` Node 4 = 0.0996679946249559 vs Node 6 = 0.0996679946249558; `Math.pow(1/3,3)` Node 10 = 0.03703703703703703498 vs Node 12 = 0.03703703703703702804.
  - Math.pow: Firefox bug 1775254, `Math.pow(10,308)` gave 1.0000000000000006e308 (SM and JSC); V8 7.4 pow lost bits (Chromium 40625237) so `Math.pow(10,-5) !== 0.00001`; V8 constant folding of `**` differed from the interpreter (`99**99` vs `Math.pow(99,99)`; Node issue 19835 `14 ** .9`). Firefox now always calls fdlibm_pow (earlier std::pow differed by 1 ulp on some Android ARM devices).
  - V8 vs itself (Scrapfly 2026, unverified against V8 source): V8 now bundles llvm-libc for exp/pow/atan and a glibc dbl-64 routine for sin/cos; Math.tanh was an fdlibm port until Chrome 147 and uses the host libm from Chrome 148 (tanh(0.7) differs Linux vs macOS/Windows). Other PRs report Node's V8 (fdlibm) vs Chromium differing in the last bit for sin/cos on about 2% of inputs. Consequence: server Node vs browser Chrome can already differ.
  - Math.hypot: one project found Firefox hypot 1 ulp off V8, breaking cross-engine solver output in 3 of 11 scenes. Math.atan 1 ulp apart V8 vs JSC broke a replay within a frame (Forge-Engine PR 124).
  - fdlibm compiled with FMA contraction varies by target, so even "fdlibm" is not guaranteed bit-equal across ARM/x86 builds.
  - Mozilla moved sin/cos/tan to fdlibm to remove platform variation (fingerprinting). Firefox is the most consistent across OSes, JSC the least.
- Same engine, different versions: yes (above). Same version, different OS/arch: yes for JSC and anything using host libm.

### (c) Other things
- Array.prototype.sort: stable since ES2019 in all current engines. Comparator must be a consistent total order. Never use the default sort for numbers.
- Property order: integer-like keys ascending, then strings by insertion (spec-defined); Map/Set iterate in insertion order. Deterministic if insertion order is; delete + reinsert moves the key.
- Number to string is spec'd shortest round-trip, so String(x) and JSON.stringify/parse round-trip finite doubles exactly across engines. JSON loses NaN/Infinity (null) and -0 (0). toLocaleString is locale-dependent; avoid. Do not parse float text for sim state; ship ints or typed arrays.
- Typed arrays hold exact bits; underlying buffer endianness is platform (little-endian on all current targets). Use DataView with explicit endianness for wire/hash. NaN payloads are not reliably preserved.
- Math.random is unseeded and per-engine: forbidden in sim. Use a seeded PRNG built on Math.imul / `>>> 0` (sfc32, xoshiro128**). No Date.now or performance.now in sim.
- JIT: spec forbids observable change to + - * /; no credible reports of JIT altering pure arithmetic. The known JIT-vs-interpreter divergence is constant folding of `**` / Math.pow (above).
- Integer ops (`|0`, `>>>0`, imul) are fully defined and wrap deterministically.

## 2. How others do it
- Photon Quantum: Q48.16 fixed-point `FP` (one long), integer mul/div, lookup tables for sin/cos/sqrt; float conversions flagged unsafe. Metaplay: F64 (32.32) and F32 (16.16).
- Box2D v3.1: cross-platform determinism without fixed point. Uses only + - * / sqrt on floats, no libm, own `b2ComputeCosSin` and `b2Atan2` approximations, FMA contraction disabled. Rollback determinism is separate. (Details of the determinism post not fetched; see FAQ and math_functions.c.)
- Gaffer On Games "Floating Point Determinism": IEEE ops are deterministic per operation, but compilers, FPU modes and libm break reproducibility. Same binary plus same ISA is the safe case, which is not our situation for transcendentals.
- GGPO/rollback and RTS lockstep: integer or fixed-point sim plus periodic checksums to detect desyncs.
- WebAssembly: scalar f64 add/sub/mul/div/sqrt are bit-exact. Nondeterminism: NaN sign/payload of results, relaxed-SIMD ops (relaxed_madd fused or not, relaxed min/max/trunc), resource limits. Wasm 3.0 defines a deterministic profile (canonical positive NaN, unfused madd); Wasmtime has NaN-canonicalisation and deterministic-relaxed-simd options. There are no transcendental instructions, so a libm compiled to Wasm (musl, Rust libm) is deterministic if you avoid relaxed SIMD. Browsers give no NaN canonicalisation switch, so avoid NaN.
- JS community workarounds (anecdotal PRs): pure-JS ports of fdlibm sin/cos/atan2 ("detmath"), full fdlibm ports (trig, exp, log, cbrt, pow), `hypot = Math.sqrt(x*x+y*y)`. They report identical bits across Node/Chromium/Firefox/WebKit.

## 3. Recommendation
Safe as-is: + - * / Math.sqrt, abs, min, max, floor, ceil, trunc, round, sign, fround, imul, clz32, comparisons, int32 ops, typed array load/store, stable sort with total-order comparator, Map/Set insertion-order iteration, String/JSON of finite doubles (normalise -0).

Replace (every non-exact Math function): sin, cos, tan, asin, acos, atan, atan2, exp, expm1, log*, pow and `**` (except small integer exponents via repeated multiplication), cbrt, hypot, the hyperbolics, Math.random, Date, float text parsing.

Cheapest robust replacements (only + - * / sqrt, so bit-identical everywhere, same code on the Node server):
- hypot/length: `Math.sqrt(x*x+y*y)`.
- sin/cos: wrap angle to [-pi, pi], reduce to [-pi/4, pi/4] by quadrant, then fdlibm kernel polynomials (about 7 multiply-adds), written as explicit Horner steps.
- atan2: octant reduction plus polynomial atan (fdlibm atan or Box2D-style approximation).
- Prefer avoiding angles in state: store unit direction vectors and rotate by multiplication, renormalise with sqrt periodically.
- exp/log/pow: avoid. Drag as per-tick constant multiplier; integer powers by multiplication; if needed, an own exp polynomial.
- Fastest option if ~1e-7 accuracy is fine: 4096-entry Float64Array sin table with linear interpolation, built with your own polynomial (never with Math.sin).
- Fixed-point int32/Q16.16 via Math.imul is also deterministic but costs precision and dev effort; a hybrid (doubles for pos/vel, ints for ticks/ids/PRNG/hash) is the practical form.
- Wasm-compiled libm is deterministic but JS<->Wasm call overhead usually makes JS polynomials faster for scalar calls.

Performance: a polynomial sin/cos in JIT'd JS is roughly comparable to native Math.sin (V8 calls out to C for Math.sin anyway), at most a few x; negligible for thousands of calls per tick. Estimate, not measured here: benchmark in the harness.

Rules: lint-ban Math.sin/cos/tan/asin/acos/atan/atan2/exp/log*/pow/cbrt/hypot/random, `**`, Date, performance.now in sim packages; watch for transpilers turning `**` into Math.pow; assert Number.isFinite in debug. Rendering, particles, audio and camera can keep native Math.

## 4. State hashing
Hash raw bytes, not JSON: write state to a Float64Array/Int32Array scratch, normalise -0, reject NaN, view as Uint32Array (assert little-endian) and run FNV-1a/xxhash32 with Math.imul. Quantising state each tick only hides drift; prefer fixing the cause and hashing exact bits.

## 5. Test strategy
1. Golden vectors: fixed seed plus scripted inputs for N (e.g. 10k) ticks, emitting per-tick (or every 100 ticks plus final) hashes to a committed JSON file.
2. Run the same bundle in Node (the production server version), Chromium/Edge, Firefox and WebKit via Playwright, plus real Safari/iOS (BrowserStack or a manual page printing hashes; WebKit-on-Linux uses glibc so real Apple devices matter), Android Chrome and an ARM machine. Report first divergent tick and field.
3. Primitive fuzz: 1e6 random inputs per replacement function (and per any remaining Math call, informationally) hashing output bit patterns in each engine.
4. CI on every PR for Node + three Playwright engines; weekly run on browser betas (the Chrome 148 tanh change shows versions drift).
5. Production: clients send periodic tick hashes; server logs desyncs with UA/OS for triage.

## Sources
- ECMA-262: https://tc39.es/ecma262/ (Math object, Number::toString, Array.prototype.sort)
- MDN Math: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math
- Math keeps changing (MacWright): https://macwright.com/2020/02/14/math-keeps-changing
- Scrapfly, browser maths per OS: https://scrapfly.dev/posts/browser-math-os-fingerprint/
- V8 issue 3006: https://groups.google.com/g/v8-dev/c/Y3es4O0yebs
- Mozilla fdlibm intent: https://groups.google.com/a/mozilla.org/g/dev-platform/c/0dxAO-JsoXI/m/eEhjM9VsAgAJ
- Firefox fdlibm override: https://searchfox.org/firefox-main/source/modules/fdlibm/inexact-math-override/math.h ; pow test: https://searchfox.org/firefox-main/source/js/src/jit-test/tests/basic/fdlibm-for-pow.js
- Firefox bug 1775254: https://bugzilla.mozilla.org/show_bug.cgi?id=1775254
- Chromium 40625237: https://issues.chromium.org/issues/40625237
- Node issue 19835: https://github.com/nodejs/node/issues/19835 ; https://www.freecodecamp.org/news/i-found-a-bug-in-v8s-exponentiation-operator-dcddfa5b8482/
- ES discuss: https://esdiscuss.org/topic/es6-accuracy-of-special-functions
- Anecdotal cross-engine PRs: https://github.com/iant89/Forge-Engine/pull/124 ; https://github.com/jjgroenendijk/sunset-driver/pull/472 ; https://github.com/ArndRosemeier/Tank-battle/pull/6 ; https://github.com/renecano/Crash_reconstruction_visualization_system/pull/36 ; https://github.com/hemartin/physicsplain/issues/56
- Wasm: https://github.com/WebAssembly/design/blob/main/Nondeterminism.md ; https://webassembly.github.io/spec/core/exec/numerics.html ; https://github.com/WebAssembly/relaxed-simd ; https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html
- Photon Quantum FP: https://doc.photonengine.com/en-us/quantum/current/manual/quantum-ecs/fixed-point ; Metaplay: https://docs.metaplay.io/game-logic/utilities/fixed-point-math
- Gaffer: https://gafferongames.com/post/floating_point_determinism/
- Box2D: https://box2d.org/documentation/md_faq.html ; https://github.com/erincatto/box2d
