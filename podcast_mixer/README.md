# podcast_mixer — 两路播客本地混音工具

把两路"各录各"的同步 WAV 按说话标记做电平匹配，混成一条可回听的节目版。
纯 Python 标准库实现（3.9+），无需安装任何依赖。

## 快速上手

```bash
cd podcast_mixer   # 本目录（包含 podcast_mixer 包的那层）

# 1. 生成两人样例（正弦拟声 + 底噪）并自动核对独讲 / 重叠 / 长静音
python3 -m podcast_mixer.make_sample --outdir sample/
python3 -m podcast_mixer.verify_sample

# 2. 混自己的节目
python3 -m podcast_mixer \
    --a host.wav  --marks-a host.marks.json \
    --b guest.wav --marks-b guest.marks.json \
    --target-a-db -20 --target-b-db -20 \
    --max-boost-a-db 12 --max-boost-b-db 20 \
    --out program.wav --report report.json
```

## 说话标记格式

每路一个 JSON，单位为秒，只标有效说话片段；**空白不要标**——
空白区间不参与电平估计，也不会被提升（底噪不会跟着抬起来）：

```json
{"segments": [[0.5, 12.3], [15.0, 41.2]]}
```

也接受裸数组 `[[0.5, 12.3], ...]`。间距小于 `--min-gap-ms`（默认 250ms）
的短断点会被并成一个区间，区间互相重叠也没问题。

## 工作原理

1. **电平估计**：只在标记的说话区间内测 RMS，按 `目标电平 - 实测电平`
   得出增益，提升量被 `--max-boost-*-db` 截住（防止把很小的声音连同底噪
   一起推得过高），衰减量被 `--max-cut-db` 截住。
2. **平滑增益包络**：增益只在说话区间内生效，区间起点前 / 终点后各用
   `--ramp-ms`（默认 50ms）的升余弦过渡，边缘不会跳变出爆音。
   报告里的 `envelope_min_db / envelope_max_db` 是实际调节范围。
3. **混音与补齐**：输出时长取较长一路（或用 `--duration` 指定），
   较短音轨末尾自动补零，报告里能看到 `padding_added_s`。
4. **峰值保护**：两路叠加后若峰值超过 `--ceiling-db`（默认 -1 dBFS），
   对整条节目施加一个固定的整体下压（可解释：全片统一一个增益值，
   无动态压缩的抽吸感），并在报告 `exceed_regions_s` 中列出受影响位置。

## 逐路监听与区间输出

```bash
# 只听处理后的 A 路
python3 -m podcast_mixer --a host.wav --marks-a host.marks.json --solo a --out solo_a.wav

# 只输出 60~90 秒（与全片渲染在相同样本位置逐位一致——先整片处理再切片）
python3 -m podcast_mixer ... --range 60 90 --out excerpt.wav
```

## 报告字段

`--report report.json`（缺省同时打印到 stdout）：

| 字段 | 含义 |
|---|---|
| `tracks.*.speech_rms_db` | 标记区间内实测电平 |
| `tracks.*.requested_gain_db` / `applied_gain_db` | 需要的增益 / 截限后实际增益 |
| `tracks.*.clamped` | 是否被最大提升/衰减量截住 |
| `tracks.*.envelope_min_db` / `envelope_max_db` | 实际调节范围 |
| `mix.peak_before_db` / `trim_applied_db` / `peak_after_db` | 峰值处理 |
| `mix.exceed_regions_s` | 下压前越限的时间范围 |

## 输入输出说明

- 输入：8/16/24/32-bit PCM WAV，多声道自动混成单声道；两路采样率必须一致。
- 输出：16-bit PCM 单声道 WAV。
- 处理在浮点域逐样本进行，一小时以内的节目内存占用约每路每分钟 10 MB。
