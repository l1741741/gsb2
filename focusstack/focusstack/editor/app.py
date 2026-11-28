"""Drawing regions for manual overrides (needs tkinter).

Usage inside the tool::

    python3 -m focusstack editor --edits edits.json PHOTO...

You draw one region at a time (rectangle, ellipse, polygon or brush), pick
the photo it must come from, then save.  The editor never invents geometry on
its own: it writes shapes in canvas coordinates into the same JSON document
the stacker reads, so the next run -- full frame or block export -- uses
exactly these pixels.

Controls:

* left drag -- draw the current shape; for a brush this paints a freehand line
* right click -- finish a polygon
* ``r`` ``e`` ``p`` ``b`` -- choose rectangle / ellipse / polygon / brush
* ``1``..``9`` -- pick the source photo
* Delete -- remove the selected override
* Save -- validate and write the JSON
"""

from __future__ import annotations

import tempfile
from pathlib import Path


def run_editor(args, load_edits, validate_document, save_edits, run_stack) -> int:
    import tkinter as tk
    from tkinter import messagebox, ttk

    from ..align import OffsetPair, place_image, placements, resolve_window
    from ..edits import EditError, empty_document
    from ..image import Image
    from ..pipeline import StackError, prepare_photos

    try:
        document = load_edits(args.edits, len(args.photos)) if Path(args.edits).exists() else empty_document()
    except (EditError, StackError) as exc:
        print("focusstack: cannot load edits: %s" % exc)
        return 2
    try:
        photos, photo_size = prepare_photos(args.photos)
    except StackError as exc:
        print("focusstack: %s" % exc)
        return 2
    offsets = [OffsetPair(0, 0) for _ in photos]
    if args.offsets:
        base = args.offsets[args.reference]
        offsets = [OffsetPair(o.dx - base.dx, o.dy - base.dy) for o in args.offsets]
    try:
        (width, height), _, placed = placements(photo_size, offsets)
        window = (0, 0, width, height) if args.window is None else resolve_window(
            photo_size, offsets, args.window, "keep"
        )
    except (ValueError, StackError) as exc:
        print("focusstack: %s" % exc)
        return 2
    shifted = [place_image(p, (width, height), placed[i], fill=(0, 0, 0, 0))
               for i, p in enumerate(photos)]

    app = _Editor(tk, ttk, messagebox, args, document, photos, shifted, width, height, window,
                  load_edits, validate_document, save_edits, run_stack)
    app.run()
    return 0


