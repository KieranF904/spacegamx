"""
The asteroid harness's GL side (scenes.ts writes the jobs): the game's rock shaders and chunk meshes drawn on the real
GPU through moderngl (no window, no browser), 8x MSAA as the game asks for, and each job's rock draws timed with GPU
timer queries.

    python harness.py <jobs.json> <out dir>

Prints a JSON line per job: its draws (chunks), vertices, triangles and GPU ms a frame (the median of 7 runs of
`reps` frames each). Saves a PNG where the job names one.
"""

import json
import sys

import moderngl
import numpy as np
from PIL import Image

ATTRS = [('aPosition', 2), ('aNormal', 3), ('aColor', 4), ('aSlot', 1), ('aSurf', 4), ('aSmooth', 3), ('aMat', 4)]
STRIDE = sum(n for _, n in ATTRS)


def main():
    spec = json.load(open(sys.argv[1]))
    ctx = moderngl.create_standalone_context(require=330)
    progs = {}
    for name, p in spec['programs'].items():
        try:
            progs[name] = ctx.program(vertex_shader=p['vert'], fragment_shader=p['frag'])
        except Exception as e:
            sys.stderr.write(f'program {name} failed to compile:\n{e}\n')
            raise
    a = spec['atlas']
    atlas = ctx.texture((a['w'], a['h']), 4, open(a['file'], 'rb').read())
    atlas.build_mipmaps()
    atlas.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    atlas.repeat_x = atlas.repeat_y = False
    query = ctx.query(time=True)
    reps = spec.get('reps', 40)

    targets = {}

    def prepare(job):
        """A job's GPU state: (frame, result, save, release)"""
        w, h = job['w'], job['h']
        # (one target per size, shared by the jobs drawn at it: a scene's before and after draw into the same memory)
        if (w, h) not in targets:
            targets[(w, h)] = (ctx.framebuffer(color_attachments=[ctx.renderbuffer((w, h), 4, samples=8)]), ctx.framebuffer(color_attachments=[ctx.texture((w, h), 4)]))
        ms, res = targets[(w, h)]
        draws = []
        made = []
        tris = verts = 0
        for c in job['chunks']:
            prog = progs[c['program']]
            raw = open(c['file'], 'rb').read()
            vb = np.frombuffer(raw, np.float32, c['verts'] * STRIDE)
            ib = np.frombuffer(raw, np.uint32, c['idxs'], c['verts'] * STRIDE * 4)
            vbo, ibo = ctx.buffer(vb.tobytes()), ctx.buffer(ib.tobytes())
            fmt = ' '.join(f'{n}f' if name in prog else f'{n}x4' for name, n in ATTRS)
            names = [name for name, _ in ATTRS if name in prog]
            vao = ctx.vertex_array(prog, [(vbo, fmt, *names)], index_buffer=ibo, index_element_size=4)
            made += [vao, vbo, ibo]
            draws.append((prog, vao, c))
            tris += c['idxs'] // 3
            verts += c['verts']

        def bind(prog, c):
            for k, v in job['uniforms'].items():
                if k not in prog:
                    continue
                u = prog[k]
                if isinstance(v, list):
                    u.write(np.array(v, np.float32).tobytes())
                else:
                    u.value = v
            for m in ('uWorldTransformMatrix', 'uTransformMatrix'):
                if m in prog:
                    prog[m].value = (1, 0, 0, 0, 1, 0, 0, 0, 1)
            prog['uXform'].write(np.array(c['xform'], np.float32).tobytes())
            prog['uFade'].write(np.array(c['fade'], np.float32).tobytes())
            if 'uDetail' in prog:
                prog['uDetail'].value = 0

        def frame():
            ms.use()
            ms.clear(*job['bg'], 1.0)
            ctx.enable(moderngl.BLEND)
            ctx.blend_func = moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA
            atlas.use(0)
            for _ in range(job.get('repeat', 1)):
                for prog, vao, c in draws:
                    bind(prog, c)
                    vao.render(moderngl.TRIANGLES)

        def save():
            frame()
            ctx.copy_framebuffer(res, ms)
            img = Image.frombytes('RGBA', (w, h), res.read(components=4)).transpose(Image.FLIP_TOP_BOTTOM).convert('RGB')
            img.save(job['out'])

        result = {'id': job['id'], 'draws': len(draws), 'verts': verts, 'tris': tris, 'repeat': job.get('repeat', 1)}
        return frame, result, save, made

    # Jobs of one scene (its before and after) are timed together, in alternating rounds, so the GPU's clocks drift
    # over both alike
    groups = {}
    for job in spec['jobs']:
        groups.setdefault(job['id'].rsplit('-', 1)[0], []).append(job)
    rounds = spec.get('rounds', 15)
    for jobs in groups.values():
        made = [(job, *prepare(job)) for job in jobs]
        times = {job['id']: [] for job in jobs}
        for job, frame, result, save, _ in made:
            frame()
        ctx.finish()
        if any(job.get('bench') for job in jobs):
            for r in range(rounds):
                order = made if r % 2 == 0 else made[::-1]
                for job, frame, result, save, _ in order:
                    with query:
                        for _ in range(reps):
                            frame()
                    ctx.finish()
                    times[job['id']].append(query.elapsed / 1e6 / reps)
        for job, frame, result, save, objs in made:
            t = sorted(times[job['id']])
            if t:
                result['gpu_ms'] = round(t[len(t) // 2], 4)
                result['gpu_ms_min'] = round(t[0], 4)
            if job.get('out'):
                save()
                result['out'] = job['out']
            print(json.dumps(result), flush=True)
            for m in objs:
                m.release()


main()
