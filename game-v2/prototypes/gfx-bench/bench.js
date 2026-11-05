// Standalone renderer comparison. Same CPU sim in every mode; only submission differs.
// URL: ?mode=pixi-webgl|pixi-webgpu|pixi-graphics|direct&p=10000&b=1000&k=100&auto=1
const W = 1280, H = 720;
const q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
for (const k of ['mode', 'p', 'b', 'k']) if (q.get(k)) $(k).value = q.get(k);

// ---- draw call counting (WebGL2 + WebGPU) ----
let draws = 0;
for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
  const o = WebGL2RenderingContext.prototype[n];
  WebGL2RenderingContext.prototype[n] = function (...a) { draws++; return o.apply(this, a); };
}
if (window.GPURenderPassEncoder) for (const n of ['draw', 'drawIndexed']) {
  const o = GPURenderPassEncoder.prototype[n];
  GPURenderPassEncoder.prototype[n] = function (...a) { draws++; return o.apply(this, a); };
}

// ---- shared simulation ----
function makeSim(P, B, K) {
  const r = Math.random;
  const s = {
    P, B, K,
    px: new Float32Array(P), py: new Float32Array(P), pvx: new Float32Array(P), pvy: new Float32Array(P), pl: new Float32Array(P), pc: new Uint32Array(P),
    bx: new Float32Array(B), by: new Float32Array(B), bvx: new Float32Array(B), bvy: new Float32Array(B), bc: new Uint32Array(B),
    kx: new Float32Array(K), ky: new Float32Array(K), kvx: new Float32Array(K), kvy: new Float32Array(K), ka: new Float32Array(K), kw: new Float32Array(K),
  };
  const pal = [0xff8030, 0xffd060, 0x60a0ff, 0xff4040, 0x80ffc0];
  for (let i = 0; i < P; i++) { s.px[i] = r() * W; s.py[i] = r() * H; const a = r() * 6.28, v = 20 + r() * 80; s.pvx[i] = Math.cos(a) * v; s.pvy[i] = Math.sin(a) * v; s.pl[i] = r(); s.pc[i] = pal[i % 5]; }
  for (let i = 0; i < B; i++) { s.bx[i] = r() * W; s.by[i] = r() * H; const a = r() * 6.28, v = 300 + r() * 200; s.bvx[i] = Math.cos(a) * v; s.bvy[i] = Math.sin(a) * v; s.bc[i] = pal[i % 5]; }
  for (let i = 0; i < K; i++) { s.kx[i] = r() * W; s.ky[i] = r() * H; s.kvx[i] = (r() - .5) * 60; s.kvy[i] = (r() - .5) * 60; s.ka[i] = r() * 6.28; s.kw[i] = (r() - .5); }
  return s;
}
function step(s, dt) {
  for (let i = 0; i < s.P; i++) {
    s.px[i] += s.pvx[i] * dt; s.py[i] += s.pvy[i] * dt; s.pl[i] -= dt * .5;
    if (s.pl[i] <= 0) { s.pl[i] = 1; s.px[i] = Math.random() * W; s.py[i] = Math.random() * H; }
  }
  for (let i = 0; i < s.B; i++) {
    let x = s.bx[i] + s.bvx[i] * dt, y = s.by[i] + s.bvy[i] * dt;
    if (x < 0) x += W; else if (x > W) x -= W;
    if (y < 0) y += H; else if (y > H) y -= H;
    s.bx[i] = x; s.by[i] = y;
  }
  for (let i = 0; i < s.K; i++) {
    let x = s.kx[i] + s.kvx[i] * dt, y = s.ky[i] + s.kvy[i] * dt;
    if (x < 0) x += W; else if (x > W) x -= W;
    if (y < 0) y += H; else if (y > H) y -= H;
    s.kx[i] = x; s.ky[i] = y; s.ka[i] += s.kw[i] * dt;
  }
}
// hull = 4 parts: body, 2 wings, engine glow (offset in ship space, w, h, color)
const HULL = [[0, 0, 28, 14, 0x8899aa], [-4, 10, 18, 8, 0x667788], [-4, -10, 18, 8, 0x667788], [-16, 0, 10, 10, 0xff9040]];

