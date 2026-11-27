import type { CharacterDef, FrameResult } from './types.js';

const BONE_COLOR = '#d8d8d8';
const JOINT_COLOR = '#ffffff';
const ATTACHMENT_COLOR = '#4fc3f7';
const PIN_OK = '#7ee787';
const PIN_MISS = '#ff6b6b';

/** 把一帧求值结果画到 Canvas 上。坐标系即场景坐标（y 向下）。 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  def: CharacterDef,
  frame: FrameResult,
  camera: { cx: number; cy: number; scale: number },
): void {
  ctx.save();
  ctx.translate(camera.cx, camera.cy);
  ctx.scale(camera.scale, camera.scale);

  // 骨骼
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = BONE_COLOR;
  for (const b of frame.bones) {
    if (b.world === undefined) continue;
    const bone = def.bones.find((x) => x.id === b.id)!;
    if (bone.length <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(b.world.x, b.world.y);
    ctx.lineTo(b.tip.x, b.tip.y);
    ctx.stroke();
  }
  // 关节
  ctx.fillStyle = JOINT_COLOR;
  for (const b of frame.bones) {
    ctx.beginPath();
    ctx.arc(b.world.x, b.world.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 道具（跟随挂点）
  for (const prop of def.props) {
    const t = frame.props[prop.id];
    if (!t) continue;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate((t.rot * Math.PI) / 180);
    ctx.fillStyle = prop.color ?? '#c9a227';
    ctx.strokeStyle = '#6b5510';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(-prop.width / 2, -prop.height / 2, prop.width, prop.height);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 挂点
  ctx.fillStyle = ATTACHMENT_COLOR;
  for (const p of Object.values(frame.attachments)) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 5);
    ctx.lineTo(p.x + 5, p.y);
    ctx.lineTo(p.x, p.y + 5);
    ctx.lineTo(p.x - 5, p.y);
    ctx.closePath();
    ctx.fill();
  }

  // 固定目标与不可达偏差
  for (const pin of frame.pins) {
    const color = pin.reachable ? PIN_OK : PIN_MISS;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pin.target.x - 7, pin.target.y);
    ctx.lineTo(pin.target.x + 7, pin.target.y);
    ctx.moveTo(pin.target.x, pin.target.y - 7);
    ctx.lineTo(pin.target.x, pin.target.y + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pin.target.x, pin.target.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    if (pin.deviation > 0.5) {
      // 红色虚线：实际末端 -> 目标，旁边标注偏差数值
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pin.achieved.x, pin.achieved.y);
      ctx.lineTo(pin.target.x, pin.target.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '11px monospace';
      ctx.fillText(
        `Δ ${pin.deviation.toFixed(1)}`,
        (pin.achieved.x + pin.target.x) / 2 + 6,
        (pin.achieved.y + pin.target.y) / 2 - 6,
      );
    }
  }

  ctx.restore();
}
