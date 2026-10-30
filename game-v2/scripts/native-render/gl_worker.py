"""
The native renderer's GL side: a persistent child of the Node service (service.ts). It holds one standalone OpenGL
context (moderngl: the real GPU, no window, no browser), the game's hull and lit shaders as Node read them out of the
TypeScript (ported to GLSL 3.30 at load), the hull atlas, and the last few assets' meshes on the GPU.

Protocol on stdin/stdout, each message: u32 header length, JSON header, u32 payload length, payload (little-endian).
  init    {shaders, tables, atlas: {w, h}}  payload: atlas RGBA
  render  {key, draws?: [...], view}       payload: the draws' arrays (omitted when the worker has `key` cached)
  sky     {shaders, size}                  payload: the sky's noise RGBA (first asked for by a starfield render)
Answers: {ok, ms, ...} and a PNG (or {miss: true}: send the draws again; or {error}).
"""
import io
import json
import struct
import sys
import time
import zlib
from collections import OrderedDict

import moderngl
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer


def read_exact(n):
    out = bytearray()
    while len(out) < n:
        chunk = stdin.read(n - len(out))
        if not chunk:
            sys.exit(0)
        out += chunk
    return bytes(out)


def read_msg():
    (hl,) = struct.unpack('<I', read_exact(4))
    header = json.loads(read_exact(hl))
    (pl,) = struct.unpack('<I', read_exact(4))
    return header, read_exact(pl) if pl else b''


def send(header, payload=b''):
    h = json.dumps(header).encode()
    stdout.write(struct.pack('<I', len(h)) + h + struct.pack('<I', len(payload)) + payload)
    stdout.flush()


FLAT_VS = """#version 330 core
in vec2 aPosition; in vec4 aColor; in float aMetal; in float aPart;
uniform vec4 uX; uniform mat3 uProjectionMatrix; uniform vec3 uLevel; uniform float uDepth; uniform sampler2D uDamage;
out vec4 vColor;
void main() {
  vec2 w = uX.xy + vec2(uX.z * aPosition.x - uX.w * aPosition.y, uX.w * aPosition.x + uX.z * aPosition.y);
  // (as the game tints its guns, Pixi's tint, each channel at most 1: metal by the light on it, lit bits as they are;
  // both towards ember red as their part is hurt: ShipRenderer hurt())
  vec3 tint = mix(vec3(1.0), min(uLevel, vec3(1.0)), aMetal);
  if (aPart > -0.5) tint = mix(vec3(0.227, 0.051, 0.031), tint, 0.35 + 0.65 * min(1.0, texelFetch(uDamage, ivec2(int(aPart + 0.5), 0), 0).r));
  vColor = vec4(aColor.rgb * tint, aColor.a);
  gl_Position = vec4((uProjectionMatrix * vec3(w, 1.0)).xy, uDepth, 1.0);
}"""
FLAT_FS = """#version 330 core
in vec4 vColor; out vec4 fragColor;
void main() { fragColor = vColor; }"""


SPR_VS = """#version 330 core
in vec2 aPosition; in vec2 aUV; in vec4 aColor;
uniform vec4 uX; uniform mat3 uProjectionMatrix;
out vec2 vUV; out vec4 vColor;
void main() {
  vec2 w = uX.xy + vec2(uX.z * aPosition.x - uX.w * aPosition.y, uX.w * aPosition.x + uX.z * aPosition.y);
  vUV = aUV; vColor = aColor;
  gl_Position = vec4((uProjectionMatrix * vec3(w, 1.0)).xy, 0.0, 1.0);
}"""
# (a sprite's colour as Pixi gives it: its texture, premultiplied, x its tint x alpha)
SPR_FS = """#version 330 core
in vec2 vUV; in vec4 vColor; uniform sampler2D uTex; out vec4 fragColor;
void main() { fragColor = texture(uTex, vUV) * vColor; }"""
QUAD_VS = """#version 330 core
in vec2 aPosition; in vec2 aUV; out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPosition, 0.0, 1.0); }"""
TEX_FS = """#version 330 core
in vec2 vUV; uniform sampler2D uTex; uniform float uMulA; out vec4 fragColor;
void main() { vec4 c = texture(uTex, vUV); fragColor = vec4(c.rgb * mix(1.0, c.a, uMulA), c.a); }"""
# (a gaussian along one axis: the bloom's blur)
BLUR_FS = """#version 330 core
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uStep; uniform float uSigma; out vec4 fragColor;
void main() {
  int R = int(ceil(uSigma * 3.0));
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int i = -R; i <= R; i++) { float k = exp(-float(i * i) / (2.0 * uSigma * uSigma)); sum += texture(uTex, vUV + uStep * float(i)) * k; wsum += k; }
  fragColor = sum / wsum;
}"""

