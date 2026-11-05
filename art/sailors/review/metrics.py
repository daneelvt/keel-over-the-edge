# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The gates: what code checks of every sailor before anyone looks at it.

Each gate measures one thing and holds it to a limit; a build writes
every gate's measure to metrics.json in its run, and fails on any gate
that does not pass, after the sheet is drawn (so the failure can be seen).
Vision misses what these catch: floating parts, counts, symmetry, a
millimetre of cloth under the skin.

- budget: triangles in each mesh and the figure, within the level's;
- mesh: no edge shared by more than two faces, no loose vertex or edge,
  no face of no area, no open edge on a part declared closed;
- weights: every vertex on at most four of the skeleton's bones, summing
  to one, on no other group;
- skeleton: the file's joints the skeleton's, in tables.yaml's order;
- poke: nothing of the body through a garment, nor of a garment through
  one over it, at rest and in every test pose (rays in along the normals
  of what is under, against what is over); nothing of the thighs or
  knees through a skirt in any frame of a clip that stands (measured, not
  yet held, in the clips placed in the boat);
- seat: nothing through the boat in the poses seated in it (the line from
  each vertex's nearest bone to it, and the skeleton from above, cross
  nothing; cloth the seat lift lays on the boat is under no top of the
  deck or hull);
- float: every part within 3 mm of another (a hat of the head or hair, a
  garment's band of the garment), at the close and deck levels;
- figure: the dressed figure within reach of the bare one (the waist, the
  shoulders, the rear in profile, the shoulders' top line as the front
  view sees it; under a woman's bust, a fitted garment returning);
- bust: a woman machine's bust shaped in her plates (each apex forward of
  the cleft between them, the plates returning under it) and seen from
  the front, the coat open over it;
- symmetry: each mesh its own mirror within 1 mm, unless declared not, at
  the close and deck levels (the far is posed);
- atlas: the UVs inside the square, no two triangles on one texel (but
  slivers under a texel, which carry no texture of their own);
- file: the meshes, skeleton and clips expected, within its size.
"""

import gzip
import json
import math
import os

import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import motion

# The body's own bones: what a vertex is anchored to, testing the seat.
BODY_BONES = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head", "clavicle", "upperarm", "lowerarm",
              "hand", "thigh", "calf", "foot", "ball")

# How far apart parts may be and still touch, and how far in a ray looks
# for what pokes through.
TOUCH = 0.003
POKE_DEPTH = 0.03
# What is under a garment, at rest: within its ease and this.
UNDER = 0.02
SYMMETRY = 0.001
ZERO_AREA = 1e-9
# The figure: the shoulders over the bare body, the rear in profile, the
# shoulders' top line, under the bust.
SHOULDER_OVER = 0.02
REAR_OVER = 0.03
TOP_LINE = 0.015
BUST_RETURN = 0.02
# A woman machine's bust: each apex this far forward of the plates at the
# middle, at its height.
BUST_CLEFT = 0.01


class Gates:
    """One version's gates, level by level."""

    def __init__(self, name):
        self.name = name
        self.levels = {}

    def add(self, level, gate, value, limit, ok, **detail):
        self.levels.setdefault(level, {})[gate] = {"value": _round(value), "limit": _round(limit), "ok": bool(ok),
                                                   **{k: _round(v) for k, v in detail.items()}}

    def failures(self):
        return [f"{self.name} {lv} {g}: {r['value']} (limit {r['limit']})"
                for lv, gates in self.levels.items() for g, r in gates.items() if not r["ok"]]


# --- Counts and meshes --------------------------------------------------


def budget(gates, level, tris, limits, kinds):
    for mesh, n in tris.items():
        kind = "body" if mesh == "body" else kinds.get(mesh, "figure")
        if kind in limits:
            gates.add(level, f"budget {mesh}", n, limits[kind], n <= limits[kind])
    total = sum(tris.values())
    gates.add(level, "budget figure", total, limits["figure"], total <= limits["figure"])


def mesh(gates, level, obj, closed=False):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    over = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    loose_v = sum(1 for v in bm.verts if not v.link_edges)
    loose_e = sum(1 for e in bm.edges if not e.link_faces)
    zero = sum(1 for f in bm.faces if f.calc_area() < ZERO_AREA)
    open_ = sum(1 for e in bm.edges if len(e.link_faces) == 1) if closed else 0
    bm.free()
    bad = over + loose_v + loose_e + zero + open_
    gates.add(level, f"mesh {obj.name}", bad, 0, bad == 0, non_manifold=over, loose_vertices=loose_v,
              loose_edges=loose_e, zero_area=zero, open_edges=open_)


def weights(gates, level, obj, bones):
    bones = set(bones)
    names = {g.index: g.name for g in obj.vertex_groups}
    bare = over = unnormal = 0
    # The group that lays skirts on the seat is the build's, not a bone's.
    foreign = sorted({n for n in names.values() if n not in bones and n != motion.SEAT_GROUP})
    for v in obj.data.vertices:
        ws = [g.weight for g in v.groups if g.weight > 0 and names.get(g.group) in bones]
        if not ws:
            bare += 1
        if len(ws) > 4:
            over += 1
        if ws and abs(sum(ws) - 1.0) > 1e-3:
            unnormal += 1
    bad = bare + over + unnormal + len(foreign)
    gates.add(level, f"weights {obj.name}", bad, 0, bad == 0, unweighted=bare, over_four=over,
              unnormalised=unnormal, other_groups=foreign)


def skeleton(gates, level, gltf, order):
    skins = gltf.get("skins", [])
    names = [gltf["nodes"][j]["name"] for j in skins[0]["joints"]] if skins else []
    gates.add(level, "skeleton", len(names), len(order), names == order,
              first_difference=next((f"{a} for {b}" for a, b in zip(names, order) if a != b), None))


# --- Poke-through -------------------------------------------------------


def layers(worn, ease):
    """Each mesh's place in the stack, and how far off what is under it it
    stands: the body under everything, the garments by their ease, the
    hair over them (a braid lies on the coat), a machine's plates on its
    coat, a hat over all."""
    out = {"body": (0.0, 0.0)}
    for w in worn:
        if w.kind == "garment":
            p = w.spec.get("params") or {}
            e = ease[p.get("layer", w.spec["family"])]
            out[w.obj.name] = (e, e)
        elif w.kind == "hair":
            out[w.obj.name] = (0.5, 0.01)
        elif w.kind == "hat":
            out[w.obj.name] = (1.0, 0.01)
        elif w.kind == "plate":
            # A machine's plates lie on its coat.
            out[w.obj.name] = (0.9, 0.01)
    return out


def under_pairs(meshes, lay):
    """At rest: which vertices of each mesh lie under which part over it
    (within the part's ease and a little more)."""
    posed = {o.name: motion.coords_posed(o) for o in meshes}
    pairs = []
    for g in meshes:
        if g.name not in lay or g.name == "body":
            continue
        tree = _tree(g, posed[g.name][0])
        for u in meshes:
            if u.name not in lay or lay[u.name][0] >= lay[g.name][0]:
                continue
            co = posed[u.name][0]
            reach = lay[g.name][1] + UNDER
            idx = [i for i, p in enumerate(co) if tree.find_nearest(Vector(p), reach)[0] is not None]
            if idx:
                pairs.append((u, g, np.array(idx)))
    return pairs


def poke(fig, pairs, depths=None, sided=False, above=None):
    """How many vertices of what is under come through what is over, as
    the figure stands now: a ray in from the vertex, along its normal,
    meets the garment within POKE_DEPTH (sided: and meets it from its
    outer side, so a part facing away from cloth beside it is not through
    it, and further than TOUCH into it; above: only what is above that
    height). Returns the count and, by
    mesh, the vertices; and fills depths, if
    given, with each one's (how far in the garment is, the vertex's
    normal), by (mesh, vertex)."""
    posed = {}
    hits = {}
    n = 0
    for u, g, idx in pairs:
        for o in (u, g):
            if o.name not in posed:
                posed[o.name] = motion.coords_posed(o)
        tree = _tree(g, posed[g.name][0])
        co, no = posed[u.name]
        for i in idx:
            if above is not None and co[i][2] < above:
                continue
            p, d = Vector(co[i]), -Vector(no[i])
            hit = tree.ray_cast(p + d * 1e-4, d, POKE_DEPTH)
            if hit[0] is not None and (not sided or (p - hit[0]).dot(hit[1]) > 0 and hit[3] > TOUCH):
                n += 1
                hits.setdefault(u.name, []).append(int(i))
                through = poke.through.setdefault(u.name, set())
                through.add(g.name)
                if depths is not None:
                    key = (u.name, int(i))
                    if hit[3] > depths.get(key, (0.0, None))[0]:
                        depths[key] = (hit[3], no[i])
    return n, hits


# What each under mesh came through, by its name, since the last poses().
poke.through = {}

# The bones whose parts a skirt hangs over and they move under it: the
# hips' own are carried with the cloth at its top, and seated sit on it.
UNDER_SKIRT = ("thigh", "calf")


def skirt_pairs(meshes, worn):
    """What of the body each skirt hangs over, in any clip: every vertex
    the thighs and knees carry, wherever it is at rest (a thigh swung back
    reaches a skirt it was far from)."""
    body = next((o for o in meshes if o.name == "body"), None)
    skirts = [w.obj for w in worn if w.kind == "garment" and (w.spec.get("params") or {}).get("skirt")]
    if body is None or not skirts:
        return []
    names = {g.index: g.name for g in body.vertex_groups}
    idx = []
    for v in body.data.vertices:
        ws = [(g.weight, names.get(g.group, "")) for g in v.groups]
        if ws and motion.kind(max(ws)[1]) in UNDER_SKIRT:
            idx.append(v.index)
    return [(body, s, np.array(idx)) for s in skirts] if idx else []


def poses(gates, level, fig, lib, worn, ease, names):
    """Poke-through at rest and in every test pose; returns the poses'
    hits for the sheet's map."""
    fig.reset()
    lay = layers(worn, ease)
    pairs = under_pairs(fig.meshes, lay)
    maps = {}
    for name in ["rest"] + list(names):
        if name == "rest":
            fig.reset()
        else:
            fig.pose(lib.poses[name])
        poke.through = {}
        n, hits = poke(fig, pairs)
        maps[name] = hits
        where = {}
        for mesh, idx in hits.items():
            co = motion.coords_posed(next(o for o in fig.meshes if o.name == mesh))[0][idx]
            where[mesh] = [len(idx)] + [round(float(x), 3) for x in co.mean(0)] + sorted(poke.through.get(mesh, ()))
        gates.add(level, f"poke {name}", n, 0, n == 0, at=where)
    fig.reset()
    return maps


# --- The boat -----------------------------------------------------------


def seat(gates, level, fig, lib, names):
    """Nothing through the boat in the poses seated in it. Returns, by
    pose, the vertices through it, by mesh."""
    maps = {}
    for name in names:
        fig.pose(lib.poses[name])
        through, hits = through_boat(fig, fig.meshes)
        maps[name] = hits
        where = {}
        for mesh, idx in hits.items():
            if idx:
                co = motion.coords_posed(next(o for o in fig.meshes if o.name == mesh))[0][idx]
                where[mesh] = [len(idx)] + [round(float(x), 3) for x in co.mean(0)]
        gates.add(level, f"seat {name}", through["vertices"] + through["bones"], 0,
                  through["vertices"] + through["bones"] == 0, at=where, **through)
    fig.reset()
    return maps


def through_boat(fig, meshes):
    """What of the figure as it stands is through the boat: the bones
    whose line from above the boat, down the skeleton, crosses it, and
    the vertices whose line from their nearest bone crosses it."""
    stage = fig.stage
    segs = [(fig.world(b.name), fig.world(b.name, "tail")) for b in fig.arm.data.bones
            if motion.kind(b.name) in BODY_BONES]
    hips = fig.world("pelvis")
    names = [b.name for b in fig.arm.data.bones if motion.kind(b.name) in BODY_BONES]
    crossed = ["pelvis from above"] if stage.crossings([Vector((hips.x, hips.y, 3.0))], [hips]) else []
    crossed += [f"{names[i]} {[round(float(x), 3) for x in segs[i][0]]}→{[round(float(x), 3) for x in segs[i][1]]}"
                for i in stage.crossed(*zip(*segs))]
    a = np.array([np.array(s[0]) for s in segs])
    b = np.array([np.array(s[1]) for s in segs])
    hits = {}
    examples = []
    for o in meshes:
        co, _ = motion.coords_posed(o)
        if motion.SEAT_GROUP in o.vertex_groups:
            # Cloth laid on the boat (a skirt on the seat): through it if,
            # straight up, it is under the top of the deck or hull. A line
            # from the thigh beside it, which drops into the cockpit, would
            # cross the deck's edge under cloth lying on the deck.
            hits[o.name] = [i for i, p in enumerate(co) if stage.under(p)]
            for i in hits[o.name][:1]:
                examples.append({"mesh": o.name, "under": [round(float(x), 3) for x in co[i]]})
            continue
        anchors = _nearest_on_segments(co, a, b)
        hits[o.name] = stage.crossed(anchors, co)
        for i in hits[o.name][:2]:
            d = Vector(co[i]) - Vector(anchors[i])
            hit = stage.tree.ray_cast(Vector(anchors[i]), d.normalized(), d.length)[0]
            examples.append({"mesh": o.name, "from": [round(float(x), 3) for x in anchors[i]],
                             "to": [round(float(x), 3) for x in co[i]], "meets": [round(float(x), 3) for x in hit]})
    return {"vertices": sum(len(h) for h in hits.values()), "bones": len(crossed), "crossed": crossed,
            "lines": examples}, hits


def keep_off_boat(fig, pose, obj):
    """A rigid mesh's vertices brought back short of the boat, posed as it
    was made (seat): the line from each one's bone to it crossing nothing.
    Returns how many moved."""
    fig.pose(pose)
    segs = [(fig.world(b.name), fig.world(b.name, "tail")) for b in fig.arm.data.bones
            if motion.kind(b.name) in BODY_BONES]
    a = np.array([np.array(s[0]) for s in segs])
    b = np.array([np.array(s[1]) for s in segs])
    co, _ = motion.coords_posed(obj)
    anchors = _nearest_on_segments(co, a, b)
    moved = fig.stage.keep_out(anchors, co)
    changed = np.flatnonzero(np.abs(moved - co).max(axis=1) > 0)
    inv = np.array(obj.matrix_world.inverted())
    for i in changed:
        obj.data.vertices[i].co = Vector(inv[:3, :3] @ moved[i] + inv[:3, 3])
    obj.data.update()
    fig.reset()
    return len(changed)


def _nearest_on_segments(p, a, b):
    """For each point, the nearest point on the nearest segment."""
    ab = b - a
    t = np.einsum("pk,sk->ps", p, ab) - np.einsum("sk,sk->s", a, ab)[None, :]
    t = np.clip(t / np.maximum(np.einsum("sk,sk->s", ab, ab), 1e-12)[None, :], 0, 1)
    q = a[None, :, :] + t[:, :, None] * ab[None, :, :]
    d = np.linalg.norm(q - p[:, None, :], axis=2)
    i = np.argmin(d, axis=1)
    return q[np.arange(len(p)), i]


# --- Parts that float ---------------------------------------------------


def floating(gates, level, meshes, kinds):
    """How far each part's islands are from everything else: every island
    of hair, a hat or a prop (what sits on something), and every island
    but the largest of a garment (a band, a rim). Not the body's: it is
    what the rest sits on, and the clothes cut it into islands."""
    posed = {o.name: motion.coords_posed(o)[0] for o in meshes}
    faces = {o.name: [list(f.vertices) for f in o.data.polygons] for o in meshes}
    for o in meshes:
        if kinds.get(o.name) == "body":
            continue
        islands = sorted(_islands(o), key=lambda isl: -len(isl["verts"]))
        sits = kinds.get(o.name) in ("hair", "hat", "prop")
        worst = 0.0
        where = size = None
        for k, isl in enumerate(islands):
            if k == 0 and not sits:
                continue
            others = [(posed[p.name], faces[p.name]) for p in meshes if p is not o]
            rest = [f for j, other in enumerate(islands) if j != k for f in other["faces"]]
            if rest:
                others.append((posed[o.name], rest))
            tree = _tree_of(others)
            if tree is None:
                continue
            gap = min(tree.find_nearest(Vector(posed[o.name][i]))[3] for i in isl["verts"])
            if gap > worst:
                worst = gap
                where = [round(float(x), 3) for x in posed[o.name][isl["verts"]].mean(0)]
                size = len(isl["faces"])
        detail = {"at": where, "faces": size} if worst > 0 else {}
        gates.add(level, f"float {o.name}", worst, TOUCH, worst <= TOUCH, islands=len(islands), **detail)


def _islands(obj):
    """The mesh's connected parts: their vertices and faces."""
    n = len(obj.data.vertices)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in obj.data.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), {"verts": [], "faces": []})["verts"].append(i)
    for f in obj.data.polygons:
        groups[find(f.vertices[0])]["faces"].append(list(f.vertices))
    return list(groups.values())


