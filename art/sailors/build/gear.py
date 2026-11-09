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
  hip, their legs a little apart;
- sash: a wide band of cloth wound round the waist over the clothes,
  knotted at one hip, its two long ends hanging from the knot down the
  side of the thigh, fringed; laid on the clothes as the strap is, and
  moving as the cloth under it does. Without a knot or ends, and with a
  buckle at the front, it is a belt;
- earrings: a ring through each ear's lobe, hanging below it; on the head;
- book: a small book in a leather cover tucked under a belt at one side
  of the front, standing up out of it;
- bib: an apron's bib, a panel of leather over the front of the chest
  from the waist up, spanning the hollows under it as leather does, and
  its strap from its top corners round the back of the neck;
- mallet: a wooden mallet, its handle down the hip outside the belt and
  its head resting on the belt's top;
- pencil: a pencil behind one ear, along the side of the head; on the
  head.
- harness: a trapeze harness, worn only on a boat sailed from the
  trapeze: a broad leather belt round the clothes at the waist, under a
  coat's or an apron's (between what is under it and what is over it, by
  rays in toward the middle), and a bronze hook standing out from its front
  clear of everything, which the wire's ring hangs on. It is not in the
  atlas: its own two materials, leather and bronze, in a file of its own.

The spectacles, dividers, earrings, book and pencil are too fine to see
from the deck: they are props (the deck level leaves them out); the case is seen from far off and
kept at every level, and so is a sash. Each is a swatch of its colours:
small parts on one painted patch of the atlas.
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

# A belt's outer face, once a sash has laid it: a book is tucked under it.
_belt = []


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
    if family == "sash":
        return sash(spec, p, marks, arm, worn, skin)
    if family == "earrings":
        return earrings(spec, p, marks, arm, skin)
    if family == "book":
        return book(spec, p, marks, arm, worn, skin)
    if family == "bib":
        return bib(spec, p, marks, arm, worn, skin)
    if family == "mallet":
        return mallet(spec, p, marks, arm, worn, skin)
    if family == "pencil":
        return pencil(spec, p, marks, arm, skin)
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


def _weigh_from(obj, hosts, arm, at=None):
    """Each vertex takes the weights of the nearest vertex of the hosts
    (the cloth or skin it lies on); or, given a point at, every vertex the
    weights of the hosts' nearest to it (a stiff thing)."""
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
        q = v.co if at is None else at
        h, t, names = min(((h, t, n) for h, t, n in trees), key=lambda x: x[1].find(q)[2])
        _, i, _ = t.find(q)
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


# --- The sash ------------------------------------------------------------


