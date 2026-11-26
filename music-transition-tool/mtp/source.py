"""采样精确的素材源读取。

核心不变量：
    read(start, n) 一定返回长度恰为 n 的各声道数据；
    当读取跨过 loop_end 时，下一个采样恰为 loop_start，
    余下长度按完整循环 + 零头拼接，不截断、不重复任何采样。

start 是相对 WAV 原点的源采样坐标，可以为负数（居中/前置淡变时，
入场点之前的预卷会向循环尾部取素材）。
"""

from __future__ import annotations

from array import array

from .errors import MaterialMissingError


class LoopSource:
    def __init__(self, asset_cfg, wav):
        self.cfg = asset_cfg
        self.wav = wav

    def read(self, start_frame: int, n_frames: int,
             transition_id: str | None = None,
             cue_id: str | None = None,
             global_range: tuple | None = None) -> list:
        if n_frames < 0:
            raise ValueError("n_frames 不能为负: %d" % n_frames)
        if n_frames == 0:
            return [array("d") for _ in range(self.wav.n_channels)]

        if self.cfg.has_loop:
            return self._read_looped(start_frame, n_frames, transition_id, cue_id)
        return self._read_oneshot(
            start_frame, n_frames, transition_id, cue_id, global_range
        )

    def _read_looped(self, start, n, transition_id, cue_id):
        l0 = self.cfg.loop_start
        l1 = self.cfg.loop_end
        length = l1 - l0
        # Python 的 % 对负数也返回 [0, length) 内的余数，
        # 所以 start < entry（淡变预卷）时会正确落到循环尾部。
        offset = (start - l0) % length
        pos = l0 + offset

        out_channels = []
        for src_ch in self.wav.channels:
            pieces = []
            remaining = n
            cur = pos
            # 第一段：从 pos 到循环尾（或取满 n）
            first = min(remaining, l1 - cur)
            pieces.append(src_ch[cur:cur + first])
            remaining -= first
            if remaining:
                full, tail = divmod(remaining, length)
                loop_seg = src_ch[l0:l1]
                if full:
                    pieces.append(loop_seg * full)
                if tail:
                    pieces.append(loop_seg[0:tail])
            out = array("d")
            for piece in pieces:
                out.extend(piece)
            # 不变量自检（开发期也能立刻抓到拼接错误）
            assert len(out) == n, "循环读取长度 %d != 请求 %d" % (len(out), n)
            out_channels.append(out)
        return out_channels

    def _read_oneshot(self, start, n, transition_id, cue_id, global_range):
        total = self.wav.n_frames
        end = start + n
        if start < 0 or end > total:
            missing_lo = max(start, 0)
            missing_hi = min(end, total) if end > total else end
            # 真正缺失的区间可能有两端；报告整个被请求区间和 WAV 可用区间
            raise MaterialMissingError(
                "素材 %r 是无循环素材，计划需要源采样 [%d, %d)（%d 帧），"
                "但 WAV 只有 [0, %d)；缺少的部分位于请求区间越界处。"
                "请补长素材、配置 loop，或调整转场/计划结束位置。"
                % (self.cfg.id, start, end, n, total),
                transition_id=transition_id,
                cue_id=cue_id,
                asset_id=self.cfg.id,
                requested_source_range=(start, end),
                available_range=(0, total),
                global_range=global_range,
            )
        return [array("d", ch[start:end]) for ch in self.wav.channels]
