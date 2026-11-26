# music-transition-tool

游戏环境音乐**循环素材 + 转场计划**的离线预听 / 导出 / 核对工具。
只读本地 WAV 和 JSON，不依赖任何第三方 Python 包（不需要 numpy / pytest），
用系统自带 Python 3.10+ 即可运行，测试用标准库 `unittest`。

放在仓库的独立目录中，不影响已有的 `renderer/` 示例。

---

## 它解决什么

1. 每个素材可配置**可循环区间、拍点、入场点**；转场位置用**小节或拍**书写，
   清单/报告最终给出可核对到整数采样的位置。
2. 播放跨过循环末尾时，采样精确地接到循环头，剩余长度按
   “完整循环 + 零头”拼接，**不截断、不重复**；计划需要的区间没有素材时
   （例如无循环素材不够长），错误会定位到**对应的转场 id** 和缺失的源采样区间。
3. 支持**重叠交叉淡变**（equal-power / linear，三种锚点）和**无重叠切换(cut)**；
   单声道/立体声都处理，立体声的左右声道独立保留。报告给出每路信号的
   **实际进入采样 E、实际退出采样 X、两路同时有效的区间**。
4. 同一份 `plan.json` 可以：
   - 导出全程试听 WAV；
   - 只导出某一个切点的预听 WAV；
   - 输出转场清单（JSON / Markdown / CSV）。

   **单个切点 WAV 与全程 WAV 的同采样区间逐采样一致**（float 混音逐值相同，
   导出的 16-bit WAV 音频字节也相同），有专门测试锁定这一性质。
5. 内置合成器生成**不同声道特征、不同短循环长度**的 WAV 样例，
   并用匹配滤波检查经过多个转场后每个“第一拍”的**实际落点**（偏移 0 采样）。

---

## 60 秒快速开始

```sh
cd music-transition-tool

# 1) 生成合成样例到 examples/wavs（仓库里已附带生成好的，可跳过）
python3 run.py generate-samples

# 2) 校验计划与素材
python3 run.py validate --plan examples/plan.json

# 3) 看转场清单（采样位置 / 进入退出 / 预听区间）
python3 run.py list --plan examples/plan.json --format md

# 4) 导出全程试听（同时写 JSON 报告，并核对第一拍落点）
python3 run.py render --plan examples/plan.json \
    --out examples/output/full_preview.wav \
    --report examples/output/transitions.json --verify

# 5) 只预听某一个切点（区间由计划的 preview 段决定）
python3 run.py render --plan examples/plan.json --only t_garden_to_market --verify

# 6) 直接核对一个已导出的 WAV
python3 run.py verify-beats --plan examples/plan.json \
    --wav examples/output/full_preview.wav

# 7) 跑全部 46 个测试
python3 -m unittest discover -s tests -v
# 或 ./run_tests.sh
```

也可以用 `python3 -m mtp ...`（在本目录内）代替 `python3 run.py ...`。

想一次重建所有示例产物：`./demo.sh`。

故意失败的缺素材示例：

```sh
python3 run.py render --plan examples/plan_missing_material.json
# 错误: [转场 't_sting_to_market' / 条目 'cue_sting'] 素材 'sting' 是无循环素材，
# 计划需要源采样 [0, 176400)（176400 帧），但 WAV 只有 [0, 22050) ...
```

---

## 目录结构

```
music-transition-tool/
├── run.py                 # CLI 便捷入口
├── demo.sh                # 一键生成样例/清单/音频/核对/测试
├── run_tests.sh
├── mtp/
│   ├── cli.py             # 命令：generate-samples/validate/list/render/verify-beats
│   ├── config.py          # assets.json 加载、WAV/配置校验、Registry
│   ├── errors.py          # 带 transition_id 的错误类型
│   ├── timeutil.py        # 小节/拍/秒/采样/timecode 换算
│   ├── source.py           # 采样精确的循环读取（核心不变量）
│   ├── timeline.py        # 计划 -> 采样坐标上的转场与声部
│   ├── render.py          # render_interval(g0,g1) 纯区间渲染（一致性关键）
│   ├── report.py          # JSON/Markdown/CSV 转场清单
│   ├── analyze.py         # 匹配滤波：第一拍实际落点
│   ├── synth.py           # 合成样例生成器
│   └── wavio.py           # 标准库 WAV 读写（8/16/24/32-bit PCM 输入，16-bit 输出）
├── examples/
│   ├── assets.json                 # 素材配置：loop / beats / entry / verify
│   ├── plan.json                   # 主计划：3 个转场（交叉淡变 + cut）
│   ├── plan_missing_material.json  # 故意缺素材，演示错误定位
│   ├── wavs/                       # 合成 WAV（已生成）
│   └── output/                     # 全程/切点 WAV 与三种清单（已生成）
└── tests/                          # unittest 测试（46 个）
```