// ---- backends ----
async function makePixi(mode, s) {
  const app = new PIXI.Application();
  await app.init({ width: W, height: H, backgroundColor: 0x000011, antialias: true, preference: mode === 'pixi-webgpu' ? 'webgpu' : 'webgl', resolution: 1 });
  $('stage').replaceChildren(app.canvas);
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, '#fff'); g.addColorStop(1, '#fff0'); x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  const tex = PIXI.Texture.from(c);
  const pc = new PIXI.Container(), bc = new PIXI.Container(), kc = new PIXI.Container();
  app.stage.addChild(kc, bc, pc);
  const ps = [], bs = [], ks = [];
  for (let i = 0; i < s.P; i++) { const sp = new PIXI.Sprite(tex); sp.anchor.set(.5); sp.scale.set(.5); sp.tint = s.pc[i]; sp.blendMode = 'add'; pc.addChild(sp); ps.push(sp); }
  for (let i = 0; i < s.B; i++) { // as the game: one Graphics per projectile
    const gr = new PIXI.Graphics();
    gr.rect(-12, -1.5, 24, 3).fill({ color: s.bc[i] }); gr.circle(12, 0, 3).fill({ color: 0xffffff });
    gr.rotation = Math.atan2(s.bvy[i], s.bvx[i]); bc.addChild(gr); bs.push(gr);
  }
  for (let i = 0; i < s.K; i++) { // as the game: Container of Graphics parts
    const ct = new PIXI.Container();
    for (const [ox, oy, w, h, col] of HULL) { const gr = new PIXI.Graphics(); gr.roundRect(-w / 2, -h / 2, w, h, 3).fill({ color: col }); gr.position.set(ox, oy); ct.addChild(gr); }
    kc.addChild(ct); ks.push(ct);
  }
  return {
    name: app.renderer.name || mode,
    update() {
      for (let i = 0; i < s.P; i++) { const sp = ps[i]; sp.x = s.px[i]; sp.y = s.py[i]; sp.alpha = s.pl[i]; }
      for (let i = 0; i < s.B; i++) { const b = bs[i]; b.x = s.bx[i]; b.y = s.by[i]; }
      for (let i = 0; i < s.K; i++) { const k = ks[i]; k.x = s.kx[i]; k.y = s.ky[i]; k.rotation = s.ka[i]; }
    },
    render() { app.renderer.render(app.stage); },
    destroy() { app.destroy(true, { children: true, texture: true }); },
  };
}

