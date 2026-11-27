"""Scan a folder of photos, propose candidate groups, and write reports.

Contract:

* One unreadable file never aborts a batch; it is recorded with its path and
  reason.
* Nothing is auto-merged: the tool produces *proposals* with reasons and
  evidence, and a person decides.
* Human decisions survive rescans.  They are keyed by file content, so a
  decision follows the picture when it is renamed or moved, and a changed file
  at a known path is reported for re-review rather than silently inheriting the
  old verdict.
* Similarity is not transitive.  Groups are built from *mutual* strong links,
  and any chain that fails that test is reported separately.
"""

from __future__ import annotations

import hashlib
import json
import os

from .analysis import Signature, build_signature, hamming
from .imaging import ImageError, load_image
from .imaging.image import Image
from .similarity import (
    PairEvidence, affine_residual, aspect_similarity, colour_distance,
    find_region, structure_similarity,
)

STATE_VERSION = 1
SUPPORTED_EXT = {".png", ".jpg", ".jpeg", ".jfif", ".bmp", ".tga", ".tif", ".tiff",
                 ".gif", ".ppm", ".pgm", ".webp", ".heic", ".heif"}

# Evidence thresholds.  Calibrated on the bundled sample set; see README.
IDENTICAL_MAX_DISTANCE = 0
STRONG_CORRELATION = 0.985
SAME_PHOTO_CORR = 0.90
SAME_PHOTO_RESIDUAL = 40.0   # flat-region residual gate for a copy
STRONG_RESIDUAL = 20.0  # max tone-corrected residual for a copy
CANDIDATE_CORRELATION = 0.88


class Photo:
    """One scanned file: identity, provenance, and analysis results."""

    __slots__ = ("path", "relpath", "abspath", "size", "mtime", "sha256",
                 "width", "height", "format", "signature", "error", "image",
                 "accounted")

    def __init__(self, path: str, relpath: str):
        self.path = path
        self.relpath = relpath
        self.abspath = os.path.abspath(path)
        self.size = 0
        self.mtime = 0
        self.sha256 = ""
        self.width = 0
        self.height = 0
        self.format = ""
        self.signature: Signature | None = None
        self.error: str | None = None
        self.image: Image | None = None
        self.accounted = False

    @property
    def ok(self) -> bool:
        return self.error is None and self.signature is not None


def collect_files(root: str) -> list[str]:
    found = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            ext = os.path.splitext(name)[1].lower()
            if ext in SUPPORTED_EXT:
                found.append(os.path.join(dirpath, name))
    found.sort()
    return found


def _hash_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def scan_file(path: str, root: str, *, external_tools: bool = True) -> Photo:
    photo = Photo(path, os.path.relpath(path, root))
    try:
        st = os.stat(path)
        photo.size = st.st_size
        photo.mtime = int(st.st_mtime)
    except OSError as exc:
        photo.error = f"cannot stat file: {exc.strerror or exc}"
        return photo
    try:
        photo.sha256 = _hash_file(path)
    except OSError as exc:
        photo.error = f"cannot read file: {exc.strerror or exc}"
        return photo
    try:
        img = load_image(path, external_tools=external_tools)
    except ImageError as exc:
        photo.error = f"无法解码：{exc}"
        return photo
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the batch
        photo.error = f"unexpected decode failure: {exc}"
        return photo
    photo.width, photo.height = img.width, img.height
    photo.format = img.format
    photo.image = img
    try:
        photo.signature = build_signature(img)
    except Exception as exc:  # noqa: BLE001
        photo.error = f"analysis failed: {exc}"
        photo.image = None
    return photo


def scan_folder(root: str, *, external_tools: bool = True, progress=None) -> list[Photo]:
    photos = []
    files = collect_files(root)
    for index, path in enumerate(files):
        if progress:
            progress(index, len(files), path)
        photos.append(scan_file(path, root, external_tools=external_tools))
    return photos


# ------------------------------------------------------------------ scoring

