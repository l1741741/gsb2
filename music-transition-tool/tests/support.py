"""测试公共辅助：在临时目录生成合成样例 + 可运行的示例计划副本。"""

import json
import sys
import tempfile
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = TOOL_ROOT.parent
EXAMPLES = TOOL_ROOT / "examples"

# 让 `python3 tests/test_xxx.py` 也能直接 import mtp
if str(TOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOL_ROOT))

from mtp.synth import generate_all  # noqa: E402
from mtp.config import Registry, load_asset_configs  # noqa: E402
from mtp.timeline import build_timeline  # noqa: E402


def make_demo_project(base: Path):
    """生成 wavs 到 base/wavs，拷贝示例 assets/plan，返回 (plan, assets)。"""
    generate_all(base / "wavs")
    assets_doc = json.loads((EXAMPLES / "assets.json").read_text(encoding="utf-8"))
    (base / "assets.json").write_text(
        json.dumps(assets_doc, ensure_ascii=False), encoding="utf-8"
    )
    plan_doc = json.loads((EXAMPLES / "plan.json").read_text(encoding="utf-8"))
    plan_doc["assets"] = "assets.json"
    plan_path = base / "plan.json"
    plan_path.write_text(json.dumps(plan_doc, ensure_ascii=False), encoding="utf-8")
    return plan_path, base / "assets.json"


def load_project(plan_path: Path, assets_path: Path = None):
    plan_doc = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    assets_path = assets_path or (Path(plan_path).parent / "assets.json")
    configs, _, assets_doc = load_asset_configs(assets_path)
    registry = Registry(
        configs,
        expected_sample_rate=plan_doc.get("sample_rate"),
        sample_rate_from_doc=assets_doc.get("sample_rate"),
    )
    tl = build_timeline(plan_doc, registry)
    return tl, registry, plan_doc


class DemoProjectMixin:
    """setUpClass 里建一次临时工程；各测试类按需调用 setup_demo()。"""

    @classmethod
    def setup_demo(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.plan_path, cls.assets_path = make_demo_project(cls.tmp)
        cls.tl, cls.registry, cls.plan_doc = load_project(
            cls.plan_path, cls.assets_path
        )

    @classmethod
    def teardown_demo(cls):
        cls._tmp.cleanup()
