# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Hats, from one family of profiles: a crown turned on a lathe and a brim
drawn by its outline and its lift.

A hat is a crown (a profile of radius against height, turned) and a brim
(a ring from the crown's foot out to an outline that may vary with the
azimuth, lifted by a curve of its own): a round felt hat is a short crown
and a level brim; a cocked hat a round crown and a brim whose outline is a
triangle with a corner forward, turned up toward the crown; a pinned brim
is lifted on one sector only; a tall crown is drawn taller, a cap has no
brim. The brim has a thickness and may be bound at its edge in another
colour (a cocked hat's tape); a band may go round the crown's foot.

Each hat is seated on the head by landmarks, not by eye: its band fits
the head's section where the crown sits, or the hair's where the hair
stands out further, and nothing floats.

Its UVs are by the lathe: round the crown and the brim by azimuth, up the
profile and out across the brim; the top and the underside are islands
of their own.
"""

import bmesh
import bpy
import numpy as np

import atlas
import body
import landmarks

# A hat's band stands this far off the head: over the hair pressed flat
# under it (hair.make).
EASE = 0.0034


def outline(kind, a, corners=3, round_=0.35):
    """The brim's outline as a share of its width at azimuth a (radians,
    0 the front, turning to the figure's left)."""
    if kind == "round":
        return 1.0
    if kind == "polygon":
        # A polygon of corners with one forward, its corners rounded: d is
        # the azimuth from the middle of the side a is on.
        sector = 2 * np.pi / corners
        d = a % sector - sector / 2
        polygon = np.cos(np.pi / corners) / np.cos(d)
        return polygon * (1 - round_) + round_
    raise ValueError(f"no brim outline {kind!r}")


def cornerness(a, corners=3):
    """1 at a corner of the outline, 0 midway between two."""
    sector = 2 * np.pi / corners
    d = (a + sector / 2) % sector - sector / 2
    return float(np.cos(d * corners / 2) ** 2)


def cocked(width, t, height, lean=0.08):
    """A brim cocked: folded up at the crown so its edge stands height
    above the band all round. Where the brim is narrow (a side's middle)
    the fold stands nearly upright against the crown; where it is wide (a
    corner) it leans out, so the corner points out and up. Returns how far
    out and how far up the point a share t across it goes."""
    s = width * t
    angle = np.arcsin(min(1.0, height / width)) if width > 0 else 0.0
    angle = min(angle, np.pi / 2 - lean)
    return s * np.cos(angle), s * np.sin(angle)


def lift(kind, a, t, height, power=2.0, sector=None):
    """How far the brim at azimuth a, a share t of the way out, is lifted:
    "level", "up" (all round, by a power curve), or "pinned" (one sector,
    centred at sector[0] degrees, sector[1] wide); a cocked brim is
    folded instead (cocked)."""
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


def make(spec, human, marks, arm, over=()):
    """The hat a spec asks for, seated on the head (and over what is in
    over: the hair) and weighted to it. spec's params: crown: [[radius
    share, height], ...] from the band up (the radius a share of the
    band's), brim: {width, outline, corners, round, lift (level, up,
    pinned or cocked), height, power, pull, sector, lean, corner-drop,
    thickness, steps, binding: {colour, width}}, band: {colour, height},
    seat: how far above the brow the band sits, in metres; tilt: how
    far it is tipped forward, in degrees; segments: how many round the
    lathe."""
    p = spec["params"]
    segments = p.get("segments", 32)
    band_z, centre, radius = seat(human, marks, p.get("seat", 0.0), over)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    crown = p["crown"]
    circumference = 2 * np.pi * radius

    def around(r_of, z_of):
        out = []
        for s in range(segments):
            a = 2 * np.pi * s / segments
            r, z = r_of(a), z_of(a)
            out.append(bm.verts.new((centre[0] + r * np.sin(a), centre[1] - r * np.cos(a), band_z + z)))
        return out

    def strip(lower, upper, v0, v1, material=0):
        """Faces between two rings, UVs by azimuth and from v0 to v1."""
        for s in range(segments):
            n = (s + 1) % segments
            f = bm.faces.new((lower[s], lower[n], upper[n], upper[s]))
            f.material_index = material
            u0, u1 = s / segments, (s + 1) / segments
            for lp, c in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
                lp[uv].uv = c

    # The crown, its length up the profile the UVs' v.
    rings = [around(lambda a, s=s: radius * s, lambda a, h=h: h) for s, h in crown]
    lengths = np.concatenate([[0], np.cumsum([np.hypot(radius * (b[0] - a[0]), b[1] - a[1])
                                               for a, b in zip(crown, crown[1:])])])
    for r in range(len(rings) - 1):
        strip(rings[r], rings[r + 1], lengths[r] / circumference, lengths[r + 1] / circumference)
    # The top, closed by a fan, mapped from above.
    top = bm.verts.new((centre[0], centre[1], band_z + crown[-1][1] + 0.002))
    for s in range(segments):
        n = (s + 1) % segments
        f = bm.faces.new((rings[-1][s], rings[-1][n], top))
        for lp in f.loops:
            c = lp.vert.co
            lp[uv].uv = (5 + (c.x - centre[0]) / circumference, (c.y - centre[1]) / circumference)
    brim = p.get("brim")
    if brim:
        _brim(bm, brim, rings[0], radius, segments, strip, around, circumference)
    band = p.get("band")
    if band:
        h = band["height"]
        share = 1 + (crown[1][0] - 1) * h / crown[1][1]
        lo = around(lambda a: radius + 0.0015, lambda a: 0.001)
        hi = around(lambda a: radius * share + 0.0015, lambda a: h)
        strip(lo, hi, 7.0, 7.0 + h / circumference, material=2)
    for f in bm.faces:
        f.smooth = True
    if p.get("tilt"):
        # Worn tipped forward: turned about the band's middle, the front
        # down.
        from mathutils import Matrix, Vector
        pivot = Vector((centre[0], centre[1], band_z))
        turn = Matrix.Translation(pivot) @ Matrix.Rotation(np.radians(p["tilt"]), 4, "X") @ Matrix.Translation(-pivot)
        bmesh.ops.transform(bm, matrix=turn, verts=bm.verts[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(spec["id"])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"], me)
    bpy.context.scene.collection.objects.link(obj)
    colour = atlas.linear(spec["colour"]) if spec["region"] == "fixed" else None
    me.materials.append(atlas.part(bpy.data.materials.new(spec["id"]), colour, spec["region"]))
    binding = (brim or {}).get("binding")
    me.materials.append(atlas.part(bpy.data.materials.new(spec["id"] + "-binding"),
                                   atlas.linear(binding["colour"]) if binding else colour,
                                   "fixed" if binding else spec["region"]))
    me.materials.append(atlas.part(bpy.data.materials.new(spec["id"] + "-band"),
                                   atlas.linear(band["colour"]) if band else colour,
                                   "fixed" if band else spec["region"]))
    _rigid(obj, arm, "head")
    return obj


def _brim(bm, brim, foot, radius, segments, strip, around, circumference):
    """The brim: its top from the crown's foot out to the outline in steps
    lifted by its curve, its edge (bound, if asked), and its underside
    back to the foot, a thickness below."""
    steps = brim.get("steps", 5)
    thick = brim.get("thickness", 0.004)
    bind = (brim.get("binding") or {}).get("width", 0.0)
    corners = brim.get("corners", 3)
    drop = brim.get("corner-drop", 0.0)

    def point(a, t, below=0.0):
        w = brim["width"] * outline(brim.get("outline", "round"), a, corners, brim.get("round", 0.35))
        if brim.get("lift") == "cocked":
            out, up = cocked(w, t, brim["height"] * (1 - drop * cornerness(a, corners)),
                             brim.get("lean", 0.08))
            r = radius + out
        else:
            up = lift(brim.get("lift", "level"), a, t, brim.get("height", 0.0), brim.get("power", 2.0),
                      brim.get("sector"))
            # A brim turned up comes in toward the crown as it rises.
            r = radius + w * t - up * brim.get("pull", 0.0)
        # The underside a thickness below the top, along the brim's own
        # normal: down when it is level, out when it stands.
        slope = np.arctan2(up, max(w * t, 1e-4))
        return r + below * np.sin(slope), up - below * np.cos(slope)

    ts = list(np.linspace(0, 1, steps + 1))
    if bind > 0:
        # The binding's inner edge.
        ts.insert(-1, 1 - bind / brim["width"])
    tops = [foot] + [around(lambda a, t=t: point(a, t)[0], lambda a, t=t: point(a, t)[1]) for t in ts[1:]]
    unders = [around(lambda a, t=t: point(a, t, thick)[0], lambda a, t=t: point(a, t, thick)[1]) for t in ts]
    scale = brim["width"] / circumference
    last = len(ts) - 2
    for k in range(len(ts) - 1):
        strip(tops[k], tops[k + 1], 1 + ts[k] * scale, 1 + ts[k + 1] * scale,
              material=1 if bind > 0 and k == last else 0)
    # The edge.
    strip(tops[-1], unders[-1], 1 + scale, 1 + scale + thick / circumference, material=1 if bind > 0 else 0)
    # The underside, from the outer edge in to the foot, its own island;
    # open at the foot, where it meets the crown inside.
    for k in range(len(ts) - 1, 0, -1):
        strip(unders[k], unders[k - 1], 3 + (1 - ts[k]) * scale, 3 + (1 - ts[k - 1]) * scale,
              material=1 if bind > 0 and k == last + 1 else 0)


def seat(human, marks, above, over=()):
    """Where a hat's band goes: the height above the brow it is asked to sit
    at, the head's middle there, and the radius that clears the head's
    section there, and the hair's, by EASE, so it rests on what is under
    it and nothing floats."""
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
    for obj in over:
        for h in landmarks.Section.of(obj).outlines(z):
            # Only what goes round the head: not a tail hanging apart.
            if np.linalg.norm(h.mean(0) - centre) < 0.05:
                radius = max(radius, float(np.max(np.linalg.norm(h - centre, axis=1))) + EASE)
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