# --- The figure kept ----------------------------------------------------


def figure(gates, marks, human, meshes, worn, ease, version):
    """The dressed figure against the bare at rest."""
    from landmarks import Section

    bare = marks.measure()
    dressed = marks.measure(dressed=Section.of_many(meshes))
    garments = [w for w in worn if w.kind == "garment"]
    hz = bare["heights"]
    waist_z = hz["waist"]
    outer = 0.0
    for w in garments:
        co = motion.coords_posed(w.obj)[0]
        if co[:, 2].min() <= waist_z <= co[:, 2].max():
            p = w.spec.get("params") or {}
            outer = max(outer, ease[p.get("layer", w.spec["family"])])
    over = dressed["waist"] - bare["waist"]
    gates.add("close", "figure waist", over, 2 * outer, over <= 2 * outer + 1e-4)
    over = dressed["shoulder"] - bare["shoulder"]
    gates.add("close", "figure shoulders", over, SHOULDER_OVER, over <= SHOULDER_OVER)

    # The rear in profile: the back of the dressed figure against the
    # bare, from the crotch to the waist.
    whole = Section.of_many(meshes)
    worst, where = 0.0, None
    for z in np.arange(marks.crotch() + 0.01, waist_z, 0.01):
        near = marks.near(z)
        b, d = marks.section.outline(z, near), whole.outline(z, near)
        if len(b) and len(d) and float(d[:, 1].max() - b[:, 1].max()) > worst:
            worst = float(d[:, 1].max() - b[:, 1].max())
            where = round(float(z), 3)
    gates.add("close", "figure rear", worst, REAR_OVER, worst <= REAR_OVER, at=where,
              by=_outermost(meshes, where, (0.0, 1.0)) if where is not None else None)

    skin = _skin_tree(human)
    cloth = _tree_of([(motion.coords_posed(w.obj)[0], [list(f.vertices) for f in w.obj.data.polygons])
                      for w in garments]) if garments else None
    # The shoulders' top line: from the neck to the shoulder's point,
    # the cloth's top over the skin's.
    # The shoulders' top line, as the front view sees it: at each x from
    # beside the neck to past the shoulder's point, the highest the skin
    # comes and the highest the cloth comes, over the shoulder's depth.
    worst, where = 0.0, None
    sh = marks.joint("l-shoulder")
    depth = np.linspace(sh[1] - 0.07, sh[1] + 0.07, 15)

    def highest(tree, x):
        zs = [z for z in (_down(tree, x, y) for y in depth) if z is not None]
        return max(zs) if zs else None

    if cloth is not None:
        for x in np.linspace(0.07, sh[0] + 0.03, 12):
            for sign in (1, -1):
                top = highest(skin, sign * x)
                over = highest(cloth, sign * x)
                if top is not None and over is not None and over - top > worst:
                    worst, where = over - top, round(float(sign * x), 3)
    top_by = None
    if where is not None:
        tops = {w.obj.name: highest(_tree_of([(motion.coords_posed(w.obj)[0], [list(f.vertices) for f in w.obj.data.polygons])]),
                                    where) for w in garments}
        top_by = max((k for k in tops if tops[k] is not None), key=lambda k: tops[k], default=None)
    gates.add("close", "figure top line", worst, TOP_LINE, worst <= TOP_LINE, at=where, by=top_by)

    # Under the bust: a woman's fitted garment comes back toward her.
    fitted = [w for w in garments if (w.spec.get("params") or {}).get("fitted")]
    if version == "female" and fitted:
        tree = _tree_of([(motion.coords_posed(w.obj)[0], [list(f.vertices) for f in w.obj.data.polygons])
                         for w in fitted])
        bust_z, apex_x = _bust(marks)
        least = math.inf
        for sign in (1, -1):
            at_bust = _front(tree, sign * apex_x, bust_z)
            below = [_front(tree, sign * apex_x, z) for z in np.arange(bust_z - 0.03, bust_z - 0.12, -0.005)]
            below = [y for y in below if y is not None]
            if at_bust is not None and below:
                least = min(least, max(below) - at_bust)
        gates.add("close", "figure under the bust", least, BUST_RETURN, least >= BUST_RETURN)
    return bare, dressed


