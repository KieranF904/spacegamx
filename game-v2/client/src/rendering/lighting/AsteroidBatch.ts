/**
 * Asteroid rocks, lit, drawn in chunks: up to PER_CHUNK rocks share one mesh
 * and one draw, each in its own slot whose transform (where the rock's
 * container is this frame) goes to the shader. A chunk's geometry is rebuilt
 * only when a rock joins or leaves it; moving and turning cost one vec4 each.
 *
 * Like ShipBatch: a leaving rock frees its slot (the others keep theirs), a
 * joining rock takes a free slot in the chunk nearest it (so a chunk's rocks
 * lie together, and its lights are picked for just that patch), and a slot is
 * drawn only once the chunk's geometry has been built with that rock in it.
 *
 * Each rock is drawn by how big it is on screen (rocks/RockMaterials.ts
 * ROCK_LOD): with its material close in, plain further out, its light mesh
 * when tiny. The shader picks per rock, so a chunk is still one draw; a chunk
 * uses the materials' shader only while one of its rocks is big enough on
 * screen for detail (and the atlas is built). A chunk with none of its rocks
 * on screen isn't drawn at all.
 */

import { Container, Geometry, Shader } from 'pixi.js';
import { LitGeometry } from './LitGeometry';
import { Lighting, LitMesh } from './Lighting';
import type { RockGeometry } from '../rocks/RockGeometry';
import { ROCK_LOD, rockAtlas, rockLitProgram, rockProgram, rockUniforms } from '../rocks/RockMaterials';
import type { AsteroidRock } from '../AsteroidLook';

const PER_CHUNK = 32;
/** The programs the rocks draw with (for compiling ahead: shaderWarmup) */
export const asteroidPrograms = () => [rockLitProgram(PER_CHUNK), rockProgram(PER_CHUNK)];
/** Chunk rebuilds per frame at most (more wait a frame) */
const REBUILDS_PER_FRAME = 2;
/** A rock joins the nearest chunk with room only if that chunk's rocks are within this (world units); otherwise it starts an empty or new one */
const GROUP_FAR = 6000;

/** Last frame's rocks on screen: drawn with their light mesh, plain, with detail; chunks drawn and with materials (RenderTuningPanel shows them) */
export const rockStats = { light: 0, plain: 0, detail: 0, chunks: 0, materialChunks: 0 };

interface Chunk {
  lit: LitMesh;
  /** Each slot's rock (-1: free) */
  ids: number[];
  /** Whose geometry each slot holds right now (-1: none): a slot is drawn only while this is its rock */
  built: number[];
  rocks: Map<number, AsteroidRock>;
  dirty: boolean;
  geometry: Geometry | null;
  /** Today's lighting, picking each rock's mesh (sharing the lit mesh's lights) */
  plain: Shader;
  /** The materials' shader, made when first needed */
  material: Shader | null;
  /** Sum of the places of the rocks that joined (and their count), for the chunk's middle */
  sx: number; sy: number; n: number;
}

/** A rock's slot, and where it joined */
interface Place { chunk: Chunk; slot: number; x: number; y: number }