# ---- effect textures (rendering/fxTextures.ts paints them on a canvas: here with PIL), premultiplied RGBA like a canvas's
PLUME_W, PLUME_H, PAD, PLUME_LEN, PLUME_HALF = 256, 128, 6, 1.3, 1.7 * 1.25


def _mask(pts, size, sigma):
    """A polygon's coverage 0..1 (4x supersampled), blurred as a canvas blur(sigma px) would"""
    w, h = size
    im = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(im).polygon([(x * 4, y * 4) for x, y in pts], fill=255)
    im = im.resize((w, h), Image.BOX)
    if sigma:
        im = im.filter(ImageFilter.GaussianBlur(sigma))
    return np.asarray(im, np.float32) / 255.0


def _plume_pts(length, half, bulge):
    sx, sy = (PLUME_W - PAD * 2) / PLUME_LEN, (PLUME_H / 2 - PAD) / PLUME_HALF
    pts = [(0, -half), (length * .28, -half * bulge), (length * .65, -half * .45), (length, 0), (length * .65, half * .45), (length * .28, half * bulge), (0, half)]
    return [(PAD + x * sx, PLUME_H / 2 + y * sy) for x, y in pts]


def _premult(layers, size):
    """'lighter' compositing of (mask, rgb, alpha) layers into premultiplied uint8 RGBA"""
    out = np.zeros((size[1], size[0], 4), np.float32)
    for m, rgb, a in layers:
        out[..., :3] += m[..., None] * a * np.asarray(rgb, np.float32)
        out[..., 3] += m * a
    return (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


def _rgb(c):
    return ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255


def make_texture_data(name):
    """(w, h, RGBA bytes) for an effect texture by name"""
    size = (PLUME_W, PLUME_H)
    parts = name.split(':')
    if parts[0] == 'white':
        return 1, 1, bytes([255, 255, 255, 255])
    if parts[0] == 'plume' and len(parts) == 4:
        outer, inner, glow = (_rgb(int(x)) for x in parts[1:])
        layers = [(_mask(_plume_pts(1.3, 1.7, 1.25), size, 2), glow, 0.1), (_mask(_plume_pts(1, 1.02, 1.1), size, 2), outer, 0.32),
                  (_mask(_plume_pts(0.68, 0.66, 1.0), size, 1), inner, 0.5)]
        return PLUME_W, PLUME_H, _premult(layers, size).tobytes()
    if name == 'plume:core':
        return PLUME_W, PLUME_H, _premult([(_mask(_plume_pts(0.34, 0.34, 0.95), size, 1), (1, 1, 1), 0.85)], size).tobytes()
    if name == 'plume:diamonds':
        sx, sy = (PLUME_W - PAD * 2) / PLUME_LEN, (PLUME_H / 2 - PAD) / PLUME_HALF

        def at(x, y):
            return (PAD + x * sx, PLUME_H / 2 + y * sy)
        layers = []
        for i in range(3):
            d, sz = 0.3 + i * 0.18, 0.32 - i * 0.07
            layers.append((_mask([at(d - sz * .15, 0), at(d, sz * .6), at(d + sz * .15, 0), at(d, -sz * .6)], size, 0.6), (1, 1, 1), 0.45 * (1 - i * 0.25)))
        return PLUME_W, PLUME_H, _premult(layers, size).tobytes()
    if parts[0] == 'dot':
        core, halo = float(parts[1]), float(parts[2])
        y, x = np.mgrid[0:64, 0:64]
        r = np.hypot(x + 0.5 - 32, y + 0.5 - 32) / 32
        stops = [(0, 1), (core * .8, .95), (core, max(halo * 2.5, .3)), (min(.99, core + .08), halo), (1, 0)]
        a = np.interp(r, [t[0] for t in stops], [t[1] for t in stops]).astype(np.float32)
        a[r >= 1] = 0
        px = np.repeat((np.clip(a, 0, 1) * 255 + .5).astype(np.uint8)[..., None], 4, axis=2)
        return 64, 64, px.tobytes()
    if name == 'beam':
        y, x = np.mgrid[0:128, 0:256]
        u, v = x / 255, np.abs(y - 63.5) / 64
        side = v / np.maximum(u, 0.01)
        across = 1 - np.clip((side - .45) / .55, 0, 1)
        a = np.where(side >= 1, 0, np.power(1 - u, 1.7) * across * across * np.minimum(1, u * 25))
        px = np.repeat((np.clip(a, 0, 1) * 255 + .5).astype(np.uint8)[..., None], 4, axis=2)
        return 256, 128, px.tobytes()
    raise ValueError(f'unknown texture {name}')


PNG_SIG = bytes([0x89]) + b'PNG' + bytes([13, 10, 26, 10])


def png_bytes(pil, level):
    """A PNG: level 0 written by hand (stored blocks, a third of PIL's time), the rest by PIL"""
    if level == 0:
        a = np.asarray(pil)
        h, w = a.shape[:2]
        raw = np.concatenate([np.zeros((h, 1), np.uint8), a.reshape(h, -1)], axis=1).tobytes()

        def chunk(t, d):
            return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
        return (PNG_SIG + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6 if a.shape[2] == 4 else 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 0)) + chunk(b'IEND', b''))
    buf = io.BytesIO()
    pil.save(buf, 'PNG', compress_level=level)
    return buf.getvalue()