def _outermost(meshes, z, direction):
    """Of the meshes, the one whose section at z comes furthest along
    direction (x, y)."""
    from landmarks import Section

    best, far = None, -math.inf
    for o in meshes:
        for out in Section.of_many([o]).outlines(z):
            d = float(max(out @ np.array(direction)))
            if d > far:
                best, far = o.name, d
    return best


def _skin_tree(human):
    import body

    mask = body.in_group(human, "body")
    co = body.coords(human)
    faces = [list(p.vertices) for p in human.data.polygons if all(mask[i] for i in p.vertices)]
    return BVHTree.FromPolygons([Vector(p) for p in co], faces)


def _down(tree, x, y):
    hit = tree.ray_cast(Vector((x, y, 3.0)), Vector((0, 0, -1)), 5.0)
    return None if hit[0] is None else hit[0].z


def _front(tree, x, z):
    """How far forward a surface comes at (x, z): its y seen from the
    front."""
    hit = tree.ray_cast(Vector((x, -2.0, z)), Vector((0, 1, 0)), 4.0)
    return None if hit[0] is None else hit[0].y


def bust(gates, marks, meshes):
    """A woman machine's bust, shaped in her plates and seen: at the bare
    bust's height, each apex standing forward of the middle (the cleft);
    the plates coming back under it, as a fitted garment does; and nothing
    over the apex from the front (the coat open over it)."""
    plates = next(o for o in meshes if o.name == "body")
    tree = _tree(plates, motion.coords_posed(plates)[0])
    z, x = _bust(marks)
    cleft = under = math.inf
    covered = []
    every = _tree_of([(motion.coords_posed(o)[0], [list(f.vertices) for f in o.data.polygons]) for o in meshes])
    for sign in (1, -1):
        at = _front(tree, sign * x, z)
        middle = _front(tree, 0.0, z)
        below = [y for y in (_front(tree, sign * x, h) for h in np.arange(z - 0.03, z - 0.12, -0.005)) if y is not None]
        if at is None or middle is None or not below:
            cleft = under = -math.inf
            continue
        cleft = min(cleft, middle - at)
        under = min(under, max(below) - at)
        first = _front(every, sign * x, z)
        if first is not None and first < at - 1e-4:
            covered.append(_outermost_at(meshes, sign * x, z))
    gates.add("close", "bust cleft", cleft, BUST_CLEFT, cleft >= BUST_CLEFT, at=[round(x, 3), round(z, 3)])
    gates.add("close", "bust under", under, BUST_RETURN, under >= BUST_RETURN)
    gates.add("close", "bust seen", len(covered), 0, not covered, by=covered)


