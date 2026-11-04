# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Hair: opaque sculpted shells, from strands combed by rule.

The game has no multisampling, so hair cannot be cards blended by
coverage: it is a solid shell. Strands are grown from the scalp (MPFB's
"scalp" group, which is the hairline) by a comb rule, kept off the face,
ears and neck by staying on the scalp's side of the hairline until they
fall below it, over an underlayer that covers the scalp; a tail is added
where the strands are gathered (a queue, or a braid); then all of it is
merged by a voxel remesh into one solid, smoothed, its specks dropped,
its inner wall (what lies against the skull) dropped, set off the skin,
collapsed to its budget and made its own mirror. A ribbon may tie the
tail, in its own colour.

A style is its parameters:

- comb: where the strands go from their roots: "back" (swept back and
  down), "down" (falling from the crown) or "side" (from a parting, at
  parting degrees from the front);
- volume: how far the hair stands off the head, in metres;
- length: how far a strand goes, in metres, from its root;
- gather: a point (x, y, z from the head's joint) the strands are drawn
  to once behind the head;
- tail: what hangs from the gather point: {kind: queue or braid, length,
  width (at its root), taper (its end's share of the width), lean (how
  far it lies back from straight down, as y a metre of fall), clear (how
  far its line keeps off the skin: the clothes' collar under it and its
  own half width), lobes (a braid's)};
- ribbon: {colour, at (a share of the tail's length), width} ties the
  tail; and, for a queue, ends: how long its two ends hang;
- strands, thickness: how many strands, and how thick at the root.

Every strand is grown on the figure's right and mirrored, so the shell is
its own mirror. Its UVs are one island: a projection round the head,
continued down the tail.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import atlas
import body
import garment
import lod

STEP = 0.01

# How far the shell is kept off the skin, in metres.
OFF_SKIN = 0.003


def make(spec, human, marks, arm, budget, under_hat=None, skin=None):
    """The hair a spec asks for, skinned; under_hat, a hat's band (its
    height, middle and radius: profiles.seat), presses it flat to the head
    from a little below the band up, so the hat fits. skin is the body as
    drawn (its proxy), which the hair is kept off; the base mesh if None.

    A style whose shell is "cap" is hair combed close and tied back: the
    scalp itself stood off the head, its volume tapering to nothing at the
    hairline, and the comb's strands laid on it only to shade it (DETAILS);
    any other is grown from strands."""
    p = spec["params"]
    co = body.coords(human)
    on_body = body.in_group(human, "body")
    scalp = on_body & body.in_group(human, "scalp")
    head = Vector(marks.joint("head"))
    nape = float(co[scalp, 2].min())

    bm = bmesh.new()
    bm.from_mesh(human.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not on_body[v.index]], context="VERTS")
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    if skin is not None:
        bm = bmesh.new()
        bm.from_mesh(skin.data)
        bm.normal_update()
        drawn = BVHTree.FromBMesh(bm)
        bm.free()
    else:
        drawn = tree

    gather = head + Vector(p["gather"]) if p.get("gather") else None
    if gather is not None and p.get("shell") == "cap":
        # Gathered at the hair's surface, the nearest to the point asked.
        loc, n, _, _ = drawn.find_nearest(gather)
        # Set out by the tail's own half width, so its root is not in the
        # nape.
        gather = loc + n * (p.get("volume", 0.008) * 0.5 + (p.get("tail") or {}).get("width", 0.03) * 0.3)
    tail_path = None
    if gather is not None and p.get("tail"):
        tail_path = tail_line(gather, p["tail"], tree, nape)
    tail_budget = int(budget * p["tail"].get("share", 0.4)) if tail_path is not None else 0
    ribbon_budget = RIBBON_TRIANGLES if p.get("ribbon") else 0

    if p.get("shell") == "cap":
        obj = cap(spec["id"], human, scalp, p, drawn, under_hat, budget - tail_budget - ribbon_budget,
                  float(marks.joint("neck")[2]))
        DETAILS.append(strands_on(obj, human, scalp, p, head, nape, gather))
    else:
        obj = grown(spec["id"], human, scalp, p, tree, head, nape, budget - tail_budget - ribbon_budget)
        off_skin(obj, drawn)
        if under_hat is not None:
            press(obj, drawn, under_hat[0])
    # A collapse is its own mirror only roughly.
    garment.mirror(obj, 0.02, greedy=True)
    project(obj, head, nape, None)
    if tail_path is not None:
        # The tail made directly, a tube round its line with its own UVs.
        tail = plait(spec["id"] + "-tail", tail_path, p["tail"])
        # Its root on the hair it hangs from, not under it.
        off_skin(tail, drawn, p.get("volume", OFF_SKIN) if p.get("shell") == "cap" else OFF_SKIN)
        join(obj, tail)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.materials.append(atlas.part(bpy.data.materials.new(spec["id"]), None, "hair"))
    if p.get("ribbon") and tail_path is not None:
        ribbon(obj, tail_path, p["ribbon"], p["tail"])
    lod.clean(obj)
    weigh(obj, arm, nape, tail_path)
    return obj


# What shades the hair in the atlas's bake and is then dropped: the comb's
# strands laid on a cap (drop_details).
DETAILS = []


def drop_details():
    for o in DETAILS:
        bpy.data.objects.remove(o, do_unlink=True)
    DETAILS.clear()


def cap(name, human, scalp, p, drawn, under_hat, budget, neck_z=0.0):
    """The scalp stood off the drawn skin by the volume, which tapers from
    nothing at the hairline over the taper's metres; pressed flat under a
    hat's band; the hairline's edge turned down to the skin."""
    bm = bmesh.new()
    bm.from_mesh(human.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not scalp[v.index]], context="VERTS")
    for g in list(bm.verts.layers.deform):
        bm.verts.layers.deform.remove(g)
    if p.get("nape") is not None:
        # Tied up, it ends above the neck's joint (and a neckcloth).
        floor = neck_z + p["nape"]
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().z < floor], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Each vertex's distance from the hairline, along the scalp.
    edge = [v for v in bm.verts if v.is_boundary]
    dist = {v: 0.0 for v in edge}
    front = list(edge)
    while front:
        nxt = []
        for v in front:
            for e in v.link_edges:
                w = e.other_vert(v)
                d = dist[v] + e.calc_length()
                if d < dist.get(w, np.inf):
                    dist[w] = d
                    nxt.append(w)
        front = nxt
    # The hairline smoothed along itself: the base mesh's steps out.
    loop = {v: [e.other_vert(v) for e in v.link_edges if e.is_boundary] for v in edge}
    for _ in range(p.get("hairline-smooth", 6)):
        moved = {v: (v.co + sum((w.co for w in ns), Vector()) ) / (1 + len(ns)) for v, ns in loop.items()}
        for v, c in moved.items():
            v.co = c
    volume, taper = p.get("volume", 0.008), p.get("taper", 0.025)
    for _ in range(2):
        bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if not v.is_boundary], factor=0.5,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in bm.verts:
        t = float(np.clip(dist[v] / taper, 0, 1))
        off = HAIRLINE + (volume - HAIRLINE) * t * t * (3 - 2 * t)
        loc, n, _, _ = drawn.find_nearest(v.co)
        v.co = loc + n * off
    # The hairline turned down to the skin, so the cap has an edge.
    edges = [e for e in bm.edges if e.is_boundary]
    made = bmesh.ops.extrude_edge_only(bm, edges=edges)
    for v in (g for g in made["geom"] if isinstance(g, bmesh.types.BMVert)):
        loc, n, _, _ = drawn.find_nearest(v.co)
        v.co = loc + n * 0.0003
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for layer in list(me.uv_layers):
        me.uv_layers.remove(layer)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if under_hat is not None:
        press(obj, drawn, under_hat[0])
    # Collapsed as one half and mirrored, so it is its own mirror vertex
    # for vertex.
    half(obj)
    lod.decimate(obj, budget // 2)
    unhalf(obj)
    return obj


def half(obj):
    """Keeps the mesh's half on the figure's right (x ≤ 0)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0), plane_no=(1, 0, 0),
                           clear_outer=True, dist=1e-6)
    bm.to_mesh(obj.data)
    bm.free()


def unhalf(obj):
    """The half and its mirror, joined down the middle."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        if abs(v.co.x) < 2e-4:
            v.co.x = 0.0
    bmesh.ops.mirror(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], axis="X", merge_dist=1e-4)
    # The mirror keeps each face's winding: the copies face in.
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


# How far a cap stands off the skin at its hairline.
HAIRLINE = 0.0012


def strands_on(obj, human, scalp, p, head, nape, gather):
    """The comb's strands laid on a cap, half sunk in it: thin tubes whose
    shadow in the bake draws the hair's lines. Not drawn, not exported."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    co = body.coords(human)
    rng = np.random.default_rng(p.get("seed", 1))
    right = np.flatnonzero(scalp & (co[:, 0] <= 0.0))
    roots = rng.choice(right, size=min(p.get("strands", 300) // 2, len(right)), replace=False)
    out = bmesh.new()
    q = dict(p, volume=p.get("thickness", 0.004) * 0.2, length=p.get("length", 0.2))
    for r in roots:
        loc, n, _, _ = tree.find_nearest(Vector(co[r]))
        if loc is None:
            continue
        path = comb(loc, n, q, tree, head, nape)
        tube(out, path, p.get("thickness", 0.004))
        tube(out, [Vector((-c.x, c.y, c.z)) for c in path], p.get("thickness", 0.004))
    me = bpy.data.meshes.new(obj.name + "-strands")
    out.to_mesh(me)
    out.free()
    d = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(d)
    return d


def grown(name, human, scalp, p, tree, head, nape, budget):
    """Hair grown from strands over an underlayer, merged into one solid."""
    co = body.coords(human)
    rng = np.random.default_rng(p.get("seed", 1))
    right = np.flatnonzero(scalp & (co[:, 0] <= 0.0))
    if p.get("gather"):
        # Roots below the gather point would hang loose beside the neck:
        # the underlayer covers the scalp there.
        right = right[co[right, 2] > head.z + p["gather"][2] + 0.01]
    roots = rng.choice(right, size=min(p.get("strands", 160) // 2, len(right)), replace=False)
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
        tube(out, [Vector((-c.x, c.y, c.z)) for c in path], p.get("thickness", 0.012))
    obj = merged(name, out, p)
    inner_wall(obj, tree)
    lod.decimate(obj, budget)
    return obj


def merged(name, bm, p):
    """The parts in bm merged into one smooth solid by a voxel remesh, its
    specks dropped."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    remesh = obj.modifiers.new("merge", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = p.get("voxel", 0.004)
    lod.apply(obj, remesh)
    smooth = obj.modifiers.new("smooth", "SMOOTH")
    smooth.iterations = p.get("smooth", 6)
    smooth.factor = 0.5
    lod.apply(obj, smooth)
    keep_largest(obj)
    return obj


def join(obj, other):
    """Moves other's mesh into obj's."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.from_mesh(other.data)
    bm.to_mesh(obj.data)
    bm.free()
    bpy.data.objects.remove(other, do_unlink=True)


def comb(root, normal, p, tree, head, nape):
    """A strand's path from its root by the comb rule, off the head by the
    volume, and on toward the gather point if any."""
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
        if gather is not None:
            # Drawn to the gather point the whole way, the more so behind
            # the head, so nothing falls loose beside the face.
            pull = 1.5 if pos.y > head.y else 0.9
            d = (gather - pos).normalized() * pull + d * 0.5
        elif pos.z < nape:
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
        if gather is not None and (pos - gather).length < 0.012:
            break
    return path


def tail_line(gather, t, tree, nape):
    """The tail's middle line from the gather point: down and a little
    back, and below the nape lying on the figure's back (off the skin by
    its own half width and the clothes' room)."""
    length = t.get("length", 0.12)
    lean = t.get("lean", 0.15)
    clear = t.get("clear", 0.03)
    pts = [gather.copy()]
    pos = gather.copy()
    walked = 0.0
    while walked < length:
        pos = pos + Vector((0, lean, -1)).normalized() * STEP
        # Clear of the neck and back all the way down, eased in from the
        # gather point over its first centimetre and a half.
        want = clear * min(1.0, walked / 0.015)
        loc, n, _, _ = tree.find_nearest(pos)
        if loc is not None and (pos - loc).dot(n) < want:
            pos = loc + n * want
        pts.append(pos.copy())
        walked += STEP
    return pts


def _frame(path, i):
    ahead = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
    side = Vector((1, 0, 0))
    up = side.cross(ahead).normalized()
    return ahead, side, up


def plait(name, path, t):
    """A tail hanging from the gather point: a tube round its line, tapering
    to its end. A queue is round; a braid is a plait, its lobes slanting
    left and right in turn, each swelling as it crosses (a real braid is
    not its own mirror). Its UVs go round it and down it."""
    # Begun a little back inside the hair it hangs from, so a coarser
    # level keeps it joined there.
    back = (path[0] - path[1]).normalized() * t.get("root", 0.03)
    path = [path[0] + back] + list(path)
    w = t.get("width", 0.03)
    taper = t.get("taper", 0.45)
    sides = t.get("sides", 6)
    braid_ = t.get("kind", "queue") == "braid"
    lobes = t.get("lobes", 10)
    per = t.get("rings", 3)
    n = lobes * per + 1 if braid_ else max(len(path), 2)
    length = (len(path) - 1) * STEP
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)

    def at(s):
        """The line's point and direction a share s along it."""
        f = s * (len(path) - 1)
        i = min(int(f), len(path) - 2)
        u = f - i
        return path[i].lerp(path[i + 1], u), (path[i + 1] - path[i]).normalized()

    rings = []
    for r in range(n):
        s = r / (n - 1)
        c, ahead = at(s)
        side = Vector((1, 0, 0))
        up = side.cross(ahead).normalized()
        side = ahead.cross(up).normalized()
        radius = w / 2 * (1 - (1 - taper) * s ** 1.4)
        if s > 0.92:
            # The end, gathered to a point below its tie.
            radius *= max(0.25, 1 - (s - 0.92) / 0.08 * 0.75)
        offset, twist = 0.0, 0.0
        if braid_:
            k, u = divmod(s * lobes, 1.0)
            sign = 1 if int(k) % 2 == 0 else -1
            swell = np.sin(np.pi * u)
            radius *= 0.85 + 0.25 * swell
            offset = sign * w * 0.12 * swell
            twist = sign * 0.35
        ring = []
        for j in range(sides):
            a = 2 * np.pi * j / sides + twist
            p = c + side * offset + (side * np.cos(a) + up * 0.8 * np.sin(a)) * radius
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for r in range(n - 1):
        for j in range(sides):
            k = (j + 1) % sides
            f = bm.faces.new((rings[r][j], rings[r][k], rings[r + 1][k], rings[r + 1][j]))
            f.smooth = True
            for lp, (a, b) in zip(f.loops, ((j, r), (j + 1, r), (j + 1, r + 1), (j, r + 1))):
                lp[uv].uv = (6 + a / sides * 0.3, -b / (n - 1) * length / (np.pi * w))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        f = bm.faces.new(list(reversed(ring)) if flip else ring)
        f.smooth = True
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = (8 + co.x * 4, (co.y + co.z) * 4 + (0 if flip else 2))
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


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


