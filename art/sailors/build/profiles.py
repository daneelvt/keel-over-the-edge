# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Hats, from one family of profiles: a crown turned on a lathe and a brim
drawn by its outline and its lift.

A hat is a crown (a profile of radius against height, turned) and a brim
(a ring from the crown's foot out to an outline that may vary with the
azimuth, lifted by a curve of its own): a round felt hat is a short crown
and a level brim; a cocked hat a round crown and a brim whose outline is a
triangle with a corner forward, turned up to the crown; a pinned brim is
lifted on one sector only; a tall crown is drawn taller, a cap has no
brim. Each hat is seated on the head by landmarks, not by eye: its band
fits the head's section where the crown sits, and nothing floats.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import body
import landmarks

# A hat's band stands this far off the head.
EASE = 0.004


def outline(kind, a, corners=3, round_=0.35):
    """The brim's outline as a share of its width at azimuth a (radians,
    0 the front, turning to the figure's left)."""
    if kind == "round":
        return 1.0
    if kind == "polygon":
        # A polygon of corners with one forward, its corners rounded.
        sector = 2 * np.pi / corners
        d = (a + sector / 2) % sector - sector / 2
        polygon = np.cos(np.pi / corners) / np.cos(d)
        return polygon * (1 - round_) + round_
    raise ValueError(f"no brim outline {kind!r}")


def lift(kind, a, t, height, power=2.0, sector=None):
    """How far the brim at azimuth a, a share t of the way out, is lifted:
    "level", "up" (all round, by a power curve: a cocked hat's), or
    "pinned" (one sector, centred at sector[0] degrees, sector[1] wide)."""
    if kind == "level":
        return 0.0
    if kind == "up":
        return height * t ** power
    if kind == "pinned":
        centre, width = np.radians(sector[0]), np.radians(sector[1])
        d = abs((a - centre + np.pi) % (2 * np.pi) - np.pi)
        share = max(0.0, np.cos(np.pi * min(d / width, 0.5)))
        return height * t ** power * share
    raise ValueError(f"no brim lift {kind!r}")


def make(spec, human, marks, arm, segments=24):
    """The hat a spec asks for, seated on the head and weighted to it.
    spec's params: crown: [[radius share, height], ...] from the band up
    (the radius a share of the band's), brim: {width, outline, lift,
    height, power, sector, corners}, seat: how far above the brow the
    band sits, in metres."""
    p = spec["params"]
    band_z, centre, radius = seat(human, marks, p.get("seat", 0.0))
    bm = bmesh.new()
    rings = []
    for share, h in p["crown"]:
        ring = []
        for s in range(segments):
            a = 2 * np.pi * s / segments
            ring.append(bm.verts.new((centre[0] + radius * share * np.sin(a),
                                      centre[1] - radius * share * np.cos(a), band_z + h)))
        rings.append(ring)
    for r in range(len(rings) - 1):
        for s in range(segments):
            n = (s + 1) % segments
            bm.faces.new((rings[r][s], rings[r][n], rings[r + 1][n], rings[r + 1][s]))
    # The crown's top closed by a fan.
    top = bm.verts.new((centre[0], centre[1], band_z + p["crown"][-1][1]))
    for s in range(segments):
        bm.faces.new((rings[-1][s], rings[-1][(s + 1) % segments], top))
    brim = p.get("brim")
    if brim:
        foot = rings[0]
        outer = []
        for s in range(segments):
            a = 2 * np.pi * s / segments
            w = brim["width"] * outline(brim.get("outline", "round"), a, brim.get("corners", 3), brim.get("round", 0.35))
            up = lift(brim.get("lift", "level"), a, 1.0, brim.get("height", 0.0), brim.get("power", 2.0),
                      brim.get("sector"))
            # A brim turned up comes in toward the crown as it rises.
            r = radius + w - up * brim.get("pull", 0.0)
            outer.append(bm.verts.new((centre[0] + r * np.sin(a), centre[1] - r * np.cos(a), band_z + up)))
        for s in range(segments):
            n = (s + 1) % segments
            bm.faces.new((foot[n], foot[s], outer[s], outer[n]))
        # A brim has two sides: turned under by its thickness.
        under = [bm.verts.new(v.co - Vector((0, 0, brim.get("thickness", 0.004)))) for v in outer]
        for s in range(segments):
            n = (s + 1) % segments
            bm.faces.new((outer[n], outer[s], under[s], under[n]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(spec["id"])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"], me)
    bpy.context.scene.collection.objects.link(obj)
    _rigid(obj, arm, "head")
    return obj


def seat(human, marks, above):
    """Where a hat's band goes: the height above the brow it is asked to sit
    at, the head's middle there, and the radius that clears the head's
    section there by EASE, so it rests on the head and nothing floats."""
    co = body.coords(human)
    eyes = (marks.joint("l-eye") + marks.joint("r-eye")) / 2
    head = co[body.in_group(human, "body") & (co[:, 2] > eyes[2])]
    z = eyes[2] + 0.03 + above
    mesh = landmarks.Section.of(human, body.in_group(human, "body"))
    o = mesh.outline(z, (0.0, float(marks.joint("head")[1])))
    if len(o) == 0:
        raise AssertionError("no head's section at the hat's band")
    centre = o.mean(0)
    radius = float(np.max(np.linalg.norm(o - centre, axis=1))) + EASE
    if z > head[:, 2].max():
        raise AssertionError("the hat's band is above the crown of the head")
    return z, centre, radius


def _rigid(obj, arm, bone):
    """Weights every vertex of obj wholly to one bone and skins it."""
    g = obj.vertex_groups.new(name=bone)
    g.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
