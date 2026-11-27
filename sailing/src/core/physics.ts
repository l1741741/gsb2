import { bearingToVector, clamp, degToRad, normalizeBearing, wrapPi } from './math.ts';
import type { BoatKinematics, PhysicsParams, Vec2, WindSample } from './types.ts';

export interface BoatIntent {
  heading: number;
  sheet: number;
}

/** 帆位对推进的增益；完全收帆仍保留一点舵效。 */
export function sheetDrive(sheet: number): number {
  return 0.04 + 0.96 * Math.pow(clamp(sheet, 0, 1), 0.9);
}

/**
 * 风对船速的增益，angleDeg 为风来向与船首向的夹角。
 * 本作是关卡练习而非帆船模拟：顶风仍保留 80% 推进，顺风 100%，
 * 让玩家主要管理“帆位（速度）+ 航向 + 时间”，而不是被角度物理卡死。
 */
export function windDrive(angleDeg: number): number {
  const deviation = Math.min(180, Math.abs(angleDeg)) / 180; // 0 = 顶风, 1 = 顺风
  return 0.8 + 0.2 * deviation;
}

/** 两罗盘方向间的最小夹角，度。 */
export function angleBetween(a: number, b: number): number {
  return Math.abs((wrapPi(degToRad(normalizeBearing(a) - normalizeBearing(b))) * 180) / Math.PI);
}

/**
 * 单步推进；纯函数。
 * 相同 (boat, intent, wind, physics, dt) 必然产生相同输出，是确定性的基础。
 */
export function stepKinematics(
  boat: BoatKinematics,
  intent: BoatIntent,
  wind: WindSample,
  physics: PhysicsParams,
  dt: number,
): BoatKinematics {
  const sheetRate = physics.sheetResponse > 0 ? 1 / physics.sheetResponse : Infinity;
  const sheet = clamp(boat.sheet + clamp(intent.sheet - boat.sheet, -sheetRate * dt, sheetRate * dt), 0, 1);

  const relative = angleBetween(intent.heading, wind.direction);
  const windRatio = clamp(wind.speed / physics.referenceWind, 0, 1.1);
  const targetSpeed = physics.hullSpeed * sheetDrive(sheet) * windRatio * windDrive(relative);

  const speedRate = physics.speedResponse > 0 ? 1 / physics.speedResponse : Infinity;
  const speed = clamp(
    boat.speed + (targetSpeed - boat.speed) * clamp(speedRate * dt, 0, 1),
    0,
    physics.hullSpeed * 1.1,
  );

  // 舵效：几乎全程有效，低速时约减半，避免静止打转的荒谬感。
  const steerage = clamp(0.5 + 0.5 * Math.min(1, boat.speed / Math.max(0.5, physics.hullSpeed * 0.35)), 0.5, 1);
  const maxTurn = degToRad(physics.maxTurnRate) * steerage * dt;
  const error = wrapPi(degToRad(normalizeBearing(intent.heading) - boat.heading));
  const heading = normalizeBearing(boat.heading + (clamp(error, -maxTurn, maxTurn) * 180) / Math.PI);

  const direction: Vec2 = bearingToVector(heading);
  const position: Vec2 = {
    x: boat.position.x + direction.x * speed * dt,
    y: boat.position.y + direction.y * speed * dt,
  };

  return { position, heading, speed, sheet };
}
