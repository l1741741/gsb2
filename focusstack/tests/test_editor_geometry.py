"""Headless tests for the editor's coordinate and shape-commit logic.

The tkinter window itself cannot be exercised here (no display), but the
logic that turns canvas-space drawing into stored shapes is pure Python.
These tests instantiate `_Editor` without building the UI, so a broken
conversion or a typo in the shape commit path is caught without a display.
"""

import unittest
from pathlib import Path

from focusstack.editor.app import _Editor
from focusstack.edits import validate_document, empty_document


class _FakeStatus:
    def __init__(self):
        self.text = ""

    def configure(self, **kwargs):
        self.text = kwargs.get("text", self.text)


class _FakeListbox:
    def __init__(self):
        self.rows = []

    def delete(self, *args):
        self.rows.clear()

    def insert(self, index, value):
        self.rows.append(value)

    def selection_set(self, index):
        pass

    def curselection(self):
        return ()


class _FakeVar:
    def __init__(self, value):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class EditorGeometryTests(unittest.TestCase):
    def _editor(self, width=200, height=100, scale=0.5):
        editor = object.__new__(_Editor)
        editor.width = width
        editor.height = height
        editor.view_scale = scale
        editor.document = empty_document()
        editor.selected = None
        editor.photo_index = 0
        editor.brush_var = _FakeVar(3)
        editor.listbox = _FakeListbox()
        editor.status = _FakeStatus()
        editor.tool = "rect"
        editor.points = []
        editor.drag_start = None
        editor.drag_current = None
        editor._render = lambda: None   # the window is covered separately
        return editor

    def test_to_image_clamps_to_photo_bounds(self):
        editor = self._editor()
        self.assertEqual(editor._to_image(20, 10), (40, 20))
        self.assertEqual(editor._to_image(-50, -50), (0, 0))
        self.assertEqual(editor._to_image(500, 500), (199, 99))

    def test_rect_commit_stores_canvas_coordinates(self):
        editor = self._editor()
        editor._commit_rect((10, 10), (40, 30))   # view space -> canvas 20,20 .. 80,60
        self.assertEqual(len(editor.document["edits"]), 1)
        shape = editor.document["edits"][0]["shapes"][0]
        self.assertEqual(shape["kind"], "rect")
        self.assertEqual((shape["x"], shape["y"]), (20, 20))
        self.assertEqual((shape["width"], shape["height"]), (60, 40))
        self.assertEqual(editor.document["edits"][0]["image"], 0)

    def test_ellipse_commit_centres_and_radii(self):
        editor = self._editor()
        editor._commit_ellipse((10, 10), (50, 30))
        shape = editor.document["edits"][0]["shapes"][0]
        self.assertEqual(shape["kind"], "ellipse")
        self.assertAlmostEqual(shape["cx"], 60.0)
        self.assertAlmostEqual(shape["cy"], 40.0)
        self.assertAlmostEqual(shape["rx"], 40.0)
        self.assertAlmostEqual(shape["ry"], 20.0)

    def test_zero_size_drag_is_ignored(self):
        editor = self._editor()
        editor._commit_rect((10, 10), (10, 10))
        self.assertEqual(editor.document["edits"], [])

    def test_brush_commit_uses_radius(self):
        editor = self._editor()
        editor.points = [[40, 20], [60, 20]]
        editor._commit_brush()
        shape = editor.document["edits"][0]["shapes"][0]
        self.assertEqual(shape["kind"], "brush")
        self.assertEqual(shape["radius"], 3.0)
        self.assertEqual(shape["points"], [[40, 20], [60, 20]])

    def test_polygon_needs_three_points(self):
        editor = self._editor()
        editor.points = [[10, 10], [30, 10]]
        editor._finish_polygon()
        self.assertEqual(editor.document["edits"], [])
        editor.points = [[10, 10], [30, 10], [20, 30]]
        editor._finish_polygon()
        shape = editor.document["edits"][0]["shapes"][0]
        self.assertEqual(shape["kind"], "polygon")
        self.assertEqual(len(shape["points"]), 3)

    def test_shapes_merge_for_same_photo_only(self):
        editor = self._editor()
        editor._commit_rect((10, 10), (20, 20))
        editor._commit_rect((30, 30), (40, 40))
        self.assertEqual(len(editor.document["edits"]), 1)
        self.assertEqual(len(editor.document["edits"][0]["shapes"]), 2)
        editor.photo_index = 1
        editor._commit_rect((60, 10), (90, 40))   # view space -> canvas 120,20..180,80
        self.assertEqual(len(editor.document["edits"]), 2)
        self.assertEqual(editor.document["edits"][1]["image"], 1)

    def test_editor_output_validates_as_edit_document(self):
        editor = self._editor()
        editor._commit_rect((10, 10), (40, 30))
        validated = validate_document(editor.document, 3)
        self.assertEqual(len(validated["edits"]), 1)
        self.assertEqual(validated["edits"][0]["shapes"][0]["strength"], 1.0)

    def test_shape_bbox_union(self):
        editor = self._editor()
        shapes = [
            {"kind": "rect", "x": 10, "y": 10, "width": 20, "height": 10},
            {"kind": "ellipse", "cx": 50, "cy": 40, "rx": 8, "ry": 5},
        ]
        box = editor._shape_bbox(shapes)
        self.assertEqual(box, (10, 10, 48, 35))


if __name__ == "__main__":
    unittest.main()