def _outermost_at(meshes, x, z):
    """Of the meshes, the one seen first from the front at (x, z)."""
    best, near = None, math.inf
    for o in meshes:
        y = _front(_tree(o, motion.coords_posed(o)[0]), x, z)
        if y is not None and y < near:
            best, near = o.name, y
    return best


def _bust(marks):
    """The bust's height and its apex's distance from the middle."""
    return marks.bust()[:2]


# --- Symmetry, the atlas, the file --------------------------------------


def symmetry(gates, level, obj, declared):
    """How far the mesh's mirror is from it: each vertex, mirrored, from
    the nearest of its vertices. (Not from its surface: the two sides' quads
    may be split along different diagonals, which a coarse mesh shows as
    millimetres.)"""
    co = motion.coords_posed(obj)[0]
    tree = KDTree(len(co))
    for i, p in enumerate(co):
        tree.insert(p, i)
    tree.balance()
    d = [tree.find((-p[0], p[1], p[2]))[2] for p in co]
    i = int(np.argmax(d))
    worst = d[i]
    where = [round(float(x), 3) for x in co[i]]
    if declared:
        gates.add(level, f"symmetry {obj.name}", worst, None, True, declared=True, at=where)
    else:
        gates.add(level, f"symmetry {obj.name}", worst, SYMMETRY, worst <= SYMMETRY, at=where,
                  over=int(sum(x > SYMMETRY for x in d)))


