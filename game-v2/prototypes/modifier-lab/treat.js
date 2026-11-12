// Modifiers on the real energy model. This file adds two kinds of part to the ports model (ports-model.js, a copy of the
// energy lab's, unchanged): modifiers, one-cell blocks that carry no power, and mounts, line parts with sockets down one
// side that the modifiers plug into. A mount's treatment goes to the guns its lines lead to, by what those guns use (the
// end load): along conduits, through joiners and splitters, never through a battery or a capacitor. A gun's property
// strength is the share of the power it uses that its mounts treat. Line parts come in tiers, each carrying so many
// effects and so much treated power. The model's own tick is not touched: before() and after() wrap one PM.tick.
// Every number is a first guess. Plain script: window.MLT in the page, require() in node (treat.check.mjs).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ports-model.js')); else root.MLT = factory(root.PM);
})(typeof self !== 'undefined' ? self : this, function (PM) {
  'use strict';
  const { T, ORDER, CATS } = PM;

  // The four components and what each gives on its own
  const COMPS = {
    coil: { name: 'Coil', prop: 'velocity', col: '#7fd8ff', say: 'Winds the power tight: shots leave faster and reach further.' },
    resonator: { name: 'Resonator', prop: 'rapid', col: '#ffd166', say: 'Sets the power ringing: more, smaller shots from the same energy.' },
    chamber: { name: 'Chamber', prop: 'explosive', col: '#ff8a3d', say: 'Packs the power unstable: shots trade direct damage for a blast.' },
    prism: { name: 'Prism', prop: 'split', col: '#b58cff', say: 'Divides the power: each shot leaves as two or three.' },
    // The special ones. Each has an input of its own on its far side and does nothing while that is dry. needs.mat: a
    // material from a hopper, per: units used for each unit of energy treated. needs.power: a power line of its own
    // (the rating of its in port), per: energy burned for each unit of energy treated.
    arc: { name: 'Arc cell', prop: 'chain', col: '#5ef2e0', needs: { mat: 'arcsalt', per: 0.05 }, say: 'Charges the shot: it arcs on from what it hits to what stands near.' },
    condenser: { name: 'Condenser', prop: 'heavy', col: '#d9a066', needs: { mat: 'cryo', per: 0.05 }, say: 'Chills and packs the power denser: the shot hits much harder, but flies slower.' },
    brand: { name: 'Brander', prop: 'burn', col: '#ff5a4a', needs: { mat: 'pyre', per: 0.05 }, say: 'Coats the shot: what it hits keeps burning.' },
    rail: { name: 'Rail driver', prop: 'hyper', col: '#f2f27a', needs: { power: 30, per: 0.5 }, say: 'Drives the shot far faster but lighter: it arrives almost at once and hits softer.' },
  };
  // A special modifier block: buf is the material it holds ready, hold the power a Rail driver holds
  const SPECIAL = { cost: 400, upkeep: 1, hp: 40, mass: 1.2, lvl: 20, buf: 3, hold: 20 };
  // What the hoppers hold: reagents the modifier works with, never ammunition (a gun's ammunition is its own feed).
  // What the hoppers hold. A hopper is loaded at a station only (the Dock button); nothing on the ship refills it.
  const HOPPERS = {
    arcsalt: { name: 'Arc salt', short: 'Arc salt', col: '#5ef2e0' },
    cryo: { name: 'Cryo fluid', short: 'Cryo', col: '#9fd8e8' },
    pyre: { name: 'Pyre gel', short: 'Pyre', col: '#ff5a4a' },
  };
  const HOPPER = { fill: 60, cost: 40, hp: 55, mass: 1.5, lvl: 14 };
  // A modifier comes in one level: a block that burns a little power through the mount it is plugged into
  const BLOCK = { cost: 60, upkeep: 1, hp: 30, mass: 0.8, lvl: 4 };
  // slots: sockets, one a cell down its side. each: energy a second each plugged modifier treats in it (a bigger mount
  // gets more out of the same modifiers). rate: its line rating.
  // (Every mount carries a full line, the same as a Conduit: a bigger mount only gets more from each modifier)
  const MOUNTS = [
    { slots: 1, name: 'Mount', rate: 200, each: 24, cost: 20, lvl: 2, hp: 40, mass: 1 },
    { slots: 2, name: 'Double mount', rate: 200, each: 30, cost: 150, lvl: 12, hp: 70, mass: 1.8 },
    { slots: 3, name: 'Triple mount', rate: 200, each: 40, cost: 700, lvl: 24, hp: 110, mass: 2.6 },
  ];
  const MOUNT_COL = '#b98fd6';
  // Recipes: a Double or Triple mount whose sockets hold exactly a recipe's kinds (at least one of each, nothing else)
  // fuses them into the recipe's own effect and gives up theirs. To add one: a row here, its property in PROPS, its
  // numbers in TUNE and its shape in spec(). parts may list two kinds or three (three needs a Triple mount).
  const RECIPES = [
    { parts: ['coil', 'prism'], prop: 'pierce' },
    { parts: ['chamber', 'resonator'], prop: 'wave' },
  ];
  const PROPS = {
    velocity: { name: 'Velocity', col: '#7fd8ff', say: 'Faster shots that reach further.' },
    rapid: { name: 'Rapid', col: '#ffd166', say: 'More, smaller shots for the same energy.' },
    explosive: { name: 'Explosive', col: '#ff8a3d', say: 'Trades direct damage for a blast around the hit.' },
    split: { name: 'Split', col: '#b58cff', say: 'Each shot leaves as two or three smaller ones.' },
    pierce: { name: 'Pierce', col: '#8ef0c8', say: 'Spreads the shot through the cells behind the first.' },
    bounce: { name: 'Bounce', col: '#f58ad0', say: 'Shots come off walls instead of dying on them.' },
    wave: { name: 'Wave', col: '#9db4ff', say: 'A wide shot that hits everything across its front.' },
    chain: { name: 'Chain', col: '#5ef2e0', say: 'The hit arcs on to nearby targets.' },
    heavy: { name: 'Heavy', col: '#d9a066', say: 'Much more damage; slower shots.' },
    burn: { name: 'Burn', col: '#ff5a4a', say: 'What it hits keeps burning for a few seconds.' },
    hyper: { name: 'Hyper', col: '#f2f27a', say: 'Much faster shots that hit softer.' },
  };
  const TUNE = {
    // Line parts (conduits, joiners, splitters) by tier: fx, how many different effects one carries; cap, how much
    // treated power a second, counted once for each effect. Over either, the rest goes on as plain power.
    lines: [null, { fx: 2, cap: 120 }, { fx: 3, cap: 300 }, { fx: 4, cap: 900 }],
    // A gun's load is the power it really uses, smoothed over this many seconds (a burst gun draws in pulses)
    loadSecs: 4,
    // There are no levels: a property's strength is the share (0 to 1) of the power the gun takes that arrived treated
    // that way. Every number below is the effect at full strength, and the effect runs straight from plain to that.
    velocity: { speed: 1.8, range: 1.6 },
    // rapid: this many times the shots for the same power, and this much more damage in all
    rapid: { rate: 1.8, total: 1.2 },
    explosive: { direct: 0.75, blast: 0.32, radius: [12, 34] },
    // split: always this many shots; the side ones grow from nothing to an equal share as the strength rises
    split: { shots: 3, total: 1.35, spreadDeg: 6 },
    // pierce: the share of the hit each cell in a row takes at full strength; weaker, more stays on the first
    pierce: { fracs: [0.36, 0.26, 0.18, 0.12, 0.08] },
    // bounce and chain: always this many; what each bounce or arc keeps grows with the strength
    bounce: { count: 4, keep: 0.75 },
    wave: { width: 3.5, perTarget: 0.78 },
    // chain: arcs to this many more targets within reach px of the last, each taking frac of the one before
    chain: { jumps: 4, frac: 0.5, reach: 64 },
    heavy: { damage: 1.6, speed: 0.62 },
    // burn: this much of the hit again, spread over secs
    burn: { total: 0.6, secs: 3 },
    hyper: { speed: 3.5, damage: 0.8 },
  };
  // How a gun's shot flies on the firing range (px a second, px): the ports model has no such numbers
  const FLIGHT = { pip: [420, 520], glint: [560, 600], hammer: [460, 600], longbarrel: [780, 900], spear: [820, 950], bastion: [500, 560], sunbreaker: [600, 900], slurry_cannon: [420, 520] };
  const BEAM_FLIGHT = [1400, 700], BEAM_TICKS = 12;

  // ================================================================ the parts
  const MOD_CAT = CATS.indexOf('Modifiers') >= 0 ? CATS.indexOf('Modifiers') : CATS.push('Modifiers') - 1;
  const port = (dir, side, cell, rate) => ({ dir, side, cell, rate });
  // A mount is a one-way line part, like a Conduit: power in at its back, out at its front, a little held
  for (const m of MOUNTS) {
    const id = `mount${m.slots}`;
    if (T[id]) continue;
    T[id] = { id, name: m.name, cat: MOD_CAT, kind: 'store', conduit: true, mount: m.slots, hold: 10 * m.slots, w: 1, h: m.slots,
      treat: m.each, upkeep: BLOCK.upkeep, hp: m.hp, mass: m.mass, col: MOUNT_COL, lvl: m.lvl, cost: m.cost, armour: 1,
      ports: [port('in', 'S', 0, m.rate), port('out', 'N', 0, m.rate)], feed: [], takes: [], intake: m.rate, produce: m.rate,
      say: `A full line with ${m.slots === 1 ? 'one socket' : m.slots + ' sockets'} down its side. Each modifier plugged in treats ${m.each} a second of the power passing.` };
    ORDER.push(id);
  }
  // A modifier is a block: no ports of its own (yet), it works through the mount whose socket it sits against
  for (const [cid, c] of Object.entries(COMPS)) {
    const id = `mod_${cid}`;
    if (T[id]) continue;
    const nd = c.needs, b = nd ? SPECIAL : BLOCK;
    T[id] = { id, name: c.name, cat: MOD_CAT, kind: 'inert', plug: cid, w: 1, h: 1, hp: b.hp, mass: b.mass, col: c.col, lvl: b.lvl, cost: b.cost,
      armour: 1, ports: [], feed: [], takes: [], say: `${c.say} Gives ${PROPS[c.prop].name}. Plug it into a mount.` };
    // (A special one has its input on its E side, unrotated: a feed point for a hopper, or a power port for a line of its own)
    if (nd && nd.mat) Object.assign(T[id], { special: true, isNew: true, feed: [{ side: 'E', cell: 0 }],
      say: `${c.say} Gives ${PROPS[c.prop].name}. Plug it into a mount and join a hopper of ${HOPPERS[nd.mat].name.toLowerCase()} to its input.` });
    if (nd && nd.power) Object.assign(T[id], { special: true, isNew: true, kind: 'store', hold: SPECIAL.hold, ports: [port('in', 'E', 0, nd.power)], intake: nd.power, produce: 0,
      say: `${c.say} Gives ${PROPS[c.prop].name}. Plug it into a mount and run a power line of its own into its input.` });
    ORDER.push(id);
  }
  for (const [mid, h] of Object.entries(HOPPERS)) {
    PM.MATS[mid] ??= { name: h.name, short: h.short, col: h.col, on: 'modifier', mod: {}, say: 'For a special modifier.' };
    const id = `hopper_${mid}`;
    if (T[id]) continue;
    T[id] = { id, name: `Hopper: ${h.name}`, cat: MOD_CAT, kind: 'tank', hopper: true, fluid: mid, fill: HOPPER.fill, w: 1, h: 1, hp: HOPPER.hp, mass: HOPPER.mass, col: h.col,
      lvl: HOPPER.lvl, cost: HOPPER.cost, armour: 1, isNew: true, ports: [], feed: ['N', 'E', 'S', 'W'].map((side) => ({ side, cell: 0 })), takes: [],
      say: `Holds ${HOPPER.fill} ${h.name.toLowerCase()} for the special modifiers joined to it. Loaded at a station only.` };
    ORDER.push(id);
  }

  // The higher tiers of the line parts: the same part, carrying more effects and more treated power (TUNE.lines), and
  // for the banks more power too. A mount is a line of its own and carries whatever is put in it.
  const LINE_BASE = { conduit: 1, corner: 1, joiner: 1, splitter: 1, passthrough: 1, combiner: 1 };
  const LINE_TIERS = { 2: { mark: 'II', cost: 4, lvl: 8, rate: 1.5, hp: 1.3 }, 3: { mark: 'III', cost: 14, lvl: 20, rate: 2.5, hp: 1.7 } };
  for (const base of ['conduit', 'corner', 'joiner', 'splitter']) for (const n of [2, 3]) {
    const id = `${base}_t${n}`, b = T[base], k = LINE_TIERS[n];
    if (T[id] || !b) continue;
    const ports = b.ports.map((q) => Object.assign({}, q, { rate: b.conduit ? q.rate : Math.round(q.rate * k.rate) })), sum = (dir) => ports.filter((q) => q.dir === dir).reduce((a, q) => a + q.rate, 0);
    T[id] = Object.assign({}, b, { id, name: `${b.name} ${k.mark}`, lineTier: n, isNew: true, lvl: b.lvl + k.lvl, cost: Math.round((b.cost || 10) * k.cost), hp: Math.round(b.hp * k.hp),
      ports, intake: sum('in'), produce: sum('out'), say: `${b.say} Tier ${n}: carries ${TUNE.lines[n].fx} effects and ${TUNE.lines[n].cap} treated power a second.` });
    ORDER.push(id);
  }
  /** A line part's tier (0: not one, or a mount, which carries anything) */
  const tierOf = (type) => T[type].lineTier || LINE_BASE[type] || 0;
  /** Treatment travels along lines and through joiners and splitters, never through a battery, a capacitor or the core */
  const carries = (p) => { const t = T[p.type]; return t.kind === 'store' && !t.plug && (!!t.conduit || tierOf(p.type) > 0); };

  /** A placed mount's sockets in world terms: the mount cell each is on, its side, and the cell a modifier must sit in */
  function socketsOf(m) {
    const n = T[m.type].mount, side = PM.placeSide('E', m.rot, m.flip), [vx, vy] = PM.SIDE_V[side], [x0, y0] = m.cells[0], out = [];
    for (let i = 0; i < n; i++) { const [dx, dy] = PM.placeCell(0, i, 1, n, m.rot, m.flip); out.push({ x: x0 + dx, y: y0 + dy, side, nx: x0 + dx + vx, ny: y0 + dy + vy }); }
    return out;
  }

  /** The recipe a set of modifier kinds makes together, or null */
  const recipe = (kinds) => { const set = [...new Set(kinds)]; return (set.length > 1 && RECIPES.find((r) => r.parts.length === set.length && r.parts.every((k) => set.includes(k)))) || null; };
  const isMod = (p) => !!T[p.type].mount;
  /** What a mount and the modifiers in it cost */
  const costOf = (m) => T[m.type].cost + (m.sockets || []).reduce((s, k) => s + (k.block ? T[k.block.type].cost : 0), 0);

  /** After PM.build: plug the modifiers into the mounts, fuse the ones that hold a recipe, and give every mount its jobs (what it treats, how much a second) */
  function link(L, tune) {
    const at = new Map(), mounts = L.stores.filter(isMod), blocks = L.alive.filter((p) => T[p.type].plug);
    for (const p of L.alive) for (const [x, y] of p.cells) at.set(x + ',' + y, p);
    for (const b of blocks) {
      b.host = null; b.bad = false; b.dry = false; b.buf ??= 0;
      // (The model counts only Combiners and feed ports as users of a feed network: a special modifier is one too)
      if (T[b.type].feed.length && b.feedNet && !b.feedNet.users.includes(b)) b.feedNet.users.push(b);
    }
    for (const m of mounts) {
      m.sockets = socketsOf(m).map((k) => { const b = at.get(k.nx + ',' + k.ny), block = b && T[b.type].plug && !b.host ? b : null; if (block) block.host = m; return Object.assign(k, { block, ok: false }); });
      // (A mount takes one kind, the first plugged in, in socket order; or the kinds of one recipe, which fuse. Anything
      // else plugged in does nothing)
      const full = m.sockets.filter((k) => k.block), first = full[0];
      m.comp = first ? T[first.block.type].plug : null; m.n = 0;
      m.fused = recipe(full.map((k) => T[k.block.type].plug));
      for (const k of full) { k.ok = !!m.fused || T[k.block.type].plug === m.comp; k.block.bad = !k.ok; if (k.ok) m.n++; }
      m.treat = m.n * T[m.type].treat; m.ready = m.n;
      m.jobs = m.comp ? [{ prop: m.fused ? m.fused.prop : COMPS[m.comp].prop, treat: m.treat }] : [];
    }
    const mods = mounts.filter((m) => m.comp);
    L.mounts = mounts; L.blocks = blocks;
    L.mods = mods;
    // Where each mount's treatment goes: every gun its lines lead to, and the line parts on the way there
    for (const q of L.stores) { q.ents = []; q.fx = {}; q.fxDrop = null; q.fxOver = 0; q.tier = tierOf(q.type); }
    for (const m of mods) for (const j of m.jobs) {
      j.reach = [];
      const prev = new Map([[m, null]]), q = [m];
      while (q.length) {
        const a = q.shift();
        for (const l of a.outL) {
          const b = l.to;
          if (prev.has(b)) continue;
          prev.set(b, a);
          if (T[b.type].kind === 'weapon') {
            const path = []; for (let x = a; x; x = prev.get(x)) path.push(x);
            const e = { j, prop: j.prop, w: b, amt: 0, k: 1 };
            j.reach.push(e);
            // (far: how far back along the line this effect was put in, for which to keep on a part that is full)
            path.forEach((x, i) => x.ents.push({ e, far: path.length - 1 - i }));
          } else if (carries(b)) q.push(b);
        }
      }
    }
    // (The parts in the order power passes them, so what one drops is already gone at the next)
    const line = L.stores.filter((q) => q.ents.length), deg = new Map(line.map((q) => [q, q.inL.filter((l) => l.from.ents && l.from.ents.length).length]));
    const order = [], open = line.filter((q) => !deg.get(q));
    while (open.length) { const a = open.shift(); order.push(a); for (const l of a.outL) if (deg.has(l.to)) { deg.set(l.to, deg.get(l.to) - 1); if (deg.get(l.to) === 0) open.push(l.to); } }
    for (const q of line) if (!order.includes(q)) order.push(q);
    L.line = order;
    for (const q of L.alive) if (T[q.type].kind === 'weapon') { q.share ??= {}; q.load ??= T[q.type].intake || 0; }
    return mods;
  }

  /** Before PM.tick: nothing now (kept so a caller wraps the tick the same way) */
  function before() {}

  /** After PM.tick: share each mount's treatment among the guns it leads to by what they use, within what the lines carry */
  function after(L, tune, dt) {
    const DT = dt || PM.DT;
    // Guns: the power each really uses. (It holds while the gun rests, so a gun is not read as starved between fights)
    for (const w of L.weapons) if (w.rate > 0.02 || w.inNow > 0) w.load += (w.inNow / DT - w.load) * Math.min(1, DT / tune.loadSecs);
    for (const s of L.mounts) {
      const t = T[s.type], need = s.comp && COMPS[s.comp].needs;
      // Special modifiers: top each one up at its input; one that is dry treats nothing
      let live = null;
      if (need) {
        live = [];
        for (const k of s.sockets) {
          if (!k.ok) continue;
          const b = k.block;
          if (need.mat) { const room = SPECIAL.buf - b.buf; if (room > 1e-9 && b.feedNet) b.buf += PM.drawMat(b.feedNet, need.mat, Math.min(room, 30 * DT)); } else b.buf = b.held;
          b.dry = !(b.buf > need.per * t.treat * DT);
          if (!b.dry) live.push(b);
        }
      }
      s.live = live; s.ready = live ? live.length : s.n || 0;
      // What it treats is shared among its guns by their load: more supply than the guns use changes nothing
      for (const j of s.jobs || []) {
        const cap = j.treat * (s.n ? s.ready / s.n : 0), total = j.reach.reduce((a, e) => a + e.w.load, 0), f = total > 1e-6 ? Math.min(1, cap / total) : 0;
        for (const e of j.reach) { e.amt = e.w.load * f; e.k = 1; }
      }
      const burn = Math.min(s.held, (s.n || 0) * t.upkeep * DT);
      if (burn > 0) s.held -= burn;
      s.burnNow = burn / DT;
    }
    // Line parts: each carries so many effects (the weakest, then the last put in, are dropped) and so much treated power
    for (const p of L.line) {
      p.fxDrop = null; p.fxOver = 0;
      const lim = tune.lines[p.tier];
      if (!lim) continue;
      const by = {};
      for (const { e, far } of p.ents) { const a = e.amt * e.k; if (a > 1e-9) { const o = (by[e.prop] ??= { amt: 0, far: 0 }); o.amt += a; o.far = Math.max(o.far, far); } }
      let kinds = Object.keys(by);
      if (kinds.length > lim.fx) {
        kinds.sort((a, b) => Math.round(by[b].amt * 10) - Math.round(by[a].amt * 10) || by[b].far - by[a].far);
        p.fxDrop = kinds.slice(lim.fx); kinds = kinds.slice(0, lim.fx);
        for (const { e } of p.ents) if (p.fxDrop.includes(e.prop)) e.k = 0;
      }
      const sum = kinds.reduce((a, k) => a + by[k].amt, 0);
      if (sum > lim.cap + 1e-6) { p.fxOver = sum; for (const { e } of p.ents) e.k *= lim.cap / sum; }
    }
    // Guns: the share of the power each uses that is treated each way
    for (const w of L.weapons) w.share = {};
    for (const s of L.mounts) for (const j of s.jobs || []) {
      let now = 0, used = 0;
      for (const e of j.reach) {
        const a = e.amt * e.k, w = e.w;
        if (a <= 1e-9 || w.load <= 1e-6) continue;
        now += a; used += a / w.load * w.inNow;
        w.share[j.prop] = Math.min(1, (w.share[j.prop] || 0) + a / w.load);
      }
      j.now = now;
      // (A special modifier uses its input for the power really treated: nothing while its guns rest)
      const need = COMPS[s.comp].needs, live = s.live;
      if (need && live && live.length && used > 0) for (const b of live) { b.buf = Math.max(0, b.buf - need.per * used / live.length); if (need.power) b.held = b.buf; }
    }
    for (const w of L.weapons) for (const prop in w.share) if (w.share[prop] < 0.005) delete w.share[prop];
    // What each line part carries, as a share of what the guns after it use (for the drawing)
    for (const p of L.line) {
      const fx = {}, guns = new Set(); let tot = 0;
      for (const { e } of p.ents) { if (!guns.has(e.w)) { guns.add(e.w); tot += e.w.load; } fx[e.prop] = (fx[e.prop] || 0) + e.amt * e.k; }
      for (const prop in fx) { fx[prop] = tot > 1e-6 ? Math.min(1, fx[prop] / tot) : 0; if (fx[prop] < 0.02) delete fx[prop]; }
      p.fx = fx;
    }
  }

  /** Clear every trace of treatment (after a rebuild that changed the lines, or Empty all) */
  function clear(parts) { for (const p of parts) { p.share = {}; p.fx = {}; delete p.load; } }

  /** A gun's property strengths: the share of the power it took lately that arrived treated each way, 0 to 1 */
  function strengths(w) { const o = {}; for (const prop in (w.share || {})) { const v = w.share[prop]; if (v >= 0.02) o[prop] = v >= 0.985 ? 1 : Math.round(v * 100) / 100; } return o; }
  /** What a line part carries, by property: the share of what the guns after it use */
  function mix(p) { return p.fx || {}; }

  /** What a gun fires, given its property strengths (0 to 1 each) and how fast it is really firing (0..1 of its full rate) */
  function spec(type, st, rateFrac, tune) {
    const t = T[type], S = (p) => Math.max(0, Math.min(1, st[p] || 0)), to = (full, k) => 1 + (full - 1) * k;
    const fl = t.beam ? BEAM_FLIGHT : FLIGHT[type] || [500, 600];
    // (A beam is shown as a fast stream of small shots; a shot gun's full rate allows for its discharge and its lines)
    const baseDamage = t.beam ? t.dps / BEAM_TICKS : t.damage, baseRate = PM.fullDps(t) / baseDamage;
    const rap = to(tune.rapid.rate, S('rapid')), rate = baseRate * rap * rateFrac;
    const heavyDamage = to(tune.heavy.damage, S('heavy')), hyperDamage = to(tune.hyper.damage, S('hyper'));
    const heavySpeed = to(tune.heavy.speed, S('heavy')), hyperSpeed = to(tune.hyper.speed, S('hyper'));
    const damage = baseDamage / rap * to(tune.rapid.total, S('rapid')) * heavyDamage * hyperDamage;
    // Split: the middle shot gives up an equal share to each side shot as the strength rises
    const sp = S('split'), shots = sp > 0 ? tune.split.shots : 1, splitTotal = to(tune.split.total, sp), mid = (shots - 1) / 2;
    const shotDmg = Array.from({ length: shots }, (_, i) => damage * splitTotal * (i === mid ? 1 - (shots - 1) * sp / shots : sp / shots));
    const ex = S('explosive'), direct = to(tune.explosive.direct, ex), blast = tune.explosive.blast * ex;
    const pi = S('pierce'), pf = tune.pierce.fracs, fracs = pi > 0 ? pf.map((f, i) => (i ? f * pi : 1 - (1 - f) * pi)) : [1];
    const perTarget = to(tune.wave.perTarget, S('wave')), burnTotal = tune.burn.total * S('burn');
    return {
      damage, shots, shotDmg, splitTotal, perShot: damage * splitTotal / shots, spreadDeg: tune.split.spreadDeg, rate,
      speed: fl[0] * to(tune.velocity.speed, S('velocity')) * heavySpeed * hyperSpeed, range: fl[1] * to(tune.velocity.range, S('velocity')),
      heavyDamage, heavySpeed, hyperDamage, hyperSpeed, burnTotal, burnSecs: tune.burn.secs,
      jumps: S('chain') > 0 ? tune.chain.jumps : 0, chainFrac: tune.chain.frac * S('chain'), chainReach: tune.chain.reach,
      direct, blast, radius: ex > 0 ? tune.explosive.radius[0] + (tune.explosive.radius[1] - tune.explosive.radius[0]) * ex : 0,
      fracs, bounces: S('bounce') > 0 ? tune.bounce.count : 0, bounceKeep: tune.bounce.keep * S('bounce'),
      width: to(tune.wave.width, S('wave')), perTarget,
      // Everything landing on one deep target, and the same gun plain at full rate
      dps: rate * damage * splitTotal * (direct + blast) * perTarget * (1 + burnTotal), baseDps: PM.fullDps(t),
    };
  }

  /** The mounts whose treated power can reach this gun (walking its lines back), for the cost against it */
  function upstream(w) {
    const seen = new Set([w]), out = [], q = [w];
    while (q.length) { const p = q.shift(); for (const l of p.inL || []) { const a = l.from; if (seen.has(a)) continue; seen.add(a); if (isMod(a)) out.push(a); q.push(a); } }
    return out;
  }

  return { COMPS, BLOCK, SPECIAL, HOPPERS, HOPPER, MOUNTS, socketsOf, costOf, RECIPES, PROPS, TUNE, MOD_CAT, isMod, tierOf, carries, recipe, link, before, after, clear, strengths, levels: strengths, mix, spec, upstream };
});
