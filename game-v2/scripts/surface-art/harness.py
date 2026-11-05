"""
Surface ground stills and timings on the real GPU (moderngl, no browser): stills.ts writes the jobs.

    python harness.py <scenes.json>

Each job: the ground drawn into a half-size target (as SurfaceRenderer does), stretched over the screen at its offset,
the clouds over it (premultiplied). A PNG if the job has `out`; with `bench`, the ground pass's GPU time (ms, median
of 7 runs of 20 draws) printed as a JSON line.
"""

import json
import re
import sys
import time

import moderngl
import numpy as np
from PIL import Image

VERT = """#version 330 core
in vec2 aPos; out vec2 vUV;
void main() { vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }
"""
BLIT = """#version 330 core
out vec4 fragColor; uniform sampler2D uTex; uniform vec2 uOff; uniform vec2 uRt; uniform float uH;
void main() {
  vec2 s = vec2(gl_FragCoord.x, uH - gl_FragCoord.y);
  vec2 t = (s - uOff) * 0.5;
  fragColor = vec4(texture(uTex, vec2(t.x / uRt.x, 1.0 - t.y / uRt.y)).rgb, 1.0);
}
"""


def port(src):
    src = src.replace('#version 300 es', '#version 330 core')
    return re.sub(r'precision\s+\w+\s+float;', '', src)


def set_uniforms(prog, values):
    for k, v in values.items():
        if k not in prog:
            continue
        prog[k].value = tuple(v) if isinstance(v, list) else v


def main():
    scenes = json.load(open(sys.argv[1]))
    ctx = moderngl.create_standalone_context(require=330)
    progs = {k: ctx.program(vertex_shader=VERT, fragment_shader=port(v)) for k, v in scenes['programs'].items()}
    blit = ctx.program(vertex_shader=VERT, fragment_shader=BLIT)
    n = scenes['noise']
    noise = ctx.texture((n['size'], n['size']), 4, open(n['file'], 'rb').read())
    noise.build_mipmaps()
    noise.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    noise.repeat_x = noise.repeat_y = True
    quad = ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype='f4').tobytes())
    vaos = {k: ctx.vertex_array(p, [(quad, '2f', 'aPos')]) for k, p in {**progs, 'blit': blit}.items()}
    for job in scenes['jobs']:
        w, h = job['w'], job['h']
        rw, rh = job['rt']
        rt = ctx.texture((rw, rh), 4)
        rt.filter = (moderngl.LINEAR, moderngl.LINEAR)
        rt_fbo = ctx.framebuffer([rt])
        screen_tex = ctx.texture((w, h), 4)
        screen = ctx.framebuffer([screen_tex])
        g = progs[job['program']]
        set_uniforms(g, job['ground'])
        if 'uNoise' in g:
            g['uNoise'].value = 0

        def ground():
            rt_fbo.use()
            ctx.viewport = (0, 0, rw, rh)
            noise.use(0)
            vaos[job['program']].render(moderngl.TRIANGLE_STRIP)

        ground()
        screen.use()
        ctx.viewport = (0, 0, w, h)
        rt.use(0)
        blit['uTex'].value = 0
        blit['uOff'].value = tuple(job['off'])
        blit['uRt'].value = (rw, rh)
        blit['uH'].value = h
        ctx.disable(moderngl.BLEND)
        vaos['blit'].render(moderngl.TRIANGLE_STRIP)
        if job.get('cloudsOn'):
            c = progs['clouds']
            set_uniforms(c, job['clouds'])
            if 'uNoise' in c:
                c['uNoise'].value = 0
            noise.use(0)
            ctx.enable(moderngl.BLEND)
            ctx.blend_func = (moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA)
            vaos['clouds'].render(moderngl.TRIANGLE_STRIP)
            ctx.disable(moderngl.BLEND)
        if job.get('out'):
            img = Image.frombytes('RGBA', (w, h), screen.read(components=4)).transpose(Image.FLIP_TOP_BOTTOM).convert('RGB')
            img.save(job['out'])
        if job.get('bench'):
            times = []
            for _ in range(7):
                q = ctx.query(time=True)
                with q:
                    for _ in range(20):
                        ground()
                ctx.finish()
                times.append(q.elapsed / 1e6 / 20)
            times.sort()
            # (and by the wall clock over many draws, as a check on the timer)
            t0 = time.perf_counter()
            for _ in range(200):
                ground()
            ctx.finish()
            wall = (time.perf_counter() - t0) * 1000 / 200
            print(json.dumps({'id': job['id'], 'groundMs': round(times[3], 4), 'wallMs': round(wall, 4), 'rt': [rw, rh]}), flush=True)
        for o in (rt_fbo, rt, screen, screen_tex):
            o.release()


main()