def atlas(gates, level, meshes, size=1024):
    """The UVs inside the square, and how many texels two triangles
    share, over every mesh."""
    tris = []
    owner = []
    outside = 0
    for o in meshes:
        me = o.data
        uv = np.empty(len(me.loops) * 2)
        me.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        outside += int(((uv < 0) | (uv > 1)).any(axis=1).sum())
        for p in me.polygons:
            ls = list(range(p.loop_start, p.loop_start + p.loop_total))
            for k in range(1, len(ls) - 1):
                tris.append(uv[[ls[0], ls[k], ls[k + 1]]])
                owner.append((o.name, p.index))
    count = np.zeros((size, size), np.uint8)
    for t in tris:
        _raster(count, t * size)
    shared = int((count > 1).sum())
    # Which meshes' faces lie on the texels shared.
    where = {}
    if shared:
        ys, xs = np.nonzero(count > 1)
        for t, (name, face) in zip(tris, owner):
            lo, hi = t.min(0) * size, t.max(0) * size
            if ((xs >= lo[0]) & (xs <= hi[0]) & (ys >= lo[1]) & (ys <= hi[1])).any():
                where.setdefault(name, set()).add(face)
    gates.add(level, "atlas", outside + shared, 0, outside + shared == 0, outside=outside, overlapping_texels=shared,
              faces={k: len(v) for k, v in where.items()})


