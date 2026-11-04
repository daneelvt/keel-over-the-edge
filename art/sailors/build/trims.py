# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Trims: what is sewn or fastened on the clothes, made on them once they
are fitted: buttons, pocket flaps, buckles.

A look lists its trims, each on a garment it names:

- buttons: domes along the garment's front edge on one side (along:
  edge, the side's edge of an opening) or down its middle (along:
  middle), count of them evenly from below the top to above the bottom;
- flaps: a pocket flap each side at an azimuth, a little below the
  skirt's top, its lower edge scalloped, with buttons along it;
- buckles: a frame on each shoe's tongue.

Each is placed by casting onto the fitted garment, never by eye, stands a
millimetre or two off it, and takes the weights of the garment's nearest
vertex, so it moves as the cloth under it does. All of a look's trims are
one mesh, a material slot for each colour, metal where it is.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import atlas
import body

# How far a trim stands off what it is on.
OFF = 0.0012


def make(specs, worn, arm, marks):
    """The look's trims on its fitted garments, one skinned mesh; and
    whether they are their own mirror (buttons down one edge are not)."""
    by_id = {w.spec["id"]: w.obj for w in worn if w.kind == "garment"}
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    slots, hosts, mirrored = [], [], True
    for i, t in enumerate(specs):
        host = by_id[t["on"]]
        colour = (t.get("colour", "#808080"), bool(t.get("metal", t["kind"] != "flaps")), t.get("region", "fixed"),
                  t.get("shade", 1.0))
        if colour not in slots:
            slots.append(colour)
        slot = slots.index(colour)
        before = set(bm.verts)
        if t["kind"] == "buttons":
            for p, n in _button_places(host, t, marks):
                button(bm, uv, p, n, t.get("radius", 0.006), slot)
            mirrored &= t.get("along") == "middle"
        elif t["kind"] == "flaps":
            flaps(bm, uv, host, t, marks, slot, slots)
        elif t["kind"] == "buckles":
            for p, n in _buckle_places(host, marks):
                buckle(bm, uv, p, n, t, slot)
        else:
            raise ValueError(f"no trim {t['kind']!r}")
        hosts.append((host, [v for v in bm.verts if v not in before]))
    me = bpy.data.meshes.new("trims")
    # A flap's point whose neighbours' casts missed has no face.
    loose = [v for v in bm.verts if not v.link_faces]
    hosts = [(h, [v for v in vs if v not in set(loose)]) for h, vs in hosts]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.verts.index_update()
    owners = {v.index: host for host, vs in hosts for v in vs}
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("trims", me)
    bpy.context.scene.collection.objects.link(obj)
    for f in me.polygons:
        f.use_smooth = True
    for colour, metal, region, shade in slots:
        m = atlas.part(bpy.data.materials.new(f"trim-{len(me.materials)}"),
                       atlas.linear(colour) if region == "fixed" else None, region, metal)
        if region != "fixed":
            m["part_colour"] = [atlas.NEUTRAL * shade] * 3
        me.materials.append(m)
    _weigh(obj, owners, arm)
    return obj, mirrored