/** Several rocks' geometry as one, each in its slot, packed straight into typed arrays (refilling `into` if given) */
function mergeRocks(parts: [RockGeometry, number][], into: Geometry | null): Geometry {
  let verts = 0, idxs = 0;
  for (const [g] of parts) { verts += g.vertexCount; idxs += g.idx.length; }
  const pos = new Float32Array(verts * 2), nrm = new Float32Array(verts * 3), col = new Float32Array(verts * 4), slot = new Float32Array(verts);
  const surf = new Float32Array(verts * 4), smo = new Float32Array(verts * 3), mat = new Float32Array(verts * 4);
  const idx = new Uint32Array(idxs);
  let v = 0, ii = 0;
  for (const [g, s] of parts) {
    const n = g.vertexCount;
    pos.set(g.pos, v * 2); nrm.set(g.nrm, v * 3); col.set(g.col, v * 4);
    slot.fill(s, v, v + n);
    surf.set(g.surf, v * 4); smo.set(g.smo, v * 3); mat.set(g.mat, v * 4);
    for (let i = 0; i < g.idx.length; i++) idx[ii + i] = g.idx[i] + v;
    v += n; ii += g.idx.length;
  }
  if (into) {
    into.getBuffer('aPosition').data = pos;
    into.getBuffer('aNormal').data = nrm;
    into.getBuffer('aColor').data = col;
    into.getBuffer('aSlot').data = slot;
    into.getBuffer('aSurf').data = surf;
    into.getBuffer('aSmooth').data = smo;
    into.getBuffer('aMat').data = mat;
    into.indexBuffer.data = idx;
    return into;
  }
  return new Geometry({
    attributes: {
      aPosition: { buffer: pos, format: 'float32x2' },
      aNormal: { buffer: nrm, format: 'float32x3' },
      aColor: { buffer: col, format: 'float32x4' },
      aSlot: { buffer: slot, format: 'float32' },
      aSurf: { buffer: surf, format: 'float32x4' },
      aSmooth: { buffer: smo, format: 'float32x3' },
      aMat: { buffer: mat, format: 'float32x4' },
    },
    indexBuffer: idx,
  });
}

export class AsteroidBatch {
  readonly container = new Container();
  private chunks: Chunk[] = [];
  private where = new Map<number, Place>();
  /** Where to start looking for chunks to rebuild (so they take turns) */
  private next = 0;

  constructor(private lighting: Lighting) {}

  /** Chunks waiting to be rebuilt (their new rocks not drawn yet), plus 1 while the relief atlas is still coming */
  get pending(): number {
    let n = this.chunks.length && !rockAtlas() ? 1 : 0;
    for (const c of this.chunks) if (c.dirty) n++;
    return n;
  }

  private newChunk(): Chunk {
    const lit = new LitMesh(new LitGeometry().toGeometry(), { slots: PER_CHUNK, chunk: true });
    lit.area = { x: 0, y: 0, r: 0 };
    const plain = new Shader({ glProgram: rockLitProgram(PER_CHUNK), resources: { litUniforms: (lit.shader.resources as Record<string, unknown>).litUniforms, rockUniforms } });
    const chunk: Chunk = { lit, ids: [], built: [], rocks: new Map(), dirty: false, geometry: null, plain, material: null, sx: 0, sy: 0, n: 0 };
    this.container.addChild(lit.mesh);
    this.lighting.add(lit);
    this.chunks.push(chunk);
    return chunk;
  }

  private hasRoom(c: Chunk): boolean {
    return c.ids.length < PER_CHUNK || c.ids.includes(-1);
  }

  /** The chunk with room whose rocks are nearest (x, y); an empty one if none is near; a new one if all are full */
  private pick(x: number, y: number): Chunk {
    let best: Chunk | null = null, bestD = Infinity, empty: Chunk | null = null;
    for (const c of this.chunks) {
      if (!this.hasRoom(c)) continue;
      if (c.n <= 0) { empty ??= c; continue; }
      const d = Math.hypot(c.sx / c.n - x, c.sy / c.n - y);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && bestD < GROUP_FAR) return best;
    return empty ?? best ?? this.newChunk();
  }

  /** A rock, at (x, y) in the world: it joins the chunk nearest there */
  add(id: number, rock: AsteroidRock, x = 0, y = 0): void {
    if (this.where.has(id)) this.remove(id);
    const chunk = this.pick(x, y);
    let slot = chunk.ids.indexOf(-1);
    if (slot >= 0) chunk.ids[slot] = id;
    else { slot = chunk.ids.length; chunk.ids.push(id); chunk.built.push(-1); }
    chunk.rocks.set(id, rock);
    chunk.sx += x; chunk.sy += y; chunk.n++;
    chunk.dirty = true;
    this.where.set(id, { chunk, slot, x, y });
  }