def _raster(count, t):
    """Adds one to every texel whose centre is inside the triangle."""
    lo = np.floor(t.min(0)).astype(int)
    hi = np.ceil(t.max(0)).astype(int)
    lo = np.clip(lo, 0, count.shape[0] - 1)
    hi = np.clip(hi, 0, count.shape[0])
    if (hi <= lo).any():
        return
    xs, ys = np.meshgrid(np.arange(lo[0], hi[0]) + 0.5, np.arange(lo[1], hi[1]) + 0.5)
    (x0, y0), (x1, y1), (x2, y2) = t
    area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    # Under a texel in area, a triangle carries no texture of its own: a
    # rim's faces take their edge's UVs, and are slivers.
    if abs(area) / 2 < 1.0:
        return
    w0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) / area
    w1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) / area
    w2 = 1 - w0 - w1
    # A texel's centre on an edge two triangles share is neither's.
    inside = (w0 > 1e-6) & (w1 > 1e-6) & (w2 > 1e-6)
    count[lo[1]:hi[1], lo[0]:hi[0]] += inside


def file(gates, level, path, gltf, meshes, order, limit, clips=None):
    """The file: what it holds, and its gzipped size against limit (None:
    counted with another level)."""
    with open(path, "rb") as f:
        size = len(gzip.compress(f.read(), 9))
    if limit is not None:
        gates.add(level, "file size", size, limit, size <= limit)
    names = sorted(n.get("name", "") for n in gltf.get("nodes", []) if "mesh" in n)
    gates.add(level, "file meshes", len(names), len(meshes), names == sorted(meshes), meshes=names)
    if clips is not None:
        got = sorted(a.get("name", "") for a in gltf.get("animations", []))
        gates.add(level, "file clips", len(got), len(clips), got == sorted(clips), clips=got)
    return size


