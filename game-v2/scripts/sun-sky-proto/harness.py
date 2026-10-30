"""
The sun and sky prototype harness: draws the jobs scenes.ts writes (the game's shaders and the prototypes,
as layers of quads or instanced sprites) on the real GPU through moderngl, with no browser. For each job it
can save a PNG and time each layer with GPU timer queries.

    python harness.py <scenes.json> <out dir>

scenes.json: { programs: {name: {vert, frag}}, textures: {name: {w, h, file, mip, repeat}},
               jobs: [{ id, w, h, out?, bench?, layers: [layer] }], composites?: [...], gifs?: [...] }
layer: { name, program, uniforms, textures: {sampler: texture}, verts: [x, y, u, v] * 4 (clip space, strip order),
         blend: normal | add | none, target?: <fbo name>, scale?: the fbo's size against the job's,
         instances?: n, extras?: per-vertex floats (4 each) }  or  { name, blit: <fbo name> }

Prints a JSON line per job with its layers' GPU times (ms, the median of 5 runs of `reps` draws each).
"""

import json
import os
import struct
import sys
import time

import moderngl
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BLIT_VERT = """#version 330 core
in vec2 aPosition; in vec2 aUV; out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPosition, 0.0, 1.0); }
"""
BLIT_FRAG = """#version 330 core
in vec2 vUV; out vec4 fragColor; uniform sampler2D uTex;
void main() { fragColor = texture(uTex, vUV); }
"""
IDENTITY = (1, 0, 0, 0, 1, 0, 0, 0, 1)


