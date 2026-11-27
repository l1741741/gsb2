# srt-remap

本地字幕重映射工具：剪辑助理拿到的 SRT 是按**素材原始时间**写的，粗剪里同一段
素材会被切开、变速或重复使用。本工具按剪辑清单（EDL）把每段素材的 SRT 重新
映射到**成片时间线**，输出成片 SRT 和一份带来源区间的对照清单。

- 纯 Python 标准库实现，无第三方依赖，Python 3.10+ 即可（开发环境 3.14）。
- 与仓库里的 `renderer/` 示例相互独立，互不影响。

## 目录结构

```
srt-remap/
├── srt_remap/            # 工具包
│   ├── timecode.py       # 时间解析与统一舍入（唯一舍入点）
│   ├── srt_io.py         # SRT 读取/写入
│   ├── edl.py            # 剪辑清单加载与逐行校验（错误聚合）
│   ├── remap.py          # 相交裁剪、变速映射、轨道冲突处理
│   ├── report.py         # SRT / CSV 对照清单 / JSON 报告输出
│   ├── cli.py            # 命令行入口
│   └── __main__.py
├── samples/
│   ├── edit_list.json    # 正常样例清单（变速/复用/边界碰齐/轨道重叠）
│   ├── bad_edit_list.json# 故意写坏的清单（演示错误定位）
│   ├── subs/             # 两个素材的源 SRT
│   └── output/           # 样例运行产物（已随仓库提供一份）
├── tests/                # unittest 测试（32 个，零依赖）
└── run_samples.sh        # 一键跑样例
```

## 快速开始

```sh
cd srt-remap
bash run_samples.sh
# 或直接调用
python3 -m srt_remap --edl samples/edit_list.json -o samples/output --stem timeline
python3 -m unittest discover -s tests -v
```

## 剪辑清单格式

JSON 文件，顶层 `clips` 为片段数组，每行一个片段；时间单位为秒，从 0 开始，
数字或字符串均可（内部统一按 Decimal 精确处理）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `material` | 是 | 素材标识，错误信息据此定位 |
| `srt` | 是 | 该素材的 SRT 路径，相对清单文件所在目录解析；多片段可引用同一文件 |
| `src_in` / `src_out` | 是 | 源入点/源出点（秒），`src_out` 必须晚于 `src_in` |
| `dst_start` | 是 | 成片起点（秒） |
| `speed` | 是 | 播放速度，必须为正的有限数；`2.0` = 两倍速（时长减半），`0.5` = 慢放 |
| `track` | 否 | 轨道顺序，整数，缺省 `0`；**数字越小优先级越高** |
| 下划线开头字段（如 `_comment`） | 否 | 注释，加载时忽略 |

```json
{
  "clips": [
    {"material": "interview_a", "srt": "subs/interview_a.srt",
     "src_in": 0, "src_out": 5, "dst_start": 0, "speed": 1.0, "track": 0}
  ]
}
```

## 映射规则

1. **只保留相交区间**：每条源字幕与每个片段在源时间轴上按半开区间
   `[start, end)` 求交；片段只覆盖字幕一部分时，只保留相交部分。
2. **跨片段切分并保留来源**：同一条源字幕被多个片段引用时，每个片段各自
   产出成片字幕，对照清单里分别标注素材、剪辑行、源条目号与源区间。
3. **变速映射**：`成片时间 = dst_start + (源时间 − src_in) / speed`。
4. **统一舍入**：求交与映射全程用 `Decimal` 精确计算，毫秒舍入只在最终输出
   发生一次，规则为 `ROUND_HALF_UP`（四舍五入）。因此两个紧挨片段共享的切点
   映射后严格相等，不会凭空产生 1ms 重叠或缝隙；舍入后起止相同的零时长字幕
   不输出，记入报告的 `dropped`。
5. **空白区间无字幕**：没有任何片段/字幕覆盖的成片区间保持空白。
6. **未被引用的源字幕不出现**在成片里。

## 重叠处理

- `--mode trim`（默认）：轨道号小的片段优先占位，高轨字幕被遮挡的区间裁掉
  （可能被切成多段，整条被遮则丢弃并记入 `dropped`）。**同轨重叠无法判定
  优先级**，两条都保留并写入冲突报告。
- `--mode keep`：全部保留，所有成片时间轴重叠都写入报告。此时若存在冲突，
  命令以退出码 `1` 结束（文件仍正常写出），便于流水线感知。

端点相碰（前一条 `end` == 后一条 `start`）按半开区间处理，**不算冲突**。

## 输出文件

给定 `--stem timeline` 时在输出目录生成：

- `timeline.srt`：成片字幕，序号从 1 连续重排。
- `timeline.manifest.csv`：逐条对照清单，含成片毫秒/时间码、素材、剪辑行、
  轨道、速度、源条目号、源区间毫秒/时间码、来源串 `provenance` 与文本。
  UTF-8 带 BOM，可直接用表格软件打开。
- `timeline.report.json`：机读报告，含冲突明细（双方来源、重叠区间、原因）、
  丢弃明细、警告与全部成片条目。

## 错误处理

坏时间、缺文件、非法速度、时间倒挂、SRT 时间戳错误等都会被拦截，错误信息
带**剪辑行号与素材标识**；清单内多行有问题时一次性聚合报告，例如：

```
错误：剪辑清单校验失败：
  - （剪辑清单第 1 行，素材 'interview_a'）源出点必须晚于源入点（src_in=5s, src_out=5s）
  - （剪辑清单第 2 行，素材 'ghost'）播放速度必须为正的有限数，实际为 Decimal('0')
  - （剪辑清单第 3 行，素材 'broll_b'）源入点 src_in 不是合法时间（秒）: 'not-a-time'
```

参数级错误退出码为 `2`。

## 自带样例覆盖的场景

`samples/edit_list.json` 四个片段依次演示：

1. 正常速度，源字幕 `#2` 在源 5s 切点处被切成两条成片字幕，切点严格相接；
2. 同一 SRT 被再次引用（复用）且 2 倍速，成片时长减半，与下一片段边界碰齐；
3. 半速慢放（0.5x），成片时长翻倍，片段前后保留无字幕空白；
4. 高轨（`track=1`）叠加：trim 模式裁掉被低轨遮挡的区间，keep 模式整条保留
   并在报告中标冲突。

## 作为库调用

```python
from srt_remap import load_project, remap
from srt_remap.report import write_all

project = load_project("edit_list.json")
result = remap(project, mode="trim")
write_all("output", "timeline", result, edl_path="edit_list.json", mode="trim")
```
