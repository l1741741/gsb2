// 离线生成两组样例：一张不足一圈的画面、一张跨起止缝的画面，
// 以及对应的 .project.json（内嵌图像，导入即可还原）。不访问网络。
// 运行：node tools/make-samples.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

// ---------- 极简 PNG 编码器（RGB8，无滤波） ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画布基元 ----------

function makeCanvas(width, height, [r, g, b]) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

function setPx(c, x, y, [r, g, b]) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= c.width || yi < 0 || yi >= c.height) return;
  const i = (yi * c.width + xi) * 3;
  c.rgb[i] = r;
  c.rgb[i + 1] = g;
  c.rgb[i + 2] = b;
}

function fillRect(c, x0, y0, w, h, color) {
  for (let y = Math.max(0, y0); y < Math.min(c.height, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(c.width, x0 + w); x += 1) {
      setPx(c, x, y, color);
    }
  }
}

function fillCircle(c, cx, cy, radius, color, wrapX = false) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      setPx(c, x, y, color);
      if (wrapX) { // 满圈画面：同时画回绕副本，让跨缝图形连续
        setPx(c, x - c.width, y, color);
        setPx(c, x + c.width, y, color);
      }
    }
  }
}

function drawLine(c, x0, y0, x1, y1, thickness, color, wrapX = false) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    fillCircle(c, x, y, thickness / 2, color, wrapX);
  }
}

// ---------- 样例一：不足一圈（200° 墙，画面不铺满，两侧留白） ----------

function makePartialArtwork() {
  const c = makeCanvas(1600, 520, [245, 242, 234]);
  // 网格
  for (let x = 0; x < c.width; x += 100) fillRect(c, x, 0, 1, c.height, [210, 205, 192]);
  for (let y = 0; y < c.height; y += 100) fillRect(c, 0, y, c.width, 1, [210, 205, 192]);
  // 主斜线与反向斜线
  drawLine(c, 0, c.height, c.width, 0, 10, [178, 52, 48]);
  drawLine(c, 0, 0, c.width, c.height, 4, [224, 168, 96]);
  // 一排圆
  for (let i = 0; i < 5; i += 1) {
    fillCircle(c, 200 + i * 300, 130, 56, [40, 92, 140]);
  }
  // 左右边缘色带：若空白区误重复贴图，色带会出现在不该出现的地方
  fillRect(c, 0, 0, 24, c.height, [32, 120, 80]);
  fillRect(c, c.width - 24, 0, 24, c.height, [200, 110, 30]);
  // 外框
  fillRect(c, 0, 0, c.width, 6, [60, 56, 48]);
  fillRect(c, 0, c.height - 6, c.width, 6, [60, 56, 48]);
  return c;
}

// ---------- 样例二：满圈跨缝（图案跨过起止缝必须连续） ----------

function makeFullCircleArtwork() {
  const W = 3000;
  const H = 1200;
  const c = makeCanvas(W, H, [238, 240, 244]);
  // 垂直渐变带
  for (let y = 0; y < H; y += 1) {
    const t = y / H;
    fillRect(c, 0, y, W, 1, [238 - t * 30, 240 - t * 40, 244 - t * 20]);
  }
  // 整数周期正弦带：左右边缘天然连续
  for (let x = 0; x < W; x += 1) {
    const yc = H / 2 + 300 * Math.sin((2 * Math.PI * 4 * x) / W);
    fillCircle(c, x, yc, 26, [150, 40, 120], true);
  }
  // 斜纹：周期整除宽度，跨缝连续
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if ((x + 2 * y) % 300 < 10) setPx(c, x, y, [120, 150, 190]);
    }
  }
  // 一个大圆故意压在右边缘（即起止缝）上，靠回绕副本保持连续
  fillCircle(c, W - 150, 320, 220, [232, 176, 40], true);
  fillCircle(c, 200, 900, 140, [30, 130, 150], true);
  return c;
}

// ---------- 写出样例与项目文件 ----------

function toDataUrl(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

mkdirSync(SAMPLES_DIR, { recursive: true });

const partialPng = encodePng(1600, 520, makePartialArtwork().rgb);
writeFileSync(join(SAMPLES_DIR, 'partial-wall-artwork.png'), partialPng);

const fullPng = encodePng(3000, 1200, makeFullCircleArtwork().rgb);
writeFileSync(join(SAMPLES_DIR, 'full-circle-artwork.png'), fullPng);

// 不足一圈：半径 3000mm，20°–200°，展开长约 9424.8mm；画面 8000×2000mm，两侧留白
const partialProject = {
  format: 'gsb2-wall-preview/1',
  wall: { radiusMm: 3000, startAngleDeg: 20, endAngleDeg: 200, heightMm: 2600 },
  artwork: {
    imageName: 'partial-wall-artwork.png',
    imageWidthPx: 1600,
    imageHeightPx: 520,
    offsetMm: 500,
    widthMm: 8000,
    bottomMm: 300,
    heightMm: 2000,
    imageDataUrl: toDataUrl(partialPng),
  },
  anchors: [
    { id: 'P1', name: 'P1', arcMm: 1200, heightMm: 300 },
    { id: 'P2', name: 'P2', arcMm: 8600, heightMm: 2300 },
    { id: 'P3', name: 'P3', arcMm: 4500, heightMm: 1300 },
  ],
};

// 满圈跨缝：半径 2500mm，0°–360°，展开长约 15708mm；
// 画面宽 6000mm，偏移 13208mm → 跨过起止缝 3500mm，检验接缝处线条连续
const circumference = 2500 * 2 * Math.PI;
const fullProject = {
  format: 'gsb2-wall-preview/1',
  wall: { radiusMm: 2500, startAngleDeg: 0, endAngleDeg: 360, heightMm: 2400 },
  artwork: {
    imageName: 'full-circle-artwork.png',
    imageWidthPx: 3000,
    imageHeightPx: 1200,
    offsetMm: Math.round((circumference - 2500) * 10) / 10,
    widthMm: 6000,
    bottomMm: 200,
    heightMm: 2000,
    imageDataUrl: toDataUrl(fullPng),
  },
  anchors: [
    { id: 'S1', name: 'S1', arcMm: Math.round((circumference - 800) * 10) / 10, heightMm: 400 },
    { id: 'S2', name: 'S2', arcMm: 500, heightMm: 2000 },
    { id: 'S3', name: 'S3', arcMm: 8000, heightMm: 1200 },
  ],
};

writeFileSync(join(SAMPLES_DIR, 'partial-wall.project.json'), JSON.stringify(partialProject, null, 2));
writeFileSync(join(SAMPLES_DIR, 'full-circle.project.json'), JSON.stringify(fullProject, null, 2));

console.log(`已生成样例到 ${SAMPLES_DIR}`);
console.log(`  partial-wall-artwork.png  ${(partialPng.length / 1024).toFixed(1)} KB（不足一圈）`);
console.log(`  full-circle-artwork.png   ${(fullPng.length / 1024).toFixed(1)} KB（满圈跨缝）`);