def sash(spec, p, marks, arm, worn, skin):
    """A band round the waist, a knot at one hip and two ends hanging from
    it. Its params: width (the band's), up (its middle above the waist),
    thick, columns, knot {azimuth (degrees from the front, toward the
    figure's left), size [across, out, up]}, ends {length [one, the
    other], width, apart (each end's azimuth from the knot's, degrees),
    fringe (its length)}, colours {fringe}."""
    garments = [w.obj for w in worn if w.kind == "garment"]
    # What the band and the ends lie on: the torso's cloth and the skirts'
    # and the thighs' below it, never the arms' beside it.
    waist, _ = _host_tree(garments + [skin], TORSO + ("skirt",))
    legs, _ = _host_tree(garments + [skin], TORSO + ("skirt", "thigh"))
    m = marks.measure()
    width = p.get("width", 0.1)
    thick = p.get("thick", 0.004)
    columns = p.get("columns", 28)
    mid_z = m["heights"]["waist"] + p.get("up", 0.0)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)

    def face(vs, slot=0):
        f = bm.faces.new(vs)
        f.material_index = slot
        for lp in f.loops:
            lp[uv].uv = (0.5, 0.5)
        return f

    def outward(z, a):
        return Vector((np.sin(a), -np.cos(a), 0.0))

    # The band: rows round the waist, each the clothes' outline at its
    # height (by rays in toward the middle), the band a thickness out from
    # it, closed at its top and bottom edges.
    rows = p.get("rows", 3)
    inner = []
    for r in range(rows):
        z = mid_z - width / 2 + width * r / (rows - 1)
        near = Vector((0.0, marks.near(z)[1], z))
        ring_in = []
        for k in range(columns):
            a = 2 * np.pi * k / columns
            d = outward(z, a)
            loc = None
            # Below the waist the cloth may be the thighs'; and a ray down
            # an edge between two faces may find neither: a hair beside it.
            for tree in (waist, legs):
                for dz in (0.0, 0.002, -0.002):
                    if loc is None:
                        loc = tree.ray_cast(near + d * 0.6 + Vector((0, 0, dz)), -d, 0.6)[0]
            if loc is not None:
                loc = loc.copy()
                loc.z = z
            # A row that finds nothing takes the other rows' distance out.
            ring_in.append(loc)
        inner.append(ring_in)
    # Each column its widest row's distance out, so the band stands
    # straight up and down, as a wound band does over what bulges under it;
    # a column that found nothing in any row, its neighbours'.
    outs = []
    for k in range(columns):
        d = outward(0, 2 * np.pi * k / columns)
        found = [(inner[r][k] - Vector((0, marks.near(inner[r][k].z)[1], inner[r][k].z))).dot(d)
                 for r in range(rows) if inner[r][k] is not None]
        outs.append(max(found) if found else None)
    if all(o is None for o in outs):
        raise AssertionError("no clothes under the sash")
    for k in range(columns):
        if outs[k] is None:
            k0 = next(j for j in range(1, columns) if outs[(k - j) % columns] is not None)
            k1 = next(j for j in range(1, columns) if outs[(k + j) % columns] is not None)
            outs[k] = (outs[(k - k0) % columns] * k1 + outs[(k + k1) % columns] * k0) / (k0 + k1)
    outer = []
    for r in range(rows):
        z = mid_z - width / 2 + width * r / (rows - 1)
        c = Vector((0, marks.near(z)[1], z))
        inner[r] = [c + outward(0, 2 * np.pi * k / columns) * (outs[k] + OFF) for k in range(columns)]
        outer.append([c + outward(0, 2 * np.pi * k / columns) * (outs[k] + OFF + thick) for k in range(columns)])
    vin = [[bm.verts.new(c) for c in ring] for ring in inner]
    vout = [[bm.verts.new(c) for c in ring] for ring in outer]
    for r in range(rows - 1):
        for k in range(columns):
            n = (k + 1) % columns
            face((vout[r][k], vout[r][n], vout[r + 1][n], vout[r + 1][k]))
            face((vin[r][n], vin[r][k], vin[r + 1][k], vin[r + 1][n]))
    for k in range(columns):
        n = (k + 1) % columns
        face((vin[0][k], vin[0][n], vout[0][n], vout[0][k]))
        face((vout[-1][k], vout[-1][n], vin[-1][n], vin[-1][k]))

    # Where a book may be tucked under it: its outer face.
    _belt[:] = [outer, mid_z, width, thick, columns]
    obj = None
    if p.get("buckle"):
        # A belt's buckle at the front: a square frame on the band.
        b = p["buckle"]
        bw, bh, wire = b.get("width", 0.04), b.get("height", 0.035), b.get("wire", 0.003)
        front = (outer[0][0] + outer[-1][0]) / 2 + Vector((0, -(wire + OFF), 0))
        frame = [front + Vector((x, 0, z)) for x, z in ((-bw / 2, -bh / 2), (bw / 2, -bh / 2), (bw / 2, bh / 2),
                                                        (-bw / 2, bh / 2))]
        ring = []
        for i in range(4):
            a, c = frame[i], frame[(i + 1) % 4]
            ring += [a.lerp(c, t) for t in (0.0, 0.5)]
        _tube(bm, uv, ring, wire, sides=4, closed=True, slot=2)
    kp = p.get("knot", {})
    if kp is None:
        # No knot, and no ends: a belt.
        obj = _new(spec["id"], bm)
        colours = p.get("colours", {})
        _materials(obj, spec, [spec.get("colour", "#3B2A1E"), colours.get("fringe", "#C8A24A"),
                               colours.get("buckle", "#B9A06A")], [False, False, True])
        _weigh_from(obj, garments + [skin], arm)
        return obj
    # The knot, on the band at its azimuth.
    a0 = np.radians(kp.get("azimuth", 100))
    d0 = outward(0, a0)
    size = kp.get("size", [0.05, 0.03, 0.055])
    k_at = min(range(columns), key=lambda k: abs(((2 * np.pi * k / columns - a0 + np.pi) % (2 * np.pi)) - np.pi))
    surface = (outer[rows // 2][k_at] + outer[rows // 2 - 1][k_at]) / 2
    centre = surface + d0 * (size[1] * 0.35) + Vector((0, 0, -width * 0.15))
    across = Vector((0, 0, 1)).cross(d0).normalized()
    blob = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=1.0)
    for v in blob["verts"]:
        c = v.co.copy()
        v.co = centre + across * (c.x * size[0] / 2) + d0 * (c.y * size[1] / 2) + Vector((0, 0, c.z * size[2] / 2))
    for f in {f for v in blob["verts"] for f in v.link_faces}:
        f.material_index = 0
        for lp in f.loops:
            lp[uv].uv = (0.5, 0.5)

    # The ends: from inside the knot down the side of the thigh, each a
    # flat strip of cloth a thickness thick, kept off what is under it.
    e = p.get("ends", {})
    lengths = e.get("length", [0.38, 0.32])
    ew = e.get("width", 0.08)
    fringe = e.get("fringe", 0.03)
    apart = np.radians(e.get("apart", 9))
    step = 0.02
    ends_from = len(bm.verts)
    top = centre.z - size[2] * 0.2
    for i, length in enumerate(lengths):
        a = a0 + apart * (1 if i == 0 else -1)
        d = outward(0, a)
        pos = centre - Vector((0, 0, size[2] * 0.2)) + d * (-size[1] * 0.1)
        path = [pos.copy()]
        walked = 0.0
        while walked < length:
            pos = pos + Vector((0, 0, -1)) * step
            loc, n, _, dist = legs.find_nearest(pos)
            if loc is not None:
                # Off the cloth by the thickness and half again: out from
                # its surface, along the side the end hangs on.
                side = (pos - loc)
                side.z = 0
                if side.length < 1e-6 or side.dot(d) < 0:
                    side = d.copy()
                side.normalize()
                want = OFF + thick
                if (pos - loc).dot(side) < want:
                    pos = loc + side * want
            path.append(pos.copy())
            walked += step
        rings = []
        for j, c in enumerate(path):
            t = j / (len(path) - 1)
            ahead = (path[min(j + 1, len(path) - 1)] - path[max(j - 1, 0)]).normalized()
            w = ew * (0.7 + 0.3 * min(1.0, t * 3))
            # Across the strip: level, along the surface it hangs on.
            flat = ahead.cross(d).normalized()
            if flat.length < 1e-6:
                flat = across
            norm = flat.cross(ahead).normalized()
            if norm.dot(d) < 0:
                norm = -norm
            rings.append([bm.verts.new(c - flat * w / 2), bm.verts.new(c + flat * w / 2),
                          bm.verts.new(c + flat * w / 2 + norm * thick), bm.verts.new(c - flat * w / 2 + norm * thick)])
        total = (len(path) - 1) * step
        for j in range(len(rings) - 1):
            slot = 1 if (j + 0.5) * step > total - fringe else 0
            for q in range(4):
                r_ = (q + 1) % 4
                face((rings[j][q], rings[j][r_], rings[j + 1][r_], rings[j + 1][q]), slot)
        face(rings[0][::-1])
        face(rings[-1], 1)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [spec.get("colour", "#A3243A"), colours.get("fringe", "#C8A24A")]
               + ([colours.get("buckle", "#B9A06A")] if p.get("buckle") else []),
               [False, False] + ([True] if p.get("buckle") else []))
    _weigh_from(obj, garments + [skin], arm)
    _hang_on_chains(obj, arm, range(ends_from, len(obj.data.vertices)), top)
    return obj


