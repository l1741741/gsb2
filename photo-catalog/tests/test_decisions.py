"""Tests for requirement 3: decisions survive rescans and content changes.

The behaviours:

* a recorded decision is applied on rescan,
* a decision keyed by content follows a file when it is renamed,
* a file whose content changed at a known path is flagged for re-review and the
  old decision is not silently applied.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402

from photocatalog.pipeline import (  # noqa: E402
    DecisionStore, Photo, _hash_file, apply_decisions, candidate_pairs,
    scan_folder,
)


def _scan(paths, tmp, root_name="root"):
    root = os.path.join(tmp, root_name)
    os.makedirs(root, exist_ok=True)
    for rel, img in paths.items():
        dest = os.path.join(root, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        helpers.write_png(img, dest)
    return root, scan_folder(root, external_tools=False)


def _photo(path: str, rel: str) -> Photo:
    p = Photo(path, rel)
    p.abspath = os.path.abspath(path)
    p.sha256 = _hash_file(path)
    return p


class DecisionTests(unittest.TestCase):
    def _pair_state(self, store_path: str, root: str):
        photos = scan_folder(root, external_tools=False)
        pairs = candidate_pairs(photos)
        store = DecisionStore(store_path)
        notices = apply_decisions(photos, pairs, store)
        return photos, pairs, notices

    def test_decision_persists_and_is_applied(self) -> None:
        a = helpers.gradient(40, 30, box=(8, 6, 26, 22))
        b = helpers.tint(a, 10, 0, 0)
        with tempfile.TemporaryDirectory() as tmp:
            root, photos = _scan({"a.png": a, "b.png": b}, tmp)
            state = os.path.join(tmp, "decisions.json")
            store = DecisionStore(state)
            pa = next(p for p in photos if p.relpath == "a.png")
            pb = next(p for p in photos if p.relpath == "b.png")
            store.record("merge", pa, pb, note="looks the same")
            store.save()

            store2 = DecisionStore(state)
            self.assertEqual(len(store2.records), 1)
            photos2, pairs2, notices = self._pair_state(state, root)
            applied = [p for p in pairs2 if any("human decision" in r for r in p.reasons)]
            self.assertTrue(applied, "stored decision was not applied on rescan")
            self.assertEqual(notices, [])

    def test_decision_follows_rename(self) -> None:
        a = helpers.gradient(40, 30, box=(8, 6, 26, 22))
        b = helpers.tint(a, 10, 0, 0)
        with tempfile.TemporaryDirectory() as tmp:
            root, photos = _scan({"a.png": a, "b.png": b}, tmp)
            state = os.path.join(tmp, "decisions.json")
            store = DecisionStore(state)
            pa = next(p for p in photos if p.relpath == "a.png")
            pb = next(p for p in photos if p.relpath == "b.png")
            store.record("merge", pa, pb)
            store.save()

            # Rename a.png -> renamed.png (same content).
            os.rename(os.path.join(root, "a.png"), os.path.join(root, "renamed.png"))
            _, pairs2, notices = self._pair_state(state, root)
            applied = [p for p in pairs2
                       if any("human decision" in r for r in p.reasons)
                       and "renamed.png" in (p.a, p.b)]
            self.assertTrue(applied, "decision did not follow the renamed file")

    def test_content_change_triggers_review(self) -> None:
        a = helpers.gradient(40, 30, box=(8, 6, 26, 22))
        b = helpers.tint(a, 10, 0, 0)
        other = helpers.gradient(40, 30, box=(20, 14, 34, 26))
        with tempfile.TemporaryDirectory() as tmp:
            root, photos = _scan({"a.png": a, "b.png": b}, tmp)
            state = os.path.join(tmp, "decisions.json")
            store = DecisionStore(state)
            pa = next(p for p in photos if p.relpath == "a.png")
            pb = next(p for p in photos if p.relpath == "b.png")
            store.record("merge", pa, pb)
            store.save()

            # Overwrite a.png with different content.
            helpers.write_png(other, os.path.join(root, "a.png"))
            _, _, notices = self._pair_state(state, root)
            changed = [n for n in notices if n["kind"] == "content-changed"]
            self.assertTrue(changed, "content change at a known path was not flagged")
            self.assertIn("a.png", changed[0]["path"])

    def test_corrupt_decision_file_does_not_crash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "decisions.json")
            with open(state, "w", encoding="utf-8") as fh:
                fh.write("{not valid json")
            store = DecisionStore(state)
            self.assertEqual(store.records, [])
            self.assertTrue(store.review_flags, "corrupt file should be reported")


if __name__ == "__main__":
    unittest.main()