def evaluate_pair(a: Photo, b: Photo) -> PairEvidence:
    """Score one pair and describe why.  Never mutates anything global."""
    assert a.signature is not None and b.signature is not None
    sa, sb = a.signature, b.signature
    ev = PairEvidence(a=a.relpath, b=b.relpath)
    ev.size_a = (a.width, a.height)
    ev.size_b = (b.width, b.height)
    ev.aspect_delta = 1.0 - aspect_similarity(ev.size_a, ev.size_b)
    ev.phash_distance = hamming(sa.phash, sb.phash)
    ev.dhash_distance = hamming(sa.dhash, sb.dhash)
    ev.colour_distance = colour_distance(sa, sb)
    ev.structure = structure_similarity(sa, sb)

    identical = a.sha256 and a.sha256 == b.sha256
    if identical:
        ev.relation = "identical"
        ev.score = 1.0
        ev.same_photo = 1.0
        ev.reasons.append("files are byte-for-byte identical (same SHA-256)")
    elif ev.size_a == ev.size_b and ev.phash_distance == 0 \
            and ev.dhash_distance == 0 and ev.structure > 0.999 \
            and ev.colour_distance < 0.01:
        ev.relation = "identical"
        ev.score = 1.0
        ev.same_photo = 1.0
        ev.reasons.append("pixels match exactly for all compared features "
                          "(different files, same image)")
    else:
        region = find_region(a.image, b.image)
        ev.region_correlation = region.correlation if region else 0.0
        ev.region_mae = region.mae if region else None
        ev.region_outlier_fraction = region.outlier_fraction if region else 1.0
        ev.region = region
        ev.region_excess = region.excess if region else 255.0
        ev.crop = region.crop if region else None
        residual = affine_residual(a.image, b.image, region) if region else None
        if residual is not None:
            ev.residual_median, ev.residual_max, ev.residual_flat = residual
        else:
            ev.residual_median, ev.residual_max, ev.residual_flat = 0.0, 255.0, 255.0
        ev.residual_gate = _residual_gate(max(ev.size_a), max(ev.size_b))
        _classify(ev, region)

    # --- Two separate notions -------------------------------------------
    # ``same_photo``: is this literally the same picture?  Judged on the
    # aligned region by a high correlation AND a small tone-corrected residual.
    # A different subject in the same place leaves a large residual even when
    # the overall framing matches, which is exactly the look-alike trap.
    # ``merge_fit``: would merging these two be a sensible archive action?
    # It additionally requires that the aligned region covers most of the
    # larger frame (a copy that lost half the scene is the same photo but is a
    # poor companion) and that no warning applies.
    corr = ev.region_correlation
    res_max = ev.residual_max
    coverage = 0.0
    if ev.region is not None:
        crop = ev.region.crop
        coverage = max(0.0, crop[2] - crop[0]) * max(0.0, crop[3] - crop[1])
    if ev.relation == "identical":
        ev.same_photo = 1.0
        ev.merge_fit = 1.0
    elif corr <= 0.0:
        ev.same_photo = 0.0
        ev.merge_fit = 0.0
    else:
        # Hard gate first: copy-like alignment and a small tone-corrected
        # residual.  Below the gate the pair is not the same picture.
        # Resampling one side of a pair blurs small detail and inflates the
        # residual, so the gate widens when the two images were captured at
        # very different pixel counts.
        # Two gates must pass: the frames line up (correlation), and the
        # tone-corrected difference is small *everywhere*, including smooth
        # areas.  A changed subject fails the second gate even when the
        # framing matches perfectly.
        if ev.residual_flat <= ev.residual_gate and corr >= SAME_PHOTO_CORR:
            margin = max(0.0, 1.0 - ev.residual_flat / ev.residual_gate)
            ev.same_photo = 0.85 + 0.15 * margin
        else:
            ev.same_photo = 0.0
        # Merge suitability.  A same-photo pair is mergeable unless the shared
        # region is genuinely small (a heavily cropped copy) or a warning
        # applies.  Border trims and resizes keep the full merge score.
        if ev.same_photo > 0.0:
            if coverage < 0.60:
                ev.merge_fit = ev.same_photo * 0.5
            elif coverage < 0.80:
                ev.merge_fit = ev.same_photo * 0.95
            else:
                ev.merge_fit = ev.same_photo
            if ev.warnings:
                ev.merge_fit = min(ev.merge_fit, 0.6)
        else:
            ev.merge_fit = 0.0
    ev.score = ev.same_photo
    return ev