class Harness:
    def __init__(self, scenes, out_dir):
        self.ctx = moderngl.create_standalone_context(require=330)
        self.out_dir = out_dir
        self.programs = {}
        for name, p in scenes['programs'].items():
            try:
                self.programs[name] = self.ctx.program(vertex_shader=p['vert'], fragment_shader=p['frag'])
            except Exception as e:
                sys.stderr.write(f'program {name} failed to compile:\n{e}\n')
                raise
        self.textures = {}
        for name, t in scenes['textures'].items():
            data = open(t['file'], 'rb').read()
            tex = self.ctx.texture((t['w'], t['h']), 4, data)
            if t.get('mip'):
                tex.build_mipmaps()
                tex.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
                tex.anisotropy = 1.0
            else:
                tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
            tex.repeat_x = tex.repeat_y = bool(t.get('repeat', True))
            self.textures[name] = tex
        self.blit = self.ctx.program(vertex_shader=BLIT_VERT, fragment_shader=BLIT_FRAG)
        self.fbos = {}
        self.query = self.ctx.query(time=True)

    def fbo(self, name, w, h):
        key = (name, w, h)
        if key not in self.fbos:
            tex = self.ctx.texture((w, h), 4)
            tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
            tex.repeat_x = tex.repeat_y = False
            self.fbos[key] = (self.ctx.framebuffer(color_attachments=[tex]), tex)
        return self.fbos[key]

    @staticmethod
    def set_uniform(prog, name, v):
        if name not in prog:
            return
        u = prog[name]
        if isinstance(v, list):
            u.value = tuple(v)
        else:
            u.value = v

    def prepare(self, layer, job, made):
        """A layer as (bind, render): bind sets its program's uniforms and textures (layers can share a program),
        render draws it once"""
        ctx = self.ctx
        if 'blit' in layer:
            fb, tex = self.fbo(layer['blit'], *self.size_of(layer['blitScale'], job))
            verts = np.array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1], np.float32)
            vbo = ctx.buffer(verts.tobytes())
            vao = ctx.vertex_array(self.blit, [(vbo, '2f 2f', 'aPosition', 'aUV')])
            made += [vao, vbo]

            def bind():
                tex.use(0)
                self.blit['uTex'].value = 0
            return bind, lambda: vao.render(moderngl.TRIANGLE_STRIP), layer.get('blend', 'none'), None
        prog = self.programs[layer['program']]
        verts = np.array(layer['verts'], np.float32)
        vbo = ctx.buffer(verts.tobytes())
        # (an attribute the compiler dropped is skipped over in the buffer)
        fmt = ' '.join('2f' if a in prog else '2x4' for a in ('aPosition', 'aUV'))
        vao = ctx.vertex_array(prog, [(vbo, fmt, *[a for a in ('aPosition', 'aUV') if a in prog])])
        made += [vao, vbo]
        units = list(enumerate(layer.get('textures', {}).items()))
        instances = layer.get('instances', 1)

        def bind():
            for m in ('uProjectionMatrix', 'uWorldTransformMatrix', 'uTransformMatrix'):
                if m in prog:
                    prog[m].value = IDENTITY
            for k, v in layer.get('uniforms', {}).items():
                self.set_uniform(prog, k, v)
            for i, (sampler, tname) in units:
                if sampler in prog:
                    prog[sampler].value = i
                if tname in self.textures:
                    self.textures[tname].use(i)
                else:
                    fb, tex = self.fbo(tname, *self.size_of(layer.get('texScale', 1), job))
                    tex.use(i)
        target = layer.get('target')
        return bind, lambda: vao.render(moderngl.TRIANGLE_STRIP, instances=instances), layer.get('blend', 'normal'), (target, layer.get('scale', 1)) if target else None

    @staticmethod
    def size_of(scale, job):
        return max(1, int(np.ceil(job['w'] * scale))), max(1, int(np.ceil(job['h'] * scale)))

    def blend(self, mode):
        ctx = self.ctx
        if mode == 'none':
            ctx.disable(moderngl.BLEND)
        else:
            ctx.enable(moderngl.BLEND)
            ctx.blend_func = (moderngl.ONE, moderngl.ONE) if mode == 'add' else (moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA)

    def run(self, job):
        w, h = job['w'], job['h']
        main, main_tex = self.fbo('main', w, h)
        steps = []
        made = []
        for layer in job['layers']:
            bind, draw, mode, target = self.prepare(layer, job, made)
            if target:
                fb, _ = self.fbo(target[0], *self.size_of(target[1], job))
            else:
                fb = main
            steps.append((layer.get('name', layer.get('program', 'blit')), bind, draw, mode, fb, layer.get('clearTarget', False), layer.get('untimed', False)))

        def frame():
            main.use()
            main.clear(*job.get('clear', [0, 0, 0, 1]))
            for _, bind, draw, mode, fb, clear, _u in steps:
                fb.use()
                if clear:
                    fb.clear(0, 0, 0, 0)
                self.blend(mode)
                bind()
                draw()
        frame()
        result = {'id': job['id'], 'w': w, 'h': h}
        if job.get('stats'):
            px = np.frombuffer(main.read(components=4), np.uint8).reshape(h, w, 4)[:, :, :3].astype(np.float32)
            result['stats'] = {'max': float(px.max()), 'mean': round(float(px.mean()), 3), 'lit': round(float((px.max(axis=2) > 2).mean()), 4)}
        if job.get('out'):
            data = main.read(components=4)
            img = Image.frombytes('RGBA', (w, h), data).transpose(Image.FLIP_TOP_BOTTOM).convert('RGB')
            path = os.path.join(self.out_dir, job['out'])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            img.save(path, compress_level=3)
            result['out'] = path
        if job.get('bench'):
            reps = job.get('reps', 20)
            times = {}
            for name, bind, draw, mode, fb, clear, untimed in steps:
                if untimed:
                    continue
                fb.use()
                self.blend(mode)
                bind()
                draw()
                self.ctx.finish()
                runs = []
                for _ in range(5):
                    with self.query:
                        for _ in range(reps):
                            draw()
                    runs.append(self.query.elapsed / 1e6 / reps)
                times[name] = round(sorted(runs)[2], 4)
            result['ms'] = times
            result['total'] = round(sum(times.values()), 4)
        # (Free the job's buffers; the programs and fbos are kept)
        for o in made:
            o.release()
        return result

    def floor(self, reps=20):
        """What a draw costs in the timings when it draws nothing (one pixel): the submission overhead, which the
        GPU timer counts when it outruns Python"""
        fb, _ = self.fbo('main', 64, 64)
        fb.use()
        vbo = self.ctx.buffer(np.array([-1, -1, 0, 0, -0.99, -1, 1, 0, -1, -0.99, 0, 1, -0.99, -0.99, 1, 1], np.float32).tobytes())
        vao = self.ctx.vertex_array(self.blit, [(vbo, '2f 2f', 'aPosition', 'aUV')])
        runs = []
        for _ in range(7):
            with self.query:
                for _ in range(reps):
                    vao.render(moderngl.TRIANGLE_STRIP)
            runs.append(self.query.elapsed / 1e6 / reps)
        vao.release(); vbo.release()
        return round(sorted(runs)[3], 4)