class _Editor:
    MAX_VIEW = 900

    def __init__(self, tk, ttk, messagebox, args, document, photos, shifted, width, height,
                 window, load_edits, validate_document, save_edits, run_stack) -> None:
        self.tk = tk
        self.ttk = ttk
        self.messagebox = messagebox
        self.args = args
        self.document = document
        self.photos = photos
        self.shifted = shifted
        self.width = width
        self.height = height
        self.window = window
        self.load_edits = load_edits
        self.validate_document = validate_document
        self.save_edits = save_edits
        self.run_stack = run_stack

        self.view_scale = min(1.0, self.MAX_VIEW / max(width, height))
        self.view_w = max(1, int(width * self.view_scale))
        self.view_h = max(1, int(height * self.view_scale))
        self.photo_index = 0
        self.tool = "rect"
        self.points = []
        self.drag_start = None
        self.drag_current = None
        self.selected = None
        self.temp_size = tempfile.mkdtemp(prefix="focusstack-editor-")

        self.root = tk.Tk()
        self.root.title("focusstack editor - %s" % Path(args.edits).name)
        self._build_ui()
        self._render()

    # ---- UI ----
    def _build_ui(self) -> None:
        tk, ttk = self.tk, self.ttk
        top = ttk.Frame(self.root, padding=6)
        top.pack(side="top", fill="x")
        ttk.Label(top, text="photo").pack(side="left")
        self.photo_var = tk.IntVar(value=0)
        self.photo_spin = ttk.Spinbox(top, from_=0, to=len(self.photos) - 1, width=4,
                                      textvariable=self.photo_var, command=self._on_photo)
        self.photo_spin.pack(side="left", padx=(4, 12))
        ttk.Label(top, text="tool").pack(side="left")
        self.tool_var = tk.StringVar(value="rect")
        combo = ttk.Combobox(top, width=9, state="readonly", textvariable=self.tool_var,
                             values=("rect", "ellipse", "polygon", "brush"))
        combo.bind("<<ComboboxSelected>>", lambda event: self._on_tool())
        combo.pack(side="left", padx=(4, 12))
        ttk.Label(top, text="brush px").pack(side="left")
        self.brush_var = tk.IntVar(value=6)
        ttk.Spinbox(top, from_=1, to=200, width=5, textvariable=self.brush_var).pack(side="left", padx=4)
        ttk.Button(top, text="Finish polygon", command=self._finish_polygon).pack(side="left", padx=4)
        ttk.Button(top, text="Save + rerun", command=self._save_and_rerun).pack(side="right", padx=4)
        ttk.Button(top, text="Save JSON", command=self._save).pack(side="right", padx=4)

        middle = ttk.Frame(self.root)
        middle.pack(side="top", fill="both", expand=True)
        self.canvas = tk.Canvas(middle, width=self.view_w, height=self.view_h,
                                background="#202020", highlightthickness=0)
        self.canvas.pack(side="left", padx=6, pady=6)
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Button-3>", self._on_right_click)
        self.root.bind("<Key>", self._on_key)

        side = ttk.Frame(middle, padding=6)
        side.pack(side="left", fill="y")
        ttk.Label(side, text="manual overrides").pack(anchor="w")
        self.listbox = tk.Listbox(side, width=34, height=16, exportselection=False)
        self.listbox.pack(fill="both", expand=True, pady=(4, 6))
        self.listbox.bind("<<ListboxSelect>>", self._on_select_override)
        buttons = ttk.Frame(side)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="Delete", command=self._delete_selected).pack(side="left")
        ttk.Button(buttons, text="Reload", command=self._reload).pack(side="left", padx=4)
        self.status = ttk.Label(side, text="", wraplength=280, justify="left")
        self.status.pack(anchor="w", pady=(8, 0))
        self._refresh_list()

    # ---- state helpers ----
    def _on_photo(self) -> None:
        self.photo_index = int(self.photo_var.get())
        self._render()

    def _on_tool(self) -> None:
        self.tool = self.tool_var.get()
        self.points = []
        self._render()

    def _on_key(self, event) -> None:
        key = event.keysym.lower()
        if key in ("r", "e", "p", "b"):
            self.tool = {"r": "rect", "e": "ellipse", "p": "polygon", "b": "brush"}[key]
            self.tool_var.set(self.tool)
            self.points = []
            self._render()
        elif key.isdigit() and key != "0":
            index = int(key) - 1
            if index < len(self.photos):
                self.photo_index = index
                self.photo_var.set(index)
                self._render()
        elif key in ("delete", "backspace"):
            self._delete_selected()

    def _to_canvas(self, sx, sy):
        return sx / self.view_scale, sy / self.view_scale

    def _to_image(self, sx, sy):
        return min(self.width - 1, max(0, int(sx / self.view_scale))), \
               min(self.height - 1, max(0, int(sy / self.view_scale)))

    # ---- drawing ----
    def _render(self) -> None:
        self.canvas.delete("all")
        base = self.shifted[self.photo_index]
        key = (self.photo_index, self.view_scale)
        if getattr(self, "_view_key", None) != key:
            self._tk_image = self._photo_to_photoimage(base, self.view_scale)
            self._view_key = key
        self.canvas.create_image(0, 0, anchor="nw", image=self._tk_image)
        self._draw_window()
        self._draw_existing_shapes()
        self._draw_pending()

    def _draw_image(self, image, scale) -> None:
        self._tk_image = self._photo_to_photoimage(image, scale)
        self.canvas.create_image(0, 0, anchor="nw", image=self._tk_image)

    def _photo_to_photoimage(self, image, scale):
        tk = self.tk
        if scale < 1.0:
            image = image.scaled(scale)
        # Fast path: tkinter reads P6 PPM through its built-in image loader.
        path = Path(self.temp_size) / "view.ppm"
        ppm = bytearray()
        ppm.extend(b"P6\n%d %d\n255\n" % (image.width, image.height))
        rows = []
        for y in range(image.height):
            row = bytearray(image.width * 3)
            offset = y * image.width
            row[0::3] = image.r[offset:offset + image.width]
            row[1::3] = image.g[offset:offset + image.width]
            row[2::3] = image.b[offset:offset + image.width]
            rows.append(bytes(row))
        ppm.extend(b"".join(rows))
        path.write_bytes(ppm)
        return tk.PhotoImage(file=str(path))

    def _draw_window(self) -> None:
        x, y, w, h = self.window
        if (w, h) == (self.width, self.height):
            return
        self.canvas.create_rectangle(
            x * self.view_scale, y * self.view_scale,
            (x + w) * self.view_scale, (y + h) * self.view_scale,
            outline="#00e5ff", width=2, dash=(4, 3),
        )

    def _draw_existing_shapes(self) -> None:
        for index, edit in enumerate(self.document["edits"]):
            color = "#ffd400" if index == self.selected else "#33ff88"
            if not edit.get("enabled", True):
                color = "#888888"
            for shape in edit["shapes"]:
                self._draw_shape(shape, color)
            box = self._shape_bbox(edit["shapes"])
            if box:
                x, y, w, h = box
                self.canvas.create_text(
                    (x + w / 2) * self.view_scale, (y - 3) * self.view_scale,
                    text="%s->%d" % (edit.get("id", "?"), edit["image"]),
                    fill=color, font=("TkDefaultFont", 9))

    def _draw_shape(self, shape, color) -> None:
        scale = self.view_scale
        kind = shape["kind"]
        if kind == "rect":
            self.canvas.create_rectangle(shape["x"] * scale, shape["y"] * scale,
                                         (shape["x"] + shape["width"]) * scale,
                                         (shape["y"] + shape["height"]) * scale,
                                         outline=color, width=2)
        elif kind == "ellipse":
            self.canvas.create_oval((shape["cx"] - shape["rx"]) * scale,
                                    (shape["cy"] - shape["ry"]) * scale,
                                    (shape["cx"] + shape["rx"]) * scale,
                                    (shape["cy"] + shape["ry"]) * scale,
                                    outline=color, width=2)
        elif kind == "polygon":
            coords = [v * scale for pair in shape["points"] for v in pair]
            self.canvas.create_polygon(coords, outline=color, fill="", width=2)
        else:
            points = shape["points"]
            radius = shape["radius"] * scale
            if len(points) == 1:
                self.canvas.create_oval(points[0][0] * scale - radius, points[0][1] * scale - radius,
                                        points[0][0] * scale + radius, points[0][1] * scale + radius,
                                        outline=color)
            else:
                for a, b in zip(points, points[1:]):
                    self.canvas.create_line(a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale,
                                            fill=color, width=max(1, int(radius)))

    def _draw_pending(self) -> None:
        if self.tool in ("rect", "ellipse") and self.drag_start and self.drag_current:
            x0, y0 = self.drag_start
            x1, y1 = self.drag_current
            if self.tool == "rect":
                self.canvas.create_rectangle(x0, y0, x1, y1, outline="#ff5e5e", width=2)
            else:
                self.canvas.create_oval(x0, y0, x1, y1, outline="#ff5e5e", width=2)
        if self.tool == "polygon" and self.points:
            coords = [v for pair in self.points for v in pair]
            if len(self.points) >= 2:
                self.canvas.create_line(coords, fill="#ff5e5e", width=2)

    # ---- mouse ----
    def _on_press(self, event) -> None:
        self.drag_start = (event.x, event.y)
        self.drag_current = (event.x, event.y)
        if self.tool == "polygon":
            point = (int(event.x / self.view_scale), int(event.y / self.view_scale))
            self.points.append(point)
            self._draw_pending()
        elif self.tool == "brush":
            point = [int(event.x / self.view_scale), int(event.y / self.view_scale)]
            self.points.append(point)
            self._draw_pending()
        self._render()

    def _on_drag(self, event) -> None:
        self.drag_current = (event.x, event.y)
        if self.tool == "brush":
            point = [int(event.x / self.view_scale), int(event.y / self.view_scale)]
            if not self.points or point != self.points[-1]:
                self.points.append(point)
        self._render()

    def _on_release(self, event) -> None:
        if self.tool == "rect" and self.drag_start and self.drag_current:
            self._commit_rect(self.drag_start, self.drag_current)
        elif self.tool == "ellipse" and self.drag_start and self.drag_current:
            self._commit_ellipse(self.drag_start, self.drag_current)
        elif self.tool == "brush" and self.points:
            self._commit_brush()
        self.drag_start = None
        self.drag_current = None
        self._render()

    def _on_right_click(self, event) -> None:
        if self.tool == "polygon":
            self._finish_polygon()

    def _commit_rect(self, start, end) -> None:
        x0, y0 = self._to_image(min(start[0], end[0]), min(start[1], end[1]))
        x1, y1 = self._to_image(max(start[0], end[0]), max(start[1], end[1]))
        if x1 <= x0 or y1 <= y0:
            return
        self._add_shape({"kind": "rect", "x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0})

    def _commit_ellipse(self, start, end) -> None:
        x0, y0 = self._to_image(min(start[0], end[0]), min(start[1], end[1]))
        x1, y1 = self._to_image(max(start[0], end[0]), max(start[1], end[1]))
        rx = (x1 - x0) / 2.0
        ry = (y1 - y0) / 2.0
        if rx < 1 or ry < 1:
            return
        self._add_shape({"kind": "ellipse", "cx": (x0 + x1) / 2.0, "cy": (y0 + y1) / 2.0,
                         "rx": rx, "ry": ry})

    def _finish_polygon(self) -> None:
        if len(self.points) >= 3:
            self._add_shape({"kind": "polygon", "points": [list(p) for p in self.points]})
        self.points = []
        self._render()

    def _commit_brush(self) -> None:
        self._add_shape({"kind": "brush", "points": [list(p) for p in self.points],
                         "radius": float(self.brush_var.get())})
        self.points = []

    def _add_shape(self, shape) -> None:
        shape["strength"] = 1.0
        shapes = [shape]
        existing = self.document["edits"]
        # Merge with the last override for the same photo if the user drew
        # another blob in one sitting; otherwise create a new entry.
        if existing and existing[-1]["image"] == self.photo_index:
            existing[-1]["shapes"].append(shape)
            self.selected = len(existing) - 1
        else:
            existing.append({
                "id": "region-%d" % (len(existing) + 1),
                "image": self.photo_index,
                "note": "drawn in editor",
                "enabled": True,
                "shapes": shapes,
            })
            self.selected = len(existing) - 1
        self._refresh_list()
        self.status.configure(text="added shape from photo %d; save to apply" % self.photo_index)

    def _shape_bbox(self, shapes) -> tuple:
        left = top = 10 ** 9
        right = bottom = -10 ** 9
        for shape in shapes:
            kind = shape["kind"]
            if kind == "rect":
                l, t = shape["x"], shape["y"]
                r, b = l + shape["width"], t + shape["height"]
            elif kind == "ellipse":
                l, t = shape["cx"] - shape["rx"], shape["cy"] - shape["ry"]
                r, b = shape["cx"] + shape["rx"], shape["cy"] + shape["ry"]
            else:
                points = shape["points"]
                l = min(p[0] for p in points)
                r = max(p[0] for p in points)
                t = min(p[1] for p in points)
                b = max(p[1] for p in points)
            left, top = min(left, l), min(top, t)
            right, bottom = max(right, r), max(bottom, b)
        if right <= left or bottom <= top:
            return None
        return (left, top, right - left, bottom - top)

    # ---- list + persistence ----
    def _refresh_list(self) -> None:
        self.listbox.delete(0, "end")
        for index, edit in enumerate(self.document["edits"]):
            marker = "" if edit.get("enabled", True) else " [off]"
            self.listbox.insert("end", "%s  photo %d  %d shape(s)%s"
                                % (edit.get("id", "?"), edit["image"], len(edit["shapes"]), marker))
        if self.document["edits"] and self.selected is None:
            self.selected = 0
        if self.selected is not None and self.selected < len(self.document["edits"]):
            self.listbox.selection_set(self.selected)

    def _on_select_override(self, event) -> None:
        selection = self.listbox.curselection()
        if selection:
            self.selected = selection[0]
            self._render()

    def _delete_selected(self) -> None:
        if self.selected is None or self.selected >= len(self.document["edits"]):
            return
        del self.document["edits"][self.selected]
        self.selected = None
        self._refresh_list()
        self._render()

    def _validate(self):
        try:
            return self.validate_document(self.document, len(self.photos))
        except EditError as exc:
            self.messagebox.showerror("focusstack editor", "edit file is invalid:\n%s" % exc)
            return None

    def _save(self) -> None:
        validated = self._validate()
        if validated is None:
            return
        self.document = validated
        self.save_edits(self.args.edits, validated)
        self.status.configure(text="saved %d override(s) to %s"
                              % (len(validated["edits"]), self.args.edits))
        self._refresh_list()

    def _save_and_rerun(self) -> None:
        validated = self._validate()
        if validated is None:
            return
        self.document = validated
        self.save_edits(self.args.edits, validated)
        try:
            result, window = self.run_stack(
                self.args.photos, reference=self.args.reference, offsets=self.args.offsets,
                edits=validated, window=self.args.window, coverage="keep",
            )
        except StackError as exc:
            self.messagebox.showerror("focusstack editor", "rerun failed:\n%s" % exc)
            return
        out = Path(self.temp_size) / "preview.png"
        from ..pngio import write_png
        write_png(out, result.composite)
        self.status.configure(text="saved and reran; preview at %s\noverride reports: %s"
                              % (out, ", ".join("%s painted %d" % (r["id"], r["painted"])
                                                for r in result.edit_records)))
        self._refresh_list()

    def _reload(self) -> None:
        try:
            self.document = self.load_edits(self.args.edits, len(self.photos))
        except EditError as exc:
            self.messagebox.showerror("focusstack editor", "cannot reload: %s" % exc)
            return
        self.selected = None
        self._refresh_list()
        self._render()
        self.status.configure(text="reloaded %d override(s)" % len(self.document["edits"]))

    def run(self) -> None:
        self.root.mainloop()