def _tree(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


def _cast(tree, origin, direction, within=2.0):
    loc, n, _, _ = tree.ray_cast(Vector(origin), Vector(direction).normalized(), within)
    if loc is None:
        return None
    # The normal toward where the ray came from: the cloth's outside.
    if n.dot(Vector(direction)) > 0:
        n = -n
    return loc, n


def _button_places(host, t, marks):
    tree = _tree(host)
    co = body.coords(host)
    count = t.get("count", 10)
    if t.get("along") == "middle":
        front = co[(np.abs(co[:, 0]) < 0.02) & (co[:, 1] < 0)]
        top, low = front[:, 2].max() - t.get("from", 0.02), front[:, 2].min() + t.get("to", 0.02)
        out = []
        for z in np.linspace(top, low, count):
            hit = _cast(tree, (0, -1, z), (0, 1, 0))
            if hit:
                out.append(hit)
        return out
    # Along an opening's edge on one side: the wearer's right is -x.
    sign = -1 if t.get("side", "right") == "right" else 1
    bm = bmesh.new()
    bm.from_mesh(host.data)
    edge = np.array([tuple(v.co) for v in bm.verts if v.is_boundary])
    bm.free()
    edge = edge[(edge[:, 0] * sign > 0) & (np.abs(edge[:, 0]) < 0.1) & (edge[:, 1] < 0)]
    edge = edge[(edge[:, 2] < marks.joint("neck")[2] - 0.03)]
    # The opening's edge: of the front's boundary, the part nearest the
    # middle at each height.
    zs = np.linspace(edge[:, 2].max() - t.get("from", 0.03), edge[:, 2].min() + t.get("to", 0.03), count)
    out = []
    for z in zs:
        near = edge[np.abs(edge[:, 2] - z) < 0.02]
        if len(near) == 0:
            continue
        x = near[np.argmin(np.abs(near[:, 0])), 0] + sign * t.get("inset", 0.012)
        hit = _cast(tree, (x, -1, z), (0, 1, 0))
        if hit:
            out.append(hit)
    return out


def button(bm, uv, p, n, radius, slot, segments=6):
    """A dome: a rim on the cloth, a shoulder, and a raised middle."""
    n = n.normalized()
    a = n.orthogonal().normalized()
    b = n.cross(a)
    base = p + n * OFF
    rim = [bm.verts.new(base + (a * np.cos(k * 2 * np.pi / segments) + b * np.sin(k * 2 * np.pi / segments)) * radius)
           for k in range(segments)]
    mid = [bm.verts.new(base + n * radius * 0.35 + (a * np.cos(k * 2 * np.pi / segments) + b * np.sin(
        k * 2 * np.pi / segments)) * radius * 0.65) for k in range(segments)]
    top = bm.verts.new(base + n * radius * 0.5)
    u0 = len(bm.faces) * 0.01
    for k in range(segments):
        j = (k + 1) % segments
        for f, cs in ((bm.faces.new((rim[k], rim[j], mid[j], mid[k])), ((0, 0), (1, 0), (1, 0.5), (0, 0.5))),
                      (bm.faces.new((mid[k], mid[j], top)), ((0, 0.5), (1, 0.5), (0.5, 1)))):
            f.material_index = slot
            for lp, c in zip(f.loops, cs):
                lp[uv].uv = (10 + u0 + (k + c[0]) / segments * 0.02, c[1] * 0.02)


def flaps(bm, uv, host, t, marks, slot, slots):
    """A pocket flap each side: a card laid on the skirt, its lower edge
    scalloped, with buttons along its middle."""
    tree = _tree(host)
    co = body.coords(host)
    top = co[:, 2].max() - t.get("below", 0.08)
    w, h = t.get("width", 0.15), t.get("height", 0.06)
    columns, rows = 8, 3
    scallops = t.get("scallops", 3)
    bcolour = (t.get("button-colour", "#B08D57"), True, "fixed", 1.0)
    if bcolour not in slots:
        slots.append(bcolour)
    bslot = slots.index(bcolour)
    for sign in (-1, 1):
        az = np.radians(t.get("azimuth", 40)) * sign
        grid = []
        r_top = None
        for r in range(rows + 1):
            row = []
            for c in range(columns + 1):
                u = c / columns
                depth = h * r / rows
                if r == rows:
                    depth = h * (1 + 0.18 * np.cos(2 * np.pi * scallops * (u - 0.5 / scallops)))
                z = top - depth
                # Round the skirt by arc length at its radius here.
                # From a metre out, only the near side: a ray through an
                # opening would find the back from inside.
                probe = _cast(tree, (np.sin(az) * 1.0, -np.cos(az) * 1.0, z), (-np.sin(az), np.cos(az), 0), 0.98)
                radius = np.hypot(probe[0].x, probe[0].y) if probe else 0.2
                r_top = r_top or radius
                a = az + (u - 0.5) * w / radius * sign
                hit = _cast(tree, (np.sin(a) * 1.0, -np.cos(a) * 1.0, z), (-np.sin(a), np.cos(a), 0), 0.98)
                if hit is None:
                    continue
                v = bm.verts.new(hit[0] + hit[1] * (OFF + 0.0015 * (rows - r) / rows))
                row.append((v, u, r / rows))
            grid.append(row)
        for ra, rb in zip(grid, grid[1:]):
            for k in range(min(len(ra), len(rb)) - 1):
                quad = (ra[k], ra[k + 1], rb[k + 1], rb[k]) if sign > 0 else (ra[k + 1], ra[k], rb[k], rb[k + 1])
                f = bm.faces.new([q[0] for q in quad])
                f.material_index = slot
                for lp, q in zip(f.loops, quad):
                    lp[uv].uv = (20 + sign + q[1] * w / h, q[2])
        for k in range(t.get("buttons", 3)):
            u = (k + 0.5) / t.get("buttons", 3)
            a = az + (u - 0.5) * w * 0.8 / (r_top or 0.2) * sign
            z = top - h * 0.6
            hit = _cast(tree, (np.sin(a), -np.cos(a), z), (-np.sin(a), np.cos(a), 0), 0.98)
            if hit:
                button(bm, uv, hit[0] + hit[1] * 0.002, hit[1], t.get("radius", 0.006), bslot)


def _buckle_places(host, marks):
    tree = _tree(host)
    out = []
    for side in ("l", "r"):
        ankle = Vector(marks.joint(f"{side}-ankle"))
        hit = _cast(tree, ankle + Vector((0, -0.25, 0.12)), Vector((0, 0.9, -0.55)))
        if hit:
            out.append(hit)
    return out


def buckle(bm, uv, p, n, t, slot):
    """A buckle: a flat rectangular frame on the shoe, square to the foot."""
    w, h, bar = t.get("width", 0.03), t.get("height", 0.024), t.get("bar", 0.004)
    n = n.normalized()
    across = Vector((1, 0, 0))
    along = n.cross(across).normalized()
    across = along.cross(n).normalized()
    base = p + n * (OFF + 0.001)

    def at(x, y, up=0.0):
        return bm.verts.new(base + across * x + along * y + n * up)

    outer = [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)]
    inner = [at(-w / 2 + bar, -h / 2 + bar, 0.0015), at(w / 2 - bar, -h / 2 + bar, 0.0015),
             at(w / 2 - bar, h / 2 - bar, 0.0015), at(-w / 2 + bar, h / 2 - bar, 0.0015)]
    for k in range(4):
        j = (k + 1) % 4
        f = bm.faces.new((outer[k], outer[j], inner[j], inner[k]))
        f.material_index = slot
        for lp, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            lp[uv].uv = (30 + k + c[0] * 0.5, c[1] * 0.2)


def _weigh(obj, owners, arm):
    """Each vertex takes the weights of its garment's nearest vertex."""
    trees = {}
    for host in set(owners.values()):
        co = body.coords(host)
        tree = KDTree(len(co))
        for i, p in enumerate(co):
            tree.insert(p, i)
        tree.balance()
        trees[host.name] = (tree, {g.index: g.name for g in host.vertex_groups})
    groups = {}
    for v in obj.data.vertices:
        host = owners[v.index]
        tree, names = trees[host.name]
        _, i, _ = tree.find(v.co)
        for g in host.data.vertices[i].groups:
            name = names[g.group]
            if name not in groups:
                groups[name] = obj.vertex_groups.new(name=name)
            groups[name].add([v.index], g.weight, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
