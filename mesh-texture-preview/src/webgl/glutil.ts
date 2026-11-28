/**
 * WebGL2 plumbing: context creation, program compilation, and the affine
 * matrices that map world or UV space into each viewport.
 *
 * Coordinates: the fabric world and the screen are Y-down. WebGL clip space is
 * Y-up. The affine form used everywhere is
 *     clip = (x, y) * (sx, sy) + (ox, oy)
 * which keeps the CPU picking code and the shaders in agreement.
 */

export class GLInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GLInitError';
  }
}

export type Affine = [sx: number, sy: number, ox: number, oy: number];

export function getContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new GLInitError('当前浏览器不支持 WebGL2');
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GLInitError('无法创建 shader 对象');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '未知 shader 错误';
    gl.deleteShader(shader);
    throw new GLInitError(`shader 编译失败: ${log}`);
  }
  return shader;
}

export interface ProgramInfo {
  program: WebGLProgram;
  attrib: {
    position: number;
    uv: number;
    colour: number;
  };
  uniform: {
    affine: WebGLUniformLocation | null;
    texture: WebGLUniformLocation | null;
    mode: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    alpha: WebGLUniformLocation | null;
    pointSize: WebGLUniformLocation | null;
  };
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramInfo {
  const program = gl.createProgram();
  if (!program) throw new GLInitError('无法创建 program 对象');
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '未知链接错误';
    gl.deleteProgram(program);
    throw new GLInitError(`program 链接失败: ${log}`);
  }
  return {
    program,
    attrib: {
      position: gl.getAttribLocation(program, 'a_pos'),
      uv: gl.getAttribLocation(program, 'a_uv'),
      colour: gl.getAttribLocation(program, 'a_col'),
    },
    uniform: {
      affine: gl.getUniformLocation(program, 'u_affine'),
      texture: gl.getUniformLocation(program, 'u_tex'),
      mode: gl.getUniformLocation(program, 'u_mode'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      alpha: gl.getUniformLocation(program, 'u_alpha'),
      pointSize: gl.getUniformLocation(program, 'u_pointSize'),
    },
  };
}

/** World → clip affine for a viewport rect (in CSS pixels) and a camera. */
export function worldAffine(
  camera: { centerX: number; centerY: number; scale: number },
  rect: { width: number; height: number },
): Affine {
  const sx = (2 * camera.scale) / rect.width;
  const sy = (-2 * camera.scale) / rect.height;
  return [sx, sy, -camera.centerX * sx, -camera.centerY * sy];
}

/**
 * UV → clip affine for a viewport rect. The unit square is centred and scaled
 * to `fit` of the shorter side, leaving margin so out-of-range UVs (repeats,
 * split offsets) stay visible.
 */
export function uvAffine(
  rect: { width: number; height: number },
  fit = 0.86,
): Affine {
  const side = Math.min(rect.width, rect.height) * fit;
  const sx = (2 * side) / rect.width;
  const sy = (-2 * side) / rect.height;
  return [sx, sy, -0.5 * sx, -0.5 * sy];
}

/** Converts the shader affine into world coordinates of a clip-space point. */
export function clipToWorld(affine: Affine, clipX: number, clipY: number): { x: number; y: number } {
  return {
    x: (clipX - affine[2]) / affine[0],
    y: (clipY - affine[3]) / affine[1],
  };
}

/** Converts a clip-space point into UV space for the UV affine. */
export function clipToUv(affine: Affine, clipX: number, clipY: number): { x: number; y: number } {
  return {
    x: (clipX - affine[2]) / affine[0],
    y: (clipY - affine[3]) / affine[1],
  };
}
