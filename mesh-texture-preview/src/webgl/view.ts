/**
 * The WebGL mesh view.
 *
 * One canvas, two panes:
 *
 *  - fabric: the mesh in fabric space, sampled with each triangle's own UVs.
 *  - texture: the UV layout over the texture image, so a designer can see
 *    where every corner samples and where the two sides of a split seam land.
 *
 * Rendering model
 * ---------------
 * Each triangle is its own three corners with its own UVs. The fabric surface
 * stays water-tight wherever fabric vertices coincide, while a split seam can
 * genuinely show two different texel lines on its two sides. Averaging UVs
 * across a seam would destroy a deliberate split, so it never happens.
 *
 * Invalid triangles (flipped or collapsed) are tinted when `badPatchMode` is
 * `retain` and omitted when it is `disable`; their outlines are always drawn so
 * the designer can still find and repair them.
 */

import { resolveSeams, weldTopology } from '../core/diagnostics.ts';
import type { DiagnosticsSnapshot, MeshDocument, ViewOptions, Vec2 } from '../core/types.ts';
import {
  createProgram,
  getContext,
  uvAffine,
  worldAffine,
  GLInitError,
  type Affine,
  type ProgramInfo,
} from './glutil.ts';
import {
  MESH_FRAGMENT_SHADER,
  MESH_VERTEX_SHADER,
  OVERLAY_FRAGMENT_SHADER,
  OVERLAY_VERTEX_SHADER,
} from './shaders.ts';

export type RGB = [number, number, number];

export interface Camera {
  /** World point at the centre of the fabric pane. */
  centerX: number;
  centerY: number;
  /** CSS pixels per world unit. */
  scale: number;
}

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Drawing-buffer pixels per CSS pixel. */
  dpr: number;
}

export interface Highlight {
  vertex: number | null;
  triangleId: number | null;
  seamId: string | null;
}

export interface PaneRect {
  /** CSS pixels, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayout {
  fabric: PaneRect;
  texture: PaneRect;
  gutter: number;
}

/** Colours are sRGB floats; the palette is tuned for a dark UI. */
export const PALETTE = {
  background: [0.055, 0.07, 0.095] as RGB,
  boundary: [0.45, 0.82, 1.0] as RGB,
  continuousSeam: [0.98, 0.8, 0.32] as RGB,
  splitSeam: [1.0, 0.42, 0.86] as RGB,
  badSeam: [1.0, 0.22, 0.22] as RGB,
  flipped: [1.0, 0.12, 0.55] as RGB,
  handle: [0.95, 0.96, 1.0] as RGB,
  handlePinned: [0.5, 0.55, 0.62] as RGB,
  handleSelected: [0.3, 1.0, 0.6] as RGB,
  wireframe: [1.0, 1.0, 1.0] as RGB,
  valid: [0.32, 0.78, 0.55] as RGB,
  stretched: [1.0, 0.58, 0.08] as RGB,
  compressed: [0.3, 0.55, 1.0] as RGB,
  collapsed: [0.85, 0.2, 0.2] as RGB,
};

const FLOATS_PER_VERTEX = 7; // x, y, u, v, r, g, b
const GUTTER = 8;

/** Splits the canvas into fabric and texture panes. */
export function paneLayout(viewport: Viewport): PaneLayout {
  const half = Math.floor((viewport.width - GUTTER) / 2);
  return {
    fabric: { x: 0, y: 0, width: half, height: viewport.height },
    texture: { x: half + GUTTER, y: 0, width: viewport.width - half - GUTTER, height: viewport.height },
    gutter: GUTTER,
  };
}

export class MeshView {
  readonly gl: WebGL2RenderingContext;
  #meshProgram: ProgramInfo;
  #overlayProgram: ProgramInfo;
  #meshVao: WebGLVertexArrayObject;
  #overlayVao: WebGLVertexArrayObject;
  #vbo: WebGLBuffer;
  #texture: WebGLTexture;
  #textureSize = { width: 1, height: 1 };
  #lost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = getContext(canvas);
    const gl = this.gl;

    this.#meshProgram = createProgram(gl, MESH_VERTEX_SHADER, MESH_FRAGMENT_SHADER);
    this.#overlayProgram = createProgram(gl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);

