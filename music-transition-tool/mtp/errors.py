"""带转场定位信息的错误类型。

任何“计划需要的区间没有素材”类错误都尽量携带 transition_id，
CLI 与测试据此定位到具体转场，而不是只抛一个底层越界异常。
"""


class MusicToolError(Exception):
    """所有本工具错误的基类。"""


class PlanError(MusicToolError):
    """计划文件本身或计划与素材冲突。

    transition_id 尽可能指向引发问题的那条转场；
    cue_id 指向相关节目条目。
    """

    def __init__(self, message, transition_id=None, cue_id=None, **details):
        super().__init__(message)
        self.transition_id = transition_id
        self.cue_id = cue_id
        self.details = details

    def location_prefix(self):
        parts = []
        if self.transition_id is not None:
            parts.append("转场 %r" % self.transition_id)
        if self.cue_id is not None:
            parts.append("条目 %r" % self.cue_id)
        return "[" + " / ".join(parts) + "] " if parts else ""


class AssetError(MusicToolError):
    """素材文件或素材配置错误。"""

    def __init__(self, message, asset_id=None, path=None, **details):
        super().__init__(message)
        self.asset_id = asset_id
        self.path = path
        self.details = details


class MaterialMissingError(PlanError):
    """计划需要读取一段 WAV 中不存在、且循环区间无法覆盖的采样。

    requested_source_range / available_range 均为 WAV 源采样坐标，
    右端为开区间，便于和报告里的 sample 位置核对。
    """

    def __init__(
        self,
        message,
        transition_id=None,
        cue_id=None,
        asset_id=None,
        requested_source_range=None,
        available_range=None,
        global_range=None,
    ):
        super().__init__(
            message,
            transition_id=transition_id,
            cue_id=cue_id,
            asset_id=asset_id,
            requested_source_range=requested_source_range,
            available_range=available_range,
            global_range=global_range,
        )
        self.asset_id = asset_id
        self.requested_source_range = requested_source_range
        self.available_range = available_range
        self.global_range = global_range
