# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Gear: what a sailor carries that is not cloth, placed on the dressed
figure by casting onto it, never by eye.

- spectacles: two round rims before the eyes and a bridge resting on the
  nose, no side arms (bridge spectacles); on the head;
- case: a leather tube slung across the back on a strap from over the
  right shoulder, across the chest and round under the left arm; the strap
  laid on the clothes round the torso (a loop in a tilted plane, cast onto
  them), the tube straight along its back, standing on it; each vertex
  taking the weights of the cloth's nearest, so it moves as the cloth under
  it does;
- dividers: a pair of brass dividers hanging from the strap at the left
  hip, their legs a little apart.

The spectacles and dividers are too fine to see from the deck: they are
props (the deck level leaves them out); the case is seen from far off and
kept at every level. Each is a swatch of its colours: small parts on one
painted patch of the atlas.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import atlas
import body

# How far gear stands off what it lies on.
OFF = 0.0015

# The bones whose cloth a case lies on: the torso's, never the arms'; a
# strap also goes over the right shoulder.
TORSO = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r")
SHOULDER = TORSO + ("upperarm_r",)

# The strap's loop, once a case has laid it: dividers hang from it.
_strap = []


def deck(spec):
    """Whether the deck level keeps the gear."""
    return (spec.get("params") or {}).get("deck", True)


def make(spec, human, marks, arm, worn, skin):
    p = spec.get("params") or {}
    family = spec["family"]
    if family == "spectacles":
        return spectacles(spec, p, marks, arm, skin)
    if family == "case":
        return case(spec, p, marks, arm, worn, skin)
    if family == "dividers":
        return dividers(spec, p, marks, arm, worn, skin)
    raise ValueError(f"{spec['id']}: no gear family {family!r}")


# --- Shared --------------------------------------------------------------


def _materials(obj, spec, colours, metal):
    """One material slot a colour, each a swatch."""
    for i, c in enumerate(colours):
        obj.data.materials.append(atlas.part(bpy.data.materials.new(f"{spec['id']}-{i}"), atlas.linear(c), "fixed",
                                             metal=metal[i], swatch=True))