// Mirrors the game's pattern (rendering/particlePool.ts, spritePool.ts, lighting/ShipBatch.ts):
//  - effects and bullets: one ParticleContainer each, Particle objects reused (begin/take/end), all properties dynamic,
//    one draw for the lot. (The game's pool swaps in a shader that picks one of 4 textures per particle; this uses Pixi's
//    default particle shader with one texture: same per-particle CPU, slightly cheaper fragment work.)
//  - hulls: chunks of 32 ships sharing one merged mesh, placed in the vertex shader from a uniform array (uXform),
//    as ShipBatch does (no lighting/damage here, so the hull shader is simpler than the game's).
// The WebGPU variant can only use Pixi's built-in particle shader and a built-in Mesh path for hulls: the game's
// custom shaders are GLSL (GlProgram) and would have to be rewritten in WGSL to run there.
const PER_CHUNK = 32;
async function makePixiGame(mode, s) {
  const gpu = mode === 'pixi-webgpu';
  const app = new PIXI.Application();
  await app.init({ width: W, height: H, backgroundColor: 0x000011, antialias: true, preference: gpu ? 'webgpu' : 'webgl', resolution: 1 });
  $('stage').replaceChildren(app.canvas);
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, '#fff'); g.addColorStop(1, '#fff0'); x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  const tex = PIXI.Texture.from(c);
  const dyn = { vertex: true, position: true, rotation: true, uvs: true, color: true };
  const mkPC = () => { const pc = new PIXI.ParticleContainer({ texture: tex, dynamicProperties: dyn }); pc.blendMode = 'add'; return pc; };
  const pcP = mkPC(), pcB = mkPC();
  const rgb = c => ((c & 0xff) << 16) + (c & 0xff00) + ((c >> 16) & 0xff);
  const mk = (pc, n) => { for (let i = 0; i < n; i++) { const p = new PIXI.Particle(tex); p.anchorX = p.anchorY = 0.5; pc.particleChildren.push(p); } };
  mk(pcP, s.P); mk(pcB, s.B);
  const hullLayer = new PIXI.Container();
  app.stage.addChild(hullLayer, pcB, pcP);
  const chunks = [];
  if (!gpu) {
    const vertex = `in vec2 aPos; in float aSlot; in vec3 aCol; uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform vec4 uXform[${PER_CHUNK}];
      out vec3 vCol; void main(){ vec4 t=uXform[int(aSlot)]; vec2 w=vec2(aPos.x*t.z-aPos.y*t.w, aPos.x*t.w+aPos.y*t.z)+t.xy;
      gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*vec3(w,1.)).xy,0.,1.); vCol=aCol; }`;
    const fragment = `in vec3 vCol; out vec4 o; void main(){ o=vec4(vCol,1.); }`;
    const prog = PIXI.GlProgram.from({ vertex, fragment, name: 'bench-hull' });
    for (let c0 = 0; c0 < s.K; c0 += PER_CHUNK) {
      const n = Math.min(PER_CHUNK, s.K - c0), pos = [], slot = [], col = [], idx = [];
      for (let i = 0; i < n; i++) for (const [ox, oy, w, h, cl] of HULL) {
        const b = pos.length / 2;
        for (const [qx, qy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(ox + qx * w / 2, oy + qy * h / 2); slot.push(i); col.push((cl >> 16 & 255) / 255, (cl >> 8 & 255) / 255, (cl & 255) / 255); }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      const geometry = new PIXI.Geometry({ attributes: { aPos: new Float32Array(pos), aSlot: new Float32Array(slot), aCol: new Float32Array(col) }, indexBuffer: new Uint32Array(idx) });
      const xf = new Float32Array(PER_CHUNK * 4);
      const ug = new PIXI.UniformGroup({ uXform: { value: xf, type: 'vec4<f32>', size: PER_CHUNK } });
      const shader = new PIXI.Shader({ glProgram: prog, resources: { chunk: ug } });
      const mesh = new PIXI.Mesh({ geometry, shader }); hullLayer.addChild(mesh);
      chunks.push({ c0, n, xf, ug });
    }
  } else { // fallback hull path under WebGPU: Container of Graphics parts (needs no custom shader)
    for (let i = 0; i < s.K; i++) {
      const ct = new PIXI.Container();
      for (const [ox, oy, w, h, cl] of HULL) { const gr = new PIXI.Graphics(); gr.roundRect(-w / 2, -h / 2, w, h, 3).fill({ color: cl }); gr.position.set(ox, oy); ct.addChild(gr); }
      hullLayer.addChild(ct); chunks.push(ct);
    }
  }
  return {
    name: app.renderer.name || mode,
    update() {
      const P = pcP.particleChildren, B = pcB.particleChildren;
      for (let i = 0; i < s.P; i++) { const p = P[i]; p.x = s.px[i]; p.y = s.py[i]; p.scaleX = p.scaleY = .5; p.color = rgb(s.pc[i]) + ((s.pl[i] * 255 | 0) << 24); }
      for (let i = 0; i < s.B; i++) { const p = B[i]; p.x = s.bx[i]; p.y = s.by[i]; p.rotation = Math.atan2(s.bvy[i], s.bvx[i]); p.scaleX = 1.5; p.scaleY = .25; p.color = rgb(s.bc[i]) + (255 << 24); }
      pcP.update(); pcB.update();
      if (!gpu) for (const ch of chunks) {
        for (let i = 0; i < ch.n; i++) { const k = ch.c0 + i; ch.xf[i * 4] = s.kx[k]; ch.xf[i * 4 + 1] = s.ky[k]; ch.xf[i * 4 + 2] = Math.cos(s.ka[k]); ch.xf[i * 4 + 3] = Math.sin(s.ka[k]); }
        ch.ug.update();
      } else chunks.forEach((ct, k) => { ct.x = s.kx[k]; ct.y = s.ky[k]; ct.rotation = s.ka[k]; });
    },
    render() { app.renderer.render(app.stage); },
    destroy() { app.destroy(true, { children: true, texture: true }); },
  };
}

function makeDirect(s) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; $('stage').replaceChildren(cv);
  const gl = cv.getContext('webgl2', { antialias: true, alpha: false });
  const vs = `#version 300 es
layout(location=0) in vec2 iPos; layout(location=1) in vec3 iRS; layout(location=2) in vec4 iCol;
uniform vec2 uRes; out vec2 vUV; out vec4 vCol;
void main(){ vec2 c=vec2(float(gl_VertexID&1), float((gl_VertexID>>1)&1))*2.-1.; vUV=c; vCol=iCol;
 float cs=cos(iRS.x), sn=sin(iRS.x); vec2 p=vec2(c.x*iRS.y, c.y*iRS.z); p=vec2(p.x*cs-p.y*sn, p.x*sn+p.y*cs)+iPos;
 gl_Position=vec4(p.x/uRes.x*2.-1., 1.-p.y/uRes.y*2., 0, 1); }`;
  const fs = `#version 300 es
precision mediump float; in vec2 vUV; in vec4 vCol; uniform int uShape; out vec4 o;
void main(){ float a=1.; if(uShape==0){ a=max(0.,1.-length(vUV)); } else { vec2 d=abs(vUV); a=1.-smoothstep(.8,1.,max(d.x,d.y)); }
 o=vec4(vCol.rgb*a*vCol.a, a*vCol.a); }`;
  const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
  gl.uniform2f(gl.getUniformLocation(pr, 'uRes'), W, H);
  const uShape = gl.getUniformLocation(pr, 'uShape');
  function layer(n) {
    const buf = new ArrayBuffer(Math.max(n, 1) * 24), f = new Float32Array(buf), u = new Uint8Array(buf);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 8); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 24, 20); gl.vertexAttribDivisor(2, 1);
    return {
      set(i, x, y, r, sx, sy, col, a) { const o = i * 6; f[o] = x; f[o + 1] = y; f[o + 2] = r; f[o + 3] = sx; f[o + 4] = sy; const b = i * 24 + 20; u[b] = col >> 16 & 255; u[b + 1] = col >> 8 & 255; u[b + 2] = col & 255; u[b + 3] = a * 255; },
      draw(shape, add) {
        if (!n) return;
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
        gl.uniform1i(uShape, shape); gl.blendFunc(gl.ONE, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      },
    };
  }
  const LP = layer(s.P), LB = layer(s.B), LK = layer(s.K * 4);
  gl.enable(gl.BLEND); gl.viewport(0, 0, W, H);
  return {
    name: 'webgl2-instanced',
    update() {
      for (let i = 0; i < s.P; i++) LP.set(i, s.px[i], s.py[i], 0, 8, 8, s.pc[i], s.pl[i]);
      for (let i = 0; i < s.B; i++) LB.set(i, s.bx[i], s.by[i], Math.atan2(s.bvy[i], s.bvx[i]), 12, 2, s.bc[i], 1);
      for (let i = 0; i < s.K; i++) {
        const cs = Math.cos(s.ka[i]), sn = Math.sin(s.ka[i]);
        for (let j = 0; j < 4; j++) { const [ox, oy, w, h, col] = HULL[j]; LK.set(i * 4 + j, s.kx[i] + ox * cs - oy * sn, s.ky[i] + ox * sn + oy * cs, s.ka[i], w / 2, h / 2, col, 1); }
      }
    },
    render() { gl.clearColor(0, 0, .067, 1); gl.clear(gl.COLOR_BUFFER_BIT); LK.draw(2, false); LB.draw(2, true); LP.draw(0, true); },
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}