# --- Shared -------------------------------------------------------------


def _tree(obj, co):
    return BVHTree.FromPolygons([Vector(p) for p in co], [list(f.vertices) for f in obj.data.polygons])


def _tree_of(parts):
    verts, faces = [], []
    for co, fs in parts:
        base = len(verts)
        verts.extend(Vector(p) for p in co)
        faces.extend([base + i for i in f] for f in fs)
    return BVHTree.FromPolygons(verts, faces) if faces else None


def _round(v):
    if isinstance(v, float):
        return None if math.isinf(v) else round(v, 5)
    if isinstance(v, dict):
        return {k: _round(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_round(x) for x in v]
    if isinstance(v, (np.floating, np.integer)):
        return _round(v.item())
    return v


def write(path, gates_by_version, previous=None):
    """metrics.json, and what changed since the previous run's."""
    out = {v: g.levels for v, g in gates_by_version.items()}
    with open(path, "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    if previous and os.path.exists(previous):
        with open(previous, encoding="utf8") as f:
            return changes(json.load(f), out)
    return []


def changes(before, after):
    """The gates whose value moved, and which way: worse when it moved
    away from passing, or a gate that passed now fails."""
    out = []
    for v, levels in after.items():
        for lv, gates in levels.items():
            for g, r in gates.items():
                old = before.get(v, {}).get(lv, {}).get(g)
                if old is None or old.get("value") == r.get("value"):
                    continue
                if not isinstance(r.get("value"), (int, float)) or not isinstance(old.get("value"), (int, float)):
                    continue
                worse = (old["ok"] and not r["ok"]) or (not r["ok"] and abs(r["value"]) > abs(old["value"]))
                out.append(f"{v} {lv} {g}: {old['value']} → {r['value']}{' (worse)' if worse else ''}")
    return out
