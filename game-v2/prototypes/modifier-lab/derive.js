// The modifier lab's rules, as one pure function: a grid of parts in, every gun's properties and numbers out.
//   parts: [{ id, x, y, type: 'reactor' | 'conduit' | 'mod' | 'gun', kind, tier }], one cell each.
// Power runs from reactors through conduits and modifiers to guns. A modifier counts for a gun when it sits on a path
// the power takes to it (each step nearer a reactor). It treats so much energy a second, divided among the guns it feeds
// by their draw; the share of a gun's draw that is treated sets the level of the property. Two modifiers that touch and
// match a recipe fuse into a combination. Plain script: window.MLD in the page, require() in node (derive.check.mjs).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.MLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const key = (x, y) => x + ',' + y;
  const N4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const conducts = (p) => !!p && (p.type === 'reactor' || p.type === 'conduit' || p.type === 'mod');
  const pick = (list, l) => list[Math.min(l, list.length - 1)];
  const modTier = (cfg, p) => cfg.MOD_TIERS.find((t) => t.tier === p.tier) || cfg.MOD_TIERS[0];
  const recipeOf = (cfg, a, b) => cfg.RECIPES.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));

  function levelOf(share, thresholds) {
    let l = 0;
    for (const t of thresholds) if (share >= t - 1e-9) l++;
    return l;
  }

  function derive(parts, cfg) {
    const T = cfg.TUNE;
    const at = new Map(), byId = new Map();
    for (const p of parts) { at.set(key(p.x, p.y), p); byId.set(p.id, p); }
    const near = (p) => N4.map(([dx, dy]) => at.get(key(p.x + dx, p.y + dy))).filter(Boolean);
    const guns = parts.filter((p) => p.type === 'gun' && cfg.GUNS[p.kind]);
    const mods = parts.filter((p) => p.type === 'mod' && cfg.MODS[p.kind]).sort((a, b) => a.y - b.y || a.x - b.x);

    // Steps from the nearest reactor, through anything that conducts
    const dist = new Map(), q = [];
    for (const p of parts) if (p.type === 'reactor') { dist.set(p.id, 0); q.push(p); }
    for (let i = 0; i < q.length; i++) {
      for (const n of near(q[i])) if (conducts(n) && !dist.has(n.id)) { dist.set(n.id, dist.get(q[i].id) + 1); q.push(n); }
    }

    // A gun's line: every conducting cell on a path from it back to a reactor that gets nearer the reactor each step
    const line = new Map();
    for (const g of guns) {
      const stack = near(g).filter((n) => conducts(n) && dist.has(n.id));
      const seen = new Set(stack.map((n) => n.id));
      while (stack.length) {
        const p = stack.pop();
        for (const n of near(p)) {
          if (conducts(n) && dist.has(n.id) && dist.get(n.id) < dist.get(p.id) && !seen.has(n.id)) { seen.add(n.id); stack.push(n); }
        }
      }
      line.set(g.id, seen);
    }
    const feeds = (m) => guns.filter((g) => line.get(g.id).has(m.id)).map((g) => g.id);

    // Fusing: in reading order, a modifier pairs with the first unpaired one to its right or below that makes a recipe
    const fusedWith = new Map(), pairs = [];
    for (const m of mods) {
      if (fusedWith.has(m.id)) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = at.get(key(m.x + dx, m.y + dy));
        if (!n || n.type !== 'mod' || fusedWith.has(n.id) || !cfg.MODS[n.kind]) continue;
        const r = recipeOf(cfg, m.kind, n.kind);
        if (!r) continue;
        fusedWith.set(m.id, n.id); fusedWith.set(n.id, m.id);
        pairs.push({ a: m.id, b: n.id, prop: r.prop });
        break;
      }
    }

    // What treats energy: each loose modifier for its own property, each fused pair for its combination
    const units = [];
    for (const m of mods) {
      if (fusedWith.has(m.id) && !T.fusedKeepsSingles) continue;
      units.push({ prop: cfg.MODS[m.kind].prop, cap: modTier(cfg, m).capacity, guns: feeds(m), mods: [m.id] });
    }
    for (const pr of pairs) {
      const a = byId.get(pr.a), b = byId.get(pr.b), fb = new Set(feeds(b));
      units.push({ prop: pr.prop, cap: Math.min(modTier(cfg, a).capacity, modTier(cfg, b).capacity), guns: feeds(a).filter((id) => fb.has(id)), mods: [a.id, b.id] });
    }

    const baseDraw = (g) => cfg.GUNS[g.kind].rate * cfg.GUNS[g.kind].shotEnergy;
    const maxLevel = T.thresholds.length;
    function treat(rapid) {
      const draw = new Map(guns.map((g) => [g.id, baseDraw(g) * (1 + T.rapid.rate * rapid.get(g.id))]));
      const imbued = new Map(guns.map((g) => [g.id, {}]));
      for (const u of units) {
        let tot = 0;
        for (const id of u.guns) tot += draw.get(id);
        if (tot <= 0) continue;
        for (const id of u.guns) { const o = imbued.get(id); o[u.prop] = (o[u.prop] || 0) + u.cap * draw.get(id) / tot; }
      }
      return { draw, imbued };
    }
    // Rapid raises the draw, which thins every share (its own too): step each gun's Rapid down until it holds
    const rapid = new Map(guns.map((g) => [g.id, maxLevel]));
    let res = treat(rapid);
    for (let i = 0; i < maxLevel * guns.length + 1; i++) {
      let changed = false;
      for (const g of guns) {
        const share = Math.min(1, (res.imbued.get(g.id).rapid || 0) / res.draw.get(g.id));
        if (levelOf(share, T.thresholds) < rapid.get(g.id)) { rapid.set(g.id, rapid.get(g.id) - 1); changed = true; }
      }
      if (!changed) break;
      res = treat(rapid);
    }

    // Networks: everything joined together shares its reactors' supply
    const root = new Map(parts.map((p) => [p.id, p.id]));
    const find = (id) => { while (root.get(id) !== id) { root.set(id, root.get(root.get(id))); id = root.get(id); } return id; };
    for (const p of parts) for (const n of near(p)) if (conducts(p) || conducts(n)) root.set(find(p.id), find(n.id));
    const nets = new Map();
    const net = (id) => { const r = find(id); if (!nets.has(r)) nets.set(r, { supply: 0, upkeep: 0, demand: 0, factor: 1 }); return nets.get(r); };
    for (const p of parts) {
      if (p.type === 'reactor' && cfg.REACTORS[p.kind]) net(p.id).supply += cfg.REACTORS[p.kind].supply;
      if (p.type === 'mod' && dist.has(p.id)) net(p.id).upkeep += modTier(cfg, p).upkeep;
      if (p.type === 'gun' && line.get(p.id) && line.get(p.id).size) net(p.id).demand += res.draw.get(p.id);
    }
    for (const n of nets.values()) n.factor = n.demand > 0 ? Math.max(0, Math.min(1, (n.supply - n.upkeep) / n.demand)) : 1;

    // What each modifier costs the guns it feeds (split evenly)
    const modCost = new Map(guns.map((g) => [g.id, 0]));
    const modOut = mods.map((m) => {
      const f = feeds(m), t = modTier(cfg, m);
      for (const id of f) modCost.set(id, modCost.get(id) + t.cost / f.length);
      return { id: m.id, feeds: f, fusedWith: fusedWith.get(m.id) ?? null, capacity: t.capacity, powered: dist.has(m.id) };
    });

    const gunOut = guns.map((g) => {
      const base = cfg.GUNS[g.kind], draw = res.draw.get(g.id), imbued = res.imbued.get(g.id);
      const powered = line.get(g.id).size > 0, factor = powered ? net(g.id).factor : 0;
      const shares = {}, levels = {}, next = {};
      for (const prop of Object.keys(imbued)) {
        shares[prop] = Math.min(1, imbued[prop] / draw);
        levels[prop] = prop === 'rapid' ? rapid.get(g.id) : levelOf(shares[prop], T.thresholds);
        const t = T.thresholds[levels[prop]];
        if (t !== undefined) next[prop] = { at: t, more: Math.max(0, t * draw - imbued[prop]) };
      }
      const L = (p) => levels[p] || 0;
      const damage = base.damage * Math.pow(T.rapid.shotDamage, L('rapid'));
      const shots = pick(T.split.count, L('split')), splitTotal = pick(T.split.total, L('split'));
      const direct = pick(T.explosive.direct, L('explosive')), blast = pick(T.explosive.blast, L('explosive'));
      const perTarget = pick(T.wave.perTarget, L('wave'));
      const rate = base.rate * (1 + T.rapid.rate * L('rapid')) * factor;
      const stats = {
        damage, shots, perShot: damage * splitTotal / shots, spreadDeg: T.split.spreadDeg, rate,
        speed: base.speed * (1 + T.velocity.speed * L('velocity')), range: base.range * (1 + T.velocity.range * L('velocity')),
        direct, blast, radius: pick(T.explosive.radius, L('explosive')),
        fracs: pick(T.pierce.fracs, L('pierce')), bounces: pick(T.bounce.count, L('bounce')), bounceKeep: T.bounce.keep,
        width: pick(T.wave.width, L('wave')), perTarget,
        // Everything landing on one deep target
        dps: rate * damage * splitTotal * (direct + blast) * perTarget,
        baseDps: base.damage * base.rate,
      };
      const mc = modCost.get(g.id);
      return { id: g.id, kind: g.kind, name: base.name, tier: base.tier, powered, factor, draw: draw * factor, wants: draw, baseDraw: baseDraw(g),
        shares, levels, next, stats, line: [...line.get(g.id)], cost: { gun: base.cost, mods: mc, total: base.cost + mc } };
    });

    let cost = 0, supply = 0, upkeep = 0, demand = 0;
    for (const p of parts) {
      if (p.type === 'gun' && cfg.GUNS[p.kind]) cost += cfg.GUNS[p.kind].cost;
      else if (p.type === 'reactor' && cfg.REACTORS[p.kind]) cost += cfg.REACTORS[p.kind].cost;
      else if (p.type === 'mod') cost += modTier(cfg, p).cost;
      else if (p.type === 'conduit') cost += cfg.CONDUIT.cost;
    }
    for (const n of nets.values()) { supply += n.supply; upkeep += n.upkeep; demand += n.demand; }
    return { guns: gunOut, mods: modOut, pairs, dist, totals: { cost, supply, upkeep, demand, dps: gunOut.reduce((s, g) => s + g.stats.dps, 0) } };
  }

  return { derive, levelOf, conducts };
});