  remove(id: number): void {
    const at = this.where.get(id);
    if (!at) return;
    this.where.delete(id);
    const chunk = at.chunk;
    // Its slot is freed, not closed up: the others keep their places, and their geometry stays valid until the rebuild
    chunk.ids[at.slot] = -1;
    chunk.rocks.delete(id);
    chunk.sx -= at.x; chunk.sy -= at.y; chunk.n--;
    chunk.dirty = true;
  }

  /** Each frame: every rock's slot follows its container (hidden ones collapse to nothing); `zoom` says how big they are on screen */
  update(containers: Map<number, Container>, zoom: number): void {
    const atlas = rockAtlas();
    const u = rockUniforms.uniforms as { uZoom: number; uLod: Float32Array };
    u.uZoom = zoom;
    u.uLod[0] = ROCK_LOD.light; u.uLod[1] = ROCK_LOD.detailFrom; u.uLod[2] = ROCK_LOD.detailFull;
    const st = rockStats;
    st.light = st.plain = st.detail = st.chunks = st.materialChunks = 0;
    let rebuilds = 0;
    const n = this.chunks.length;
    // (Chunks take turns being first in line, so one that keeps changing can't starve the rest)
    for (let k = 0; k < n && rebuilds < REBUILDS_PER_FRAME; k++) {
      const chunk = this.chunks[(this.next + k) % n];
      if (!chunk.dirty) continue;
      rebuilds++;
      chunk.dirty = false;
      const parts: [RockGeometry, number][] = [];
      chunk.ids.forEach((id, slot) => {
        const rock = id >= 0 ? chunk.rocks.get(id) : undefined;
        chunk.built[slot] = rock ? id : -1;
        if (rock) parts.push([rock.geometry, slot]);
      });
      chunk.geometry = mergeRocks(parts, chunk.geometry);
    }
    if (n) this.next = (this.next + 1) % n;
    for (const chunk of this.chunks) {
      const x = chunk.lit.xform, area = chunk.lit.area!;
      x.fill(0);
      let shown = false, biggest = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let slot = 0; slot < chunk.ids.length; slot++) {
        const id = chunk.ids[slot];
        // (Not drawn until the chunk's geometry has this rock in this slot)
        if (id < 0 || chunk.built[slot] !== id) continue;
        const c = containers.get(id);
        if (!c || !c.visible) continue;
        shown = true;
        const rock = chunk.rocks.get(id)!, s = c.scale.x, o = slot * 4, px = rock.size * s * zoom;
        biggest = Math.max(biggest, px);
        if (px < ROCK_LOD.light) st.light++; else if (px < ROCK_LOD.detailFrom || !atlas) st.plain++; else st.detail++;
        x[o] = c.x; x[o + 1] = c.y; x[o + 2] = Math.cos(c.rotation) * s; x[o + 3] = Math.sin(c.rotation) * s;
        const r = rock.size * s * 1.3;
        if (c.x - r < x0) x0 = c.x - r;
        if (c.x + r > x1) x1 = c.x + r;
        if (c.y - r < y0) y0 = c.y - r;
        if (c.y + r > y1) y1 = c.y + r;
      }
      const mesh = chunk.lit.mesh;
      mesh.visible = shown && !!chunk.geometry;
      if (!mesh.visible || !chunk.geometry) continue;
      // Lights are picked for the patch of sky this chunk's rocks cover
      area.x = (x0 + x1) / 2; area.y = (y0 + y1) / 2; area.r = Math.hypot(x1 - x0, y1 - y0) / 2;
      st.chunks++;
      if (mesh.geometry !== chunk.geometry) mesh.geometry = chunk.geometry;
      let shader = chunk.plain;
      if (atlas && biggest >= ROCK_LOD.detailFrom) {
        st.materialChunks++;
        shader = chunk.material ??= new Shader({
          glProgram: rockProgram(PER_CHUNK),
          resources: { litUniforms: (chunk.lit.shader.resources as Record<string, unknown>).litUniforms, rockUniforms, uDetail: atlas.source },
        });
      }
      if (mesh.shader !== shader) mesh.shader = shader;
    }
  }
}
