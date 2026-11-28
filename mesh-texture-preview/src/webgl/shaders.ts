/**
 * Shaders for the mesh preview.
 *
 * Triangles are drawn as separate meshes (each with its own UVs), which is
 * what makes split seams possible: a shared fabric edge has two independent
 * texel lines, one per side. The fragment shader samples a repeating texture
 * and optionally replaces or tints it with a diagnostic colour.
 */

export const MESH_VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec3 a_col;
uniform vec4 u_affine; // scale.x, scale.y, offset.x, offset.y
out vec2 v_uv;
out vec3 v_col;
void main() {
  vec2 clip = a_pos * u_affine.xy + u_affine.zw;
  gl_Position = vec4(clip.x, clip.y, 0.0, 1.0);
  v_uv = a_uv;
  v_col = a_col;
}
`;

/**
 * u_mode: 0 = texture, 1 = flat colour, 2 = texture multiplied by a tint.
 * a_col is white for normal triangles and a diagnostic colour otherwise.
 */
export const MESH_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_col;
uniform sampler2D u_tex;
uniform int u_mode;
uniform float u_opacity;
out vec4 outColor;
void main() {
  if (u_mode == 1) {
    outColor = vec4(v_col, u_opacity);
    return;
  }
  vec4 tex = texture(u_tex, v_uv);
  if (u_mode == 2) {
    outColor = vec4(tex.rgb * mix(vec3(1.0), v_col, 0.55), u_opacity);
    return;
  }
  outColor = vec4(tex.rgb, u_opacity);
}
`;

/**
 * Overlay program for linesquad segments and point handles. It shares the
 * vertex layout of the mesh program so one buffer/VAO pattern is reused.
 */
export const OVERLAY_VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec3 a_col;
uniform vec4 u_affine;
uniform float u_pointSize;
out vec3 v_col;
void main() {
  vec2 clip = a_pos * u_affine.xy + u_affine.zw;
  gl_Position = vec4(clip.x, clip.y, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_col = a_col;
}
`;

export const OVERLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_col;
uniform float u_alpha;
uniform int u_mode; // 0 = plain, 1 = round point
out vec4 outColor;
void main() {
  if (u_mode == 1) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  outColor = vec4(v_col, u_alpha);
}
`;
