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
  own half width), lobes (a braid's), splay (how far it goes out to its
  side, as x a metre of fall), pair (true: two, the gather point's and
  its mirror image's: a pair of braids)};
- ribbon: {colour, at (a share of the tail's length), width} ties the
  tail; and, for a queue, ends: how long its two ends hang;
- strands, thickness: how many strands, and how thick at the root;
- crown: a cap's extra volume at the top of the head (a thick crown of
  hair standing up), over its top crown-depth metres;
- clear: long hair falling loose below the nape, kept this far off the
  back (over the clothes); coil: {radius, pitch} winds each strand below
  the nape into a ringlet (long curls).

Every strand is grown on the figure's right and mirrored, so the shell is
its own mirror. Its UVs are one island: a projection round the head,
continued down the tail.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

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
        if p["gather"][0] == 0:
            # On the middle, though the drawn body is not quite its own
            # mirror.
            loc, n = loc.copy(), n.copy()
            loc.x = n.x = 0.0
            n.normalize()
        # Set out by the tail's own half width, so its root is not in the
        # nape.
        gather = loc + n * (p.get("volume", 0.008) * 0.5 + (p.get("tail") or {}).get("width", 0.03) * 0.3)
        if (p.get("tail") or {}).get("kind") == "bun":
            # A bun is pinned on the hair, not hung from it.
            gather = loc + n * p.get("volume", 0.008)
    tail = p.get("tail") or {}
    bun_ = tail.get("kind") == "bun"
    tail_path = None
    if gather is not None and tail and not bun_:
        tail_path = tail_line(gather, tail, tree, nape)
    tail_budget = int(budget * tail.get("share", 0.4)) if tail_path is not None or (bun_ and gather) else 0
    if tail_path is not None and tail.get("pair"):
        tail_budget *= 2
    ribbon_budget = RIBBON_TRIANGLES * (2 if tail.get("pair") else 1) if p.get("ribbon") else 0
    curls_budget = int(budget * sum(c.get("share", 0.2) for c in p.get("curls") or []))
    shell_budget = budget - tail_budget - ribbon_budget - curls_budget

    obj = None
    if p.get("shell") == "cap":
        obj = cap(spec["id"], human, scalp, p, drawn, under_hat, shell_budget, float(marks.joint("neck")[2]))
        # Hair hidden under a scarf has no strands to bake: through it,
        # they would darken the scarf.
        if p.get("details", True):
            DETAILS.append(strands_on(obj, human, scalp, p, head, nape, gather))
        else:
            # Collapsed without strands to shade it, a cap may meet three
            # faces on an edge: mended before its UVs are laid.
            lod.manifold(obj)
    elif p.get("shell") != "none":
        obj = grown(spec["id"], human, scalp, p, tree, head, nape, shell_budget)
        off_skin(obj, drawn)
        if under_hat is not None:
            press(obj, drawn, under_hat[0])
    if obj is not None:
        # A collapse is its own mirror only roughly.
        garment.mirror(obj, 0.02, greedy=True)
        if p.get("clear"):
            # Long hair lies over itself seen round the head: projected by
            # its faces' directions, as curls are (uv-angle: finer, so a
            # wave does not fold an island over itself).
            atlas.prepare(obj, angle=p.get("uv-angle", 1.15))
        else:
            project(obj, head, nape, None)

    def add(part):
        nonlocal obj
        if obj is None:
            part.name = part.data.name = spec["id"]
            obj = part
        else:
            join(obj, part)

    if tail_path is not None:
        # The tail made directly, a tube round its line with its own UVs.
        tail_obj = plait(spec["id"] + "-tail", tail_path, tail)
        # Its root on the hair it hangs from, not under it.
        off_skin(tail_obj, drawn, p.get("volume", OFF_SKIN) if p.get("shell") == "cap" else OFF_SKIN)
        if tail.get("pair"):
            # Two, one each side: the second the first's mirror image, so
            # the hair is still its own mirror.
            add(mirrored(tail_obj))
        add(tail_obj)
    if bun_ and gather is not None:
        b = bun(spec["id"] + "-bun", gather, tail, tail_budget)
        off_skin(b, drawn, p.get("volume", OFF_SKIN))
        # A bun is on the head, however low it sits.
        nape = min(nape, min(v.co.z for v in b.data.vertices) - 0.01)
        add(b)
    lowest_curl = None
    for c in p.get("curls") or []:
        part, path = curls(spec["id"] + "-curls", human, marks, c, tree, drawn, int(budget * c.get("share", 0.2)))
        # Curls overlap themselves seen from any one side: projected by
        # their own faces' directions, a few islands.
        atlas.prepare(part)
        add(part)
        if lowest_curl is None or path[-1].z < lowest_curl[-1].z:
            lowest_curl = path
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.materials.append(atlas.part(bpy.data.materials.new(spec["id"]), None, "hair"))
    if p.get("ribbon") and tail_path is not None:
        ribbon(obj, tail_path, p["ribbon"], tail)
        if tail.get("pair"):
            ribbon(obj, [Vector((-c.x, c.y, c.z)) for c in tail_path], p["ribbon"], tail, material=False)
    lod.clean(obj)
    if p.get("curls") or p.get("clear"):
        # Curls and long hair merged may meet three faces on an edge.
        lod.manifold(obj)
    weigh(obj, arm, nape, tail_path or lowest_curl, long_hair=bool(p.get("clear")))
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
    # A crown standing up: more volume toward the top of the head, over
    # its last crown-depth metres.
    top = max(v.co.z for v in bm.verts)
    crown, depth = p.get("crown", 0.0), p.get("crown-depth", 0.08)
    for v in bm.verts:
        t = float(np.clip(dist[v] / taper, 0, 1))
        up = float(np.clip((v.co.z - (top - depth)) / depth, 0, 1))
        off = HAIRLINE + (volume + crown * up * up * (3 - 2 * up) - HAIRLINE) * t * t * (3 - 2 * t)
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
    rng_coil = np.random.default_rng(p.get("seed", 1) + 7)
    for r in roots:
        path = comb(Vector(co[r]), human.data.vertices[r].normal, p, tree, head, nape)
        if p.get("coil"):
            path = coil(path, p["coil"], nape, rng_coil)
        tube(out, path, p.get("thickness", 0.012))
        tube(out, [Vector((-c.x, c.y, c.z)) for c in path], p.get("thickness", 0.012))
    obj = merged(name, out, p)
    inner_wall(obj, tree)
    # Collapsed as one half and mirrored, so it is its own mirror vertex
    # for vertex, as a cap is.
    half(obj)
    lod.decimate(obj, budget // 2)
    unhalf(obj)
    lod.manifold(obj)
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
    # (Below the nape, long hair is kept off the back by clear: over the
    # clothes, not in them.)
        loc, n, _, dist = tree.find_nearest(pos)
        if loc is not None and pos.z >= nape:
            d -= n * d.dot(n)
        d.normalize()
        pos = pos + d * STEP
        loc, n, _, dist = tree.find_nearest(pos)
        least = volume if pos.z >= nape or not p.get("clear") else p["clear"]
        if loc is not None and (pos - loc).dot(n) < least:
            pos = loc + n * least
        path.append(pos.copy())
        walked += STEP
        if gather is not None and (pos - gather).length < 0.012:
            break
    return path


def coil(path, c, nape, rng):
    """A strand's path wound into a ringlet below the nape: a helix of c's
    radius and pitch round it, growing in over its first centimetres."""
    out = []
    phase = rng.uniform(0, 2 * np.pi)
    r = c.get("radius", 0.01) * rng.uniform(0.8, 1.2)
    walked = 0.0
    for i, q in enumerate(path):
        if i:
            walked += (q - path[i - 1]).length
        if q.z >= nape:
            out.append(q)
            continue
        ahead = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        side = ahead.cross(Vector((0, 1, 0)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(ahead)
        grow = min(1.0, (nape - q.z) / 0.03)
        th = phase + 2 * np.pi * walked / c.get("pitch", 0.03)
        out.append(q + (side * np.cos(th) + up * np.sin(th)) * r * grow)
    # Finer steps than the comb's, so the helix is round.
    fine = []
    for i in range(len(out) - 1):
        for u in np.linspace(0, 1, 3, endpoint=False):
            fine.append(out[i].lerp(out[i + 1], u))
    fine.append(out[-1])
    return fine


def tail_line(gather, t, tree, nape):
    """The tail's middle line from the gather point: down and a little
    back, and below the nape lying on the figure's back (off the skin by
    its own half width and the clothes' room)."""
    length = t.get("length", 0.12)
    lean = t.get("lean", 0.15)
    clear = t.get("clear", 0.03)
    # Out to its own side, as x a metre of fall (a pair of tails, apart).
    splay = t.get("splay", 0.0) * (1 if gather.x > 0 else -1)
    # A tail from the middle stays on it, though the body under it is not
    # quite its own mirror.
    middle = abs(gather.x) < 1e-6
    pts = [gather.copy()]
    pos = gather.copy()
    walked = 0.0
    while walked < length:
        pos = pos + Vector((splay, lean, -1)).normalized() * STEP
        # Clear of the neck and back all the way down, eased in from the
        # gather point over its first centimetre and a half.
        want = clear * min(1.0, walked / 0.015)
        loc, n, _, _ = tree.find_nearest(pos)
        if loc is not None and (pos - loc).dot(n) < want:
            pos = loc + n * want
        if middle:
            pos.x = 0.0
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


def mirrored(obj):
    """A copy of obj mirrored across the figure's middle, its faces turned
    so they still face out."""
    me = obj.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    twin = bpy.data.objects.new(obj.name + "-mirror", me)
    bpy.context.scene.collection.objects.link(twin)
    return twin


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


def ribbon(obj, path, r, t, material=True):
    """A ribbon round the tail at a share of its length, in its own colour,
    joined to the hair as a second material (a second ribbon, of a pair of
    tails, sharing the first's); a queue's with two ends hanging below
    it."""
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
    if material:
        obj.data.materials.append(atlas.part(bpy.data.materials.new(obj.name + "-ribbon"), atlas.linear(r["colour"]),
                                             "fixed"))


def weigh(obj, arm, nape, tail_path, long_hair=False):
    """On the head down to the nape. Below it a queue hangs along the spring
    joints that hang from the head; a braid long enough to lie on the back,
    or long hair falling loose on it, goes over to the chest's bone, so it
    lies where the back is."""
    springs = [arm.data.bones[f"spring_{i:02d}"] for i in range(1, 5)]
    long_ = long_hair or (tail_path is not None and tail_path[-1].z < nape - 0.2)
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


# --- Beards, buns and curls ---------------------------------------------


def make_beard(b, human, marks, arm, budget, skin):
    """A beard, a mesh of its own on the face, coloured as the hair is and
    moving as the skin under it does."""
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    drawn = BVHTree.FromBMesh(bm)
    bm.free()
    obj = beard("beard", human, marks, b, drawn, min(budget, b.get("triangles", budget)))
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.materials.append(atlas.part(bpy.data.materials.new("beard"), None, "hair"))
    lod.clean(obj)
    lod.manifold(obj)
    skin_weights(obj, skin, range(len(obj.data.vertices)))
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
    return obj


def beard(name, human, marks, b, drawn, budget):
    """A beard: the skin of the jaw, chin and cheeks below a line, and the
    upper lip's (a moustache) if asked, stood off the face by its volume,
    thicker and longer at the chin, its edge tapering in to the skin over
    the taper's metres and turned down to it. The lips are left bare. Its
    params: volume, taper, cheek (the line at the side, below the eyes),
    moustache (the line over the upper lip, above the lips' middle, or
    false), mouth (the lips' half width left bare), under (how far above
    the neck's joint it ends under the jaw), back (how far in front of the
    head's joint it ends at the sideburn), chin (how much further the chin
    stands, down and forward), share (of the hair's triangles)."""
    co = body.coords(human)
    on = body.in_group(human, "body")
    eyes = (marks.joint("l-eye") + marks.joint("r-eye")) / 2
    head = marks.joint("head")
    neck = marks.joint("neck")
    lips_z = eyes[2] - 0.065
    middle = on & (np.abs(co[:, 0]) < 0.004) & (np.abs(co[:, 2] - lips_z) < 0.01) & (co[:, 1] < head[1])
    lips_y = float(co[middle, 1].min())
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    ax = np.abs(x)
    cheek = eyes[2] - b.get("cheek", 0.035)
    moustache = b.get("moustache", 0.018)
    top_mid = lips_z + moustache if moustache else lips_z - 0.012
    # The top line: over the upper lip at the middle, past the mouth's
    # corners, then rising across the cheek to the sideburn before the
    # ear, where it is highest.
    corner = b.get("corner", 0.03)
    top = np.interp(ax, [0.0, corner, corner + 0.02, 0.075, 0.2],
                    [top_mid, top_mid + 0.004, cheek - 0.022, cheek, cheek + b.get("sideburn", 0.0)])
    # Below: under the jaw, from a little below the chin's point at the
    # front back to below the ear, rising along the jaw's line.
    chin = marks.chin
    ear_y = head[1] + b.get("back", -0.01)
    s = np.clip((y - chin[1]) / max(ear_y - chin[1], 1e-3), 0, 1)
    floor = (chin[2] - b.get("under", 0.012)) * (1 - s) + (lips_z - b.get("jaw", 0.02)) * s
    region = on & (z < top) & (z > floor) & (y < ear_y)
    # The lips, bare.
    mouth = b.get("mouth", 0.027)
    lips = ((x / mouth) ** 2 + ((z - lips_z + 0.001) / b.get("lips", 0.0095)) ** 2 < 1) & (y < lips_y + 0.02)
    region &= ~lips
    # Clean below the lower lip at the middle, down to the chin's beard.
    region &= ~((np.abs(x) < b.get("below-lip", 0.0)) & (z > lips_z - 0.024) & (z < lips_z) & (y < lips_y + 0.02))

    bm = bmesh.new()
    bm.from_mesh(human.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not region[v.index]], context="VERTS")
    for g in list(bm.verts.layers.deform):
        bm.verts.layers.deform.remove(g)
    # Only the largest piece: a speck cut off by the line goes.
    _largest(bm)
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
    loop = {v: [e.other_vert(v) for e in v.link_edges if e.is_boundary] for v in edge}
    for _ in range(4):
        moved = {v: (v.co + sum((w.co for w in ns), Vector())) / (1 + len(ns)) for v, ns in loop.items()}
        for v, c in moved.items():
            v.co = c
    volume, taper = b.get("volume", 0.008), b.get("taper", 0.012)
    chin = b.get("chin", 0.0)
    chin_z = lips_z - 0.045
    for v in bm.verts:
        t = float(np.clip(dist.get(v, taper) / taper, 0, 1))
        off = HAIRLINE + (volume - HAIRLINE) * t * t * (3 - 2 * t)
        loc, n, _, _ = drawn.find_nearest(v.co)
        if loc is None:
            continue
        p = loc + n * off
        # The chin's beard fuller, down and a little forward, most at the
        # middle below the lips.
        if chin:
            s = float(np.exp(-(v.co.x / 0.035) ** 2)) * float(np.clip((lips_z - 0.015 - v.co.z) / 0.03, 0, 1))
            s *= t
            p = p + Vector((0, -0.15, -1)).normalized() * chin * s
        v.co = p
    for _ in range(b.get("smooth", 2)):
        bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if not v.is_boundary], factor=0.5,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
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
    half(obj)
    lod.decimate(obj, budget // 2)
    unhalf(obj)
    off_skin(obj, drawn, HAIRLINE * 0.25)
    DETAILS.append(beard_strands(obj, b))
    # Its UVs by projection: a few islands (the chin's underside apart
    # from its front, which a projection from the front would lay on it).
    atlas.prepare(obj)
    return obj


def beard_strands(obj, b):
    """A beard's strands laid on it, half sunk, falling down its surface
    and in toward the chin: their shadow in the bake draws the hair's
    lines. Not drawn, not exported."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    faces = [f for f in bm.faces if f.calc_area() > 0]
    areas = np.array([f.calc_area() for f in faces])
    rng = np.random.default_rng(b.get("seed", 5))
    picks = rng.choice(len(faces), size=b.get("strands", 500), p=areas / areas.sum())
    thick = b.get("thickness", 0.0022)
    out = bmesh.new()
    for i in picks:
        f = faces[i]
        w = rng.dirichlet((1, 1, 1)) if len(f.verts) == 3 else None
        start = sum((v.co * float(k) for v, k in zip(f.verts, w)), Vector()) if w is not None \
            else f.calc_center_median()
        if start.x > 0:
            continue
        pos = start.copy()
        path = []
        for _ in range(int(b.get("strand", 0.018) / 0.003)):
            loc, n, _, _ = tree.find_nearest(pos)
            if loc is None:
                break
            pos = loc + n * thick * 0.2
            path.append(pos.copy())
            d = Vector((-pos.x * 2, -0.25, -1))
            d -= n * d.dot(n)
            if d.length < 1e-6:
                break
            pos = pos + d.normalized() * 0.003
        if len(path) > 2:
            tube(out, path, thick, sides=4)
            tube(out, [Vector((-c.x, c.y, c.z)) for c in path], thick, sides=4)
    bm.free()
    me = bpy.data.meshes.new(obj.name + "-strands")
    out.to_mesh(me)
    out.free()
    d = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(d)
    return d


def edge_to_skin(obj, skin):
    """A shell's open edges brought down to the skin, as when it was made."""
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        if v.is_boundary:
            loc, n, _, _ = tree.find_nearest(v.co)
            if loc is not None:
                v.co = loc + n * 0.0005
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def _largest(bm):
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
    bmesh.ops.delete(bm, geom=[v for part in parts[1:] for v in part], context="VERTS")


def bun(name, at, t, budget):
    """A bun: hair coiled at the back of the head, a round knot flattened
    against it, a coil's turns round it."""
    w, h, d = t.get("width", 0.055), t.get("height", 0.045), t.get("depth", 0.03)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new(atlas.ATLAS)
    rings, sides = 8, 16
    turns = t.get("turns", 1.5)
    out = Vector((0, 1, -t.get("droop", 0.2))).normalized()
    up = Vector((0, 0, 1))
    up = (up - out * up.dot(out)).normalized()
    across = out.cross(up)
    # Its front sunk a little into the hair it is pinned to.
    centre = at + out * (d * 0.5 - 0.006)
    grid = []
    for r in range(rings + 1):
        e = np.pi * (r / rings - 0.5)
        row = []
        for s in range(sides):
            a = 2 * np.pi * s / sides
            # The coil: a groove that winds round the bun from its middle
            # out.
            groove = 1 - 0.08 * max(0.0, np.cos(turns * 2 * np.pi * r / rings)) ** 4
            p = (centre + across * (np.cos(e) * np.cos(a) * w / 2 * groove)
                 + up * (np.cos(e) * np.sin(a) * h / 2 * groove) + out * (np.sin(e) * d / 2))
            row.append(bm.verts.new(p))
        grid.append(row)
    for r in range(rings):
        for s in range(sides):
            n = (s + 1) % sides
            f = bm.faces.new((grid[r][s], grid[r][n], grid[r + 1][n], grid[r + 1][s]))
            for lp, (u, v) in zip(f.loops, ((s, r), (s + 1, r), (s + 1, r + 1), (s, r + 1))):
                lp[uv].uv = (14 + u / sides * 0.6, v / rings * 0.3)
    # The poles' rings collapsed to points: merged.
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if budget and lod.triangles(obj) > budget:
        lod.decimate(obj, budget)
    return obj


def curls(name, human, marks, c, tree, drawn, budget):
    """Curls escaping from under a scarf or a hat: from roots along the
    head at a height, between two azimuths, each strand a helix round a
    line falling from its root (a tail's, kept off the neck and back), the
    strands of the cluster merged into one solid and its mirror. Its params:
    azimuth and spread (degrees, the cluster's middle and width; 0 the
    front), z (the roots' height above the neck's joint), count (strands
    a side), length, radius (of the helix), pitch, thickness, clear, lean,
    seed, share (of the hair's triangles). Returns the solid and its
    longest strand's line."""
    head = Vector(marks.joint("head"))
    neck = marks.joint("neck")
    rng = np.random.default_rng(c.get("seed", 3))
    z0 = neck[2] + c.get("z", 0.04)
    out = bmesh.new()
    longest = None
    a0, spread = np.radians(c.get("azimuth", 180)), np.radians(c.get("spread", 90))
    count = c.get("count", 6)
    radius, pitch = c.get("radius", 0.008), c.get("pitch", 0.014)
    for k in range(count):
        # On the figure's right (x ≤ 0): azimuths past the middle there.
        a = a0 + spread / 2 * (k + 0.5) / count * (1 if np.sin(a0 + 0.01) <= 0 else -1)
        if abs(np.sin(a0)) > 0.5:
            # A cluster off the middle (at a temple) is made on the right
            # and mirrored: its azimuths about its middle, on the right.
            a = -abs(a0) + spread * ((k + 0.5) / count - 0.5)
        d = Vector((np.sin(a), -np.cos(a), 0))
        loc, n, _, _ = drawn.ray_cast(Vector((head.x, head.y, z0 + rng.uniform(-0.006, 0.006))) + d * 0.3, -d, 0.5)
        if loc is None:
            continue
        length = c.get("length", 0.1) * rng.uniform(0.75, 1.1) * (1 - 0.3 * abs(np.sin(a - a0)))
        root = loc + n * (c.get("thickness", 0.006) * 0.5)
        line = tail_line(root, {"length": length, "lean": c.get("lean", 0.1), "clear": c.get("clear", 0.03)},
                         tree, root.z)
        if longest is None or line[-1].z < longest[-1].z:
            longest = line
        phase = rng.uniform(0, 2 * np.pi)
        r = radius * rng.uniform(0.8, 1.2)
        path = []
        walked = 0.0
        for i, p in enumerate(line):
            if i:
                walked += (p - line[i - 1]).length
            ahead = (line[min(i + 1, len(line) - 1)] - line[max(i - 1, 0)]).normalized()
            side = ahead.cross(Vector((0, 1, 0)))
            if side.length < 1e-6:
                side = Vector((1, 0, 0))
            side.normalize()
            up = side.cross(ahead)
            th = phase + 2 * np.pi * walked / pitch
            grow = min(1.0, walked / 0.01)
            path.append(p + (side * np.cos(th) + up * np.sin(th)) * r * grow)
        # Finer steps than the line's, so the helix is round.
        fine = []
        for i in range(len(path) - 1):
            for u in np.linspace(0, 1, 4, endpoint=False):
                fine.append(path[i].lerp(path[i + 1], u))
        fine.append(path[-1])
        tube(out, fine, c.get("thickness", 0.006), sides=6)
        tube(out, [Vector((-q.x, q.y, q.z)) for q in fine], c.get("thickness", 0.006), sides=6)
    obj = merged(name, out, {"voxel": c.get("voxel", 0.0025), "smooth": c.get("smooth", 3)})
    off_skin(obj, drawn)
    half(obj)
    lod.decimate(obj, max(budget // 2, 40))
    unhalf(obj)
    return obj, longest


def skin_weights(obj, skin, vertices):
    """The vertices given take the weights of the skin's nearest vertex."""
    co = body.coords(skin)
    tree = KDTree(len(co))
    for i, p in enumerate(co):
        tree.insert(p, i)
    tree.balance()
    names = {g.index: g.name for g in skin.vertex_groups}
    groups = {g.name: g for g in obj.vertex_groups}
    for i in vertices:
        v = obj.data.vertices[i]
        _, j, _ = tree.find(v.co)
        for g in list(v.groups):
            obj.vertex_groups[g.group].remove([i])
        for g in skin.data.vertices[j].groups:
            name = names[g.group]
            if name not in groups:
                groups[name] = obj.vertex_groups.new(name=name)
            groups[name].add([i], g.weight, "REPLACE")