def _classify(ev: PairEvidence, region) -> None:
    size_a, size_b = ev.size_a, ev.size_b
    same_size = size_a == size_b
    ev.reasons.append(
        f"dimensions {size_a[0]}×{size_a[1]} vs {size_b[0]}×{size_b[1]}"
        + ("" if same_size else f" ({ev.aspect_delta * 100:.1f}% aspect difference)"))
    ev.reasons.append(f"perceptual hash distance {ev.phash_distance}/64, "
                      f"gradient hash {ev.dhash_distance}/64")
    ev.reasons.append(f"colour layout distance {ev.colour_distance * 100:.1f}%")
    if region is not None:
        ev.reasons.append(f"best alignment correlation {region.correlation:.3f}")
        ev.reasons.append(f"difference map: median tile error "
                          f"{region.median_error:.0f}/255, max {region.max_error:.0f}/255")
        if region.outlier_fraction > 0.02:
            ev.reasons.append(
                f"{region.outlier_fraction * 100:.0f}% of the frame differs much more "
                "than the rest — typical of a changed subject, not a copy")
        crop = region.crop
        if crop != (0.0, 0.0, 1.0, 1.0):
            ev.reasons.append(
                f"best match uses a sub-region of the larger image "
                f"(x {crop[0]:.2f}–{crop[2]:.2f}, y {crop[1]:.2f}–{crop[3]:.2f})")
    else:
        ev.warnings.append("no stable alignment found; pair reported as a weak candidate only")

    # --- Relation label --------------------------------------------------
    # A "copy" needs a high alignment correlation AND a small tone-corrected
    # residual; the residual is what separates a copy from a look-alike with
    # the same background.
    copy_like = (ev.region_correlation >= SAME_PHOTO_CORR
                 and ev.residual_flat <= ev.residual_gate)
    if copy_like:
        crop = region.crop if region is not None else (0.0, 0.0, 1.0, 1.0)
        covered = ((crop[2] - crop[0]) * (crop[3] - crop[1])
                   if region is not None else 1.0)
        if covered < 0.62:
            ev.relation = "cropped-heavily"
            ev.warnings.append(
                "the two frames share only part of their extent; the smaller "
                "copy has lost a large portion of the scene")
        elif crop != (0.0, 0.0, 1.0, 1.0):
            ev.relation = "cropped"
        elif not same_size:
            ev.relation = "resized"
        elif ev.colour_distance > 0.03:
            ev.relation = "recoloured"
        else:
            ev.relation = "same-image"
    elif ev.region_correlation >= CANDIDATE_CORRELATION:
        ev.relation = "look-alike"
        ev.warnings.append(
            "similar overall composition but the difference map shows a "
            "localised change; review before merging")
    else:
        ev.relation = "weak"
    ev.region = region


def candidate_pairs(photos: list[Photo], *, threshold: float = 0.0) -> list[PairEvidence]:
    """All pairs worth showing to a human.

    Uses cheap blocking (aspect and colour) so a large archive does not become
    O(n²) full analyses; exact duplicates are paired first.
    """
    usable = [p for p in photos if p.ok]
    by_hash: dict[str, list[Photo]] = {}
    for p in usable:
        by_hash.setdefault(p.sha256, []).append(p)

    pairs: list[PairEvidence] = []
    # Exact duplicates are certain and cheap.
    for digest, group in by_hash.items():
        if len(group) < 2:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                pairs.append(evaluate_pair(group[i], group[j]))

    # Near-duplicates: block by aspect and overall colour.
    remaining = usable
    for i in range(len(remaining)):
        for j in range(i + 1, len(remaining)):
            a, b = remaining[i], remaining[j]
            if a.signature is None or b.signature is None:
                continue
            if a.sha256 == b.sha256:
                continue
            # Cheap prefilter only.  Aspect ratio deliberately is *not* a gate:
            # a crop changes it, and a panorama may bridge two very differently
            # shaped crops.  Colour layout is a safe, cheap filter; the
            # alignment check in evaluate_pair rejects the rest.
            if colour_distance(a.signature, b.signature) > 0.30:
                continue
            pairs.append(evaluate_pair(a, b))
    return pairs


# ------------------------------------------------------------------ grouping

def _residual_gate(long_a: int, long_b: int) -> float:
    """Residual threshold, widened when one side was heavily resampled.

    A 1:2 or 1:4 resample loses detail; that shows up as residual in the same
    places as a genuine difference would, so the gate must scale.
    """
    ratio = max(long_a, long_b) / max(1, min(long_a, long_b))
    if ratio < 1.4:
        return SAME_PHOTO_RESIDUAL
    if ratio < 2.5:
        return SAME_PHOTO_RESIDUAL * 1.1
    return SAME_PHOTO_RESIDUAL * 1.25


STRONG_RELATIONS = {"identical", "same-image", "resized", "cropped",
                    "recoloured", "cropped-heavily"}


def _is_strong(ev: PairEvidence, min_confidence: float) -> bool:
    return (ev.merge_fit >= min_confidence and ev.relation in STRONG_RELATIONS
            and not ev.warnings)


