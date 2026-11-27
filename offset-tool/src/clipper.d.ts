/**
 * clipper-lib 6.4.2（Angus Johnson Clipper1 的 JS 移植）的最小类型声明。
 * 运行时由 npm 包 clipper-lib 提供（vendor/clipper-6.4.2.js 为离线备份），
 * 这里仅声明本项目实际使用的 API。
 */
declare module 'clipper-lib' {
  export interface IntPoint {
    X: number;
    Y: number;
  }

  export type IntPath = IntPoint[];
  export type IntPaths = IntPath[];

  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPath(path: IntPath, joinType: number, endType: number): void;
    AddPaths(paths: IntPaths, joinType: number, endType: number): void;
    Execute(solution: PolyTree | IntPaths, delta: number): number | undefined;
    Clear(): void;
    ArcTolerance: number;
    MiterLimit: number;
  }

  export class PolyNode {
    Contour(): IntPath;
    IsHole(): boolean;
    IsOpen(): boolean;
    ChildCount(): number;
    Childs(): PolyNode[];
    Parent(): PolyNode | null;
  }

  export class PolyTree extends PolyNode {
    Total(): number;
    GetFirst(): PolyNode | null;
  }

  export class Clipper {
    AddPath(path: IntPath, polyType: number, closed?: boolean): boolean;
    AddPaths(paths: IntPaths, polyType: number, closed?: boolean): boolean;
    Execute(
      clipType: number,
      solution: PolyTree | IntPaths,
      subjFillType?: number,
      clipFillType?: number,
    ): boolean;
    Clear(): void;
    static Area(path: IntPath): number;
    static CleanPolygon(path: IntPath, distance?: number): IntPath;
    static CleanPolygons(paths: IntPaths, distance?: number): IntPaths;
    static PolyTreeToPaths(tree: PolyTree): IntPaths;
    static ReversePath(path: IntPath): void;
    static ReversePaths(paths: IntPaths): void;
    static PointInPolygon(pt: IntPoint, path: IntPath): number;
    static SimplifyPolygon(path: IntPath, fillType?: number): IntPaths;
    static SimplifyPolygons(paths: IntPaths, fillType?: number): IntPaths;
  }

  export interface ClipperLibStatic {
    version: string;
    JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
    EndType: {
      etClosedPolygon: number;
      etClosedLine: number;
      etOpenButt: number;
      etOpenSquare: number;
      etOpenRound: number;
    };
    PolyType: { ptSubject: number; ptClip: number };
    ClipType: {
      ctIntersection: number;
      ctUnion: number;
      ctDifference: number;
      ctXor: number;
    };
    PolyFillType: {
      pftEvenOdd: number;
      pftNonZero: number;
      pftPositive: number;
      pftNegative: number;
    };
    Path: new () => IntPath;
    Paths: new () => IntPaths;
    ClipperOffset: typeof ClipperOffset;
    PolyTree: typeof PolyTree;
    PolyNode: typeof PolyNode;
    Clipper: typeof Clipper;
  }

  const ClipperLib: ClipperLibStatic;
  export default ClipperLib;
}
