# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Headscarves: cloth tied tight over the skull, knotted at the back, its
two tails hanging.

The scarf is a grid over the head: rays out from inside the skull, by
azimuth and elevation, find the skin; each point stands off it by the
scarf's volume (over hair pressed flat under it, hair.press). Its lower
edge is a line round the head set on landmarks, never by eye: low on the
forehead at the front, above the ears at the sides, down to the nape at
the back, eased between them; the hem is turned down to the skin there,
so the cloth has an edge. A knot sits on it at the back, at the nape, and
two tails hang from under the knot, flat strips of cloth that widen a
little toward their ends and keep off the neck and back as a queue does
(hair.tail_line); they hang on the spring joints from the head, the scarf
and its knot are on the head.

The same cloth makes a wrap wound high over the head (its rows rising
above the crown and swelling, ridged where it is wound) and a knitted cap
(its brim turned up in a roll, its top drooping over to one side).

Its UVs are by the grid: round the head by azimuth and up it, the crown a
fan mapped from above; the knot and each tail are islands of their own.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import atlas
import body
import hair
import lod
import patterns


def edge(p, marks):
    """The scarf's lower edge: its height at azimuth a (radians, 0 the
    front, turning to the figure's left), from the front's, the side's
    (at a quarter turn) and the back's, eased between them."""
    eyes = (marks.joint("l-eye") + marks.joint("r-eye")) / 2
    neck = marks.joint("neck")
    e = p.get("edge", {})
    front = eyes[2] + e.get("front", 0.045)
    side = eyes[2] + e.get("side", 0.03)
    back = neck[2] + e.get("back", 0.05)

    def at(a):
        c = np.cos(a)
        # Front to side as the cosine falls to 0, side to back beyond.
        if c >= 0:
            t = 1 - c
            return front + (side - front) * t * t * (3 - 2 * t)
        t = -c
        return side + (back - side) * t * t * (3 - 2 * t)

    return at


def band(human, marks, params):
    """Where hair under the scarf is pressed flat from (hair.press): the
    lowest the scarf comes, at the nape, a little lower."""
    at = edge(params, marks)
    return min(at(a) for a in np.linspace(0, 2 * np.pi, 64)) - 0.005, None, None