def _new(name, bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for f in me.polygons:
        f.use_smooth = True
    return obj


def _tube(bm, uv, path, radius, sides=6, closed=False, slot=0, caps=True):
    """A tube round a path (a ring if closed), its radius one value or one
    a point; capped at its ends if open."""
    n = len(path)
    radii = radius if isinstance(radius, (list, tuple, np.ndarray)) else [radius] * n
    rings = []
    for i, c in enumerate(path):
        nxt = path[(i + 1) % n] if closed else path[min(i + 1, n - 1)]
        prv = path[(i - 1) % n] if closed else path[max(i - 1, 0)]
        ahead = (nxt - prv).normalized()
        ref = Vector((0, 0, 1)) if abs(ahead.z) < 0.9 else Vector((1, 0, 0))
        side = ahead.cross(ref).normalized()
        up = side.cross(ahead).normalized()
        rings.append([bm.verts.new(c + (side * np.cos(2 * np.pi * k / sides) + up * np.sin(2 * np.pi * k / sides))
                                   * radii[i]) for k in range(sides)])
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for a, b in pairs:
        for k in range(sides):
            m = (k + 1) % sides
            f = bm.faces.new((a[k], a[m], b[m], b[k]))
            f.material_index = slot
            for lp in f.loops:
                lp[uv].uv = (0.5, 0.5)
    if caps and not closed:
        for ring in (rings[0], rings[-1]):
            f = bm.faces.new(ring)
            f.material_index = slot
            for lp in f.loops:
                lp[uv].uv = (0.5, 0.5)
    return rings


def _host_tree(meshes, bones):
    """A tree of the faces of the meshes most of whose vertices are on the
    bones named (by their heaviest weight), and what each face is of."""
    verts, faces, owner = [], [], []
    for o in meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        best = []
        for v in o.data.vertices:
            ws = [(g.weight, names.get(g.group, "")) for g in v.groups]
            best.append(max(ws)[1] if ws else "")
        ok = np.array([any(b.startswith(x) for x in bones) for b in best])
        co = body.coords(o)
        for f in o.data.polygons:
            idx = list(f.vertices)
            if ok[idx].mean() > 0.5:
                base = len(verts)
                verts.extend(Vector(co[i]) for i in idx)
                faces.append(list(range(base, base + len(idx))))
                owner.append((o, idx[0]))
    return BVHTree.FromPolygons(verts, faces), owner


def _weigh_from(obj, hosts, arm):
    """Each vertex takes the weights of the nearest vertex of the hosts
    (the cloth or skin it lies on)."""
    trees = []
    for h in hosts:
        co = body.coords(h)
        t = KDTree(len(co))
        for i, c in enumerate(co):
            t.insert(c, i)
        t.balance()
        trees.append((h, t, {g.index: g.name for g in h.vertex_groups}))
    groups = {}
    for v in obj.data.vertices:
        h, t, names = min(((h, t, n) for h, t, n in trees), key=lambda x: x[1].find(v.co)[2])
        _, i, _ = t.find(v.co)
        ws = [(names[g.group], g.weight) for g in h.data.vertices[i].groups
              if names[g.group] in arm.data.bones]
        total = sum(w for _, w in ws) or 1.0
        for name, w in ws:
            if name not in groups:
                groups[name] = obj.vertex_groups.new(name=name)
            groups[name].add([v.index], w / total, "REPLACE")
    _skinned(obj, arm)


def _rigid(obj, arm, bone):
    obj.vertex_groups.new(name=bone).add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    _skinned(obj, arm)


def _skinned(obj, arm):
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm


def _skin_tree(skin):
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


# --- Spectacles ----------------------------------------------------------


def spectacles(spec, p, marks, arm, skin):
    """Round rims before the eyes, a bridge over the nose between them."""
    tree = _skin_tree(skin)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    rx, rz = p.get("radius", [0.016, 0.0135])
    wire = p.get("wire", 0.0011)
    out = p.get("out", 0.013)
    down = p.get("down", 0.002)
    eyes = {s: Vector(marks.joint(f"{s}-eye")) for s in ("l", "r")}
    eye_r = p.get("eye", 0.012)
    centres = {}
    for s, e in eyes.items():
        c = e + Vector((p.get("apart", 0.0) * (1 if s == "l" else -1), -(eye_r + out), -down))
        centres[s] = c
        ring = [c + Vector((rx * np.cos(a), 0, rz * np.sin(a))) for a in np.linspace(0, 2 * np.pi, 16, endpoint=False)]
        _tube(bm, uv, ring, wire, sides=4, closed=True)
    # The bridge: from each rim's inner side over the nose, resting on it.
    z = (eyes["l"].z + eyes["r"].z) / 2 + p.get("bridge-up", 0.004)
    hit = tree.ray_cast(Vector((0, -1, z)), Vector((0, 1, 0)), 2.0)[0]
    if hit is None:
        raise AssertionError("no nose under the spectacles' bridge")
    mid = hit + Vector((0, -(wire + 0.0005), 0))
    a = centres["r"] + Vector((rx * 0.97, 0, rz * 0.3))
    b = centres["l"] + Vector((-rx * 0.97, 0, rz * 0.3))
    path = []
    for t in np.linspace(0, 1, 7):
        # A quadratic through the rims' inner sides and the nose's top.
        q = a * (1 - t) ** 2 + (2 * mid - (a + b) / 2) * 2 * t * (1 - t) + b * t ** 2
        path.append(q)
    _tube(bm, uv, path, wire, sides=4)
    obj = _new(spec["id"], bm)
    _materials(obj, spec, [spec.get("colour", "#5A5148")], [True])
    _rigid(obj, arm, "head")
    return obj


# --- The case on its strap -----------------------------------------------


def case(spec, p, marks, arm, worn, skin):
    """The strap round the torso, and the case on the back."""
    meshes = [w.obj for w in worn if w.kind == "garment"] + [skin]
    host, owner = _host_tree(meshes, SHOULDER)
    # The case rests on the clothes alone: the skin at the neck, which it
    # could touch, is buried under the collar.
    torso, _ = _host_tree(meshes[:-1], TORSO)
    m = marks.measure()
    sh = marks.joint("l-shoulder")
    neck = marks.joint("neck")
    s = p.get("strap", {})
    # The loop's plane: through a point on the right shoulder's top, beside
    # the neck, and one at the left side below the waist; upright through
    # the body (front to back).
    top = Vector((-s.get("shoulder", 0.075), neck[1], sh[2] + 0.06))
    low = Vector((s.get("side", 0.2), marks.near(m["heights"]["hip"])[1], m["heights"]["waist"] - s.get("below", 0.04)))
    along = (top - low).normalized()
    normal = along.cross(Vector((0, 1, 0))).normalized()
    across = normal.cross(along).normalized()
    middle = (top + low) / 2
    width = s.get("width", 0.028)
    loop = []
    count = s.get("segments", 40)
    for k in range(count):
        a = 2 * np.pi * k / count
        d = along * np.cos(a) + across * np.sin(a)
        start = middle + d * 0.6
        loc, n, i, _ = host.ray_cast(start, -d, 0.6)
        if loc is None:
            continue
        loop.append((loc + n * OFF, n, owner[i][0]))
    _strap[:] = [(c, n) for c, n, _ in loop]
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    # The strap: a band along the loop, its width across the loop's plane,
    # a thickness off the cloth.
    thick = s.get("thick", 0.003)
    rows = []
    for c, n, _ in loop:
        side = normal * (width / 2)
        rows.append([bm.verts.new(c - side), bm.verts.new(c + side), bm.verts.new(c + side + n * thick),
                     bm.verts.new(c - side + n * thick)])
    for r in range(len(rows)):
        a, b = rows[r], rows[(r + 1) % len(rows)]
        for j in range(4):
            k = (j + 1) % 4
            f = bm.faces.new((a[j], a[k], b[k], b[j]))
            f.material_index = 0
            for lp in f.loops:
                lp[uv].uv = (0.5, 0.5)

    # The case: straight along the strap's back, from below the right
    # shoulder blade to the left side, standing on what is under it.
    c = p.get("tube", {})
    radius = c.get("radius", 0.034)
    back = [(q, n) for q, n, _ in loop if n.y > 0.5]
    if len(back) < 2:
        raise AssertionError("no strap on the back to hang the case on")
    hi = max(back, key=lambda x: x[0].z)[0]
    lo = min(back, key=lambda x: x[0].z)[0]
    axis = (lo - hi).normalized()
    length = c.get("length", 0.5)
    # Its top a little below the strap's top, clear of the neck.
    mid = (hi + lo) / 2 + axis * c.get("down", 0.05)
    ends = [mid - axis * length / 2, mid + axis * length / 2]
    # Out from the back, along the back's own direction there, until its
    # surface is the strap's thickness off the nearest cloth: resting on
    # the back where the back stands furthest out.
    out = sum((n for _, n in back), Vector()).normalized()
    clear = radius + thick + OFF

    def least(shift):
        return min(torso.find_nearest(ends[0].lerp(ends[1], t) + out * shift)[3] for t in np.linspace(0, 1, 41))

    # The shift out at which its nearest approach is the clearance, by
    # bisection (the nearest grows as it goes out).
    lo_s, hi_s = -0.1, 0.3
    for _ in range(40):
        mid_s = (lo_s + hi_s) / 2
        if least(mid_s) < clear:
            lo_s = mid_s
        else:
            hi_s = mid_s
    ends = [e + out * hi_s for e in ends]
    path = [ends[0].lerp(ends[1], t) for t in np.linspace(0, 1, 6)]
    cap = c.get("cap", 0.06)
    # Its two caps a little wider than the leather between them.
    r = [radius * 1.08, radius * 1.08, radius, radius, radius * 1.08, radius * 1.08]
    path = [ends[0], ends[0] + axis * cap, ends[0] + axis * (cap + 0.004), ends[1] - axis * (cap + 0.004),
            ends[1] - axis * cap, ends[1]]
    rings = _tube(bm, uv, path, r, sides=c.get("sides", 12), slot=1)
    for f in bm.faces:
        if f.material_index == 1:
            # The caps' faces in their own colour.
            mid_z = sum((v.co for v in f.verts), Vector()) / len(f.verts)
            t = (mid_z - ends[0]).dot(axis) / length
            if t < cap / length or t > 1 - cap / length:
                f.material_index = 2
    tube_from = len(rows) * 4
    # The leather tabs that fasten the strap to the case's two caps: each
    # from the cap's ring nearest the strap to the strap's face under it.
    tab_from = len(bm.verts)
    for ring in (rings[1], rings[-2]):
        centre = sum((v.co for v in ring), Vector()) / len(ring)
        row = min(rows, key=lambda rw: ((rw[2].co + rw[3].co) / 2 - centre).length)
        k = min(range(len(ring)), key=lambda i: (ring[i].co - (row[2].co + row[3].co) / 2).length)
        a, b = ring[k].co.copy(), ring[(k + 1) % len(ring)].co.copy()
        quad = [bm.verts.new(a), bm.verts.new(b), bm.verts.new(row[2].co.copy()), bm.verts.new(row[3].co.copy())]
        f = bm.faces.new(quad)
        f.material_index = 0
        for lp in f.loops:
            lp[uv].uv = (0.5, 0.5)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [colours.get("strap", "#3B2A1E"), spec.get("colour", "#6B4428"),
                           colours.get("caps", "#3A2618")], [False, False, False])
    _weigh_from(obj, [h for h in {o for _, _, o in loop}], arm)
    # The case itself is stiff: on the chest's bone at its top and the
    # waist's at its bottom, eased between them along its length.
    top, bottom = ends[0], ends[1]
    for v in obj.data.vertices[tube_from:tab_from]:
        t = float(np.clip((v.co - top).dot(axis) / length, 0, 1))
        for g in list(v.groups):
            obj.vertex_groups[g.group].remove([v.index])
        for bone, w in (("spine_03", 1 - t), ("spine_01", t)):
            if w > 0:
                group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
                group.add([v.index], w, "REPLACE")
    return obj


