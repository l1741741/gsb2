// 浏览器端入口：加载本地 JSON，提供播放 / 逐帧 / 拖动时间轴 / 循环 /
// 过渡观察 / 挂点固定（可拖动目标）/ 数值导出。
import type { CharacterDef, ClipDef, ScenarioDef } from './types.js';
import { buildScene, evaluateFrame, type Scene } from './evaluate.js';
import { renderFrame } from './render.js';
import { exportScenario } from './export.js';

const FRAME_STEP = 1 / 60;

async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return (await res.json()) as T;
}

const [character, clipsData, scenariosData] = await Promise.all([
  loadJson<CharacterDef>('data/character.json'),
  loadJson<{ clips: ClipDef[] }>('data/clips.json'),
  loadJson<{ scenarios: ScenarioDef[] }>('data/scenarios.json'),
]);

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud') as HTMLPreElement;
const scenarioSelect = document.getElementById('scenario') as HTMLSelectElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const prevBtn = document.getElementById('prev') as HTMLButtonElement;
const nextBtn = document.getElementById('next') as HTMLButtonElement;
const loopChk = document.getElementById('loop') as HTMLInputElement;
const speedSel = document.getElementById('speed') as HTMLSelectElement;
const timeSlider = document.getElementById('time') as HTMLInputElement;
const exportBtn = document.getElementById('export') as HTMLButtonElement;
const pinList = document.getElementById('pins') as HTMLDivElement;

// ---- 播放状态：唯一的可变状态是“当前时间”等 UI 输入；画面永远由
// evaluateFrame(scene, time) 纯函数得出，与播放历史无关。 ----
let scene: Scene;
let time = 0;
let playing = false;
let speed = 1;
let loop = true;
let pinEnabled: boolean[] = [];
let draggingPin: number | null = null;

const camera = { cx: canvas.width / 2, cy: 220, scale: 2 };

function currentScenario(): ScenarioDef {
  return scenariosData.scenarios[scenarioSelect.selectedIndex];
}

function rebuildScene(): void {
  const def = currentScenario();
  // 根据勾选状态过滤固定点
  const filtered: ScenarioDef = {
    ...def,
    pins: def.pins.filter((_, i) => pinEnabled[i] !== false),
    loop,
  };
  scene = buildScene(character, clipsData.clips, filtered);
  timeSlider.max = String(scene.totalDuration);
  timeSlider.step = '0.001';
  buildPinList(def);
}

function buildPinList(def: ScenarioDef): void {
  pinList.innerHTML = '';
  def.pins.forEach((pin, i) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = pinEnabled[i] !== false;
    box.addEventListener('change', () => {
      pinEnabled[i] = box.checked;
      rebuildScene();
    });
    label.append(box, ` 固定 ${pin.attachment} → (${pin.x}, ${pin.y})`);
    pinList.append(label);
  });
}

function drawFrame(): void {
  const frame = evaluateFrame(scene, time);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderFrame(ctx, character, frame, camera);
  const seg = scene.scenario.program[frame.segmentIndex];
  const lines = [
    `time      ${frame.time.toFixed(3)} / ${scene.totalDuration.toFixed(3)}`,
    `segment   #${frame.segmentIndex} ${frame.segmentType}` +
      (frame.blend !== null ? `  blend=${frame.blend.toFixed(3)}` : ''),
    `clip(s)   ${seg.type === 'clip' ? seg.clip : `${seg.from} → ${seg.to}`}`,
  ];
  for (const pin of frame.pins) {
    lines.push(
      `pin ${pin.attachment.padEnd(8)} target(${pin.target.x}, ${pin.target.y})` +
        `  achieved(${pin.achieved.x.toFixed(1)}, ${pin.achieved.y.toFixed(1)})` +
        `  deviation=${pin.deviation.toFixed(2)} ${pin.reachable ? '可达' : '不可达'}`,
    );
  }
  hud.textContent = lines.join('\n');
  if (document.activeElement !== timeSlider) timeSlider.value = String(frame.time);
}

// ---- 控件 ----
scenarioSelect.addEventListener('change', () => {
  pinEnabled = [];
  time = 0;
  rebuildScene();
  drawFrame();
});
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '暂停' : '播放';
});
prevBtn.addEventListener('click', () => {
  time -= FRAME_STEP;
  drawFrame();
});
nextBtn.addEventListener('click', () => {
  time += FRAME_STEP;
  drawFrame();
});
loopChk.addEventListener('change', () => {
  loop = loopChk.checked;
  rebuildScene();
  drawFrame();
});
speedSel.addEventListener('change', () => {
  speed = Number(speedSel.value);
});
timeSlider.addEventListener('input', () => {
  time = Number(timeSlider.value);
  drawFrame();
});
exportBtn.addEventListener('click', () => {
  const data = exportScenario(scene);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${scene.scenario.id}-export.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// 拖动固定点目标（场景坐标）
function toScene(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - camera.cx) / camera.scale,
    y: (e.clientY - rect.top - camera.cy) / camera.scale,
  };
}
canvas.addEventListener('mousedown', (e) => {
  const p = toScene(e);
  const pins = currentScenario().pins;
  for (let i = 0; i < pins.length; i++) {
    if (pinEnabled[i] === false) continue;
    if (Math.hypot(pins[i].x - p.x, pins[i].y - p.y) < 10 / camera.scale + 6) {
      draggingPin = i;
      return;
    }
  }
});
canvas.addEventListener('mousemove', (e) => {
  if (draggingPin === null) return;
  const p = toScene(e);
  const pin = currentScenario().pins[draggingPin];
  pin.x = Math.round(p.x * 10) / 10;
  pin.y = Math.round(p.y * 10) / 10;
  rebuildScene();
  drawFrame();
});
canvas.addEventListener('mouseup', () => {
  draggingPin = null;
});

// ---- 主循环：只推进时间，画面由纯函数求值 ----
let lastTs: number | null = null;
function tick(ts: number): void {
  if (playing && lastTs !== null) {
    time += ((ts - lastTs) / 1000) * speed;
    if (loop) {
      time = ((time % scene.totalDuration) + scene.totalDuration) % scene.totalDuration;
    } else {
      time = Math.min(Math.max(time, 0), scene.totalDuration);
      if (time >= scene.totalDuration) {
        playing = false;
        playBtn.textContent = '播放';
      }
    }
    drawFrame();
  }
  lastTs = ts;
  requestAnimationFrame(tick);
}

loopChk.checked = true;
rebuildScene();
drawFrame();
requestAnimationFrame(tick);