---

## 配置格式

### assets.json —— 每个素材的循环区间、拍点、入场点

```json
{
  "sample_rate": 44100,
  "assets": {
    "garden": {
      "file": "wavs/garden_stereo.wav",
      "loop": [0, 176400],
      "entry_sample": 0,
      "beats": [0, 22050, 44100, 66150, 88200, 110250, 132300, 154350],
      "verify": {"template": "downbeat_marker_v1", "channel": "L"}
    }
  }
}
```

| 字段 | 含义 |
|---|---|
| `file` | 本地 WAV，相对 assets.json 所在目录 |
| `loop` | `[start, end)`，右端开区间。跨过 `end-1 → start` 就是循环回头。不填表示无循环一次性素材 |
| `entry_sample` | **入场点**：与计划转场同步点 P 对齐的源采样。有 loop 时必须落在 loop 区间内；缺省为 loop 头或 0 |
| `beats` | **拍点**采样列表，仅用于配置核对/报告（不做拉伸） |
| `verify` | 可选的落点检测模板：`downbeat_marker_v1`（合成样例内置标记）或 `source`（从 `entry_sample` 取自波形模板），`channel` 为 `L/R/C/mix/auto` |

校验会拒绝：文件不存在、采样率与计划不一致（本工具不做重采样）、
`loop`/`entry_sample`/`beats` 超出 WAV 范围、`entry_sample` 不在 loop 内等。

### plan.json —— 用小节或拍写转场位置

```json
{
  "assets": "assets.json",
  "sample_rate": 44100,
  "bpm": 120,
  "beats_per_bar": 4,
  "output": {"channels": 2, "bit_depth": 16, "gain": 0.72},
  "preview": {"pre_roll_beats": 2, "post_roll_beats": 2},
  "end": {"bar": 9, "beat": 1},
  "program": [
    {"id": "cue_garden_main", "asset": "garden", "at": {"bar": 1, "beat": 1}},
    {"id": "cue_market", "asset": "market", "at": "3.1",
     "transition": {
       "id": "t_garden_to_market",
       "mode": "crossfade",
       "duration_beats": 1,
       "anchor": "center",
       "curve": "equal_power"
     }},
    {"id": "cue_harbor", "asset": "harbor", "at": "5.1",
     "transition": {"id": "t_market_to_harbor", "mode": "cut"}}
  ]
}
```

位置 `at` / `end` 支持四种写法：

- `"3.1"`：第 3 小节第 1 拍（小节、拍均从 1 开始）；需要半拍可用 `"3.1.5"`（= 第 3 小节第 1.5 拍）或对象写法；
- `{"bar": 3, "beat": 1.5}`：第 3 小节第 1.5 拍；
- `{"beats": 8}` 或直接写数字 `8`：从 `1.1` 原点起的绝对拍偏移；
- `{"sample": 176400}`：直接给采样。

时长支持 `duration_beats` / `duration_seconds` / `duration_samples`
（交叉淡变也可用别名 `overlap_beats`）。

---

## 采样坐标模型（核对报告时读这一节）

设转场的**同步点**为 P（`sync_sample`）：入场素材的 `entry_sample` 恰好对齐到
全局采样 P，因此“第一拍”落在 P。

交叉淡变长度 D，由 `anchor` 决定重叠区间 `[E, X)`（整数采样、右端开区间）：

```
anchor="start"  : E = P,            X = P + D     P 在淡变起点
anchor="center" : E = P - floor(D/2), X = E + D    P 近似在中间
anchor="end"    : E = P - D,        X = P         P 在淡变终点
```

- **实际进入位置** = E：入场声部第一个被累加的采样（该采样包络增益为 0 或极小，
  报告另外给出增益 ≥ 0.001 的“有效进入”采样）。
- **实际退出位置** = X（开区间右端）：出声部最后一个被累加的采样是 `X-1`。
- **两路同时有效区间**：报告 `both_effective` 给出两路增益都 ≥ 0.001 的
  `[start_sample, end_sample_exclusive)` 与长度。
- `mode="cut"` 时 D=0、E=X=P：旧声部读到 P（不含 P），新声部从 P 开始，
  **重叠 0 采样**，也不做任何淡化（保证切点逐采样干净、可位精确核对）。

循环映射：全局采样 g 对应的源采样为
`entry_sample + (g - P)`；当它落在 `[loop_start, loop_end)` 之外时按模循环长度
折回循环区间（支持淡变预卷产生的负源坐标——它会取循环尾部）。
报告同时给出“源坐标”和“循环映射后实际读 WAV 的采样”。

### 单切点区间

每条转场的预听区间为