# --- Dividers ------------------------------------------------------------


def dividers(spec, p, marks, arm, worn, skin):
    """A pair of dividers hanging from the strap at the left side: two
    tapering legs from a round head, a little apart."""
    if not _strap:
        raise AssertionError("dividers hang from a case's strap: make the case first")
    left = [(c, n) for c, n in _strap if c.x > 0.1]
    c, n = min(left, key=lambda x: x[0].z)
    length = p.get("length", 0.11)
    apart = np.radians(p.get("apart", 14))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    head = c + n * (0.006 + OFF)
    down = Vector((0, 0, -1))
    side = n.cross(down).normalized()
    _tube(bm, uv, [head - side * 0.005, head + side * 0.005], 0.0055, sides=8)
    for sign in (1, -1):
        d = (down * np.cos(apart / 2) + side * sign * np.sin(apart / 2)).normalized()
        path = [head + d * (0.004 + length * t) for t in np.linspace(0, 1, 4)]
        _tube(bm, uv, path, [0.0022, 0.0018, 0.0012, 0.0004], sides=4)
    obj = _new(spec["id"], bm)
    _materials(obj, spec, [spec.get("colour", "#B9934E")], [True])
    meshes = [w.obj for w in worn if w.kind in ("garment", "gear")]
    _weigh_from(obj, meshes, arm)
    return obj
