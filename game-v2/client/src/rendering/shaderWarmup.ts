/**
 * Shader programs compiled ahead of their first draw, without holding up a frame.
 *
 * Pixi compiles a program the first time something draws with it, then waits for the driver (a blocking LINK_STATUS
 * read). On a cold GPU program cache (a first visit, a new Chrome or driver) that's 0.1 to 2 s for the big ones, all of
 * it a frozen frame. Here the game's programs are linked early, behind the sign-in screen, with
 * KHR_parallel_shader_compile where the browser has it: the driver compiles on its own threads and the completion status
 * is polled once a frame, never waited on. A finished program goes straight into the renderer's own program table, so
 * Pixi's first draw with it costs nothing. A program Pixi needs while it's still compiling here is finished then
 * (waiting only for what's left of it, never compiled twice). Without the extension it's one program a frame.
 *
 * Only for the game's renderer (attachShaderWarmup); elsewhere (the viewer, the sandbox) shaderReady is always true and
 * Pixi compiles as it always has.
 */
import {
  compileShader, Container, DefaultBatcher, defaultValue, extractAttributesFromGlProgram, getUboData, getUniformData,
  GlProgramData, logProgramError, Mesh, type Filter, type GlProgram, type Renderer, type Shader,
} from 'pixi.js';

/** The parts of Pixi's GlShaderSystem this reaches into (its program table, by program key) */
interface ShaderSystem {
  _programDataHash: Record<number, GlProgramData>;
  _createProgramData(program: GlProgram): GlProgramData;
}
/** GlProgram's reflection fields, which generateProgram fills in */
interface Reflected { _attributeData: unknown; _uniformData: Record<string, { type: string; size: number }>; _uniformBlockData: unknown }
interface Linking { program: GlProgram; gl: WebGLProgram; vs: WebGLShader; fs: WebGLShader }

let gl: WebGL2RenderingContext | null = null;
let shaders: ShaderSystem | null = null;
let parallel: { COMPLETION_STATUS_KHR: number } | null = null;
const queue: GlProgram[] = [];
const linking = new Map<number, Linking>();
let ticking = false;
/**
 * Compiles in flight at once. The driver's compile threads are shared with Pixi's own compiles: a few at a time leaves
 * them free for a program wanted at once (a long queue of these would be ahead of it)
 */
const IN_FLIGHT = 2;

/** Compile ahead for this renderer (the game's; WebGL only) */
export function attachShaderWarmup(renderer: Renderer): void {
  const r = renderer as unknown as { gl?: WebGL2RenderingContext; shader?: Partial<ShaderSystem> };
  if (!r.gl || !r.shader?._createProgramData || !r.shader._programDataHash) return;
  gl = r.gl;
  shaders = r.shader as ShaderSystem;
  parallel = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
  // A draw that needs a program still compiling here takes that one (waiting for the rest of its compile only)
  const create = shaders._createProgramData.bind(shaders);
  shaders._createProgramData = (program) => {
    const l = linking.get(program._key);
    if (!l) return create(program);
    linking.delete(program._key);
    return finish(l);
  };
}

/** Start compiling these (in order) if they aren't compiled or on the way */
export function warmShaders(programs: Iterable<GlProgram>): void {
  if (!shaders) return;
  for (const p of programs) if (!shaders._programDataHash[p._key] && !linking.has(p._key) && !queue.includes(p) && !p.transformFeedbackVaryings) queue.push(p);
  if (!ticking && queue.length) { ticking = true; requestAnimationFrame(tick); }
}

/** Whether a draw with `program` costs no compile now. If not, its compile is started (draw something else meanwhile) */
export function shaderReady(program: GlProgram): boolean {
  if (!shaders || shaders._programDataHash[program._key]) return true;
  warmShaders([program]);
  return false;
}

/**
 * Pixi's own batch program (sprites, graphics, text). Pixi's batchers share one, made by the first batcher: made here
 * first (for this renderer's texture count, as Pixi makes it), it's the renderer's too, and can be compiled ahead.
 */
export function batchProgram(renderer: Renderer): GlProgram | null {
  const maxTextures = (renderer as unknown as { limits?: { maxBatchableTextures?: number } }).limits?.maxBatchableTextures;
  if (!maxTextures) return null;
  return new DefaultBatcher({ maxTextures, attributesInitialSize: 4, indicesInitialSize: 6 }).shader.glProgram;
}