def _skin_tree(human, skin=None):
    if skin is not None:
        bm = bmesh.new()
        bm.from_mesh(skin.data)
    else:
        bm = bmesh.new()
        bm.from_mesh(human.data)
        on = body.in_group(human, "body")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not on[v.index]], context="VERTS")
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def make(spec, human, marks, arm, skin=None, over=()):
    """The scarf a spec asks for, on the head (and over what is in over:
    the hair pressed under it), skinned. Its params: volume (off the skin,
    metres), edge {front, side, back}, columns, rows, knot {size, up,
    azimuth} or null for none, tails {length: [left, right], width, end,
    thick, spread, lean, clear}, smooth (passes), hem (how far the turned
    hem stands off the skin); a wrap's tall and folds, a knitted cap's
    roll and droop (_tall, _folds, _roll, _droop); a pattern
    (patterns.py)."""
    p = spec["params"]
    columns, rows = p.get("columns", 28), p.get("rows", 8)
    volume = p.get("volume", 0.007)
    at = edge(p, marks)
    # The whole skin to find the head by (the drawn body has holes where
    # the clothes cover it); kept off the drawn skin and what is over it.
    tree = _skin_tree(human)
    extra = [_skin_tree(None, o) for o in [skin, *over] if o is not None]
    head = Vector(marks.joint("head"))
    # Rays from the skull's middle: between the brow and the back of the
    # head, a little above the eyes, so every ray meets the skin squarely.
    eyes = (Vector(marks.joint("l-eye")) + Vector(marks.joint("r-eye"))) / 2
    behind = tree.ray_cast(Vector((0, eyes.y + 0.4, eyes.z + 0.02)), Vector((0, -1, 0)), 0.6)[0]
    before = tree.ray_cast(Vector((0, eyes.y - 0.4, eyes.z + 0.03)), Vector((0, 1, 0)), 0.6)[0]
    centre = Vector((0, (behind.y + before.y) / 2, eyes.z + 0.02))

    def hit(a, e):
        d = Vector((np.sin(a) * np.cos(e), -np.cos(a) * np.cos(e), np.sin(e)))
        loc, n, _, _ = tree.ray_cast(centre, d, 0.4)
        if loc is None:
            return None, None
        return loc, n

    def lowest(a):
        """The elevation at azimuth a where the skin is at the edge's
        height: by bisection, the ray's hit falling with the elevation."""
        z = at(a)
        lo, hi = np.radians(-80), np.radians(80)
        for _ in range(40):
            mid = (lo + hi) / 2
            loc, _ = hit(a, mid)
            # A ray that misses went out through the eyes' or the mouth's
            # opening: below the edge.
            if loc is not None and loc.z > z:
                hi = mid
            else:
                lo = mid
        return hi

    # The grid's rows from the edge up toward the crown, closer together at
    # the edge where the head curves under.
    top = np.radians(p.get("top", 78))
    grid = []
    # Each column's lowest elevation, a column the bisection led astray
    # (a ray grazing the nose's ridge) brought to its neighbours'.
    e0s = np.array([lowest(2 * np.pi * c / columns) for c in range(columns)])
    e0s = np.array([np.median(np.take(e0s, range(c - 2, c + 3), mode="wrap")) for c in range(columns)])
    for c in range(columns):
        a = 2 * np.pi * c / columns
        e0 = e0s[c]
        ring = []
        for r in range(rows + 1):
            t = r / rows
            e = e0 + (top - e0) * (1 - (1 - t) ** 1.4)
            loc, n = hit(a, e)
            ring.append((loc, n))
        grid.append(ring)
    pts = np.array([[tuple(loc + n * volume) for loc, n in col] for col in grid])
    # What sticks out of the skull's round (an ear's rim, the brow's
    # ridge under the edge) is brought back to its neighbours' distance
    # from the middle: the cloth bridges it.
    c0 = np.array(tuple(centre))
    d = pts - c0
    r = np.linalg.norm(d, axis=2)
    unit = d / r[..., None]
    for row in range(rows + 1):
        ring = r[:, row]
        near = np.array([np.median(np.take(ring, range(c - 3, c + 4), mode="wrap")) for c in range(columns)])
        r[:, row] = np.minimum(ring, near + 0.004)
    pts = c0 + unit * r[..., None]
    # The crown's point: straight up.
    loc, n = hit(0.0, np.radians(90))
    crown = np.array(tuple(loc + n * volume))
    if p.get("tall"):
        pts, crown = _tall(pts, crown, c0, p["tall"])
    # Smoothed (the base mesh's bumps out of the cloth), the edge row held,
    # then set back off the skin by at least most of its volume.
    for _ in range(p.get("smooth", 4)):
        new = pts.copy()
        for c in range(columns):
            for r in range(1, rows + 1):
                up = pts[c, r + 1] if r < rows else crown
                nb = [pts[(c - 1) % columns, r], pts[(c + 1) % columns, r], pts[c, r - 1], up]
                new[c, r] = pts[c, r] * 0.5 + np.mean(nb, axis=0) * 0.5
        pts = new

    def off(p3, least):
        v = Vector(p3)
        for t in [tree] + extra:
            loc, n, _, _ = t.find_nearest(v)
            if loc is not None and (v - loc).dot(n) < least:
                v = loc + n * least
        return np.array(tuple(v))

    for c in range(columns):
        for r in range(rows + 1):
            pts[c, r] = off(pts[c, r], volume * 0.85)
    crown = off(crown, volume * 0.85)
    # A knitted cap's brim turned up in a roll, and a wrap's folds where it
    # is wound: on the smoothed cloth.
    if p.get("roll"):
        # A roll shows its edge: a column the bisection led astray at the
        # middle of the brow is brought to its neighbours first.
        pts = _roll(_even(pts), c0, at, columns, p["roll"])
    if p.get("folds"):
        pts = _folds(pts, c0, columns, p["folds"])
    # Its own mirror: the right half's columns mirrored onto the left.
    for c in range(columns):
        m = (columns - c) % columns
        if m <= c:
            continue
        pts[m] = pts[c] * np.array([-1, 1, 1])
    for r in range(rows + 1):
        for c in (0, columns // 2):
            pts[c, r][0] = 0.0
    crown[0] = 0.0

    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    verts = [[bm.verts.new(tuple(pts[c, r])) for r in range(rows + 1)] for c in range(columns)]
    top_v = bm.verts.new(tuple(crown))
    circ = 2 * np.pi * 0.1
    lengths = np.zeros((columns, rows + 1))
    for c in range(columns):
        for r in range(1, rows + 1):
            lengths[c, r] = lengths[c, r - 1] + np.linalg.norm(pts[c, r] - pts[c, r - 1])

    def u_of(c):
        return c / columns

    for c in range(columns):
        n = (c + 1) % columns
        for r in range(rows):
            f = bm.faces.new((verts[c][r], verts[n][r], verts[n][r + 1], verts[c][r + 1]))
            un = u_of(c + 1)
            for lp, (u, v) in zip(f.loops, ((u_of(c), lengths[c, r]), (un, lengths[n, r]),
                                            (un, lengths[n, r + 1]), (u_of(c), lengths[c, r + 1]))):
                lp[uv].uv = (u, v / circ)
        f = bm.faces.new((verts[c][rows], verts[n][rows], top_v))
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = (3 + (co.x - head.x) / circ, (co.y - head.y) / circ)
    # The hem turned down to the skin.
    hem = []
    for c in range(columns):
        loc, n, _, _ = tree.find_nearest(Vector(pts[c, 0]))
        if p.get("roll"):
            # Under a roll, straight in toward the head's middle, so the
            # roll's underside is level.
            d = Vector((pts[c, 0][0] - c0[0], pts[c, 0][1] - c0[1], 0)).normalized()
            hit_ = tree.ray_cast(Vector(pts[c, 0]), -d, 0.1)
            if hit_[0] is not None:
                loc, n = hit_[0], hit_[1]
        # Down to the skin, or to the hair pressed under it.
        hem_off = p.get("hem", 0.0005)
        q = Vector(off(np.array(tuple(loc + n * hem_off)), hem_off))
        if c in (0, columns // 2):
            q.x = 0.0
        hem.append(bm.verts.new(tuple(q)))
    for c in range(columns):
        m = (columns - c) % columns
        if m > c:
            hem[m].co = Vector((-hem[c].co.x, hem[c].co.y, hem[c].co.z))
    for c in range(columns):
        n = (c + 1) % columns
        f = bm.faces.new((hem[c], hem[n], verts[n][0], verts[c][0]))
        for lp, (u, v) in zip(f.loops, ((u_of(c), -0.03), (u_of(c + 1), -0.03), (u_of(c + 1), 0.0), (u_of(c), 0.0))):
            lp[uv].uv = (u, v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # Outward: the crown's fan faces up.
    if top_v.link_faces[0].normal.z < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])

    # The knot, at the back at the nape unless it says (a wrap's is tucked
    # in at the front), standing on the cloth.
    k = p.get("knot", {"size": [0.024, 0.016, 0.02], "up": 0.012})
    shell = BVHTree.FromBMesh(bm)
    knot_at = None
    if k:
        a = np.radians(k.get("azimuth", 180))
        z = at(a) + k.get("up", 0.012)
        out_d = Vector((np.sin(a), -np.cos(a), 0))
        probe = Vector((0, centre.y, z)) + out_d * 0.3
        loc, n, _, _ = shell.ray_cast(probe, -out_d, 0.5)
        if loc is None:
            # The ray passed under the scarf's edge (lifted off loose hair
            # under it): the knot on its nearest point.
            loc = shell.find_nearest(Vector((0, centre.y, z)) + out_d * 0.1)[0]
        if loc is None:
            raise AssertionError("no scarf to knot")
        size = k["size"]
        knot_at = loc + out_d * size[1] * 0.3
        _blob(bm, uv, knot_at, size)
    # A knitted cap's top, drooping over: a soft tapering tube from the
    # crown, rising and falling to one side.
    if p.get("droop"):
        _droop(bm, uv, shell, Vector(tuple(crown)), Vector(tuple(c0)), p["droop"])
    obj = _object(spec, bm)
    on_head = len(obj.data.vertices)

    # The tails: from under the knot, down and a little apart.
    t = p.get("tails")
    paths = []
    if t and knot_at is not None:
        lengths_ = t["length"] if isinstance(t["length"], list) else [t["length"]] * 2
        for sign, length in zip((1, -1), lengths_):
            start = knot_at + Vector((sign * t.get("spread", 0.01), size[1] * 0.1, -size[2] * 0.3))
            q = {"length": length, "lean": t.get("lean", 0.15), "clear": t.get("clear", 0.04)}
            path = hair.tail_line(start, q, tree, float(start.z))
            # Apart as they fall.
            path = [c + Vector((sign * t.get("splay", 0.08) * (c.z - start.z) * -1, 0, 0)) for c in path]
            paths.append(path)
            tail = _strip(spec["id"] + f"-tail-{'l' if sign > 0 else 'r'}", path, t, sign)
            hair.join(obj, tail)
    lod.clean(obj)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    colour = atlas.linear(spec["colour"]) if spec["region"] == "fixed" else None
    mat = atlas.part(bpy.data.materials.new(spec["id"]), colour, spec["region"])
    if p.get("pattern"):
        patterns.paint(mat, p["pattern"])
    obj.data.materials.append(mat)
    # On the head; the tails on the spring joints hanging from it below the
    # knot.
    _weigh(obj, arm, on_head, float(knot_at.z) if knot_at is not None else -1.0)
    return obj


def _weigh(obj, arm, on_head, knot_z):
    """The scarf and its knot on the head; each tail's vertices below the
    knot on the spring joint hanging from the head nearest them in height,
    eased in from the head's over the first few centimetres."""
    springs = [arm.data.bones[f"spring_{i:02d}"] for i in range(1, 5)]
    head = obj.vertex_groups.new(name="head")
    groups = {}
    for v in obj.data.vertices:
        if v.index < on_head or v.co.z >= knot_z:
            head.add([v.index], 1.0, "REPLACE")
            continue
        s = float(np.clip((knot_z - v.co.z) / 0.03, 0, 1))
        nearest = min(springs, key=lambda b: abs((b.head_local.z + b.tail_local.z) / 2 - v.co.z))
        if nearest.name not in groups:
            groups[nearest.name] = obj.vertex_groups.new(name=nearest.name)
        if s < 1:
            head.add([v.index], 1 - s, "REPLACE")
        groups[nearest.name].add([v.index], s, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm


def _object(spec, bm):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(spec["id"])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"], me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _blob(bm, uv, centre, size, rings=5, sides=10):
    """The knot: a sphere flattened to its size, its UVs the sphere's own
    (seamed), moved clear of the scarf's."""
    out = bmesh.ops.create_uvsphere(bm, u_segments=sides, v_segments=rings, radius=1.0, calc_uvs=True)
    for v in out["verts"]:
        v.co = centre + Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    for f in {f for v in out["verts"] for f in v.link_faces}:
        for lp in f.loops:
            lp[uv].uv = (5 + lp[uv].uv.x * 0.6, lp[uv].uv.y * 0.3)


def _strip(name, path, t, sign):
    """A tail: a flat strip of cloth along its line, its width across the
    figure (x), widening toward its end, a thickness through it, its end
    cut square."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    w0, w1 = t.get("width", 0.03), t.get("end", 0.04)
    thick = t.get("thick", 0.005)
    n = len(path)
    rings = []
    for i, c in enumerate(path):
        s = i / max(n - 1, 1)
        ahead = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        side = Vector((1, 0, 0))
        out = side.cross(ahead).normalized()
        if out.y < 0:
            out = -out
        side = ahead.cross(out).normalized() * (1 if side.dot(ahead.cross(out)) > 0 else -1)
        w = (w0 + (w1 - w0) * s) / 2
        # A little turned, as cloth hangs, the outer edge back.
        twist = sign * 0.25 * s
        across = (side * np.cos(twist) + out * np.sin(twist)).normalized()
        through = out
        ring = [bm.verts.new(c + across * x + through * y)
                for x, y in ((-w, -thick / 2), (w, -thick / 2), (w, thick / 2), (-w, thick / 2))]
        rings.append(ring)
    length = sum((b - a).length for a, b in zip(path, path[1:]))
    for r in range(n - 1):
        v0, v1 = r / (n - 1) * length / 0.2, (r + 1) / (n - 1) * length / 0.2
        for j in range(4):
            k = (j + 1) % 4
            f = bm.faces.new((rings[r][j], rings[r][k], rings[r + 1][k], rings[r + 1][j]))
            for lp, (u, v) in zip(f.loops, ((j, v0), (j + 1, v0), (j + 1, v1), (j, v1))):
                lp[uv].uv = (7 + 0.25 * u * (w0 + w1) / 0.2, -v)
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        f = bm.faces.new(list(reversed(ring)) if flip else ring)
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = (9 + co.x * 5, co.y * 5 + (0 if flip else 1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _tall(pts, crown, c0, t):
    """A wrap wound high: from its edge the cloth rises nearly straight,
    swelling a little and leaning back, and rounds over at a top its height
    above the crown. Each column's points go over from the head's shape
    at the edge to the wrap's within the lower third. Its params: height
    (above the crown), swell (a share wider at the top than at the edge),
    back (how far the top leans back), round (the higher, the flatter the
    top), blend (the share of the way up by which it is the wrap's)."""
    columns, n = pts.shape[0], pts.shape[1]
    rows = n - 1
    height, swell, back = t.get("height", 0.06), t.get("swell", 0.1), t.get("back", 0.0)
    k = t.get("round", 3.0)
    top = crown[2] + height
    out = pts.copy()
    for c in range(columns):
        edge = pts[c, 0]
        h0 = np.array([edge[0] - c0[0], edge[1] - c0[1]])
        for r in range(1, rows + 1):
            # Short of the top: the crown's point is the top itself, a
            # little above the last row's, so the top is round, not peaked.
            s = r / (rows + 0.5)
            rho = (1 + swell * s) * (1 - s ** k) ** (1 / k)
            model = np.array([c0[0] + h0[0] * rho, c0[1] + h0[1] * rho + back * s * s,
                              edge[2] + (top - edge[2]) * s ** 0.85])
            w = float(np.clip(s / t.get("blend", 0.35), 0, 1))
            w = w * w * (3 - 2 * w)
            out[c, r] = pts[c, r] * (1 - w) + model * w
    crown = np.array([c0[0], c0[1] + back, top])
    return out, crown


def _even(pts, rows=3, most=0.008):
    """The lowest rows' points that stand more than most off the median
    of their neighbours round the head (two each side), brought to the
    mean of the two beside them."""
    new = pts.copy()
    columns = pts.shape[0]
    for r in range(min(rows, pts.shape[1])):
        for c in range(columns):
            near = np.array([pts[(c + k) % columns, r] for k in (-2, -1, 1, 2)])
            if np.linalg.norm(pts[c, r] - np.median(near, axis=0)) > most:
                new[c, r] = (pts[(c - 1) % columns, r] + pts[(c + 1) % columns, r]) / 2
    return new


def _roll(pts, c0, at, columns, r):
    """A brim turned up in a roll: the rows from the edge up stood out by
    its out, each by its share (rows), rounding back to the cap above."""
    shares, out = r.get("rows", [1.0, 0.85, 0.4]), r.get("out", 0.008)
    new = pts.copy()
    for c in range(columns):
        for row, f in enumerate(shares[:pts.shape[1]]):
            d = pts[c, row] - c0
            d[2] = 0
            d /= max(np.linalg.norm(d), 1e-6)
            new[c, row] = pts[c, row] + d * out * f
    return new


def _folds(pts, c0, columns, f):
    """A wrap's folds where the cloth is wound: ridges round it, rising a
    little as they go round (twist, in rows a turn), stood out by depth,
    between two shares of the way up (from, to)."""
    rows = pts.shape[1] - 1
    count, depth, twist = f.get("count", 3), f.get("depth", 0.004), f.get("twist", 0.0)
    lo, hi = f.get("from", 0.1), f.get("to", 0.85)
    new = pts.copy()
    for c in range(columns):
        # Symmetric about the middle: the twist rises toward the back on
        # both sides.
        a = abs(((c / columns) * 2 + 1) % 2 - 1)
        for r in range(rows + 1):
            s = r / rows
            if s < lo or s > hi:
                continue
            fade = np.sin(np.pi * (s - lo) / (hi - lo))
            ridge = 0.5 + 0.5 * np.cos(2 * np.pi * (count * (s - lo) / (hi - lo) + twist * a))
            d = pts[c, r] - c0
            d[2] = 0
            d /= max(np.linalg.norm(d), 1e-6)
            new[c, r] = pts[c, r] + d * depth * ridge * fade
    return new


def _droop(bm, uv, shell, crown, c0, d):
    """A knitted cap's top drooping over: a soft tube from the crown lying
    over the cap toward an azimuth (degrees, 0 the front, toward the
    figure's left), down to an elevation, standing a little off it in the
    middle where it folds over, tapering from its base to a rounded tip.
    Its params: azimuth, from and down (the elevations it starts at and
    falls to, degrees, seen from the middle of the cap's round), lift (how far it stands off the cap mid-way), radius
    [base, tip], off (how far its tip hangs out beyond the cap, toward the
    azimuth), rings, sides."""
    a = np.radians(d.get("azimuth", 180))
    out = Vector((np.sin(a), -np.cos(a), 0))
    up = Vector((0, 0, 1))
    r0, r1 = d.get("radius", [0.04, 0.014])
    lift = d.get("lift", 0.01)
    down = np.radians(d.get("down", 20))
    start = np.radians(d.get("from", 90))
    rings_n, sides = d.get("rings", 8), d.get("sides", 10)
    # From the middle of the cap's round, under the crown.
    middle = Vector((crown.x, crown.y, (crown.z + c0.z) / 2))
    path, radii = [], []
    for i in range(rings_n + 1):
        t = i / rings_n
        e = start + (down - start) * t
        ray = (out * np.cos(e) + up * np.sin(e)).normalized()
        loc, n, _, _ = shell.ray_cast(middle, ray, 0.5)
        if loc is None:
            raise AssertionError("no cap under its drooping top")
        r = r0 + (r1 - r0) * t ** 0.8
        # Its base sunk in the cap, the rest standing off it.
        path.append(loc + n * (r * (0.3 + 0.4 * min(1.0, 4 * t)) + lift * np.sin(np.pi * t))
                    + out * d.get("off", 0.0) * t ** 1.5)
        radii.append(r)
    rings = []
    for i, c in enumerate(path):
        ahead = (path[min(i + 1, rings_n)] - path[max(i - 1, 0)]).normalized()
        side = ahead.cross(out if abs(ahead.dot(out)) < 0.95 else up).normalized()
        norm = side.cross(ahead).normalized()
        rings.append([bm.verts.new(c + (side * np.cos(2 * np.pi * j / sides) + norm * np.sin(2 * np.pi * j / sides))
                                   * radii[i]) for j in range(sides)])
    for i in range(rings_n):
        for j in range(sides):
            m = (j + 1) % sides
            f = bm.faces.new((rings[i][j], rings[i][m], rings[i + 1][m], rings[i + 1][j]))
            for lp, (u, v) in zip(f.loops, ((j, i), (j + 1, i), (j + 1, i + 1), (j, i + 1))):
                lp[uv].uv = (11 + u / sides, v / rings_n)
    # Both ends rounded off: the base's in the crown, the tip's out.
    for ring, nxt, r, row in ((rings[-1], path[-2], r1, 1), (rings[0], path[1], r0, -1)):
        c = sum((v.co for v in ring), Vector()) / sides
        tip = bm.verts.new(c + (c - nxt).normalized() * r * 0.8)
        for j in range(sides):
            m = (j + 1) % sides
            f = bm.faces.new((ring[j], ring[m], tip))
            for lp, (u, v) in zip(f.loops, ((j, 0), (j + 1, 0), (j + 0.5, 0.2))):
                lp[uv].uv = (11 + u / sides, row + v if row > 0 else row - v)
    # Facing out, as the rest of the cap does.
    faces = list({f for ring in rings for v in ring for f in v.link_faces})
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    mid = path[rings_n // 2]
    f = rings[rings_n // 2][0].link_faces[0]
    if (f.calc_center_median() - mid).dot(f.normal) < 0:
        bmesh.ops.reverse_faces(bm, faces=faces)