def _hang_on_chains(obj, arm, vertices, top, over=0.06):
    """What hangs below top goes over, in its first over metres, from the
    weights of what it lies on to the skirt chains' about it (the two
    nearest by azimuth, the upper bone then the lower): it swings as a
    coat's skirt does, and lies on the seat as one does."""
    chains = {b.name[:-3]: b for b in arm.data.bones if b.name.startswith("skirt_") and b.name.endswith("_01")}
    azimuth = {n: np.arctan2(b.head_local.x, -b.head_local.y) for n, b in chains.items()}

    def apart(a, b):
        return abs(((a - b + np.pi) % (2 * np.pi)) - np.pi)

    names = {g.index: g.name for g in obj.vertex_groups}
    for i in vertices:
        v = obj.data.vertices[i]
        t = float(np.clip((top - v.co.z) / over, 0, 1))
        if t <= 0:
            continue
        a = np.arctan2(v.co.x, -v.co.y)
        near = sorted(azimuth, key=lambda n: apart(a, azimuth[n]))[:2]
        d = [apart(a, azimuth[n]) ** 3 for n in near]
        share = [d[1] / (d[0] + d[1] + 1e-12), d[0] / (d[0] + d[1] + 1e-12)]
        first = arm.data.bones[near[0] + "_01"]
        lower = float(np.clip((first.head_local.z - v.co.z) / max(first.length, 1e-3) - 0.5, 0, 1))
        want = {}
        for g in v.groups:
            want[names[g.group]] = want.get(names[g.group], 0.0) + g.weight * (1 - t)
        for n, w in zip(near, share):
            want[n + "_01"] = want.get(n + "_01", 0.0) + t * w * (1 - lower)
            want[n + "_02"] = want.get(n + "_02", 0.0) + t * w * lower
        for g in list(v.groups):
            obj.vertex_groups[g.group].remove([i])
        for name, w in want.items():
            if w <= 0:
                continue
            group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
            names[group.index] = name
            group.add([i], w, "REPLACE")