class Worker:
    def __init__(self):
        self.ctx = moderngl.create_standalone_context(require=330)
        self.cache = OrderedDict()
        self.kept = 400
        self.fbo_size = None
        self.textures = {}
        self.bloom_size = None
        self.sky_ready = False

    def init(self, h, payload):
        ctx = self.ctx
        s = h['shaders']
        self.hull = ctx.program(vertex_shader=s['hullVertex'], fragment_shader=s['hullFragment'])
        self.lit = ctx.program(vertex_shader=s['litVertex'], fragment_shader=s['litFragment'])
        self.flat = ctx.program(vertex_shader=FLAT_VS, fragment_shader=FLAT_FS)
        self.spr = ctx.program(vertex_shader=SPR_VS, fragment_shader=SPR_FS)
        self.texp = ctx.program(vertex_shader=QUAD_VS, fragment_shader=TEX_FS)
        self.blur = ctx.program(vertex_shader=QUAD_VS, fragment_shader=BLUR_FS)
        # (a full-screen quad: clip positions, uv straight from them; and one with uv (0, 0) at the screen's top left, for the sky)
        pos = np.array([[-1, -1], [1, -1], [-1, 1], [1, 1]], np.float32)
        self.quad = ctx.buffer(np.concatenate([pos, (pos + 1) / 2], axis=1).astype(np.float32).tobytes())
        self.quad_sky = ctx.buffer(np.array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0], np.float32).tobytes())
        self.texp_vao = ctx.vertex_array(self.texp, [(self.quad, '2f 2f', 'aPosition', 'aUV')])
        self.blur_vao = ctx.vertex_array(self.blur, [(self.quad, '2f 2f', 'aPosition', 'aUV')])
        t = h['tables']
        self.tables = t
        a = h['atlas']
        self.atlas = ctx.texture((a['w'], a['h']), 4, payload)
        self.atlas.build_mipmaps()
        self.atlas.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
        self.atlas.anisotropy = 16.0
        self.atlas.repeat_x = self.atlas.repeat_y = False
        dmg = np.full((t['damageH'], t['damageW'], 4), 255, np.uint8)
        self.damage = ctx.texture((t['damageW'], t['damageH']), 4, dmg.tobytes())
        self.damage.filter = (moderngl.NEAREST, moderngl.NEAREST)
        for name, v in (('uKindLook', t['uKindLook']), ('uKindGlow', t['uKindGlow']), ('uGlowCool', t['uGlowCool']),
                        ('uGlowWarm', t['uGlowWarm']), ('uWear', t['uWear'])):
            self.set(self.hull, name, v)
        self.set(self.hull, 'uDamage', 0)
        self.set(self.hull, 'uDetail', 1)
        self.set(self.flat, 'uDamage', 0)
        info = ctx.info
        return {'ok': True, 'gl': info['GL_RENDERER'], 'version': info['GL_VERSION']}

    @staticmethod
    def set(prog, name, v):
        """A uniform by name, arrays padded to their length (no-op if the compiler dropped it)"""
        if name not in prog:
            return
        u = prog[name]
        if isinstance(v, (int, float)):
            if u.dimension == 1 and u.array_length == 1:
                u.value = v
                return
            v = [v]
        arr = np.zeros(u.array_length * u.dimension, np.float32 if u.fmt[-1] == 'f' else np.int32)
        flat = np.asarray(v, arr.dtype).ravel()[: arr.size]
        arr[: flat.size] = flat
        u.write(arr.tobytes())

    def make(self, d, payload):
        ctx = self.ctx
        prog = {'hull': self.hull, 'lit': self.lit, 'flat': self.flat, 'sprite': self.spr}[d['kind']]
        bufs, content = [], []
        for name, (off, length, size) in d['attrs'].items():
            if name not in prog:
                continue
            vbo = ctx.buffer(payload[off: off + length])
            bufs.append(vbo)
            content.append((vbo, f'{size}f', name))
        off, length = d['idx']
        ibo = ctx.buffer(payload[off: off + length])
        bufs.append(ibo)
        vao = ctx.vertex_array(prog, content, index_buffer=ibo, index_element_size=4)
        return {'vao': vao, 'prog': prog, 'bufs': bufs, 'meta': d}

    def free(self, made):
        for m in made:
            m['vao'].release()
            for b in m['bufs']:
                b.release()

    def upload(self, key, draws, payload):
        self.cache[key] = [self.make(d, payload) for d in draws]
        self.cache.move_to_end(key)
        while len(self.cache) > self.kept:
            self.drop(next(iter(self.cache)))

    def texture(self, name):
        t = self.textures.get(name)
        if t is None:
            w, h, data = make_texture_data(name)
            t = self.ctx.texture((w, h), 4, data)
            if w > 1:
                t.build_mipmaps()
                t.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
            t.repeat_x = t.repeat_y = False
            self.textures[name] = t
        return t

    def init_sky(self, h, payload):
        ctx = self.ctx
        s = h['shaders']
        self.haze = ctx.program(vertex_shader=s['skyVert'], fragment_shader=s['hazeFrag'])
        self.stars = ctx.program(vertex_shader=s['skyVert'], fragment_shader=s['starsFrag'])
        n = h['size']
        self.noise = ctx.texture((n, n), 4, payload)
        self.noise.build_mipmaps()
        self.noise.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
        self.noise.repeat_x = self.noise.repeat_y = True
        self.haze_vao = ctx.vertex_array(self.haze, [(self.quad_sky, '2f 2f', 'aPosition', 'aUV')])
        self.stars_vao = ctx.vertex_array(self.stars, [(self.quad_sky, '2f 2f', 'aPosition', 'aUV')])
        self.haze_fbo_size = None
        self.sky_ready = True
        return {'ok': True}

    def draw_sky(self, sky, css):
        """The sky as the game draws it: the haze into a texture half the view's size (CSS px), stretched over it, the stars added"""
        ctx = self.ctx
        hw, hh = max(1, -(-css['w'] // 2)), max(1, -(-css['h'] // 2))
        if self.haze_fbo_size != (hw, hh):
            if self.haze_fbo_size:
                self.haze_fbo.release()
                self.haze_tex.release()
            self.haze_tex = ctx.texture((hw, hh), 4, dtype='f2')
            self.haze_tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
            self.haze_tex.repeat_x = self.haze_tex.repeat_y = False
            self.haze_fbo = ctx.framebuffer(color_attachments=[self.haze_tex])
            self.haze_fbo_size = (hw, hh)
        ident = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        for prog, vals in ((self.haze, sky['haze']), (self.stars, sky['stars'])):
            for name in ('uProjectionMatrix', 'uWorldTransformMatrix', 'uTransformMatrix'):
                self.set(prog, name, ident)
            for name, val in vals.items():
                self.set(prog, name, val)
            self.set(prog, 'uNoise', 3)
        self.noise.use(3)
        self.haze_fbo.use()
        ctx.viewport = (0, 0, hw, hh)
        ctx.disable(moderngl.BLEND)
        self.haze_vao.render(moderngl.TRIANGLE_STRIP)
        # (back to the picture: the haze stretched over it, then the stars added)
        self.ms.use()
        ctx.viewport = (0, 0, self.fbo_size[0], self.fbo_size[1])
        self.haze_tex.use(4)
        self.set(self.texp, 'uTex', 4)
        self.set(self.texp, 'uMulA', 0.0)
        self.texp_vao.render(moderngl.TRIANGLE_STRIP)
        ctx.enable(moderngl.BLEND)
        ctx.blend_func = (moderngl.ONE, moderngl.ONE)
        self.stars_vao.render(moderngl.TRIANGLE_STRIP)

    def bloom(self, passes, css, sigma, mula=0.0):
        """The glowing things (flames, exhaust, beams: `passes`) drawn into a texture a quarter of the view's size, blurred, and added over the picture"""
        ctx = self.ctx
        bw, bh = max(1, -(-css['w'] // 4)), max(1, -(-css['h'] // 4))
        if self.bloom_size != (bw, bh):
            if self.bloom_size:
                for o in self.bloom_fbos + self.bloom_texs:
                    o.release()
            self.bloom_texs = [ctx.texture((bw, bh), 4, dtype='f2') for _ in range(2)]
            for t in self.bloom_texs:
                t.filter = (moderngl.LINEAR, moderngl.LINEAR)
                t.repeat_x = t.repeat_y = False
            self.bloom_fbos = [ctx.framebuffer(color_attachments=[t]) for t in self.bloom_texs]
            self.bloom_size = (bw, bh)
        self.bloom_fbos[0].use()
        ctx.viewport = (0, 0, bw, bh)
        ctx.clear(0, 0, 0, 0)
        ctx.enable(moderngl.BLEND)
        for X, m, blend in passes:
            ctx.blend_func = (moderngl.ONE, moderngl.ONE) if blend == 'add' else (moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA)
            self.set(self.spr, 'uX', X)
            self.texture(m['meta']['tex']).use(2)
            self.set(self.spr, 'uTex', 2)
            m['vao'].render(moderngl.TRIANGLES)
        ctx.disable(moderngl.BLEND)
        # (blurred along each axis in turn)
        for src, dst, step in ((0, 1, (1.0 / bw, 0.0)), (1, 0, (0.0, 1.0 / bh))):
            self.bloom_fbos[dst].use()
            self.bloom_texs[src].use(5)
            self.set(self.blur, 'uTex', 5)
            self.set(self.blur, 'uStep', step)
            self.set(self.blur, 'uSigma', sigma)
            self.blur_vao.render(moderngl.TRIANGLE_STRIP)
        self.ms.use()
        ctx.viewport = (0, 0, self.fbo_size[0], self.fbo_size[1])
        ctx.enable(moderngl.BLEND)
        ctx.blend_func = (moderngl.ONE, moderngl.ONE)
        self.bloom_texs[0].use(5)
        self.set(self.texp, 'uTex', 5)
        self.set(self.texp, 'uMulA', mula)
        self.texp_vao.render(moderngl.TRIANGLE_STRIP)
        ctx.disable(moderngl.BLEND)

    def target(self, w, h, samples):
        if self.fbo_size == (w, h, samples):
            return
        if self.fbo_size:
            for o in (self.ms, self.out):
                o.release()
        ctx = self.ctx
        self.ms = ctx.framebuffer(color_attachments=[ctx.renderbuffer((w, h), 4, samples=samples)],
                                  depth_attachment=ctx.depth_renderbuffer((w, h), samples=samples))
        self.out = ctx.framebuffer(color_attachments=[ctx.renderbuffer((w, h), 4)])
        self.fbo_size = (w, h, samples)

    def render(self, h, payload):
        t0 = time.perf_counter()
        items = h['items']
        for it in items:
            if it['key'] not in self.cache:
                if 'draws' not in it:
                    return {'miss': True}, b''
            elif 'draws' in it:
                self.drop(it['key'])
        for it in items:
            if 'draws' in it:
                self.upload(it['key'], it['draws'], payload)
            else:
                self.cache.move_to_end(it['key'])
        t1 = time.perf_counter()
        v = h['view']
        w, hh = v['w'], v['h']
        samples = min(h.get('samples', 8), self.ctx.max_samples)
        self.target(w, hh, samples)
        ctx = self.ctx
        self.ms.use()
        ctx.viewport = (0, 0, w, hh)
        bg = v['bg']
        ctx.clear(*(bg if not v['transparent'] else [0, 0, 0]), 0.0 if v['transparent'] else 1.0, depth=1.0)
        z, (cx, cy) = v['zoom'], v['cam']
        a, d = 2 * z / w, -2 * z / hh
        # (column-major mat3: world px to clip, y down as Pixi's projection)
        proj = [a, 0, 0, 0, d, 0, -cx * a, -cy * d, 1]
        ident = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        cs, ca, sa = h['cs'], float(np.cos(v['angle'])), float(np.sin(v['angle']))
        cell_px = cs * z
        self.damage.use(0)
        self.atlas.use(1)
        ctx.enable(moderngl.BLEND)
        depth = 0.99
        fades = [1.0] * (4 * self.tables['fades'])
        lights = v.get('lights', [])[: self.tables['maxLights']]
        for prog in (self.hull, self.lit):
            for name, val in (('uProjectionMatrix', proj), ('uWorldTransformMatrix', ident), ('uTransformMatrix', ident), ('uFade', fades),
                              ('uPlace', 1.0), ('uAmbient', v['ambient']), ('uSun', v['sun']), ('uSunColor', v['sunColor']),
                              ('uSunElev', v['sunElev']), ('uGround', [0, 0, 0]), ('uColor', [1, 1, 1, 1]),
                              ('uCount', float(len(lights))), ('uLightPos', [x for l in lights for x in l['pos']]),
                              ('uLightCol', [x for l in lights for x in l['col']]), ('uLightCone', [x for l in lights for x in l['cone']])):
                self.set(prog, name, val)
        self.set(self.hull, 'uFlash', [0.0] * (4 * self.tables['fades']))
        self.set(self.hull, 'uTime', float(h.get('time', 1.0)))
        self.set(self.hull, 'uCell', float(cs))
        self.set(self.flat, 'uProjectionMatrix', proj)
        self.set(self.flat, 'uLevel', v['level'])
        self.set(self.spr, 'uProjectionMatrix', proj)
        if v.get('sky') and self.sky_ready:
            self.draw_sky(v['sky'], v['css'])
            self.damage.use(0)
            self.atlas.use(1)
            ctx.enable(moderngl.BLEND)
        glow = []
        transient = []
        for it in items:
            X = [it['x'], it['y'], ca, sa]
            # its parts' health (red) and standing (green), row 0
            row = np.full((self.tables['damageH'], self.tables['damageW'], 4), 255, np.uint8)
            dmg = np.asarray(it.get('damage', []), np.uint8)[: self.tables['damageW']]
            row[0, : dmg.size, 0] = dmg
            self.damage.write(row.tobytes())
            # (flames, exhaust and beams go under the hull; they're made afresh each time, and glow into the bloom)
            fx = [self.make(d, payload) for d in it.get('fx', [])]
            transient += fx
            for m in fx + self.cache[it['key']]:
                meta, prog = m['meta'], m['prog']
                if cell_px < meta.get('minPx', 0):
                    continue
                if meta.get('heat') and v.get('heat', 0) <= 0:
                    continue
                ctx.blend_func = (moderngl.ONE, moderngl.ONE) if meta.get('blend') == 'add' else (moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA)
                if meta['kind'] == 'sprite':
                    ctx.disable(moderngl.DEPTH_TEST)
                    self.set(prog, 'uX', X)
                    self.texture(meta['tex']).use(2)
                    self.set(prog, 'uTex', 2)
                    glow.append((X, m, meta.get('blend', 'add')))
                    m['vao'].render(moderngl.TRIANGLES)
                    continue
                if meta['kind'] == 'flat':
                    self.set(prog, 'uX', X)
                    if meta.get('once'):
                        ctx.enable(moderngl.DEPTH_TEST)
                        ctx.depth_func = '<'
                        self.set(prog, 'uDepth', depth * 2 - 1)
                        depth -= 0.0005
                    else:
                        ctx.disable(moderngl.DEPTH_TEST)
                        self.set(prog, 'uDepth', 0.0)
                else:
                    ctx.disable(moderngl.DEPTH_TEST)
                    self.set(prog, 'uXform', X + [0, 0, 0, 0])
                    # (a frame's glowing half: its alpha is its heat, as the game sets the mesh's)
                    a = 0.9 * v.get('heat', 0) if meta.get('heat') else 1.0
                    self.set(prog, 'uColor', [a, a, a, a])
                m['vao'].render(moderngl.TRIANGLES)
        ctx.disable(moderngl.DEPTH_TEST)
        if v.get('bloom', True) and glow:
            self.bloom(glow, v['css'], h.get('bloomSigma', 3.0), h.get('bloomMulA', 0.0))
        self.free(transient)
        ctx.copy_framebuffer(self.out, self.ms)
        raw = self.out.read(components=4)
        t2 = time.perf_counter()
        img = np.frombuffer(raw, np.uint8).reshape(hh, w, 4)[::-1]
        if v['transparent']:
            # premultiplied in the framebuffer: back to straight alpha for the PNG
            # (only edge pixels need it: inside a hull alpha is 255, outside 0)
            img = img.copy()
            al = img[..., 3]
            part = (al > 0) & (al < 255)
            if part.any():
                px = img[part].astype(np.uint32)
                px[:, :3] = np.minimum(255, (px[:, :3] * 255 + px[:, 3:4] // 2) // px[:, 3:4])
                img[part] = px.astype(np.uint8)
            pil = Image.fromarray(img, 'RGBA')
        else:
            pil = Image.fromarray(np.ascontiguousarray(img[..., :3]), 'RGB')
        if v.get('labels'):
            self.label(pil, v['labels'], v['zoom'])
        data = png_bytes(pil, h.get('compress', 1))
        t3 = time.perf_counter()
        return {'ok': True, 'uploadMs': round((t1 - t0) * 1000, 1), 'gpuMs': round((t2 - t1) * 1000, 1),
                'pngMs': round((t3 - t2) * 1000, 1)}, data

    def label(self, pil, labels, zoom):
        """Labels under each (a sheet's), in the viewer's style: Segoe UI 13px, pale blue-grey, centred"""
        from PIL import ImageDraw, ImageFont
        if not hasattr(self, 'font'):
            try:
                self.font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 13)
            except OSError:
                self.font = ImageFont.load_default()
        dr = ImageDraw.Draw(pil)
        for lb in labels:
            dr.text((lb['x'], lb['y']), lb['text'], fill=(0xb8, 0xc4, 0xd6, 255), font=self.font, anchor='ma')

    def drop(self, key):
        self.free(self.cache.pop(key, None) or [])


def main():
    wk = Worker()
    while True:
        h, payload = read_msg()
        try:
            if h['op'] == 'init':
                send(wk.init(h, payload))
            elif h['op'] == 'sky':
                send(wk.init_sky(h, payload))
            elif h['op'] == 'render':
                out, png = wk.render(h, payload)
                send(out, png)
            elif h['op'] == 'quit':
                return
        except Exception as e:  # report and carry on (the service decides)
            import traceback
            send({'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-2000:]})


if __name__ == '__main__':
    main()
