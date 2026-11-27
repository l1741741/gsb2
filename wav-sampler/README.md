# WAV Sampler

离线 PCM WAV 取样工具。设备开着录了一整天、交付只要其中几段时, 用一张段落清单
声明每个 WAV 在项目时间轴上的位置, 再按一个或多个时间范围取样导出, 并产出可追溯
到源文件与源样本的交付清单与报告。

- 纯 Python 标准库, 无第三方依赖 (Python 3.13 起 `audioop` 已移除, PCM 编解码自行实现)
- 流式分块处理, 不把整天的录音读进内存
- 时间轴内部一律用整数帧, 半开区间 `[start, end)`, 相邻输出拼接不丢帧、不重帧
- 只支持未压缩 PCM (格式码 1), 位深 8/16/24/32 bit, 全部输入采样率必须相同

## 目录

```
wav_sampler/   包: 清单解析、时间轴扫线、声道映射、流式导出、报告
tools/         make_fixtures.py 合成三路录音与清单
tests/         unittest 单元测试与端到端测试
examples/      清单示例
```

## 快速开始

```sh
# 1. 生成三路互相搭接、中间留空洞的合成录音
python3 tools/make_fixtures.py /tmp/wav-demo

# 2. 按清单取样 (在本目录下运行, 使 wav_sampler 包可被导入)
python3 -m wav_sampler -m /tmp/wav-demo/manifest.json -o /tmp/wav-demo/out
```

输出目录包含:

| 文件 | 内容 |
|---|---|
| `r1.wav r2.wav r3.wav` | 各取样范围的导出 WAV |
| `segments.csv` | 每段文件在项目时间轴上的开始时间与有效区间 |
| `delivery-manifest.json` | 交付清单: 只有合法输出列入, 含逐段 provenance |
| `report.md` | 人读报告: 段落表、来源/重叠/静音分段、诊断 |

## 清单格式

时间值可写秒 (`0.75`)、帧对象 (`{"frames": 6000}`) 或秒对象 (`{"seconds": 0.75}`)。
裸整数按秒处理; 帧坐标无歧义, 关键边界建议用 `{"frames": n}`。

```json
{
  "sample_rate": 8000,
  "output_channels": 2,
  "output_sample_width": 3,
  "segments": [
    {
      "id": "segA",
      "path": "wav/segA.wav",
      "start": {"frames": 0},
      "duration": {"frames": 8000},
      "priority": 1,
      "channel_map": [0, 1]
    }
  ],
  "ranges": [
    {"id": "r1", "start": {"frames": 2000}, "end": {"frames": 12000}, "output": "r1.wav"}
  ]
}
```

- `path` 相对于清单文件所在目录; `output` 只能是文件名, 不能含路径分隔符。
- `duration` 可省略, 此时以 WAV 实际帧数为准。
- `priority` 越大越优先; 同优先级按段落 id 字典序, 保证结果确定。
- `channel_map` 可省略, 用默认映射 (见下)。
- `output_sample_width` 可省略, 默认取所有源文件的最大位深。

## 时间轴与取样语义

- 所有段与范围都落在同一条项目时间轴上, 坐标是绝对帧 (帧号 = 秒 × 采样率, 四舍五入)。
- 区间一律半开 `[start, end)`。扫线算法只在范围端点与段落有效区间端点处切分,
  每个输出分段 (Run) 内部来源关系恒定, 相邻同来源分段自动合并。
- **重叠**: 多段覆盖同一帧时按 `priority` 选一段, 该 Run 标记为 `overlap`,
  并在 provenance 里记录全部竞争段 (`contenders`)。
- **空洞**: 没有任何段覆盖的帧补静音, Run 标记为 `silence`, 与 `overlap` 明确区分。
- **边界精确**: 搭接点两侧各归各段, 共同边界帧不重不丢。两个相邻/重叠范围的输出
  重新接起来时, 帧数与全量导出逐帧一致 (测试 `test_adjacent_outputs_*` 字节级校验)。

## 声道映射 (公开规则)

各输入文件声道数可以不同, 但一次导出的输出声道数固定。映射逐文件生效,
含义是「输出声道 k 取自该文件的哪个源声道」。默认映射 (源声道数 S → 输出声道数 C):

1. `S == C`: 直通, 输出 k = 源 k。
2. `S == 1` (单声道文件): 上混, 每个输出声道都取源声道 0。
3. `C == 1` (单声道输出): 下混, 输出声道 0 取源声道 0, 其余源声道丢弃。
4. 其他 (`S>1, C>1, S!=C`): 按索引一一对应; 源不足的输出声道补静音 (`-1`),
   多出的源声道丢弃。例: `2→4` 得 `[0,1,-1,-1]`; `4→2` 得 `[0,1]`。

清单可在单段上用 `channel_map` 覆盖: 长度必须等于输出声道数, 元素为源声道索引
或 `-1` (该输出声道在此段内恒静音)。映射结果同时写入 `segments.csv` 与报告。

## 诊断与交付保障

文件与清单冲突时产生**定位到源段和项目帧**的诊断, 每条带受影响的项目时间区间:

| code | 级别 | 含义 |
|---|---|---|
| `segment_ended_early` | error | 声明时长超过实际文件, 给出实际结束帧与无数据区间 |
| `segment_longer_than_declared` | warning | 文件比声明长, 声明区间外素材不参与取样 |
| `sample_rate_mismatch` / `empty_wav` / `wav_unreadable` | error | 文件不可用 |
| `bad_channel_map` | error | 显式声道映射越界或长度不符 |
| `output_exists` | warning | 输出文件已存在, 跳过以保护已有交付 |

- 一个范围只有在与任何 error 的受影响区间都不相交时才导出; 不合法范围标记
  `rejected`, 不写 WAV, 也不进交付清单的 `delivered` 列表。
- 导出先写 `*.part` 再 `os.replace` 原子落盘; 中途失败只删 `.part`, 正式文件不受影响。
- 默认不覆盖已存在的输出 (`--overwrite` 显式开启); 跳过记 `skipped_exists`, 属保护性
  warning, 不影响同次其他范围, CLI 退出码仍为 0。存在 `rejected` 或 error 时退出码为 1。

## 验证

```sh
python3 -m unittest discover -s tests -v
```

34 个测试覆盖: PCM 四种位深编解码、四类声道映射、扫线优先级与平局、帧数账平、
搭接边界逐帧取值、空洞静音长度与分类、单/多声道对应、相邻输出字节级拼接、
3600s 整点前后取样、提前结束部分拒绝、已有文件保护、不可读文件的影响面隔离等。

## 范围与限制

- 不做重采样: 输入采样率必须与清单一致, 否则该段报错。
- 不做混音/淡变: 重叠区只取优先级获胜段, 不交叉淡化。
- 仅处理 PCM; 浮点 WAV、压缩格式、广播 WAV (bext) 元数据不在范围内。
