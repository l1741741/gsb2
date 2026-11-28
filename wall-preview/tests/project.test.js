import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWall, arcLengthMm } from '../src/geometry.js';
import { PROJECT_FORMAT, buildExport, serializeProject, parseProject } from '../src/project.js';

function sampleProject() {
  const wall = makeWall({ radiusMm: 2500, startAngleDeg: 0, endAngleDeg: 360, heightMm: 2400 });
  const length = arcLengthMm(wall);
  return {
    wall,
    artwork: {
      imageName: 'art.png',
      imageWidthPx: 3000,
      imageHeightPx: 1200,
      offsetMm: length - 2500, // 跨起止缝
      widthMm: 6000,
      bottomMm: 200,
      heightMm: 2000,
    },
    anchors: [
      { id: 'P1', name: 'P1', arcMm: 500, heightMm: 2000 },
      { id: 'P2', name: 'P2', arcMm: length - 800, heightMm: 400 },
    ],
  };
}

test('导出包含展开坐标，重新导入可完整还原', () => {
  const project = sampleProject();
  const exported = buildExport(project);
  assert.equal(exported.format, PROJECT_FORMAT);
  // 展开坐标：原点在起始边底角；跨缝画面 x1 超出展开长度
  assert.equal(exported.unwrapped.artworkRectMm.x0, project.artwork.offsetMm);
  assert.ok(exported.unwrapped.artworkRectMm.x1 > exported.unwrapped.arcLengthMm);
  assert.deepEqual(exported.unwrapped.anchors.map((a) => a.id), ['P1', 'P2']);

  const result = parseProject(serializeProject(project));
  assert.equal(result.ok, true, result.errors?.join('；'));
  assert.deepEqual(result.project.wall, project.wall);
  assert.equal(result.project.artwork.offsetMm, project.artwork.offsetMm);
  assert.equal(result.project.artwork.widthMm, project.artwork.widthMm);
  assert.deepEqual(
    result.project.anchors.map((a) => [a.id, a.arcMm, a.heightMm]),
    project.anchors.map((a) => [a.id, a.arcMm, a.heightMm]),
  );
});

test('非法角在导入时被拒绝并指明原因', () => {
  const project = sampleProject();
  project.wall = { radiusMm: 2500, startAngleDeg: 300, endAngleDeg: 100, heightMm: 2400 };
  const result = parseProject(JSON.stringify(buildExport(project)));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('结束角必须大于起始角')));

  project.wall = { radiusMm: 2500, startAngleDeg: 0, endAngleDeg: 720, heightMm: 2400 };
  const result2 = parseProject(JSON.stringify(buildExport(project)));
  assert.equal(result2.ok, false);
  assert.ok(result2.errors.some((e) => e.includes('360')));
});

test('相互冲突的定位点在导入时被明确指出', () => {
  const project = sampleProject();
  project.anchors = [
    { id: 'A', arcMm: 1000, heightMm: 1000 },
    { id: 'B', arcMm: 1000.2, heightMm: 999.8 },
  ];
  const result = parseProject(JSON.stringify(buildExport(project)));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('冲突') && e.includes('A') && e.includes('B')));
});

test('格式不符与 JSON 损坏都有明确报错', () => {
  assert.ok(parseProject('{oops').errors.some((e) => e.includes('JSON 解析失败')));
  const wrong = parseProject(JSON.stringify({ format: 'other/1', wall: sampleProject().wall }));
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some((e) => e.includes('文件格式不符')));
});

test('不足一圈时跨缝布置在导入时被拒绝', () => {
  const project = sampleProject();
  project.wall = makeWall({ radiusMm: 3000, startAngleDeg: 0, endAngleDeg: 200, heightMm: 2600 });
  project.artwork = { ...project.artwork, offsetMm: 9000, widthMm: 2000, heightMm: 2000 };
  const result = parseProject(JSON.stringify(buildExport(project)));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('不足一圈')));
});
