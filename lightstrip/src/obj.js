// Wavefront OBJ export with positions, texture coordinates, vertex normals
// and per-part materials ('strip' surface, 'cap' end caps).

function fmt(v) {
  const r = Math.abs(v) < 1e-12 ? 0 : v; // avoid "-0"
  return Number(r.toPrecision(8)).toString();
}

export function toObj(mesh) {
  const lines = [
    `# lightstrip export: ${mesh.name}`,
    `# vertices=${mesh.positions.length} faces=${mesh.faces.length} closed=${mesh.closed}`,
    `o ${mesh.name}`,
  ];
  for (const p of mesh.positions) lines.push(`v ${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`);
  for (const uv of mesh.uvs) lines.push(`vt ${fmt(uv[0])} ${fmt(uv[1])}`);
  for (const n of mesh.normals) lines.push(`vn ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
  let material = null;
  for (const f of mesh.faces) {
    if (f.material !== material) {
      lines.push(`usemtl ${f.material}`);
      material = f.material;
    }
    lines.push(`f ${f.indices.map((i) => `${i + 1}/${i + 1}/${i + 1}`).join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}