def keep_largest(obj):
    """Drops every piece the remesh left apart from the shell: a strand's
    tip cut off, a speck."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, parts = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        stack, part = [v], []
        seen.add(v)
        while stack:
            u = stack.pop()
            part.append(u)
            for e in u.link_edges:
                w = e.other_vert(u)
                if w not in seen:
                    seen.add(w)
                    stack.append(w)
        parts.append(part)
    parts.sort(key=len, reverse=True)
    gone = [v for part in parts[1:] for v in part]
    bmesh.ops.delete(bm, geom=gone, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


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
    # What the cut left hanging by an edge or a corner.
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def off_skin(obj, tree, least=OFF_SKIN):
    """Sets every vertex nearer the skin than least out to it."""
    for v in obj.data.vertices:
        loc, n, _, _ = tree.find_nearest(v.co)
        if loc is not None and (v.co - loc).dot(n) < least:
            v.co = loc + n * least


# How far the hair stands off the head under a hat's band.
UNDER_HAT = 0.0032


def press(obj, tree, band_z, below=0.03):
    """Brings the hair in to UNDER_HAT off the head from below the band
    up, eased in over the below metres under it."""
    for v in obj.data.vertices:
        t = float(np.clip((v.co.z - (band_z - below)) / (below - 0.005), 0, 1))
        if t <= 0:
            continue
        t = t * t * (3 - 2 * t)
        loc, n, _, _ = tree.find_nearest(v.co)
        if loc is None:
            continue
        d = (v.co - loc).dot(n)
        v.co = loc + n * (d + (min(d, UNDER_HAT) - d) * t)


def project(obj, head, nape, tail_path):
    """One UV island: round the head by its azimuth from the back (the seam
    at the face, where the hair is least) and its height, continued down
    the tail by its length."""
    me = obj.data
    if atlas.ATLAS not in me.uv_layers:
        me.uv_layers.new(name=atlas.ATLAS)
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv[atlas.ATLAS]
    top = max(v.co.z for v in bm.verts)
    scale = 1.0 / (np.pi * 0.11)

    def at(c):
        a = np.arctan2(c.x - head.x, c.y - head.y)
        r = 0.11 if c.z >= nape else max(0.02, np.hypot(c.x, c.y - head.y))
        return (a * r * scale, (c.z - top) * scale)

    for f in bm.faces:
        uvs = [at(lp.vert.co) for lp in f.loops]
        us = [u for u, _ in uvs]
        if max(us) - min(us) > 0.5 * 2 * np.pi * 0.11 * scale:
            uvs = [(u + 2 * np.pi * 0.11 * scale if u < 0 else u, v) for u, v in uvs]
        for lp, c in zip(f.loops, uvs):
            lp[uv].uv = c
    bm.to_mesh(me)
    bm.free()
    for layer in list(me.uv_layers):
        if layer.name != atlas.ATLAS:
            me.uv_layers.remove(layer)


RIBBON_TRIANGLES = 64


def ribbon(obj, path, r, t):
    """A ribbon round the tail at a share of its length, in its own colour,
    joined to the hair as a second material; a queue's with two ends
    hanging below it."""
    n = len(path)
    i = min(int(r.get("at", 0.0) * (n - 1)), n - 1)
    ahead, side, up = _frame(path, i)
    w = t.get("width", 0.03) * (1 - (1 - t.get("taper", 0.4)) * (i / (n - 1)) ** 1.5)
    radius = w / 2 + 0.002 if t.get("kind", "queue") == "queue" else w * 0.36 + 0.002
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    sides = 12
    height = r.get("width", 0.012)
    rings = []
    for h in (-height / 2, height / 2):
        rings.append([bm.verts.new(path[i] - ahead * h + (side * np.cos(2 * np.pi * k / sides)
                                                            + up * 0.85 * np.sin(2 * np.pi * k / sides)) * radius)
                      for k in range(sides)])
    faces = []
    for k in range(sides):
        nk = (k + 1) % sides
        faces.append(bm.faces.new((rings[0][k], rings[0][nk], rings[1][nk], rings[1][k])))
    # The ends: two strips hanging from the back of the knot.
    for sign in (-1, 1):
        if not r.get("ends"):
            break
        # On the ribbon, flattened as it is.
        root = path[i] + up * radius * 0.85
        a = root + side * sign * 0.006
        b = root + side * sign * 0.018
        down = Vector((sign * 0.12, 0.2, -1)).normalized() * r["ends"]
        v = [bm.verts.new(a), bm.verts.new(b), bm.verts.new(b + down), bm.verts.new(a + down)]
        faces.append(bm.faces.new(v))
    uvl = bm.loops.layers.uv[atlas.ATLAS]
    for f in faces:
        f.material_index = 1
        f.smooth = True
        for k, lp in enumerate(f.loops):
            lp[uvl].uv = (2.0 + 0.05 * (k in (1, 2)), -0.05 * (k >= 2))
    bmesh.ops.triangulate(bm, faces=faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.materials.append(atlas.part(bpy.data.materials.new(obj.name + "-ribbon"), atlas.linear(r["colour"]),
                                         "fixed"))


def weigh(obj, arm, nape, tail_path):
    """On the head down to the nape. Below it a queue hangs along the spring
    joints that hang from the head; a braid long enough to lie on the back
    goes over to the chest's bone, so it lies where the back is."""
    springs = [arm.data.bones[f"spring_{i:02d}"] for i in range(1, 5)]
    long_ = tail_path is not None and tail_path[-1].z < nape - 0.2
    groups = {}

    def group(name):
        if name not in groups:
            groups[name] = obj.vertex_groups.new(name=name)
        return groups[name]

    for v in obj.data.vertices:
        if v.co.z >= nape:
            group("head").add([v.index], 1.0, "REPLACE")
            continue
        if long_:
            s = float(np.clip((nape - v.co.z) / 0.1, 0, 1))
            if s < 1:
                group("head").add([v.index], 1 - s, "REPLACE")
            if s > 0:
                group("spine_03").add([v.index], s, "REPLACE")
            continue
        nearest = min(springs, key=lambda b: abs((b.head_local.z + b.tail_local.z) / 2 - v.co.z))
        group(nearest.name).add([v.index], 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