# --- Earrings ------------------------------------------------------------


def _lobe(skin, marks):
    """Where a ring goes through the left ear's lobe: a little above the
    ear's lowest point, half way through it. The ear is what stands out
    from the side of the head behind the eye, between the jaw and the
    temple; its lobe its lowest part."""
    co = body.coords(skin)
    eye = marks.joint("l-eye")
    band = co[(co[:, 0] > 0) & (co[:, 1] > eye[1] + 0.03) & (co[:, 1] < eye[1] + 0.16)
              & (co[:, 2] > eye[2] - 0.08) & (co[:, 2] < eye[2] + 0.02)]
    if not len(band):
        raise AssertionError("no ear beside the head")
    ear = band[band[:, 0] > band[:, 0].max() - 0.012]
    low = ear[ear[:, 2].argmin()]
    # Half way through the lobe: the skin's nearest across it, inward.
    near = band[(np.abs(band[:, 2] - low[2]) < 0.006) & (np.abs(band[:, 1] - low[1]) < 0.008)]
    inner = float(near[:, 0].min()) if len(near) else low[0] - 0.006
    return Vector(((low[0] + max(inner, low[0] - 0.008)) / 2, low[1] - 0.001, low[2] + 0.005))


def earrings(spec, p, marks, arm, skin):
    """A ring through each lobe, hanging below it in the plane of the side
    of the head: a hoop, or a small ring. Its params: radius, wire."""
    radius, wire = p.get("radius", 0.01), p.get("wire", 0.0012)
    at = _lobe(skin, marks)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    for sign in (1, -1):
        top = Vector((at.x * sign, at.y, at.z))
        centre = top - Vector((0, 0, radius))
        ring = [centre + Vector((0, radius * np.sin(a), radius * np.cos(a)))
                for a in np.linspace(0, 2 * np.pi, p.get("segments", 14), endpoint=False)]
        _tube(bm, uv, ring, wire, sides=4, closed=True)
    obj = _new(spec["id"], bm)
    _materials(obj, spec, [spec.get("colour", "#C9A65A")], [True])
    _rigid(obj, arm, "head")
    return obj


# --- A tally book --------------------------------------------------------