    const vbo = gl.createBuffer();
    const meshVao = gl.createVertexArray();
    const overlayVao = gl.createVertexArray();
    const texture = gl.createTexture();
    if (!vbo || !meshVao || !overlayVao || !texture) throw new GLInitError('WebGL 资源分配失败');
    this.#vbo = vbo;
    this.#meshVao = meshVao;
    this.#overlayVao = overlayVao;
    this.#texture = texture;

    this.#configureVao(meshVao, this.#meshProgram);
    this.#configureVao(overlayVao, this.#overlayProgram);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([80, 82, 88, 255]));

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.#lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.#lost = false;
    });
  }

  get contextLost(): boolean {
    return this.#lost;
  }

  get textureSize(): { width: number; height: number } {
    return this.#textureSize;
  }

  #configureVao(vao: WebGLVertexArrayObject, program: ProgramInfo): void {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);
    const stride = FLOATS_PER_VERTEX * 4;
    for (const [index, size, offset] of [
      [program.attrib.position, 2, 0],
      [program.attrib.uv, 2, 8],
      [program.attrib.colour, 3, 16],
    ] as const) {
      if (index < 0) continue;
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset);
    }
    gl.bindVertexArray(null);
  }

  setTexture(source: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    this.#textureSize = { width, height };
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Resizes the drawing buffer to CSS size × dpr. */
  resize(canvas: HTMLCanvasElement, viewport: Viewport): boolean {
    const pw = Math.max(1, Math.round(viewport.width * viewport.dpr));
    const ph = Math.max(1, Math.round(viewport.height * viewport.dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      return true;
    }
    return false;
  }

  render(
    canvas: HTMLCanvasElement,
    doc: MeshDocument,
    diagnostics: DiagnosticsSnapshot,
    camera: Camera,
    viewport: Viewport,
    options: ViewOptions,
    highlight: Highlight,
  ): void {
    if (this.#lost) return;
    const gl = this.gl;
    this.resize(canvas, viewport);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(PALETTE.background[0], PALETTE.background[1], PALETTE.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const layout = paneLayout(viewport);
    const dpr = viewport.dpr;

    this.#beginPane(layout.fabric, dpr);
    this.#drawFabric(doc, diagnostics, options, highlight, camera, layout.fabric);

    this.#beginPane(layout.texture, dpr);
    this.#drawTexturePane(doc, diagnostics, options, highlight, layout.texture);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  #beginPane(rect: PaneRect, dpr: number): void {
    const gl = this.gl;
    // Both panes span the full canvas height, so WebGL's bottom-left origin
    // and the pane's top-left origin agree on y = 0.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(rect.x * dpr), 0, Math.round(rect.width * dpr), Math.round(rect.height * dpr));
    gl.viewport(Math.round(rect.x * dpr), 0, Math.round(rect.width * dpr), Math.round(rect.height * dpr));
    gl.clearColor(PALETTE.background[0], PALETTE.background[1], PALETTE.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /* --------------------------------------------------------------- fabric */

  #drawFabric(
    doc: MeshDocument,
    diagnostics: DiagnosticsSnapshot,
    options: ViewOptions,
    highlight: Highlight,
    camera: Camera,
    rect: PaneRect,
  ): void {
    const gl = this.gl;
    const affine = worldAffine(camera, rect);
    const skipInvalid = options.badPatchMode === 'disable';
    const valid: number[] = [];
    const invalid: number[] = [];
    for (const tri of doc.triangles) {
      const metric = diagnostics.triangleById.get(tri.id);
      const isInvalid = metric?.invalid ?? false;
      if (isInvalid && skipInvalid) continue;
      const target = isInvalid ? invalid : valid;
      for (let k = 0; k < 3; k++) {
        const p = doc.vertices[tri.vertices[k]];
        const uv = tri.uvs[k];
        target.push(p.x, p.y, uv.x, uv.y, 1, 1, 1);
      }
    }

    gl.useProgram(this.#meshProgram.program);
    gl.uniform4f(this.#meshProgram.uniform.affine, ...affine);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.uniform1i(this.#meshProgram.uniform.texture, 0);
    gl.uniform1f(this.#meshProgram.uniform.opacity, 1);
    gl.bindVertexArray(this.#meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);

    if (valid.length > 0) {
      gl.uniform1i(this.#meshProgram.uniform.mode, 0);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(valid), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, valid.length / FLOATS_PER_VERTEX);
    }
    if (invalid.length > 0) {
      // Flat magenta for geometry that cannot be trusted.
      const tinted = invalid.slice();
      for (let i = 0; i < tinted.length; i += FLOATS_PER_VERTEX) {
        tinted[i + 4] = PALETTE.flipped[0];
        tinted[i + 5] = PALETTE.flipped[1];
        tinted[i + 6] = PALETTE.flipped[2];
      }
      gl.uniform1i(this.#meshProgram.uniform.mode, 1);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tinted), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, tinted.length / FLOATS_PER_VERTEX);
    }

    if (options.channel === 'stretch') {
      this.#drawStretch(doc, diagnostics, affine);
    }

    // Overlays: wireframe, boundary, seams, invalid outlines, handles.
    if (options.showGrid || options.channel === 'wireframe') {
      const segments: Segment[] = [];
      for (const tri of doc.triangles) {
        const p = [doc.vertices[tri.vertices[0]], doc.vertices[tri.vertices[1]], doc.vertices[tri.vertices[2]]];
        segments.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] }, { a: p[2], b: p[0] });
      }
      this.#drawLines(segments, PALETTE.wireframe, 0.22, affine);
    }

    if (options.showBoundary) {
      this.#drawLines(boundarySegments(doc), PALETTE.boundary, 0.9, affine);
    }

    if (options.showSeams) {
      const resolved = resolveSeams(doc);
      const continuous: Segment[] = [];
      const split: Segment[] = [];
      const bad: Segment[] = [];
      for (const seam of resolved) {
        const metrics = diagnostics.seamById.get(seam.id);
        const segment: Segment = { a: seam.p0, b: seam.p1 };
        if (!metrics || metrics.status === 'invalid' || metrics.status === 'accidental-split') bad.push(segment);
        else if (seam.kind === 'split') split.push(segment);
        else continuous.push(segment);
      }
      if (highlight.seamId) {
        const seam = resolved.find((s) => s.id === highlight.seamId);
        if (seam) {
          const segment = { a: seam.p0, b: seam.p1 };
          // White underlay makes the selected seam readable over any colour.
          this.#drawLines([segment], [1, 1, 1], 1, affine, 4);
        }
      }
      this.#drawLines(continuous, PALETTE.continuousSeam, 0.75, affine, 1.5);
      this.#drawLines(split, PALETTE.splitSeam, 1, affine, 2);
      this.#drawLines(bad, PALETTE.badSeam, 1, affine, 2.5);
    }

    // Invalid outlines stay visible even with badPatchMode = disable.
    const invalidOutlines: Segment[] = [];
    for (const tri of doc.triangles) {
      const metric = diagnostics.triangleById.get(tri.id);
      if (!metric?.invalid) continue;
      const p = [doc.vertices[tri.vertices[0]], doc.vertices[tri.vertices[1]], doc.vertices[tri.vertices[2]]];
      invalidOutlines.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] }, { a: p[2], b: p[0] });
    }
    if (invalidOutlines.length > 0) this.#drawLines(invalidOutlines, PALETTE.flipped, 1, affine, 2.5);

    if (highlight.triangleId !== null) {
      const tri = doc.triangles.find((t) => t.id === highlight.triangleId);
      if (tri) {
        const p = [doc.vertices[tri.vertices[0]], doc.vertices[tri.vertices[1]], doc.vertices[tri.vertices[2]]];
        this.#drawLines(
          [{ a: p[0], b: p[1] }, { a: p[1], b: p[2] }, { a: p[2], b: p[0] }],
          [1, 1, 1],
          1,
          affine,
          2.5,
        );
      }
    }

    if (options.showHandles) this.#drawWorldHandles(doc, highlight, affine);
  }

  #drawStretch(doc: MeshDocument, diagnostics: DiagnosticsSnapshot, affine: Affine): void {
    const gl = this.gl;
    gl.useProgram(this.#meshProgram.program);
    gl.uniform4f(this.#meshProgram.uniform.affine, ...affine);
    gl.uniform1i(this.#meshProgram.uniform.mode, 1);
    gl.uniform1f(this.#meshProgram.uniform.opacity, 0.62);
    gl.bindVertexArray(this.#meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);
    const data: number[] = [];
    for (const tri of doc.triangles) {
      const metric = diagnostics.triangleById.get(tri.id);
      if (!metric) continue;
      const colour = metricColour(metric);
      for (let k = 0; k < 3; k++) {
        const p = doc.vertices[tri.vertices[k]];
        const uv = tri.uvs[k];
        data.push(p.x, p.y, uv.x, uv.y, colour[0], colour[1], colour[2]);
      }
    }
    if (data.length === 0) return;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / FLOATS_PER_VERTEX);
  }

  #drawWorldHandles(doc: MeshDocument, highlight: Highlight, affine: Affine): void {
    const topology = weldTopology(doc.vertices);
    const highlighted = new Set<number>();
    if (highlight.vertex !== null) highlighted.add(topology.vertexWeld[highlight.vertex]);
    if (highlight.triangleId !== null) {
      const tri = doc.triangles.find((t) => t.id === highlight.triangleId);
      if (tri) for (const vi of tri.vertices) highlighted.add(topology.vertexWeld[vi]);
    }
    const normal: Point[] = [];
    const pinned: Point[] = [];
    const selected: Point[] = [];
    for (let weld = 0; weld < topology.weldVertex.length; weld++) {
      const vertex = doc.vertices[topology.weldVertex[weld]];
      const point: Point = { p: topology.weldPosition[weld] };
      if (highlighted.has(weld)) selected.push(point);
      else if (vertex.pinned) pinned.push(point);
      else normal.push(point);
    }
    this.#drawPoints(normal, PALETTE.handle, 6, affine);
    this.#drawPoints(pinned, PALETTE.handlePinned, 7, affine);
    this.#drawPoints(selected, PALETTE.handleSelected, 9, affine);
  }

  /* -------------------------------------------------------- texture pane */

  #drawTexturePane(
    doc: MeshDocument,
    diagnostics: DiagnosticsSnapshot,
    options: ViewOptions,
    highlight: Highlight,
    rect: PaneRect,
  ): void {
    const gl = this.gl;
    const affine = uvAffine(rect, 0.84);
    const boundaryTriangleIds = boundaryTriangles(doc);

    // The texture image as a unit-square quad in UV space.
    gl.useProgram(this.#meshProgram.program);
    gl.uniform4f(this.#meshProgram.uniform.affine, ...affine);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.uniform1i(this.#meshProgram.uniform.texture, 0);
    gl.uniform1i(this.#meshProgram.uniform.mode, 0);
    gl.uniform1f(this.#meshProgram.uniform.opacity, 1);
    gl.bindVertexArray(this.#meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(TEXTURE_QUAD), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // UV layout: draw the UV wireframe of every triangle so the texture stays
    // readable, then tint only the triangles a designer needs to find (flipped,
    // collapsed, over-stretched). Filling every triangle would hide the texture
    // the layout is meant to be compared against.
    const uvLines: Segment[] = [];
    const tintData: number[] = [];
    for (const tri of doc.triangles) {
      const metric = diagnostics.triangleById.get(tri.id);
      if (metric?.invalid && options.badPatchMode === 'disable') continue;
      const uv = tri.uvs;
      if (highlight.triangleId === tri.id) {
        uvLines.push({ a: uv[0], b: uv[1] }, { a: uv[1], b: uv[2] }, { a: uv[2], b: uv[0] });
      }
      if (!metric?.bad) continue;
      const colour = metric.invalid ? PALETTE.flipped : PALETTE.stretched;
      for (let k = 0; k < 3; k++) {
        const p = doc.vertices[tri.vertices[k]];
        tintData.push(uv[k].x, uv[k].y, p.x, p.y, colour[0], colour[1], colour[2]);
      }
    }
    if (tintData.length > 0) {
      gl.uniform1i(this.#meshProgram.uniform.mode, 2);
      gl.uniform1f(this.#meshProgram.uniform.opacity, 0.75);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tintData), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, tintData.length / FLOATS_PER_VERTEX);
    }

    // Thin UV wireframe for every triangle, plus a brighter outline for the
    // selected one.
    const allUvLines: Segment[] = [];
    for (const tri of doc.triangles) {
      const uv = tri.uvs;
      allUvLines.push({ a: uv[0], b: uv[1] }, { a: uv[1], b: uv[2] }, { a: uv[2], b: uv[0] });
    }
    this.#drawLines(allUvLines, [1, 1, 1], 0.18, affine);
    if (uvLines.length > 0) this.#drawLines(uvLines, [1, 1, 1], 0.95, affine);

    // Seam UV lines: both sides drawn separately. A split seam shows two
    // lines; a continuous seam shows one (they coincide).
    const resolved = resolveSeams(doc);
    const seamSegmentsA: Segment[] = [];
    const seamSegmentsB: Segment[] = [];
    const seamBad: Segment[] = [];
    for (const seam of resolved) {
      const metrics = diagnostics.seamById.get(seam.id);
      const segmentA: Segment = { a: seam.uvA[0], b: seam.uvA[1] };
      const segmentB: Segment = { a: seam.uvB[0], b: seam.uvB[1] };
      if (!metrics || metrics.status === 'invalid' || metrics.status === 'accidental-split') {
        seamBad.push(segmentA, segmentB);
        continue;
      }
      if (seam.kind === 'split') {
        seamSegmentsA.push(segmentA);
        seamSegmentsB.push(segmentB);
      } else {
        seamSegmentsA.push(segmentA);
      }
    }
    this.#drawLines(seamSegmentsA, PALETTE.continuousSeam, 0.9, affine, 1.5);
    this.#drawLines(seamSegmentsB, PALETTE.splitSeam, 1, affine, 2);
    this.#drawLines(seamBad, PALETTE.badSeam, 1, affine, 2);

    if (highlight.seamId) {
      const seam = resolved.find((s) => s.id === highlight.seamId);
      if (seam) {
        this.#drawLines([{ a: seam.uvA[0], b: seam.uvA[1] }], [1, 1, 1], 1, affine, 4);
        this.#drawLines([{ a: seam.uvB[0], b: seam.uvB[1] }], [1, 1, 1], 1, affine, 4);
      }
    }

    if (options.showBoundary) {
      for (const tri of doc.triangles) {
        if (!boundaryTriangleIds.has(tri.id)) continue;
        const uv = tri.uvs;
        this.#drawLines(
          [
            { a: uv[0], b: uv[1] },
            { a: uv[1], b: uv[2] },
            { a: uv[2], b: uv[0] },
          ],
          PALETTE.boundary,
          0.4,
          affine,
        );
      }
    }

    if (options.showHandles) {
      const points: Point[] = [];
      for (const tri of doc.triangles) {
        const selected = highlight.triangleId === tri.id;
        for (let k = 0; k < 3; k++) points.push({ p: tri.uvs[k], selected });
      }
      const normal = points.filter((p) => !p.selected);
      const selected = points.filter((p) => p.selected);
      this.#drawPoints(normal, PALETTE.handle, 4, affine);
      this.#drawPoints(selected, PALETTE.handleSelected, 6, affine);
    }
  }

  /* -------------------------------------------------------------- drawing */

  #upload(data: number[]): Float32Array {
    if (data.length === 0) return new Float32Array(0);
    const gl = this.gl;
    const buffer = new Float32Array(data);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.DYNAMIC_DRAW);
    return buffer;
  }

  #drawLines(segments: Segment[], colour: RGB, alpha: number, affine: Affine, pointSize = 1): void {
    if (segments.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.#overlayProgram.program);
    gl.uniform4f(this.#overlayProgram.uniform.affine, ...affine);
    gl.uniform1i(this.#overlayProgram.uniform.mode, 0);
    gl.uniform1f(this.#overlayProgram.uniform.alpha, alpha);
    gl.uniform1f(this.#overlayProgram.uniform.pointSize, pointSize);
    gl.bindVertexArray(this.#overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);
    const data: number[] = [];
    for (const segment of segments) {
      for (const p of [segment.a, segment.b]) {
        data.push(p.x, p.y, 0, 0, colour[0], colour[1], colour[2]);
      }
    }
    this.#upload(data);
    gl.drawArrays(gl.LINES, 0, segments.length * 2);
  }

  #drawPoints(points: Point[], colour: RGB, size: number, affine: Affine): void {
    if (points.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.#overlayProgram.program);
    gl.uniform4f(this.#overlayProgram.uniform.affine, ...affine);
    gl.uniform1i(this.#overlayProgram.uniform.mode, 1);
    gl.uniform1f(this.#overlayProgram.uniform.alpha, 0.92);
    gl.uniform1f(this.#overlayProgram.uniform.pointSize, size * 2);
    gl.bindVertexArray(this.#overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo);
    const data: number[] = [];
    for (const point of points) {
      for (const _ of [0, 1]) {
        data.push(point.p.x, point.p.y, 0, 0, colour[0], colour[1], colour[2]);
      }
    }
    this.#upload(data);
    gl.drawArrays(gl.POINTS, 0, points.length * 2);
  }
}

interface Segment {
  a: Vec2;
  b: Vec2;
}

interface Point {
  p: Vec2;
  selected?: boolean;
}

const TEXTURE_QUAD = [
  0, 0, 0, 0, 1, 1, 1,
  1, 0, 1, 1, 1, 1, 1,
  1, 1, 1, 0, 1, 1, 1,
  0, 0, 0, 0, 1, 1, 1,
  1, 1, 1, 0, 1, 1, 1,
  0, 1, 0, 1, 1, 1, 1,
];

/** Colour ramp for the stretch channel. */
export function metricColour(metric: DiagnosticsSnapshot['triangles'][number]): RGB {
  if (metric.flipped) return PALETTE.flipped;
  if (metric.collapsed) return PALETTE.collapsed;
  if (metric.compressed) return PALETTE.compressed;
  if (!metric.overStretched) return PALETTE.valid;
  const t = Math.min(1, Math.max(0, (metric.deformation - 1) / 2));
  return [0.4 + 0.6 * t, 0.85 - 0.55 * t, 0.3 - 0.25 * t];
}

/** Boundary segments in fabric space (welded to avoid split-seam duplicates). */
export function boundarySegments(doc: MeshDocument): Segment[] {
  const topology = weldTopology(doc.vertices);
  const edges = new Map<string, { a: Vec2; b: Vec2; count: number }>();
  for (const tri of doc.triangles) {
    for (let k = 0; k < 3; k++) {
      const va = topology.vertexWeld[tri.vertices[k]];
      const vb = topology.vertexWeld[tri.vertices[(k + 1) % 3]];
      if (va === vb) continue;
      const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
      const existing = edges.get(key);
      if (existing) existing.count++;
      else {
        edges.set(key, {
          a: topology.weldPosition[Math.min(va, vb)],
          b: topology.weldPosition[Math.max(va, vb)],
          count: 1,
        });
      }
    }
  }
  const result: Segment[] = [];
  for (const [, edge] of edges) if (edge.count === 1) result.push({ a: edge.a, b: edge.b });
  return result;
}

/** Triangle ids that touch a boundary edge, for texture-pane outlines. */
export function boundaryTriangles(doc: MeshDocument): Set<number> {
  const topology = weldTopology(doc.vertices);
  const edgeCounts = new Map<string, number>();
  const triangleEdges = new Map<number, string[]>();
  for (const tri of doc.triangles) {
    const keys: string[] = [];
    for (let k = 0; k < 3; k++) {
      const va = topology.vertexWeld[tri.vertices[k]];
      const vb = topology.vertexWeld[tri.vertices[(k + 1) % 3]];
      if (va === vb) continue;
      const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
      keys.push(key);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    triangleEdges.set(tri.id, keys);
  }
  const result = new Set<number>();
  for (const [id, keys] of triangleEdges) {
    if (keys.some((key) => edgeCounts.get(key) === 1)) result.add(id);
  }
  return result;
}

/**
 * Screen (CSS pixel, pane-local) → fabric world. Inverse of `worldAffine`.
 */
export function screenToWorld(
  camera: Camera,
  rect: PaneRect,
  x: number,
  y: number,
): Vec2 {
  return {
    x: (x - rect.width / 2) / camera.scale + camera.centerX,
    y: (y - rect.height / 2) / camera.scale + camera.centerY,
  };
}

/**
 * Screen (CSS pixel, pane-local) → UV. Inverse of `uvAffine`.
 */
export function screenToUv(rect: PaneRect, x: number, y: number, fit = 0.84): Vec2 {
  // Direct inverse of uvToScreen: the UV square is centred and scaled to the
  // shorter side, in screen (Y-down) space.
  const side = Math.min(rect.width, rect.height) * fit;
  return {
    x: (x - rect.width / 2) / side + 0.5,
    y: (y - rect.height / 2) / side + 0.5,
  };
}

/**
 * UV → CSS pixel inside the texture pane. Exposed for tests and hit-testing.
 */
export function uvToScreen(rect: PaneRect, uv: Vec2, fit = 0.84): Vec2 {
  const side = Math.min(rect.width, rect.height) * fit;
  return {
    x: rect.width / 2 + (uv.x - 0.5) * side,
    y: rect.height / 2 + (uv.y - 0.5) * side,
  };
}

