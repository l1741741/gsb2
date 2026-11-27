// 内置样例场景。每个场景都带检查点 checkpoints：
//   dark    —— 该点应全暗（无任何灯贡献）
//   partial —— 多束光在该点相交（至少两盏灯贡献）
//   visible —— 至少一盏灯直接可见，lights 字段给出应贡献的灯 id
// 检查点坐标为世界坐标，测试与浏览器探针使用同一套照度代码。

export const corridorScene = {
  name: '走廊与门缝',
  bounds: { width: 1000, height: 420 },
  settings: { threshold: 0.15, cellSize: 14 },
  walls: [
    { id: 'wall-top', from: { x: 40, y: 60 }, to: { x: 960, y: 60 } },
    { id: 'wall-bottom', from: { x: 40, y: 360 }, to: { x: 960, y: 360 } },
    { id: 'wall-left', from: { x: 40, y: 60 }, to: { x: 40, y: 360 } },
    { id: 'wall-right', from: { x: 960, y: 60 }, to: { x: 960, y: 360 } },
  ],
  // 竖隔断在 x=500，门缝 y∈[190,250]。
  partitions: [
    {
      id: 'partition-door',
      from: { x: 500, y: 60 },
      to: { x: 500, y: 360 },
      openings: [{ start: 190, end: 250 }],
    },
  ],
  columns: [],
  lights: [
    { id: 'L1', name: '走廊左灯', x: 250, y: 180, aim: 0, fov: 1.0, range: 340, power: 1, color: '#ffd9a0' },
    { id: 'L2', name: '走廊右灯', x: 750, y: 180, aim: Math.PI, fov: 1.0, range: 340, power: 1, color: '#ffe6b0' },
  ],
  checkpoints: [
    { id: 'cp-dark', x: 900, y: 320, expect: 'dark', note: '右灯锥角外、左灯距离外，应全暗' },
    { id: 'cp-door', x: 560, y: 220, expect: 'partial', lights: ['L1', 'L2'], note: '门缝两侧两束光相交' },
    { id: 'cp-near', x: 280, y: 220, expect: 'visible', lights: ['L1'], note: '左灯直接可见，右灯距离不够' },
  ],
};

export const cornerScene = {
  name: '并排墙角（共享顶点）',
  bounds: { width: 1000, height: 700 },
  settings: { threshold: 0.15, cellSize: 14 },
  // L 形墙：水平段与竖直段共享顶点 (550,400)。
  walls: [
    { id: 'wall-horizontal', from: { x: 150, y: 400 }, to: { x: 550, y: 400 } },
    { id: 'wall-vertical', from: { x: 550, y: 150 }, to: { x: 550, y: 400 } },
  ],
  partitions: [],
  columns: [],
  lights: [
    { id: 'L1', name: '左上区灯', x: 250, y: 200, aim: 0, fov: Math.PI, range: 450, power: 1, color: '#ffd9a0' },
    { id: 'L2', name: '右下区灯', x: 720, y: 520, aim: 0, fov: Math.PI, range: 450, power: 1, color: '#b9d7ff' },
  ],
  checkpoints: [
    { id: 'cp-dark', x: 940, y: 100, expect: 'dark', note: '两灯射程之外，应全暗' },
    { id: 'cp-cross', x: 680, y: 100, expect: 'partial', lights: ['L1', 'L2'], note: '竖墙顶端上方，两束光绕过墙端相交' },
    { id: 'cp-graze-a', x: 545, y: 395, expect: 'visible', lights: ['L1'], note: '共享顶点左上侧：仅 L1 可见，L2 不得从顶点漏光' },
    { id: 'cp-graze-b', x: 555, y: 405, expect: 'visible', lights: ['L2'], note: '共享顶点右下侧：仅 L2 可见，L1 不得从顶点漏光' },
  ],
};

export const crossingScene = {
  name: '相交光束与圆柱',
  bounds: { width: 1000, height: 700 },
  settings: { threshold: 0.15, cellSize: 14 },
  walls: [
    { id: 'wall-top', from: { x: 40, y: 40 }, to: { x: 960, y: 40 } },
    { id: 'wall-bottom', from: { x: 40, y: 660 }, to: { x: 960, y: 660 } },
    { id: 'wall-left', from: { x: 40, y: 40 }, to: { x: 40, y: 660 } },
    { id: 'wall-right', from: { x: 960, y: 40 }, to: { x: 960, y: 660 } },
  ],
  partitions: [],
  columns: [
    { id: 'column-center', center: { x: 500, y: 350 }, radius: 45 },
  ],
  lights: [
    { id: 'L1', name: '左上全向灯', x: 200, y: 150, aim: 0, fov: Math.PI, range: 420, power: 1, color: '#ffd9a0' },
    { id: 'L2', name: '右上全向灯', x: 800, y: 150, aim: 0, fov: Math.PI, range: 420, power: 1, color: '#b9d7ff' },
  ],
  checkpoints: [
    { id: 'cp-shadow', x: 500, y: 400, expect: 'dark', note: '圆柱正后方，两灯视线都被柱身挡住' },
    { id: 'cp-cross', x: 500, y: 200, expect: 'partial', lights: ['L1', 'L2'], note: '圆柱上方两束光相交' },
    { id: 'cp-direct', x: 150, y: 500, expect: 'visible', lights: ['L1'], note: '左下开阔处仅 L1 直接可见' },
  ],
};

export const sampleScenes = [
  { key: 'corridor', label: '走廊与门缝', data: corridorScene },
  { key: 'corner', label: '并排墙角', data: cornerScene },
  { key: 'crossing', label: '相交光束与圆柱', data: crossingScene },
];