```
[ max(0, E - pre_roll_samples), min(total, X + post_roll_samples) )
```

默认前后各留 2 拍（`preview.pre_roll_beats/post_roll_beats`）。
CLI 渲染 `--only <id>` 与全程渲染调用的是同一个纯函数
`render_interval(timeline, registry, g0, g1)`，增益/源映射只依赖全局采样坐标，
所以切点区间天然等于全程的对应切片。

---

## 命令参考

| 命令 | 作用 |
|---|---|
| `generate-samples [--out DIR]` | 生成 4 个合成 WAV（三循环 + 一无循环音效） |
| `validate --plan P [--assets A]` | 解析计划、加载并校验全部素材 |
| `list --plan P --format md\|json\|csv [--out F]` | 输出转场清单 |
| `render --plan P [--only TID] [--out W] [--report J] [--verify] [--strict-verify]` | 渲染全程或单个切点 |
| `verify-beats --plan P [--wav W] [--json J]` | 匹配滤波核对第一拍实际落点；不通过退出码 3 |

素材库路径解析顺序：`--assets` → plan 里的 `"assets"`（相对 plan 目录）→
plan 同目录的 `assets.json`。

退出码：`0` 成功；`2` 计划/素材/IO 错误（stderr 带转场定位）；
`3` `--strict-verify` 或 `verify-beats` 发现落点不符。

---

## 合成样例与“第一拍落点”检查

`mtp/synth.py` 在 44.1 kHz / 120 BPM 下合成，因此
**1 拍 = 22050 采样、1 小节 = 88200 采样，都是整数**，没有换算舍入：

| 文件 | 声道 | 循环 | 声道特征 |
|---|---|---|---|
| `garden_stereo.wav` | 立体声 | 2 小节 / 176400 帧 | 下拍 PRN 标记只在**左**，琶音在右 |
| `market_stereo.wav` | 立体声 | 1 小节 / 88200 帧 | 下拍标记只在**右**，拨弦在左 |
| `harbor_mono.wav` | 单声道 | 1 小节 / 88200 帧 | 标记居中；导出时左右完全相同 |
| `sting_oneshot.wav` | 立体声 | 无循环 / 22050 帧 | 供缺素材示例使用 |

每个循环头嵌入一段公开已知的 256 采样确定性伪随机标记
（`downbeat_marker_v1`）。`mtp/analyze.py` 在配置声道上做滑窗能量归一化的
匹配滤波，在 P 附近搜索相关峰，输出：

```
[PASS] t_garden_to_market  期望 176400 实测 176400 偏移 +0 采样 corr=0.377 (次峰 0.167) ch=R
...
```

`tests/test_render.py` 除了断言三个转场（经过 4 个条目、多次循环回头）偏移全为 0，
还会**故意把 market 的 entry_sample 改错 100 采样**，验证检测器确实报出
`offset_samples == -100` 且 `passed == False`——说明这个检查不是“永远通过”的摆设。

---

## 测试覆盖了哪些需求

`python3 -m unittest discover -s tests`：

- `test_timeutil.py`：小节/拍/采样换算、示例速度下网格全为整数采样。
- `test_source.py`：循环尾→头的精确序列、任意请求长度不截断/不重复、
  负起点预卷、立体声、无循环缺区间时错误携带 `transition_id` 与请求/可用区间。
- `test_wavio.py`：int16 单位增益往返逐位一致、左右声道不同、削波计数与钳位。
- `test_timeline.py`：cut 零重叠、三种 anchor 的 E/X 数学、预听区间、
  cut 带时长报错、位置非递增报错、未知素材携带转场 id。
- `test_render.py`：
  - **每个切点的 float 数组与全程切片逐值相同**；
  - **每个切点导出的 WAV 音频字节等于全程 WAV 的对应字节区间**；
  - 立体声 L/R 独立保留、单声道上变换后左右相同、cut 单位区间与源 WAV 逐采样一致；
  - 多转场后第一拍落点全 0；错误入场点能被检测为 -100。
- `test_cli_report.py`：三种清单格式、报告字段、CLI 渲染/严格核对、
  缺素材计划退出码 2 且 stderr 含 `t_sting_to_market` 与缺失区间。

---

## 限制（当前版本）

- 输入 WAV 支持 PCM 8/16/24/32-bit；导出固定 16-bit PCM（计划里的
  `bit_depth` 目前仅作意图记录）。
- 不做采样率转换：素材采样率必须与计划一致（示例全部 44.1 kHz）。
- 输出声道数支持 1 或 2；>2 声道素材需先自行折叠。
- 只做增益包络淡变，不做滤波/响度归一化；提供 `output.gain` 防止削波，
  渲染统计会报告 `peak_amplitude` 与 `clipped_frames`。
