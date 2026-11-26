"""离线游戏音乐转场预听 / 导出工具（仅依赖 Python 标准库）。

模块划分：
- wavio:      WAV 读写（8/16/24/32-bit PCM 输入，16-bit PCM 输出）
- timeutil:   小节/拍/秒/采样位置互转
- config:     素材库与转场计划的加载、校验
- source:     采样精确的循环读取（跨循环尾无缝回头，不截断/不重复）
- timeline:   把计划解析成采样坐标上的声部(voice)与转场
- render:     纯函数区间渲染（全程与单切点走同一条渲染路径）
- report:     转场清单（JSON / Markdown / CSV）
- analyze:    第一拍实际落点的匹配滤波检测
- synth:      生成带声像特征与短循环的合成样例
- cli:        命令行入口
"""

__version__ = "1.0.0"