// ---- runner ----
let cur = null, raf = 0;
async function start() {
  cancelAnimationFrame(raf); cur?.be.destroy(); cur = null;
  const mode = $('mode').value, P = +$('p').value, B = +$('b').value, K = +$('k').value;
  const s = makeSim(P, B, K);
  const be = mode === 'direct' ? makeDirect(s) : mode === 'pixi-graphics' ? await makePixi('pixi-webgl', s) : await makePixiGame(mode, s);
  cur = { be, s, mode, P, B, K };
  let last = performance.now(), acc = { n: 0, dt: 0, cpu: 0, dr: 0 }, lastShow = last;
  const loop = (t) => {
    const dt = Math.min(t - last, 100); last = t;
    const t0 = performance.now(); draws = 0;
    step(s, 1 / 60); be.update(); be.render();
    const cpu = performance.now() - t0, dr = draws;
    acc.n++; acc.dt += dt; acc.cpu += cpu; acc.dr += dr;
    cur.last = { dt, cpu, dr };
    if (t - lastShow > 500) {
      $('stats').textContent = `${be.name}  fps ${(1000 * acc.n / acc.dt).toFixed(1)}  frame ${(acc.dt / acc.n).toFixed(2)}ms  JS-cpu ${(acc.cpu / acc.n).toFixed(2)}ms  draws ${(acc.dr / acc.n).toFixed(0)}`;
      acc = { n: 0, dt: 0, cpu: 0, dr: 0 }; lastShow = t;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}
async function measure(frames = 120, warm = 40) {
  const rec = { dt: [], cpu: [], dr: [] };
  let n = 0;
  await new Promise(res => {
    const tick = () => {
      n++;
      if (n > warm && cur.last) { rec.dt.push(cur.last.dt); rec.cpu.push(cur.last.cpu); rec.dr.push(cur.last.dr); }
      if (n >= warm + frames) res(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const sorted = [...rec.dt].sort((a, b) => a - b);
  return { frameMs: +avg(rec.dt).toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2), cpuMs: +avg(rec.cpu).toFixed(2), draws: Math.round(avg(rec.dr)) };
}
const TIERS = [[1000, 200, 30], [10000, 1000, 100], [50000, 5000, 300], [100000, 10000, 300]];
async function table() {
  const rows = [];
  for (const [P, B, K] of TIERS) {
    $('p').value = P; $('b').value = B; $('k').value = K;
    try { await start(); const m = await measure(); rows.push({ renderer: cur.be.name, P, B, K, ...m }); }
    catch (e) { rows.push({ renderer: $('mode').value, P, B, K, error: String(e) }); }
  }
  window.__results = rows;
  $('out').innerHTML = '<table><tr><th>renderer</th><th>particles</th><th>bullets</th><th>hulls</th><th>frame ms</th><th>p95 ms</th><th>JS cpu ms</th><th>draws</th></tr>' +
    rows.map(r => r.error ? `<tr><td>${r.renderer}</td><td>${r.P}</td><td>${r.B}</td><td>${r.K}</td><td colspan=4>${r.error}</td></tr>` : `<tr><td>${r.renderer}</td><td>${r.P}</td><td>${r.B}</td><td>${r.K}</td><td>${r.frameMs}</td><td>${r.p95Ms}</td><td>${r.cpuMs}</td><td>${r.draws}</td></tr>`).join('') + '</table>';
  return rows;
}
$('go').onclick = start; $('table').onclick = table;
if (q.get('auto')) table().then(() => { window.__done = true; }); else start();