def group_candidates(pairs: list[PairEvidence], *,
                     min_confidence: float = 0.80) -> list[dict]:
    """Propose groups of files that a person may merge as one photo.

    Returns ``{"members": [...], "complete": bool, "failed_pairs": [...]}``
    entries.  A group is proposed only when every member is strongly linked to
    every other member (a clique).  When a cluster of strong links is *not* a
    clique, the largest fully-linked subset is proposed and ``complete`` is
    False, with the failing pairs listed, so nobody mistakes a chain for a
    three-way merge.
    """
    adjacency: dict[str, set[str]] = {}
    links: dict[frozenset[str], PairEvidence] = {}
    for p in pairs:
        if not _is_strong(p, min_confidence):
            continue
        key = frozenset((p.a, p.b))
        links[key] = p
        adjacency.setdefault(p.a, set()).add(p.b)
        adjacency.setdefault(p.b, set()).add(p.a)

    groups: list[dict] = []
    seen: set[str] = set()
    for node in sorted(adjacency):
        if node in seen:
            continue
        component = _component(node, adjacency)
        seen |= component
        if len(component) < 2:
            continue
        remaining = set(component)
        while len(remaining) >= 2:
            clique = _largest_clique(remaining, adjacency)
            if len(clique) < 2:
                break
            failed = []
            for a in sorted(clique):
                for b in sorted(clique):
                    if a >= b:
                        continue
                    if frozenset((a, b)) not in links:
                        ev = next((p for p in pairs
                                   if {p.a, p.b} == {a, b}), None)
                        failed.append({
                            "a": a,
                            "b": b,
                            "relation": ev.relation if ev else "unlinked",
                            "confidence": round(ev.same_photo, 3) if ev else 0.0,
                        })
            groups.append({
                "members": sorted(clique),
                "complete": not failed,
                "failed_pairs": failed,
            })
            remaining -= clique
            if not any(frozenset((r, o)) in links for r in remaining for o in remaining if r < o):
                break
    return groups


def _component(start: str, adjacency: dict[str, set[str]]) -> set[str]:
    component = {start}
    frontier = [start]
    while frontier:
        cur = frontier.pop()
        for nxt in adjacency.get(cur, ()):
            if nxt not in component:
                component.add(nxt)
                frontier.append(nxt)
    return component


def _largest_clique(nodes: set[str], adjacency: dict[str, set[str]]) -> set[str]:
    """Greedy clique from the densest node, then a local improvement pass."""
    ordered = sorted(nodes, key=lambda n: (-len(adjacency.get(n, set()) & nodes), n))
    clique = {ordered[0]}
    for node in ordered[1:]:
        if all(node in adjacency.get(member, set()) for member in clique):
            clique.add(node)
    # Try to grow further: any two remaining members linked to everything.
    for node in ordered:
        if node in clique:
            continue
        if all(node in adjacency.get(member, set()) for member in clique):
            clique.add(node)
    return clique


def find_chains(pairs: list[PairEvidence], *,
                min_middle: float = 0.85) -> list[dict]:
    """Triples where A–B and B–C are the same photo but A–C is not.

    This is the case a naive transitive merge gets wrong: A resembles B, B
    resembles C, yet A and C are clearly different pictures.  The middle links
    must be judged the *same photo* (``same_photo``), independent of whether
    the pair is a good merge candidate — a panorama that bridges two
    non-overlapping crops is exactly such a case, and its middle links are
    crops whose shared coverage is too small to merge directly.

    Each triple is reported once.
    """
    by_pair: dict[frozenset[str], PairEvidence] = {}
    for p in pairs:
        by_pair[frozenset((p.a, p.b))] = p

    adjacency: dict[str, set[str]] = {}
    for p in pairs:
        if p.same_photo >= min_middle or p.merge_fit >= 0.80:
            adjacency.setdefault(p.a, set()).add(p.b)
            adjacency.setdefault(p.b, set()).add(p.a)

    chains: list[dict] = []
    emitted: set[frozenset[str]] = set()
    for middle in sorted(adjacency):
        neighbours = sorted(adjacency[middle])
        for i in range(len(neighbours)):
            for j in range(i + 1, len(neighbours)):
                left, right = neighbours[i], neighbours[j]
                triple = frozenset((left, middle, right))
                if len(triple) < 3 or triple in emitted:
                    continue
                end = by_pair.get(frozenset((left, right)))
                if end is None:
                    continue
                # A–C being the same photo means the three are a genuine group.
                if end.same_photo >= 0.50:
                    continue
                left_link = by_pair[frozenset((left, middle))]
                right_link = by_pair[frozenset((middle, right))]
                # The middle must actually bridge both neighbours.  Require at
                # least one of same_photo / merge_fit to be convincing on each
                # side, so unrelated look-alikes cannot form a phantom chain.
                if max(left_link.same_photo, left_link.merge_fit) < 0.55:
                    continue
                if max(right_link.same_photo, right_link.merge_fit) < 0.55:
                    continue
                emitted.add(triple)
                chains.append({
                    "middle": middle,
                    "left": left,
                    "right": right,
                    "left_link": left_link,
                    "right_link": right_link,
                    "end_link": end,
                    "explanation": (
                        f"“{left}” and “{middle}” appear to be the same photo "
                        f"(confidence {left_link.same_photo:.2f}); so do "
                        f"“{middle}” and “{right}” "
                        f"(confidence {right_link.same_photo:.2f}). But “{left}” "
                        f"and “{right}” do not match ({end.relation}, "
                        f"confidence {end.same_photo:.2f}). This is a chain, not "
                        "one group: the middle image may show a wider view that "
                        "contains both. Decide each pair separately instead of "
                        "merging all three."
                    ),
                })
    return chains