def label_font(size):
    try:
        return ImageFont.truetype('arial.ttf', size)
    except Exception:
        return ImageFont.load_default()


def composite(out_dir, c):
    """A grid of PNGs with a label over each: { out, cols, cells: [{ file, label }], scale? }"""
    imgs = [Image.open(os.path.join(out_dir, cell['file'])) for cell in c['cells']]
    s = c.get('scale', 1.0)
    if s != 1.0:
        imgs = [im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS) for im in imgs]
    cols = c['cols']
    rows = (len(imgs) + cols - 1) // cols
    cw, ch = max(i.width for i in imgs), max(i.height for i in imgs)
    title = c.get('title')
    top = 44 if title else 0
    sheet = Image.new('RGB', (cols * cw + (cols - 1) * 4, top + rows * ch + (rows - 1) * 4), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    font = label_font(22)
    if title:
        draw.text((12, 10), title, fill=(230, 230, 235), font=label_font(26))
    for k, (im, cell) in enumerate(zip(imgs, c['cells'])):
        x, y = (k % cols) * (cw + 4), top + (k // cols) * (ch + 4)
        sheet.paste(im, (x, y))
        if cell.get('label'):
            tw = draw.textlength(cell['label'], font=font)
            draw.rectangle([x + 6, y + 6, x + 18 + tw, y + 36], fill=(0, 0, 0))
            draw.text((x + 12, y + 8), cell['label'], fill=(255, 255, 255), font=font)
    path = os.path.join(out_dir, c['out'])
    sheet.save(path, compress_level=6)
    return path


def gif(out_dir, g):
    """Frames (each a composite or a PNG) into an animated GIF: { out, frames: [file], ms }"""
    frames = [Image.open(os.path.join(out_dir, f)).convert('RGB') for f in g['frames']]
    if g.get('scale'):
        frames = [f.resize((int(f.width * g['scale']), int(f.height * g['scale'])), Image.LANCZOS) for f in frames]
    pal = [f.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
    path = os.path.join(out_dir, g['out'])
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=g.get('ms', 80), loop=0, optimize=False)
    return path


def main():
    scenes = json.load(open(sys.argv[1], encoding='utf8'))
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    h = Harness(scenes, out_dir)
    info = {'renderer': h.ctx.info['GL_RENDERER'], 'floorMs': h.floor()}
    print(json.dumps({'info': info}), flush=True)
    t0 = time.perf_counter()
    for job in scenes['jobs']:
        print(json.dumps(h.run(job)), flush=True)
    for c in scenes.get('composites', []):
        print(json.dumps({'composite': composite(out_dir, c)}), flush=True)
    for g in scenes.get('gifs', []):
        print(json.dumps({'gif': gif(out_dir, g)}), flush=True)
    print(json.dumps({'done': round(time.perf_counter() - t0, 2)}), flush=True)


if __name__ == '__main__':
    main()
