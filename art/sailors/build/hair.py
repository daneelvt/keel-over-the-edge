# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Hair: opaque sculpted shells, from strands combed by rule.

The game has no multisampling, so hair cannot be cards blended by
coverage: it is a solid shell. Strands are grown from the scalp (MPFB's
"scalp" group, which is the hairline) by a comb rule, kept off the face,
ears and neck by staying on the scalp's side of the hairline until they
fall below it, over an underlayer that covers the scalp; then all of it is
merged by a voxel remesh into one solid, smoothed, collapsed to its budget,
and its inner wall (what lies against the skull) dropped.

A style is its parameters:

- comb: where the strands go from their roots: "back" (swept back and
  down), "down" (falling from the crown) or "side" (from a parting, at
  parting degrees from the front);
- volume: how far the hair stands off the head, in metres;
- length: how far a strand goes, in metres, from its root;
- gather: a point (x, y, z from the head's joint) the strands are drawn
  to once behind the head (a queue, a ponytail, a bun), and tail: how far
  they fall on from it, together;
- strands, thickness: how many strands, and how thick at the root.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import body
import lod

STEP = 0.01


def make(spec, human, marks, arm, budget):
    p = spec["params"]
    co = body.coords(human)
    skin = body.in_group(human, "body")
    scalp = skin & body.in_group(human, "scalp")
    head = Vector(marks.joint("head"))
    nape = float(co[scalp, 2].min())

    bm = bmesh.new()
    bm.from_mesh(human.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not skin[v.index]], context="VERTS")
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    bm.free()

    rng = np.random.default_rng(p.get("seed", 1))
    roots = np.flatnonzero(scalp)
    roots = rng.choice(roots, size=min(p.get("strands", 160), len(roots)), replace=False)
    out = bmesh.new()

    # The underlayer: the scalp, stood off the head a little less than the
    # volume, so no skin shows between strands.
    under = bmesh.new()
    under.from_mesh(human.data)
    bmesh.ops.delete(under, geom=[v for v in under.verts if not scalp[v.index]], context="VERTS")
    under.normal_update()
    for v in under.verts:
        v.co += v.normal * p.get("volume", 0.01) * 0.6
    bmesh.ops.solidify(under, geom=under.faces[:], thickness=-0.004)
    me = bpy.data.meshes.new("under")
    under.to_mesh(me)
    under.free()
    out.from_mesh(me)
    bpy.data.meshes.remove(me)

    for r in roots:
        path = comb(Vector(co[r]), human.data.vertices[r].normal, p, tree, head, nape)
        tube(out, path, p.get("thickness", 0.012))

    me = bpy.data.meshes.new(spec["id"])
    out.to_mesh(me)
    out.free()
    obj = bpy.data.objects.new(spec["id"], me)
    bpy.context.scene.collection.objects.link(obj)
    remesh = obj.modifiers.new("merge", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = p.get("voxel", 0.004)
    lod.apply(obj, remesh)
    smooth = obj.modifiers.new("smooth", "SMOOTH")
    smooth.iterations = 4
    smooth.factor = 0.5
    lod.apply(obj, smooth)
    inner_wall(obj, tree)
    lod.decimate(obj, budget)
    weigh(obj, arm, nape)
    return obj


def comb(root, normal, p, tree, head, nape):
    """A strand's path from its root by the comb rule, off the head by the
    volume, and on toward the gather point and down the tail if any."""
    volume = p.get("volume", 0.01)
    length = p.get("length", 0.12)
    comb_ = p.get("comb", "back")
    if comb_ == "back":
        want = Vector((0, 1, -0.6))
    elif comb_ == "down":
        want = Vector((0, 0, -1))
    else:
        a = np.radians(p.get("parting", 60))
        parting = Vector((np.sin(a), -np.cos(a), 0))
        want = (root - head).normalized() - parting * 0.5 + Vector((0, 0, -0.5))
    gather = None
    if p.get("gather"):
        gather = head + Vector(p["gather"])
    pos = root + normal * volume
    path = [pos.copy()]
    walked = 0.0
    while walked < length:
        d = want.copy()
        if gather is not None and pos.y > head.y:
            d = (gather - pos).normalized() * 1.5 + d * 0.5
        if pos.z < nape:
            d = Vector((0, 0.15, -1))
        # Along the head's surface: what points into the head is taken out.
        loc, n, _, dist = tree.find_nearest(pos)
        if loc is not None and pos.z >= nape:
            d -= n * d.dot(n)
        d.normalize()
        pos = pos + d * STEP
        loc, n, _, dist = tree.find_nearest(pos)
        if loc is not None and (pos - loc).dot(n) < volume:
            pos = loc + n * volume
        path.append(pos.copy())
        walked += STEP
        if gather is not None and (pos - gather).length < 0.01:
            break
    if gather is not None and p.get("tail"):
        end = gather.copy()
        for i in range(int(p["tail"] / STEP)):
            end = end + Vector((0, 0.1, -1)).normalized() * STEP
            path.append(end.copy())
    return path


def tube(bm, path, thickness, sides=5):
    """A strand: a tube along path, tapering to a point."""
    rings = []
    for i, c in enumerate(path):
        t = i / max(len(path) - 1, 1)
        r = thickness * (1 - 0.7 * t) / 2
        ahead = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        side = ahead.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(ahead)
        rings.append([bm.verts.new(c + (side * np.cos(2 * np.pi * k / sides) + up * np.sin(2 * np.pi * k / sides)) * r)
                      for k in range(sides)])
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            n = (k + 1) % sides
            bm.faces.new((a[k], a[n], b[n], b[k]))


def inner_wall(obj, tree):
    """Drops the faces that lie against the skull: within a few millimetres
    of the skin and facing it."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    gone = []
    for f in bm.faces:
        c = f.calc_center_median()
        loc, n, _, dist = tree.find_nearest(c)
        if loc is not None and dist < 0.008 and f.normal.dot(n) < 0:
            gone.append(f)
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def weigh(obj, arm, nape):
    """On the head down to the nape; below it, along the spring joints that
    hang from the head, so a queue or a braid swings."""
    # The chain that hangs from the head (rig.py: the first four).
    springs = [arm.data.bones[f"spring_{i:02d}"] for i in range(1, 5)]
    head = obj.vertex_groups.new(name="head")
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in springs}
    for v in obj.data.vertices:
        if v.co.z >= nape or not springs:
            head.add([v.index], 1.0, "REPLACE")
            continue
        nearest = min(springs, key=lambda b: abs((b.head_local.z + b.tail_local.z) / 2 - v.co.z))
        groups[nearest.name].add([v.index], 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