# --------------------------------------------------------------- decisions

class DecisionStore:
    """Persistent human decisions, keyed by content with a path fallback.

    Each record stores, for a *pair* of files:

    * the decision (``merge`` or ``exclude``),
    * the SHA-256 of each side at decision time, and
    * the paths involved.

    On rescan, a stored decision applies when both files still have the same
    content — regardless of path, so renames and moves keep the verdict.  When
    a known path now holds different content (``sha256`` mismatch) the decision
    is *not* applied and the pair is surfaced for re-review.
    """

    def __init__(self, path: str):
        self.path = path
        self.records: list[dict] = []
        self.review_flags: list[dict] = []
        self._load()

    @staticmethod
    def pair_key(sha_a: str, sha_b: str) -> str:
        return "|".join(sorted((sha_a, sha_b)))

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, json.JSONDecodeError):
            # A corrupt decision file must not stop a scan; start clean and say so.
            self.review_flags.append({
                "path": self.path,
                "reason": "decision file could not be read; starting with no saved decisions",
            })
            return
        if state.get("version") != STATE_VERSION:
            return
        self.records = list(state.get("decisions", []))

    def save(self) -> None:
        state = {
            "version": STATE_VERSION,
            "decisions": self.records,
        }
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, self.path)

    def record(self, decision: str, a: Photo, b: Photo, note: str = "") -> None:
        assert decision in ("merge", "exclude")
        record = {
            "decision": decision,
            "sha_a": a.sha256,
            "sha_b": b.sha256,
            "path_a": a.abspath,
            "path_b": b.abspath,
            "note": note,
            "key": self.pair_key(a.sha256, b.sha256),
        }
        # Replace an earlier decision for the same content pair.
        self.records = [r for r in self.records if r.get("key") != record["key"]]
        self.records.append(record)

    def lookup(self, a: Photo, b: Photo) -> dict | None:
        key = self.pair_key(a.sha256, b.sha256)
        for record in self.records:
            if record.get("key") == key:
                return record
        return None


def apply_decisions(photos: list[Photo], pairs: list[PairEvidence],
                    store: DecisionStore) -> list[dict]:
    """Annotate pairs with their stored decision and flag stale paths.

    Returns a list of re-review notices.  A notice is raised when a path that
    had a decision on record now holds different content.
    """
    by_abs = {p.abspath: p for p in photos}
    known_paths: dict[str, dict] = {}
    for record in store.records:
        for side in ("a", "b"):
            path = record.get(f"path_{side}")
            digest = record.get(f"sha_{side}")
            if path and digest:
                known_paths.setdefault(path, record)

    notices = []
    for path, record in sorted(known_paths.items()):
        photo = by_abs.get(path)
        digest = record.get("sha_a") if record.get("path_a") == path else record.get("sha_b")
        if photo is None:
            notices.append({
                "path": path,
                "kind": "missing",
                "reason": "a file with a saved decision is no longer present",
            })
        elif photo.error:
            notices.append({
                "path": path,
                "kind": "unreadable",
                "reason": f"saved decision cannot be checked: {photo.error}",
            })
        elif photo.sha256 != digest:
            notices.append({
                "path": path,
                "kind": "content-changed",
                "reason": ("file at a path with a saved decision now has different "
                           "content; the old decision was not applied — please re-review"),
            })

    by_rel = {p.relpath: p for p in photos}
    for pair in pairs:
        a = by_rel.get(pair.a)
        b = by_rel.get(pair.b)
        if a is None or b is None:
            continue
        record = store.lookup(a, b)
        if record is not None:
            pair.reasons.append(f"human decision on record: {record['decision']}")
    return notices
