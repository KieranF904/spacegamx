// The modifier lab's firing range: one gun on the left firing the shot the rules derived for it, at an armoured block
// (five cells deep, for Pierce), a loose cluster (for Explosive, Split and Wave) and round a baffle (for Bounce). It
// measures the damage that actually lands. Drawing and a small shot simulation only; no rules live here.
// Plain script: window.MLR.
(function (root) {
  'use strict';

  const W = 720, H = 260, GUN = { x: 36, y: 130 }, BAFFLE = { x: 390, y: 196, w: 10, h: 54 };
  const WINDOW = 4;

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.max(1, Math.min(2, root.devicePixelRatio || 1));
    canvas.width = W * dpr; canvas.height = H * dpr;
    let spec = null, col = '#f5a83a', shots = [], arcs = [], rings = [], floats = [], cells = [], hits = [], now = 0, acc = 0, since = 0, last = 0;
    let manual = false, held = false, wasLive = false, lastFire = -1e9;
    const aim = { x: 500, y: 130 };

    function build() {
      cells = [];
      for (let c = 0; c < 5; c++) for (let r = 0; r < 7; r++) cells.push({ x: 470 + c * 16, y: 74 + r * 16, s: 15, hp: 120, max: 120, back: 0 });
      for (let c = 0; c < 4; c++) for (let r = 0; r < 2; r++) cells.push({ x: 286 + c * 19, y: 26 + r * 19, s: 12, hp: 40, max: 40, back: 0 });
      // (One that moves, for what speed and accuracy are worth)
      cells.push({ x: 624, y: 40, s: 14, hp: 60, max: 60, back: 0, vy: 80, lo: 14, hi: 232 });
    }

    function setShot(s, colour) {
      spec = s; col = colour || col; shots = []; hits = []; acc = 0; since = now;
    }

    /** Change what is fired without restarting the range (shots in flight carry on unless clear is set) */
    function setSpec(s, colour, clear) {
      spec = s; col = colour || col;
      if (clear || !s) shots = [];
    }

    function hurt(cell, amount, quiet) {
      if (amount <= 0 || cell.hp <= 0) return;
      cell.hp -= amount;
      hits.push({ t: now, amount });
      if (!quiet && floats.length < 60) floats.push({ x: cell.x + cell.s / 2, y: cell.y, t: now, text: amount >= 10 ? amount.toFixed(0) : amount.toFixed(1) });
      // (Burn: this much of the hit again, spread over the next few seconds)
      if (!quiet && spec.burnTotal > 0) (cell.burns ??= []).push({ dps: amount * spec.burnTotal / spec.burnSecs, until: now + spec.burnSecs });
      if (cell.hp <= 0) { cell.back = now + 2.5; cell.burns = null; }
    }

    const mid = (c) => [c.x + c.s / 2, c.y + c.s / 2];
    // Chain: from the cell struck to the nearest one standing within reach, and on from there, each arc weaker
    function chain(from, dmg, seen) {
      let cur = from, d = dmg;
      for (let j = 0; j < (spec.jumps || 0); j++) {
        const [x, y] = mid(cur);
        let best = null, bd = spec.chainReach;
        for (const c of cells) { if (c.hp <= 0 || seen.has(c)) continue; const [cx, cy] = mid(c), dd = Math.hypot(cx - x, cy - y); if (dd < bd) { bd = dd; best = c; } }
        if (!best) return;
        d *= spec.chainFrac; seen.add(best);
        const [bx, by] = mid(best);
        arcs.push({ x1: x, y1: y, x2: bx, y2: by, t: now });
        hurt(best, d); cur = best;
      }
    }

    function burst(x, y, dmg) {
      if (!spec.blast) return;
      rings.push({ x, y, r: spec.radius, t: now });
      for (const c of cells) {
        if (c.hp <= 0) continue;
        const dx = Math.max(c.x - x, 0, x - c.x - c.s), dy = Math.max(c.y - y, 0, y - c.y - c.s);
        const d = Math.hypot(dx, dy);
        // (full at the hit, fading to nothing at the edge)
        if (d < spec.radius) hurt(c, dmg * spec.blast * (1 - d / spec.radius));
      }
    }

    const touches = (s, r) => {
      const dx = Math.max(r.x - s.x, 0, s.x - r.x - (r.w ?? r.s)), dy = Math.max(r.y - s.y, 0, s.y - r.y - (r.h ?? r.s));
      return dx * dx + dy * dy <= s.r * s.r;
    };

    // A wall or the baffle: come off it if the shot has a bounce left, else die there
    function wall(s, flipX) {
      if (s.bounces > 0) {
        s.bounces--; s.dmg *= spec.bounceKeep;
        if (flipX) s.vx = -s.vx; else s.vy = -s.vy;
        return;
      }
      s.dead = true;
      burst(s.x, s.y, s.dmg);
    }

    function fire() {
      const a = Math.atan2(aim.y - GUN.y, aim.x - GUN.x), n = spec.shots;
      for (let i = 0; i < n; i++) {
        const b = a + ((i - (n - 1) / 2) * spec.spreadDeg) * Math.PI / 180;
        shots.push({ x: GUN.x + Math.cos(b) * 14, y: GUN.y + Math.sin(b) * 14, vx: Math.cos(b) * spec.speed, vy: Math.sin(b) * spec.speed,
          r: 2.5 * spec.width, dmg: spec.shotDmg ? spec.shotDmg[i] : spec.perShot, depth: 0, seen: new Set(), bounces: spec.bounces, gone: 0, dead: false });
      }
    }

    function stepShot(s, dt) {
      const speed = Math.hypot(s.vx, s.vy), steps = Math.max(1, Math.ceil(speed * dt / 4)), h = dt / steps;
      for (let i = 0; i < steps && !s.dead; i++) {
        const px = s.x;
        s.x += s.vx * h; s.y += s.vy * h; s.gone += speed * h;
        if (s.gone > spec.range) { s.dead = true; return; }
        if (s.x < s.r || s.x > W - s.r) { s.x = Math.max(s.r, Math.min(W - s.r, s.x)); wall(s, true); continue; }
        if (s.y < s.r || s.y > H - s.r) { s.y = Math.max(s.r, Math.min(H - s.r, s.y)); wall(s, false); continue; }
        if (touches(s, BAFFLE)) {
          const side = px < BAFFLE.x || px > BAFFLE.x + BAFFLE.w;
          s.x -= s.vx * h; s.y -= s.vy * h;
          wall(s, side);
          continue;
        }
        let struck = cells.filter((c) => c.hp > 0 && !s.seen.has(c) && touches(s, c));
        if (!struck.length) continue;
        if (spec.width > 1) {
          // A wide shot strikes everything across its front
          const front = { x: s.x + s.vx / speed * 6, y: s.y + s.vy / speed * 6, r: s.r };
          struck = cells.filter((c) => c.hp > 0 && !s.seen.has(c) && touches(front, c));
        } else if (struck.length > 1) {
          // A plain shot strikes one cell: the nearest
          const d = (c) => Math.hypot(c.x + c.s / 2 - s.x, c.y + c.s / 2 - s.y);
          struck = [struck.reduce((a, b) => (d(b) < d(a) ? b : a))];
        }
        const frac = spec.fracs[s.depth];
        for (const c of struck) { s.seen.add(c); hurt(c, s.dmg * spec.direct * spec.perTarget * frac); }
        if (s.depth === 0 && spec.jumps) chain(struck[0], s.dmg * spec.direct * spec.perTarget * frac, new Set(struck));
        if (s.depth === 0) burst(s.x, s.y, s.dmg);
        if (++s.depth >= spec.fracs.length) s.dead = true;
      }
    }

    function step(dt) {
      now += dt;
      for (const c of cells) {
        if (c.hp <= 0 && now >= c.back) c.hp = c.max;
        if (c.vy) { c.y += c.vy * dt; if (c.y < c.lo) { c.y = c.lo; c.vy = -c.vy; } else if (c.y > c.hi) { c.y = c.hi; c.vy = -c.vy; } }
        if (c.burns && c.burns.length) { c.burns = c.burns.filter((b) => b.until > now); for (const b of c.burns) hurt(c, b.dps * dt, true); }
      }
      arcs = arcs.filter((a) => now - a.t < 0.18);
      // The trigger: always down on auto fire, else while the left button is held on the range. A fresh pull fires at
      // once unless the gun fired too recently for its rate.
      const live = !!spec && spec.rate > 0 && (!manual || held);
      if (live) {
        if (!wasLive) acc = Math.min(1, (now - lastFire) * spec.rate);
        acc += dt * spec.rate;
        while (acc >= 1) { acc--; fire(); lastFire = now; }
      }
      wasLive = live;
      if (spec) for (const s of shots) stepShot(s, dt); else shots = [];
      shots = shots.filter((s) => !s.dead);
      rings = rings.filter((r) => now - r.t < 0.35);
      floats = floats.filter((f) => now - f.t < 0.8);
      hits = hits.filter((x) => now - x.t < WINDOW);
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0f13'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#2a3742'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W - 2, H - 2);
      if (spec) {
        ctx.strokeStyle = 'rgba(139,155,167,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
        ctx.beginPath(); ctx.arc(GUN.x, GUN.y, spec.range, -Math.PI / 2, Math.PI / 2); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = '#3a4853'; ctx.fillRect(BAFFLE.x, BAFFLE.y, BAFFLE.w, BAFFLE.h);
      for (const c of cells) {
        if (c.hp <= 0) { ctx.strokeStyle = '#1d262e'; ctx.lineWidth = 1; ctx.strokeRect(c.x + 0.5, c.y + 0.5, c.s - 1, c.s - 1); continue; }
        const k = c.hp / c.max;
        ctx.fillStyle = `rgb(${Math.round(239 - 132 * k)},${Math.round(106 + 12 * k)},${Math.round(90 + 38 * k)})`;
        ctx.fillRect(c.x, c.y, c.s, c.s);
        if (c.burns && c.burns.length) { ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 2; ctx.strokeRect(c.x + 1, c.y + 1, c.s - 2, c.s - 2); }
      }
      for (const a of arcs) {
        const k = (now - a.t) / 0.18, mx = (a.x1 + a.x2) / 2 + (a.y2 - a.y1) * 0.18, my = (a.y1 + a.y2) / 2 - (a.x2 - a.x1) * 0.18;
        ctx.strokeStyle = `rgba(94,242,224,${1 - k})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(mx, my); ctx.lineTo(a.x2, a.y2); ctx.stroke();
      }
      const a = Math.atan2(aim.y - GUN.y, aim.x - GUN.x);
      ctx.strokeStyle = '#dde5ea'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(GUN.x, GUN.y); ctx.lineTo(GUN.x + Math.cos(a) * 16, GUN.y + Math.sin(a) * 16); ctx.stroke();
      ctx.fillStyle = '#1d262e'; ctx.strokeStyle = '#dde5ea'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(GUN.x, GUN.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'round';
      for (const s of shots) {
        const sp = Math.hypot(s.vx, s.vy), ux = s.vx / sp, uy = s.vy / sp;
        if (spec.width > 1) {
          ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(s.x - uy * s.r, s.y + ux * s.r); ctx.lineTo(s.x + uy * s.r, s.y - ux * s.r); ctx.stroke();
        } else {
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(s.x - ux * 9, s.y - uy * 9); ctx.lineTo(s.x, s.y); ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
      for (const r of rings) {
        const k = (now - r.t) / 0.35;
        ctx.strokeStyle = `rgba(255,138,61,${0.8 * (1 - k)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r * (0.4 + 0.6 * k), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center';
      for (const f of floats) {
        const k = (now - f.t) / 0.8;
        ctx.fillStyle = `rgba(221,229,234,${1 - k})`; ctx.fillText(f.text, f.x, f.y - 3 - k * 14);
      }
      if (!spec) {
        ctx.fillStyle = '#8b9ba7'; ctx.font = '13px "IBM Plex Sans", system-ui, sans-serif';
        ctx.fillText('Select a gun on the grid to fire it here', W / 2, H / 2 + 60);
      } else if (manual && !held && !shots.length) {
        ctx.fillStyle = '#8b9ba7'; ctx.font = '13px "IBM Plex Sans", system-ui, sans-serif';
        ctx.fillText(spec.rate > 0 ? 'Hold left click here to fire' : 'No power is reaching this gun', W / 2, H / 2 + 60);
      }
    }

    function frame(t) {
      const dt = Math.min(0.05, last ? (t - last) / 1000 : 0);
      last = t;
      step(dt); draw();
      root.requestAnimationFrame(frame);
    }

    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      aim.x = (e.clientX - r.left) * W / r.width; aim.y = (e.clientY - r.top) * H / r.height;
    };
    canvas.addEventListener('pointermove', point);
    canvas.addEventListener('pointerdown', (e) => {
      point(e);
      if (e.button !== 0) return;
      held = true; e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    });
    const release = () => { held = false; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    root.addEventListener('blur', release);

    build();
    root.requestAnimationFrame(frame);
    return {
      setShot,
      setSpec,
      /** true: fire only while the left button is held on the range; false: fire all the time */
      setManual(on) { manual = !!on; },
      // Damage a second that landed over the last few seconds
      measured() { const span = Math.max(0.5, Math.min(WINDOW, now - since)); return hits.reduce((s, x) => s + x.amount, 0) / span; },
    };
  }

  root.MLR = { create };
})(typeof self !== 'undefined' ? self : this);