def book(spec, p, marks, arm, worn, skin):
    """A small book standing in the belt at an azimuth (degrees from the
    front, toward the figure's left), its back to the cloth under the belt
    and the belt across its lower half: its leather cover in its colour,
    the pages' edges showing at the top and the fore-edge. Its params:
    azimuth, size [across, up, thick], up (its middle above the belt's)."""
    if not _belt:
        raise AssertionError("a book is tucked in a belt: make the belt first")
    outer, mid_z, width, thick, columns = _belt
    a = np.radians(p.get("azimuth", 35))
    across_, up_, th = p.get("size", [0.07, 0.1, 0.016])
    k = min(range(columns), key=lambda i: abs(((2 * np.pi * i / columns - a + np.pi) % (2 * np.pi)) - np.pi))
    rows = len(outer)
    surface = sum((outer[r][k] for r in range(rows)), Vector()) / rows
    # The band's own direction round the waist there, and out from it.
    along = (outer[rows // 2][(k + 1) % columns] - outer[rows // 2][(k - 1) % columns]).normalized()
    out = Vector((0, 0, 1)).cross(along).normalized()
    if out.dot(Vector((np.sin(a), -np.cos(a), 0))) < 0:
        out = -out
    # Its back on the belt's outer face, a little into it, so its corners
    # touch where the belt curves away round the waist under its flat back.
    centre = surface + out * (th / 2 - p.get("into", 0.003)) + Vector((0, 0, p.get("up", 0.03)))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    up = Vector((0, 0, 1))
    corners = {}
    for i in (-1, 1):
        for j in (-1, 1):
            for m in (-1, 1):
                corners[i, j, m] = bm.verts.new(centre + along * (i * across_ / 2) + up * (j * up_ / 2)
                                                + out * (m * th / 2))
    c = corners
    # The spine toward the front (-x side of along, nearer the middle).
    spine = -1 if (centre + along * 0.01).length > (centre - along * 0.01).length else 1
    quads = [
        ((c[-1, -1, 1], c[1, -1, 1], c[1, 1, 1], c[-1, 1, 1]), 0),     # the cover, out
        ((c[1, -1, -1], c[-1, -1, -1], c[-1, 1, -1], c[1, 1, -1]), 0),  # the back cover
        ((c[-1, 1, -1], c[-1, 1, 1], c[1, 1, 1], c[1, 1, -1]), 1),      # the pages' top
        ((c[1, -1, -1], c[1, -1, 1], c[-1, -1, 1], c[-1, -1, -1]), 1),  # the bottom
        ((c[spine, -1, -1], c[spine, 1, -1], c[spine, 1, 1], c[spine, -1, 1]), 0),     # the spine
        ((c[-spine, -1, 1], c[-spine, 1, 1], c[-spine, 1, -1], c[-spine, -1, -1]), 1),  # the fore-edge
    ]
    for vs, slot in quads:
        f = bm.faces.new(vs)
        f.material_index = slot
        for lp in f.loops:
            lp[uv].uv = (0.5, 0.5)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [spec.get("colour", "#4A3020"), colours.get("pages", "#E8DFC8")], [False, False])
    # Stiff: every corner on the weights of the belt's nearest point to its
    # middle.
    belt = [w.obj for w in worn if w.kind == "gear" and w.spec["family"] == "sash"]
    _weigh_from(obj, belt or [w.obj for w in worn if w.kind == "garment"], arm, at=centre)
    return obj


# --- An apron's bib ------------------------------------------------------


def _front_hull(xs, ys):
    """The front-most convex envelope of a row of points (x, y, -y
    forward): the line a stiff panel laid across them takes, spanning the
    hollows between what stands out. Returns y at each x."""
    pts = sorted(zip(xs, ys))
    hull = []
    for q in pts:
        # Keep the hull convex toward -y.
        while len(hull) >= 2:
            (x1, y1), (x2, y2) = hull[-2], hull[-1]
            if (x2 - x1) * (q[1] - y1) - (y2 - y1) * (q[0] - x1) <= 0:
                hull.pop()
            else:
                break
        hull.append(q)
    hx, hy = zip(*hull)
    return np.interp(xs, hx, hy)


def bib(spec, p, marks, arm, worn, skin):
    """The bib: a grid over the front of the chest, its rows cast onto the
    clothes from the front and laid across what stands out (_front_hull),
    a thickness of leather, from below the waist (under the ties) up to
    top metres above the bust's apex; narrower at its top (width: [top,
    bottom]). Its strap (strap: {width, thick, neck, back}) from the top
    corners up over the shoulders beside the neck and round the back of
    the neck, laid on what is under it."""
    # What it lies on and moves with: the torso's clothes, not a skirt's
    # (an apron's, hanging from under it, swings).
    garments = [w.obj for w in worn if w.kind == "garment" and not (w.spec.get("params") or {}).get("skirt")]
    host, owner = _host_tree(garments + [skin], TORSO)
    m = marks.measure()
    bust_z = marks.bust()[0]
    lo = m["heights"]["waist"] - p.get("below", 0.02)
    hi = bust_z + p.get("top", 0.07)
    w_top, w_bottom = p.get("width", [0.22, 0.3])
    thick = p.get("thick", 0.003)
    cols, rows = p.get("columns", 9), p.get("rows", 8)
    grid = []
    for r in range(rows + 1):
        z = lo + (hi - lo) * r / rows
        half = (w_bottom + (w_top - w_bottom) * r / rows) / 2
        xs = [-half + 2 * half * c / cols for c in range(cols + 1)]
        ys = []
        for x in xs:
            loc = host.ray_cast(Vector((x, -0.6, z)), Vector((0, 1, 0)), 1.2)[0]
            ys.append(loc.y if loc is not None else None)
        known = [i for i, y in enumerate(ys) if y is not None]
        if not known:
            raise AssertionError("no clothes under the bib")
        ys = np.interp(range(len(xs)), known, [ys[i] for i in known])
        ys = _front_hull(xs, ys)
        # Its own mirror.
        ys = np.minimum(ys, ys[::-1])
        grid.append([Vector((x, y - OFF, z)) for x, y in zip(xs, ys)])
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)

    def face(vs, slot=0):
        f = bm.faces.new(vs)
        f.material_index = slot
        for lp in f.loops:
            lp[uv].uv = (0.5, 0.5)

    back = [[bm.verts.new(c) for c in row] for row in grid]
    front = [[bm.verts.new(c - Vector((0, thick, 0))) for c in row] for row in grid]
    for r in range(rows):
        for c in range(cols):
            face((front[r][c], front[r][c + 1], front[r + 1][c + 1], front[r + 1][c]))
            face((back[r][c + 1], back[r][c], back[r + 1][c], back[r + 1][c + 1]))
    edge = ([(r, 0) for r in range(rows + 1)] + [(rows, c) for c in range(1, cols + 1)]
            + [(r, cols) for r in range(rows - 1, -1, -1)] + [(0, c) for c in range(cols - 1, 0, -1)])
    for (r0, c0), (r1, c1) in zip(edge, edge[1:] + edge[:1]):
        face((front[r0][c0], back[r0][c0], back[r1][c1], front[r1][c1]))

    # The strap: through the top corners, beside the neck over the
    # shoulders, and the back of the neck, laid on what is under it.
    st = p.get("strap", {})
    sw, st_thick = st.get("width", 0.018), st.get("thick", 0.003)
    neck = Vector(marks.joint("neck"))
    inset = st.get("inset", 0.012)
    corner = (grid[-1][0] + Vector((inset, 0, -0.01)), grid[-1][-1] + Vector((-inset, 0, -0.01)))
    side = st.get("neck", 0.065)
    nape = neck + Vector((0, st.get("back", 0.06), st.get("down", -0.02)))
    beside = [Vector((-side, neck.y + st.get("ahead", -0.01), neck.z + st.get("up", -0.005))),
              Vector((side, neck.y + st.get("ahead", -0.01), neck.z + st.get("up", -0.005)))]
    keys = [corner[0], beside[0], nape, beside[1], corner[1]]
    path = []
    count = st.get("segments", 40)
    for i in range(count + 1):
        u = i / count * (len(keys) - 1)
        k = min(int(u), len(keys) - 2)
        t = u - k
        p0, p1, p2, p3 = keys[max(k - 1, 0)], keys[k], keys[k + 1], keys[min(k + 2, len(keys) - 1)]
        q = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                   + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
        loc, n, _, _ = host.find_nearest(q)
        path.append((loc + n * OFF, n))
    rings = []
    for i, (c, n) in enumerate(path):
        ahead = (path[min(i + 1, len(path) - 1)][0] - path[max(i - 1, 0)][0]).normalized()
        across = ahead.cross(n).normalized()
        rings.append([bm.verts.new(c - across * sw / 2), bm.verts.new(c + across * sw / 2),
                      bm.verts.new(c + across * sw / 2 + n * st_thick), bm.verts.new(c - across * sw / 2 + n * st_thick)])
    for a, b in zip(rings, rings[1:]):
        for j in range(4):
            k = (j + 1) % 4
            face((a[j], a[k], b[k], b[j]), 1)
    face(rings[0][::-1], 1)
    face(rings[-1], 1)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [spec.get("colour", "#6B4A2E"), colours.get("strap", "#4A321E")], [False, False])
    _weigh_from(obj, garments + [skin], arm)
    return obj


