import { buildSweep } from '../src/sweep.js';
import { formatDiagnostics } from '../src/diagnostics.js';

const CASES = ['spatial-bend', 'closed-loop', 'u-turn', 'straight-joint'];

const canvas = document.querySelector('#view');
const ctx = canvas.getContext('2d');
const select = document.querySelector('#case');
const diagEl = document.querySelector('#diag');
const wireEl = document.querySelector('#wire');

for (const name of CASES) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  select.append(option);
}

let mesh = null;
let intersectingFaces = new Set();
let yaw = 0.7;
let pitch = 0.45;
let distance = 8;
let target = [0, 0, 0];

async function loadCase(name) {
  const response = await fetch(`../cases/${name}.json`);
  const def = await response.json();
  mesh = buildSweep(def);
  intersectingFaces = new Set();
  for (const pair of mesh.diagnostics.selfIntersections.pairs) {
    intersectingFaces.add(pair.faceA);
    intersectingFaces.add(pair.faceB);
  }
  // Frame the model.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.positions) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  target = min.map((v, k) => (v + max[k]) / 2);
  distance = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])) * 1.4;
  const text = formatDiagnostics(mesh.diagnostics);
  const hasProblems = text.includes('PROBLEMS');
  diagEl.innerHTML = `<span class="${hasProblems ? 'bad' : 'ok'}"></span>`;
  diagEl.textContent = text;
  diagEl.className = hasProblems ? 'bad' : 'ok';
  draw();
}

function project(p, width, height) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const dx = p[0] - target[0];
  const dy = p[1] - target[1];
  const dz = p[2] - target[2];
  const x1 = dx * cy - dz * sy;
  const z1 = dx * sy + dz * cy;
  const y2 = dy * cp - z1 * sp;
  const z2 = dy * sp + z1 * cp;
  const camZ = distance - z2;
  if (camZ < 0.05) return null;
  const f = height * 1.1;
  return [width / 2 + (x1 * f) / camZ, height / 2 - (y2 * f) / camZ, camZ];
}

function shade(base, factor) {
  const r = Math.min(255, Math.round(base[0] * factor));
  const g = Math.min(255, Math.round(base[1] * factor));
  const b = Math.min(255, Math.round(base[2] * factor));
  return `rgb(${r},${g},${b})`;
}

const LIGHT = (() => {
  const l = Math.hypot(0.5, 0.8, 0.6);
  return [0.5 / l, 0.8 / l, 0.6 / l];
})();

function draw() {
  if (!mesh) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * devicePixelRatio) {
    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
  }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, width, height);

  const projected = mesh.positions.map((p) => project(p, width, height));
  const wire = wireEl.checked;

  // Painter's algorithm: draw far faces first.
  const order = mesh.faces
    .map((face, index) => {
      const pts = face.indices.map((i) => projected[i]);
      const z = pts.every(Boolean) ? (pts[0][2] + pts[1][2] + pts[2][2]) / 3 : -Infinity;
      return { face, index, pts, z };
    })
    .filter((item) => item.z > 0)
    .sort((a, b) => b.z - a.z);

  for (const { face, index, pts } of order) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.closePath();
    if (intersectingFaces.has(index)) {
      ctx.fillStyle = '#ff4d6d';
    } else {
      const n = mesh.normals[face.indices[0]];
      const lambert = 0.35 + 0.65 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      ctx.fillStyle = shade(face.material === 'cap' ? [61, 155, 232] : [232, 163, 61], lambert);
    }
    if (wire) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
    } else {
      ctx.fill();
    }
  }

  // Path polyline.
  ctx.strokeStyle = 'rgba(240,240,240,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const p of mesh.pathSamples) {
    const q = project(p, width, height);
    if (!q) continue;
    if (started) ctx.lineTo(q[0], q[1]);
    else ctx.moveTo(q[0], q[1]);
    started = true;
  }
  ctx.stroke();

  // Control point markers with indices.
  ctx.font = '10px ui-monospace, monospace';
  mesh.controlPoints.forEach((cp, i) => {
    const q = project(cp.position, width, height);
    if (!q) return;
    ctx.beginPath();
    ctx.arc(q[0], q[1], 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f2f2f2';
    ctx.fill();
    ctx.fillStyle = '#10151c';
    ctx.fillText(String(i), q[0] - 3, q[1] + 3);
  });
}

// Orbit controls.
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw += e.movementX * 0.008;
  pitch = Math.min(1.5, Math.max(-1.5, pitch + e.movementY * 0.008));
  draw();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  distance = Math.max(0.5, distance * (1 + Math.sign(e.deltaY) * 0.1));
  draw();
}, { passive: false });
wireEl.addEventListener('change', draw);
select.addEventListener('change', () => loadCase(select.value));
window.addEventListener('resize', draw);

select.value = CASES[0];
loadCase(CASES[0]);