/** The programs Pixi's own render pipes draw with by default (particles, plain meshes, graphics), made with the renderer */
export function pipePrograms(renderer: Renderer): GlProgram[] {
  const out: GlProgram[] = [];
  type Holder = { defaultShader?: Shader | null; shader?: Shader | null; _shader?: Shader | null; _adaptor?: Holder };
  for (const pipe of Object.values((renderer as unknown as { renderPipes?: Record<string, Holder | undefined> }).renderPipes ?? {})) {
    for (const h of [pipe, pipe?._adaptor]) for (const s of [h?.defaultShader, h?.shader, h?._shader]) if (s?.glProgram && !out.includes(s.glProgram)) out.push(s.glProgram);
  }
  return out;
}

/** Every program the meshes and filters under `root` draw with (hidden ones too) */
export function programsUnder(root: Container, out: GlProgram[] = []): GlProgram[] {
  const add = (p: GlProgram | null | undefined) => { if (p && !out.includes(p)) out.push(p); };
  const visit = (c: Container) => {
    if (c instanceof Mesh) add((c.shader as { glProgram?: GlProgram } | null)?.glProgram);
    for (const f of (c.filters ?? []) as Filter[]) {
      add(f.glProgram);
      // (A blur is two passes, each its own program)
      const b = f as unknown as { blurXFilter?: Filter; blurYFilter?: Filter };
      add(b.blurXFilter?.glProgram);
      add(b.blurYFilter?.glProgram);
    }
    for (const child of c.children) visit(child);
  };
  visit(root);
  return out;
}

function tick(): void {
  if (!gl || !shaders || gl.isContextLost()) { queue.length = 0; linking.clear(); ticking = false; return; }
  // With the extension a few compile at once on the driver's threads, in order; without it, one a frame (that frame waits for it)
  while (queue.length && linking.size < (parallel ? IN_FLIGHT : 1)) begin(queue.shift()!);
  for (const [key, l] of linking) {
    if (parallel && !gl.getProgramParameter(l.gl, parallel.COMPLETION_STATUS_KHR)) continue;
    linking.delete(key);
    finish(l);
  }
  ticking = linking.size > 0 || queue.length > 0;
  if (ticking) requestAnimationFrame(tick);
}

function begin(program: GlProgram): void {
  if (shaders!._programDataHash[program._key] || linking.has(program._key)) return;
  const g = gl!;
  // (As Pixi's generateProgram: the same sources, so the same program, and the driver's cache serves either)
  const vs = compileShader(g, g.VERTEX_SHADER, program.vertex!), fs = compileShader(g, g.FRAGMENT_SHADER, program.fragment!);
  const p = g.createProgram()!;
  g.attachShader(p, vs);
  g.attachShader(p, fs);
  g.linkProgram(p);
  linking.set(program._key, { program, gl: p, vs, fs });
}

/** The rest of Pixi's generateProgram, once linked: the program's reflection and uniform locations, into the table */
function finish({ program, gl: p, vs, fs }: Linking): GlProgramData {
  const g = gl!, table = shaders!._programDataHash;
  // (Pixi compiled its own meanwhile: keep that one)
  if (table[program._key]) { g.deleteProgram(p); g.deleteShader(vs); g.deleteShader(fs); return table[program._key]; }
  if (!g.getProgramParameter(p, g.LINK_STATUS)) logProgramError(g, p, vs, fs);
  const r = program as unknown as Reflected;
  r._attributeData = extractAttributesFromGlProgram(p, g, !/^[ \t]*#[ \t]*version[ \t]+300[ \t]+es[ \t]*$/m.test(program.vertex!));
  r._uniformData = getUniformData(p, g) as Reflected['_uniformData'];
  r._uniformBlockData = getUboData(p, g);
  g.deleteShader(vs);
  g.deleteShader(fs);
  const uniformData: Record<string, { location: WebGLUniformLocation; value: unknown }> = {};
  for (const name in r._uniformData) {
    const d = r._uniformData[name];
    uniformData[name] = { location: g.getUniformLocation(p, name)!, value: defaultValue(d.type, d.size) };
  }
  return (table[program._key] = new GlProgramData(p, uniformData as ConstructorParameters<typeof GlProgramData>[1]));
}
