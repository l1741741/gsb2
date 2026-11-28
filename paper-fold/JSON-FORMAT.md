# JSON 模型格式

## 顶层结构

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 模型名称，仅用于显示 |
| `rootFace` | string | 否 | 固定不动的根面 id；缺省取 `faces` 第一项 |
| `faces` | array | 是 | 面列表，至少 1 个 |
| `creases` | array | 是（单面板可空数组） | 共享折缝列表，连接图必须是树 |
| `targetSeams` | array | 否 | 需要度量合拢度的自由边对 |

## face

```json
{ "id": "F0", "vertices": [[x, y, z], ...] }
```

- `id`：非空字符串，全模型唯一。
- `vertices`：至少 3 个三维点，全部为有限数字；按多边形边界顺序排列。
- 单面必须平面、无重合相邻顶点；所有面在展开状态共面。
- 边索引 `[i, j]` 合法当且仅当 `j === (i+1) mod n`（含首尾相邻）。

## crease

```json
{
  "id": "C1",
  "faces": ["F0", "F1"],
  "edges": { "F0": [1, 2], "F1": [3, 0] },
  "direction": "valley",
  "endAngle": 1.5707963267948966
}
```

- `id`：非空字符串，全模型唯一（重复报 `DUPLICATE_CREASE_ID`）。
- `faces`：恰好两个**不同**的、已存在的面 id；同一对面之间只能有一条折缝。
- `edges`：以面 id 为键，给出该折缝在各自面上的边界边索引。
  两条边的端点必须在展开板上重合（顺序可相反），否则报
  `CREASE_EDGE_NOT_SHARED`；索引不是边界边报 `CREASE_EDGE_NOT_BOUNDARY`，
  越界报 `CREASE_EDGE_OUT_OF_RANGE`。
- `direction`：`valley`（谷折，抬向板面 +z）或 `mountain`（山折，压向 -z）。
- `endAngle`：有限数字，弧度，建议 0 到 2π。进度 t 时转角为 `direction * endAngle * t`。
- 形成闭合环时报 `CREASE_RING`，消息中指出是哪条折缝、连接哪两个面。

## targetSeam

```json
{
  "id": "管口",
  "edges": [
    { "face": "F0", "edge": [0, 3] },
    { "face": "F3", "edge": [1, 2] }
  ]
}
```

- 恰好两条边，分别属于两个**不同**的面；边必须是该面的合法边界边。
- 每帧输出：`gap`（两种端点配对中较小的最大端点偏差）、`midpointGap`（中点间距）、
  `lengthMismatch`（两边长度差）、`reversed`（是否反向配对）、`closed`（是否进入容差）。

## 校验错误码速查

| code | 触发条件 |
| --- | --- |
| `MODEL_INVALID` / `FACES_MISSING` | 根节点不是对象、faces 缺失或为空 |
| `FACE_ID_INVALID` / `DUPLICATE_FACE_ID` | 面 id 缺失或重复 |
| `FACE_VERTICES_INVALID` / `FACE_DEGENERATE` / `FACE_NOT_PLANAR` | 顶点不足、非有限数、共线、单面不共面 |
| `FACE_POLYGON_INVALID` | 耳切三角化失败（自交等） |
| `MODEL_NOT_FLAT` | 展开状态各面不共面 |
| `CREASE_ID_INVALID` / `DUPLICATE_CREASE_ID` | 折缝 id 缺失或重复 |
| `CREASE_FACES_INVALID` / `CREASE_FACE_UNKNOWN` / `CREASE_SELF_FACE` | 面引用问题 |
| `CREASE_DIRECTION_INVALID` / `CREASE_ANGLE_INVALID` | 方向或结束角非法 |
| `CREASE_EDGE_INVALID` / `CREASE_EDGE_OUT_OF_RANGE` / `CREASE_EDGE_NOT_BOUNDARY` | 边索引问题 |
| `CREASE_EDGE_NOT_SHARED` | 两面的边在展开板上不重合 |
| `CREASE_DUPLICATE_PAIR` / `CREASE_RING` | 同一对面两条折缝 / 连接图成环 |
| `FACE_DISCONNECTED` / `ROOT_FACE_UNKNOWN` | 面未挂到折叠树 / 根面不存在 |
| `TARGET_*` | 目标接缝的结构、面引用或边索引问题 |

所有错误对象形如 `{ code, path, message, ... }`，`path` 指向 JSON 中的位置，
`message` 为中文具体原因；一次加载返回**全部**错误而非第一个。