# --- A mallet in the belt ------------------------------------------------


def mallet(spec, p, marks, arm, worn, skin):
    """A wooden mallet hung at the belt at an azimuth (degrees from the
    front, toward the figure's left): its head a short round block lying
    along the belt's top, its handle down from it outside the belt, kept
    off what is below the belt. Its params: azimuth, head [length,
    radius], handle [length, radius]; rigid on the belt's weights."""
    if not _belt:
        raise AssertionError("a mallet hangs at a belt: make the belt first")
    outer, mid_z, width, thick, columns = _belt
    a = np.radians(p.get("azimuth", -100))
    head_len, head_r = p.get("head", [0.09, 0.024])
    handle_len, handle_r = p.get("handle", [0.15, 0.011])
    k = min(range(columns), key=lambda i: abs(((2 * np.pi * i / columns - a + np.pi) % (2 * np.pi)) - np.pi))
    rows = len(outer)
    surface = sum((outer[r][k] for r in range(rows)), Vector()) / rows
    along = (outer[rows // 2][(k + 1) % columns] - outer[rows // 2][(k - 1) % columns]).normalized()
    out = Vector((0, 0, 1)).cross(along).normalized()
    if out.dot(Vector((np.sin(a), -np.cos(a), 0))) < 0:
        out = -out
    top_z = max(outer[r][k].z for r in range(rows))
    # The handle: its top at the belt's top, outside it; down from there,
    # pushed out wherever what is below the belt stands further out.
    garments = [w.obj for w in worn if w.kind == "garment"]
    host, _ = _host_tree(garments + [skin], TORSO + ("skirt", "thigh"))
    clear = handle_r + OFF
    # Out from the belt so the head over it clears the cloth above it.
    top = surface + out * max(handle_r + OFF, head_r * 0.7) + Vector((0, 0, top_z - surface.z))
    bottom = top + Vector((0, 0, -handle_len))
    for _ in range(3):
        need = 0.0
        for t in np.linspace(0.3, 1.0, 8):
            q = top.lerp(bottom, t)
            loc, n, _, d = host.find_nearest(q)
            if loc is not None and (q - loc).dot(out) < clear:
                need = max(need, (clear - (q - loc).dot(out)) / t)
        bottom = bottom + out * need
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    axis = (bottom - top).normalized()
    # The handle down from the belt's top; the head across its top, along
    # the belt, its lowest line on the handle's end.
    path = [top + axis * (handle_len * t) for t in np.linspace(0, 1, 4)]
    _tube(bm, uv, path, [handle_r, handle_r, handle_r * 1.05, handle_r * 1.15], sides=6, slot=0)
    centre = top + Vector((0, 0, head_r))
    ends = [centre - along * head_len / 2, centre + along * head_len / 2]
    hp = [ends[0], ends[0] + along * 0.006, centre, ends[1] - along * 0.006, ends[1]]
    # Eight sides, a corner straight down onto the handle's end.
    _tube(bm, uv, hp, [head_r * 0.93, head_r, head_r, head_r, head_r * 0.93], sides=8, slot=1)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [spec.get("colour", "#8A6440"), colours.get("head", "#A27C52")], [False, False])
    belt = [w.obj for w in worn if w.kind == "gear" and w.spec["family"] == "sash"]
    _weigh_from(obj, belt or garments, arm, at=surface)
    return obj


# --- A pencil behind the ear ---------------------------------------------


def _ear_top(skin, marks):
    """The top of the left ear where it leaves the head: the highest point
    of what stands out from the side of the head behind the eye."""
    co = body.coords(skin)
    eye = marks.joint("l-eye")
    band = co[(co[:, 0] > 0) & (co[:, 1] > eye[1] + 0.03) & (co[:, 1] < eye[1] + 0.16)
              & (co[:, 2] > eye[2] - 0.08) & (co[:, 2] < eye[2] + 0.05)]
    if not len(band):
        raise AssertionError("no ear beside the head")
    ear = band[band[:, 0] > band[:, 0].max() - 0.012]
    return Vector(ear[ear[:, 2].argmax()])


def pencil(spec, p, marks, arm, skin):
    """A pencil behind one ear (side: left or right), lying in the fold
    between the ear's top and the head, its point forward and a little
    down; rigid on the head. Its params: length, radius, back (how far
    behind the ear's top its middle is), in (how far in from the ear's
    rim), tip (its sharpened point's length)."""
    top = _ear_top(skin, marks)
    sign = 1 if p.get("side", "right") == "left" else -1
    length, radius = p.get("length", 0.09), p.get("radius", 0.0036)
    mid = Vector((sign * (top.x - p.get("in", 0.007)), top.y + p.get("back", 0.0), top.z + p.get("up", 0.002)))
    tilt = np.radians(p.get("tilt", 12))
    d = Vector((0, -np.cos(tilt), -np.sin(tilt)))
    tip = p.get("tip", 0.018)
    a, b = mid - d * length / 2, mid + d * length / 2
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    body_end = b - d * tip
    _tube(bm, uv, [a, a.lerp(body_end, 0.5), body_end], radius, sides=6, slot=0)
    _tube(bm, uv, [body_end, body_end + d * tip * 0.8, b], [radius, radius * 0.35, radius * 0.08], sides=6, slot=1)
    obj = _new(spec["id"], bm)
    colours = p.get("colours", {})
    _materials(obj, spec, [spec.get("colour", "#B8894E"), colours.get("point", "#D8C3A0")], [False, False])
    _rigid(obj, arm, "head")
    return obj


# --- The trapeze's harness ------------------------------------------------

# The harness's colours (sRGB) and the bronze's metal.
LEATHER = "#4A3020"
BRONZE = "#8C6B3D"


def harness(spec, marks, arm, worn, skin, ease):
    """A trapeze harness on the dressed figure at rest: a band round the
    waist (spec: width, thick, columns, up: its middle above the waist;
    hook: how far its hook stands out before the band), over the body and
    what is worn under a coat (by ease, less than a coat's) and under the
    coat, an apron and what is carried over them, squeezed thinner where
    they lie close; and a hook at the front, out past whatever is before
    it. Returns the mesh, skinned as the cloth under it, and the hook's
    eye, where the ring hangs, in the figure's space."""
    coat = ease["coat"]

    def layer(w):
        return ease.get((w.spec.get("params") or {}).get("layer", w.spec.get("family")), 0.0)

    under = [skin] + [w.obj for w in worn if w.kind in ("garment", "plate") and layer(w) < coat]
    over = [w.obj for w in worn if (w.kind == "garment" and layer(w) >= coat) or w.kind == "gear"]
    under_t, _ = _host_tree(under, TORSO + ("skirt",))
    over_t, _ = _host_tree(over, TORSO + ("skirt",)) if over else (None, None)
    every = [skin] + [w.obj for w in worn if w.kind not in ("hair", "beard", "face")]
    every_t, _ = _host_tree(every, TORSO + ("skirt",))
    m = marks.measure()
    width, thick, columns = spec["width"], spec["thick"], spec["columns"]
    mid_z = m["heights"]["waist"] + spec.get("up", 0.0)
    rows = 3
    zs = [mid_z - width / 2 + width * r / (rows - 1) for r in range(rows)]

    def outward(a):
        return Vector((np.sin(a), -np.cos(a), 0.0))

    def out_at(tree, z, a, far=True):
        """How far out from the torso's middle the first surface a ray in
        toward it meets (far: from outside; else the nearest out from
        the middle, a ray outward), or None."""
        c = Vector((0.0, marks.near(z)[1], z))
        d = outward(a)
        for dz in (0.0, 0.002, -0.002):
            if far:
                hit = tree.ray_cast(c + d * 0.6 + Vector((0, 0, dz)), -d, 0.6)[0]
            else:
                hit = tree.ray_cast(c + Vector((0, 0, dz)), d, 0.6)[0]
            if hit is not None:
                return (hit - c).dot(d)
        return None

    inner, outer = [], []
    for k in range(columns):
        a = 2 * np.pi * k / columns
        found = [x for x in (out_at(under_t, z, a) for z in zs) if x is not None]
        lo = max(found) if found else None
        hi = None
        if over_t is not None:
            # The inside of what is over it: the nearest out from the middle.
            got = [x for x in (out_at(over_t, z, a, far=False) for z in zs) if x is not None]
            hi = min(got) if got else None
        inner.append(lo)
        outer.append(hi)
    if all(x is None for x in inner):
        raise AssertionError("nothing under the harness")
    for k in range(columns):
        if inner[k] is None:
            k0 = next(j for j in range(1, columns) if inner[(k - j) % columns] is not None)
            k1 = next(j for j in range(1, columns) if inner[(k + j) % columns] is not None)
            inner[k] = (inner[(k - k0) % columns] * k1 + inner[(k + k1) % columns] * k0) / (k0 + k1)
    bands = []
    for k in range(columns):
        a_in = inner[k] + OFF
        a_out = a_in + thick
        if outer[k] is not None and outer[k] > inner[k]:
            # Under what is over it: squeezed, never through it.
            a_out = min(a_out, outer[k] - 0.002)
            a_out = max(a_out, a_in + 0.001)
        bands.append((a_in, a_out))

    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("uv")
    vin, vout = [], []
    for z in zs:
        c = Vector((0.0, marks.near(z)[1], z))
        vin.append([bm.verts.new(c + outward(2 * np.pi * k / columns) * bands[k][0]) for k in range(columns)])
        vout.append([bm.verts.new(c + outward(2 * np.pi * k / columns) * bands[k][1]) for k in range(columns)])

    def face(vs, slot=0):
        f = bm.faces.new(vs)
        f.material_index = slot
        return f

    for r in range(rows - 1):
        for k in range(columns):
            n = (k + 1) % columns
            face((vout[r][k], vout[r][n], vout[r + 1][n], vout[r + 1][k]))
            face((vin[r][n], vin[r][k], vin[r + 1][k], vin[r + 1][n]))
    for k in range(columns):
        n = (k + 1) % columns
        face((vin[0][k], vin[0][n], vout[0][n], vout[0][k]))
        face((vout[-1][k], vout[-1][n], vin[-1][n], vin[-1][k]))

    # The hook: from a bronze plate on the band's front, out past whatever
    # is before it (a coat's front, an apron), and turned up toward the
    # head, the ring's eye in its crook.
    front = Vector((0.0, marks.near(mid_z)[1], mid_z)) + outward(0.0) * bands[0][1]
    clear = max([bands[0][1]] + [x for x in (out_at(every_t, z, 0.0) for z in zs) if x is not None])
    reach = max(spec["hook"], clear - bands[0][1] + 0.03)
    ahead = Vector((0.0, -1.0, 0.0))
    up = Vector((0.0, 0.0, 1.0))
    plate = [front + up * dz + ahead * dy for dy, dz in ((0.0, 0.0), (0.004, 0.0))]
    _tube(bm, uv, plate, 0.022, sides=10, slot=1)
    tip = front + ahead * reach
    path = [front + ahead * 0.004, tip, tip + ahead * 0.012 + up * 0.012, tip + up * 0.03, tip + up * 0.034 + ahead * -0.008]
    _tube(bm, uv, path, 0.005, sides=6, slot=1)
    eye = tip + ahead * 0.006 + up * 0.012
    obj = _new("harness", bm)
    for name, colour, metal in (("harness-leather", LEATHER, 0.0), ("harness-bronze", BRONZE, 1.0)):
        mat = bpy.data.materials.new(name)
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*atlas.linear(colour), 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = 0.75 if metal == 0.0 else 0.4
        obj.data.materials.append(mat)
    _weigh_from(obj, [skin] + [o for o in under if o is not skin], arm)
    return obj, eye
