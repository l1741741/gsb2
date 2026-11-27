"""Fallback decoding via decoders that ship with the operating system.

Pillow is not required.  When a file's format is not handled by the pure
Python decoders (WEBP, HEIC, rare TIFF variants, ...) the loader can ask a
locally installed tool to convert it to PPM, which is trivial to parse.

Supported tools, tried in order:

* ``ffmpeg``  - broad format coverage, decode-only (never re-encodes)
* ``sips``    - macOS built-in; converts to a temporary PNG

The tool is only ever used as a converter for an already-local file; nothing
is uploaded and no network access is involved.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from .image import Image, ImageError


def _find_tool(*names: str) -> str | None:
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    # Homebrew installs ffmpeg outside the default PATH in some shells.
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if name == "ffmpeg" and os.path.exists(candidate):
            return candidate
    return None


def decode_with_external_tool(path: str, *, max_dimension: int | None = None) -> Image:
    ffmpeg = _find_tool("ffmpeg")
    if ffmpeg:
        try:
            return _decode_with_ffmpeg(ffmpeg, path, max_dimension)
        except ImageError:
            pass
        except (OSError, subprocess.SubprocessError):
            pass
    sips = _find_tool("sips")
    if sips:
        try:
            return _decode_with_sips(sips, path)
        except ImageError:
            pass
        except (OSError, subprocess.SubprocessError):
            pass
    raise ImageError("no decoder available for this format "
                     "(install ffmpeg or Pillow, or convert the file)")


def _decode_with_ffmpeg(ffmpeg: str, path: str, max_dimension: int | None) -> Image:
    with tempfile.TemporaryDirectory(prefix="photocatalog-") as tmp:
        out = os.path.join(tmp, "out.ppm")
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path]
        if max_dimension:
            cmd += ["-vf", f"scale='min({max_dimension},iw)':-1"]
        cmd += ["-f", "image2", "-pix_fmt", "rgb24", out]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        if proc.returncode != 0 or not os.path.exists(out):
            detail = (proc.stderr or "").strip().splitlines()
            detail = detail[-1] if detail else "ffmpeg conversion failed"
            raise ImageError(detail)
        return _read_ppm(out, "external-ffmpeg")


def _decode_with_sips(sips: str, path: str) -> Image:
    from .png import decode_png
    with tempfile.TemporaryDirectory(prefix="photocatalog-") as tmp:
        out = os.path.join(tmp, "out.png")
        proc = subprocess.run([sips, "-s", "format", "png", path, "--out", out],
                              capture_output=True, text=True, timeout=120, check=False)
        if proc.returncode != 0 or not os.path.exists(out):
            detail = (proc.stderr or "").strip().splitlines()
            detail = detail[-1] if detail else "sips conversion failed"
            raise ImageError(detail)
        img = decode_png(out)
        return img


def _read_ppm(path: str, source: str) -> Image:
    with open(path, "rb") as fh:
        magic = fh.readline().strip()
        if magic != b"P6":
            raise ImageError(f"external decoder returned unexpected data ({magic!r})")
        dims = fh.readline().split()
        while dims and dims[0].startswith(b"#"):
            dims = fh.readline().split()
        if len(dims) < 2:
            raise ImageError("external decoder output missing dimensions")
        width, height = int(dims[0]), int(dims[1])
        fh.readline()
        pixels = fh.read(width * height * 3)
    if len(pixels) != width * height * 3:
        raise ImageError("external decoder output truncated")
    return Image(width, height, pixels, 3, source, "RGB")
