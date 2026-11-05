# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The machines: a figure of rigid metal parts on the sailors' skeleton.

A machine is made on the body of its version, so it has a sailor's
proportions and plays every sailor's clip; but it has no skin. Its parts:

- the plates: the body cut by the bone that carries each part of it, each
  part made the solid that wraps it (its convex hull), drawn in a little
  and shortened at its ends, so the joints show between them; each plate
  rigid on its bone, its end edges sharp;
- the frame: the body drawn in toward its bones under the plates, dark,
  skinned as the body is, kept only where the plates leave it seen (the
  joints);
- the head: the face carved in planes like a figurehead's, from the body's
  own face collapsed and drawn flat; lamp eyes in deep sockets with
  glowing walls and a stepped lens, under hooded lids; sensor discs for
  ears, each on a joint of its own so it can turn; a cap of swept strips
  gathered at a boss behind (the female) or broad strips under a crest,
  and a slotted grille over the mouth (the male); a neck of overlapping
  lames, with a piston each side behind;
- over the coat (over_coat): layered shoulder plates lying on it, and a
  lantern at the nape, above the shoulder line, glowing;
- the coat, a garment like any other, fitted to the body under it.

The metal is the region a player's finish colours (the atlas's "skin"),
the frame its own dark iron, the lamps glow (the mask's blue, which a
machine's material lights); everything is metal but the coat.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import atlas
import body
import face
import garment
import lod

# The bone each part of the body is carried by: the bones a body has that
# a rigid part has no use for give their share to the one beside them.
CARRIED = {
    "lowerarm_twist": "lowerarm",
    "thigh_corrector": "thigh",
    "ball": "foot",
}
# What the head carries.
HEADS = ("head", "jaw", "eye", "lid")
FINGERS = ("thumb", "index", "middle", "ring", "pinky")

# The ear discs turn on the lower lids' joints, which a machine, having no
# lids, places at its ears.
EARS = {"l": "lid_lower_l", "r": "lid_lower_r"}


def params(look, v):
    """The machine's parameters for a version: the look's, the version's
    over them."""
    return _merged(look["machine"], look["versions"][v].get("machine") or {})


def _merged(a, b):
    """b over a, tables merged all the way down."""
    out = dict(a)
    for k, x in b.items():
        out[k] = _merged(out[k], x) if isinstance(x, dict) and isinstance(out.get(k), dict) else x
    return out


def carrier(name):
    """The bone that carries what the named bone moves."""
    if name.startswith(HEADS):
        return "head"
    for prefix, to in CARRIED.items():
        if name.startswith(prefix):
            return to + name[len(prefix):]
    return name


class Materials:
    """The machine's parts of the atlas: metal in the finish, the frame's
    dark iron, the lamps' glass and their sockets' glowing walls."""

    def __init__(self, p):
        c = p["colours"]
        new = bpy.data.materials.new
        self.metal = atlas.part(new("metal"), None, "skin", metal=True)
        # The small parts' metal: a swatch, with no texture of its own.
        self.fitting = atlas.part(new("fitting"), None, "skin", metal=True, swatch=True)
        self.dark = atlas.part(new("frame"), atlas.linear(c["frame"]), "fixed", metal=True, swatch=True)
        self.glass = atlas.part(new("glass"), atlas.linear(c["glass"]), "glow", swatch=True)
        self.socket = atlas.part(new("socket"), atlas.linear(c["socket"]), "glow", swatch=True)
        self.all = [self.metal, self.fitting, self.dark, self.glass, self.socket]

    def slot(self, m):
        return self.all.index(m)


# --- The figure ---------------------------------------------------------


def make(job, v, human, arm, marks):
    """The machine's own meshes, on the skeleton: the plates and frame
    ("body") and the head ("head"). Returns the body and the head as
    worn."""
    p = params(job["look"], v)
    mats = Materials(p)
    place_ears(arm, marks, p)
    src = lod.fit(human, "close", rigged=True)
    src.name = src.data.name = "machine-source"
    owners = _owners(src)
    co = body.coords(src)

    plates = Part("body", mats)
    shells = p.get("shells") or {}
    for bone in sorted(set(owners)):
        if bone in ("head", "neck_01") or bone.endswith("_r") or bone.startswith(FINGERS):
            continue
        pts = co[np.array([o == bone for o in owners])]
        if len(pts) < 4:
            continue
        spec = dict(p["plates"])
        for prefix, mine in (p.get("bones") or {}).items():
            if bone.startswith(prefix):
                spec.update(mine)
        if bone in shells:
            shell(plates, src, owners, arm.data.bones[bone], shells[bone], mats.metal)
            continue
        plates.hull(pts, arm.data.bones[bone], spec, mats.metal, bone)
    fingers(plates, arm, p["fingers"], mats)
    plates.mirror_left()
    hulls = plates.tree()
    frame(plates, src, owners, arm, hulls, p["frame"], mats.dark)
    obj = plates.object(arm)

    head = Part("head", mats)
    Head(head, human, src, owners, marks, arm, p, mats).make()
    head_obj = head.object(arm)

    bpy.data.objects.remove(src, do_unlink=True)
    return obj, [garment.Worn(head_obj, "head", {"id": "head", "region": "skin", "params": {}}, None)]


def place_ears(arm, marks, p):
    """Moves the lower lids' joints to the ears, where the discs turn."""
    import rig

    rig.select(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    for side, name in EARS.items():
        at = Vector(ear(marks, side, p))
        b = eb[name]
        sign = 1.0 if side == "l" else -1.0
        b.head = at
        b.tail = at + Vector((sign * 0.03, 0, 0))
        b.roll = 0.0
    bpy.ops.object.mode_set(mode="OBJECT")


def ear(marks, side, p):
    """The ear's middle on the side of the head: a little below the eyes'
    joints and behind the head's, at the skull's side."""
    eye = marks.joint(f"{side}-eye")
    headj = marks.joint("head")
    skin = marks.skin
    z = eye[2] + p["ears"]["up"]
    y = headj[1] + p["ears"]["back"]
    band = skin[(np.abs(skin[:, 2] - z) < 0.012) & (np.abs(skin[:, 1] - y) < 0.012)]
    sign = 1.0 if side == "l" else -1.0
    # The skull's side, not the ear's rim: the band's median outermost.
    xs = np.sort(band[:, 0] * sign)
    x = float(np.percentile(xs, 80)) * sign if len(xs) else sign * 0.07
    return (x, y, z)


def _owners(obj):
    """Each vertex's carrying bone: the bone that weighs most on it."""
    names = {g.index: g.name for g in obj.vertex_groups}
    out = []
    for v in obj.data.vertices:
        best, w = None, 0.0
        for g in v.groups:
            if g.weight > w and not names[g.group].startswith(("skirt_", "spring_", "pendant")):
                best, w = names[g.group], g.weight
        out.append(carrier(best) if best else "pelvis")
    return out


# --- Building a mesh ----------------------------------------------------


class Part:
    """One mesh of the machine, built up: each vertex's bone (or, for one
    skinned as the body is, its weights), each face's material, which
    edges are sharp; the left side's parts, to be mirrored."""

    def __init__(self, name, mats):
        self.name = name
        self.mats = mats
        self.bm = bmesh.new()
        self.bone = self.bm.verts.layers.string.new("bone")
        self.left = []
        self.weights = {}
        # Each face's UVs, by its vertices, where it has its own: a face
        # without is a swatch's.
        self.uvs = {}

    def vert(self, co, bone):
        v = self.bm.verts.new(Vector(co))
        v[self.bone] = bone.encode()
        return v

    def face(self, verts, mat, smooth=False, left=False):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        f.material_index = self.mats.slot(mat)
        f.smooth = smooth
        if left:
            self.left.append(f)
        return f

    def grid(self, rows, mat, bone, smooth=False, left=False, closed=False, flip=False, uv=False):
        """Quads between rows of points (each a list of the same length);
        closed joins each row's last point to its first. With uv, the grid
        is its own island, laid out by its lengths."""
        vs = [[self.vert(p, bone) for p in row] for row in rows]
        out = []
        n = len(rows[0])
        if uv:
            us = np.concatenate([[0.0], np.cumsum([(Vector(rows[0][i + 1]) - Vector(rows[0][i])).length
                                                    for i in range(n - 1)])])
            ws = np.concatenate([[0.0], np.cumsum([(Vector(rows[k + 1][n // 2]) - Vector(rows[k][n // 2])).length
                                                    for k in range(len(rows) - 1)])])
        for k, (a, b) in enumerate(zip(vs, vs[1:])):
            for i in range(n if closed else n - 1):
                j = (i + 1) % n
                quad = [a[i], a[j], b[j], b[i]]
                f = self.face(quad[::-1] if flip else quad, mat, smooth, left)
                out.append(f)
                if uv and f is not None and not closed:
                    self.uvs[f] = {a[i]: (us[i], ws[k]), a[j]: (us[j], ws[k]), b[j]: (us[j], ws[k + 1]),
                                   b[i]: (us[i], ws[k + 1])}
        return vs, [f for f in out if f is not None]

    def fan(self, ring, centre, mat, bone, left=False, flip=False):
        """A fan of triangles from a ring of vertices to a point."""
        c = self.vert(centre, bone)
        n = len(ring)
        for i in range(n):
            tri = [ring[i], ring[(i + 1) % n], c]
            self.face(tri[::-1] if flip else tri, mat, False, left)
        return c

    def add(self, other, bone_of, mat_of, left=False, uv_of=None):
        """Adds another bmesh's faces, each vertex on the bone
        bone_of(vertex) names, each face in mat_of(face); its UVs its own
        (its first map's), or uv_of(vertex)'s."""
        index = {}
        for v in other.verts:
            index[v] = self.vert(v.co, bone_of(v))
        layer = other.loops.layers.uv.active if uv_of is None else None
        out = []
        for f in other.faces:
            nf = self.face([index[v] for v in f.verts], mat_of(f), f.smooth, left)
            if nf is not None:
                out.append(nf)
                if layer is not None:
                    self.uvs[nf] = {index[lp.vert]: tuple(lp[layer].uv) for lp in f.loops}
                elif uv_of is not None:
                    self.uvs[nf] = {index[v]: uv_of(v) for v in f.verts}
        for e in other.edges:
            if not e.smooth:
                ne = self.bm.edges.get([index[e.verts[0]], index[e.verts[1]]])
                if ne is not None:
                    ne.smooth = False
        return out

    def hull(self, pts, bone, spec, mat, name, left=None):
        """A plate: the solid wrapping the points, drawn in toward the
        bone's line and shortened at its ends, its sharp edges kept. A
        plate on the left (a name ending _l, or left) is made again on the
        right; any other is its own mirror."""
        left = name.endswith("_l") if left is None else left
        h, t = np.array(bone.head_local), np.array(bone.tail_local)
        axis = t - h
        axis /= np.linalg.norm(axis)
        rel = pts - h
        along = rel @ axis
        radial = rel - np.outer(along, axis)
        r = np.linalg.norm(radial, axis=1, keepdims=True)
        radial *= np.maximum(r - spec["inset"], r * 0.6) / np.maximum(r, 1e-9)
        lo, hi = along.min(), along.max()
        mid = (lo + hi) / 2
        span = max(hi - lo, 1e-3)
        gap = min(spec["gap"], span * 0.2)
        along = mid + (along - mid) * (span - 2 * gap) / span
        bm = bmesh.new()
        for q in h + np.outer(along, axis) + radial:
            bm.verts.new(q)
        res = bmesh.ops.convex_hull(bm, input=bm.verts[:], use_existing_faces=False)
        bmesh.ops.delete(bm, geom=list(set(res["geom_interior"] + res["geom_unused"])), context="VERTS")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        # Collapsed to its share, its long sides smooth and its ends sharp.
        _collapse(bm, spec.get("triangles", 120))
        # A rim round each end, standing proud: the plate's edge, which
        # catches the light.
        rim = spec.get("rim")
        if rim and span > 4 * rim["width"]:
            a0, a1 = mid - (span - 2 * gap) / 2, mid + (span - 2 * gap) / 2
            for at, sign in ((a0 + rim["width"], -1), (a1 - rim["width"], 1)):
                geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
                bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector(h + axis * at), plane_no=Vector(axis), dist=1e-5)
            for v in bm.verts:
                q = np.array(v.co) - h
                al = q @ axis
                if al < a0 + rim["width"] - 1e-4 or al > a1 - rim["width"] + 1e-4:
                    rad = q - al * axis
                    n = np.linalg.norm(rad)
                    if n > 1e-6:
                        v.co += Vector(rad / n * rim["proud"])
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        if not left:
            # A plate on the middle is its own mirror: its left half, and
            # that half's mirror image.
            _mirror_half(bm)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(spec.get("sharp", 40)):
                e.smooth = False
        # Unrolled round the bone, cut down its back: one island.
        back = np.cross(axis, [1.0, 0.0, 0.0])
        if np.linalg.norm(back) < 0.5:
            back = np.cross(axis, [0.0, 1.0, 0.0])
        back /= np.linalg.norm(back)
        side = np.cross(axis, back)
        radius = float(np.median(np.linalg.norm(radial, axis=1)))

        def cyl(v):
            q = np.array(v.co) - h
            return math.atan2(q @ side, q @ back), float(q @ axis)

        polar = {v: cyl(v) for v in bm.verts}
        uvs = {}
        bm.normal_update()
        for f in bm.faces:
            # The ends face along the bone: unrolled they would fold onto
            # the sides; they are swatches.
            if abs(np.array(f.normal) @ axis) > 0.6:
                continue
            a = [polar[v][0] for v in f.verts]
            wrap = max(a) - min(a) > math.pi
            uvs[f] = [((polar[v][0] + (2 * math.pi if wrap and polar[v][0] < 0 else 0.0)) * radius, polar[v][1])
                      for v in f.verts]
        # A face folded over the rest (its UVs wound the other way) is one
        # too.
        areas = {f: _area(uv) for f, uv in uvs.items()}
        sign = np.sign(sum(areas.values()))
        uvs = {f: uv for f, uv in uvs.items() if areas[f] * sign > 0}
        faces = self.add(bm, lambda v: name, lambda f: mat, left=left)
        for nf, f in zip(faces, [f for f in bm.faces]):
            if f in uvs:
                self.uvs[nf] = dict(zip(nf.verts, uvs[f]))
        bm.free()

    def mirror_left(self):
        """Every part made on the left made again on the right."""
        faces = list(dict.fromkeys(f for f in self.left if f.is_valid))
        verts = list({v for f in faces for v in f.verts})
        edges = list({e for f in faces for e in f.edges})
        copy = bmesh.ops.duplicate(self.bm, geom=verts + edges + faces)
        vmap = copy["vert_map"]
        for src, dst in copy["face_map"].items():
            if src in self.uvs:
                self.uvs[dst] = {vmap[v]: uv for v, uv in self.uvs[src].items()}
        for el in copy["geom"]:
            if isinstance(el, bmesh.types.BMVert):
                el.co.x = -el.co.x
                el[self.bone] = _other_side(el[self.bone].decode()).encode()
        bmesh.ops.reverse_faces(self.bm, faces=[el for el in copy["geom"] if isinstance(el, bmesh.types.BMFace)])
        self.left = []

    def tree(self):
        self.bm.normal_update()
        return BVHTree.FromBMesh(self.bm)

    def object(self, arm):
        """The part as an object on the skeleton: each vertex wholly on its
        bone, or on the weights its name stands for (one skinned as the
        body is)."""
        me = bpy.data.meshes.new(self.name)
        # What was laid on the head's or body's surface by rays is its own
        # mirror only to a few millimetres: made exactly so.
        garment.symmetrize(self.bm, 0.006)
        gone = [f for f in self.bm.faces if f.calc_area() < 1e-8]
        bmesh.ops.delete(self.bm, geom=gone, context="FACES")
        bmesh.ops.delete(self.bm, geom=[v for v in self.bm.verts if not v.link_faces], context="VERTS")
        self.bm.normal_update()
        names = [v[self.bone].decode() for v in self.bm.verts]
        # The UVs, where faces have their own; the rest are swatches.
        layer = self.bm.loops.layers.uv.new(atlas.ATLAS)
        metal, fitting = self.mats.slot(self.mats.metal), self.mats.slot(self.mats.fitting)
        for f in self.bm.faces:
            mine = self.uvs.get(f)
            if mine is None:
                if f.material_index == metal:
                    f.material_index = fitting
                continue
            for lp in f.loops:
                lp[layer].uv = mine.get(lp.vert, (0.0, 0.0))
        self.bm.to_mesh(me)
        self.bm.free()
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        for m in self.mats.all:
            me.materials.append(m)
        groups = {}
        for i, n in enumerate(names):
            for bone, w in self.weights.get(n, [(n, 1.0)]):
                g = groups.get(bone) or obj.vertex_groups.new(name=bone)
                groups[bone] = g
                g.add([i], w, "REPLACE")
        obj.parent = arm
        mod = obj.modifiers.new("skeleton", "ARMATURE")
        mod.object = arm
        return obj


def _mirror_half(bm, swap=None):
    """Cuts a bmesh at the middle and makes its right half the mirror of
    its left, joined along the cut; swap maps each deform group to its
    mirror's, for a bmesh with weights."""
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0),
                           plane_no=(-1, 0, 0), dist=1e-6, clear_outer=True)
    for v in bm.verts:
        if abs(v.co.x) < 1e-5:
            v.co.x = 0.0
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    copy = bmesh.ops.duplicate(bm, geom=geom)
    new = copy["geom"]
    deform = bm.verts.layers.deform.active if swap else None
    for el in new:
        if isinstance(el, bmesh.types.BMVert):
            el.co.x = -el.co.x
            if deform is not None:
                ws = dict(el[deform].items())
                el[deform].clear()
                for g, w in ws.items():
                    el[deform][swap.get(g, g)] = w
    bmesh.ops.reverse_faces(bm, faces=[el for el in new if isinstance(el, bmesh.types.BMFace)])
    bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v.co.x == 0.0], dist=1e-6)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    # What the cut left of no area, or three faces on an edge, goes.
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-9], context="FACES")
    for e in [e for e in bm.edges if len(e.link_faces) > 2]:
        if e.is_valid and len(e.link_faces) > 2:
            extra = sorted(e.link_faces, key=lambda f: f.calc_area())[:len(e.link_faces) - 2]
            bmesh.ops.delete(bm, geom=extra, context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def _area(uv):
    """A polygon's signed area."""
    p = np.array(uv)
    return 0.5 * float(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))


def _other_side(name):
    if name.endswith("_l"):
        return name[:-2] + "_r"
    return name


def _collapse(bm, triangles):
    """Collapses a bmesh to about this many triangles."""
    me = bpy.data.meshes.new("collapse")
    bm.to_mesh(me)
    obj = bpy.data.objects.new("collapse", me)
    bpy.context.scene.collection.objects.link(obj)
    lod.decimate(obj, triangles)
    bm.clear()
    bm.from_mesh(obj.data)
    old = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(old)


def shell(part, src, owners, bone, c, mat):
    """A plate made as a shell over the body's own surface, where the body
    has a form a hull would lose (a woman's bust, its cleft and the fold
    under it): the skin the bone carries, its edge tidied and eased smooth,
    collapsed, stood off the skin by c["out"], its edge rolled in by
    c["rim"] to a clean lip. Its left half only, short of the middle by
    half c["seam"], a groove down the middle between it and its mirror."""
    bm = bmesh.new()
    bm.from_mesh(src.data)
    for g in list(bm.verts.layers.deform):
        bm.verts.layers.deform.remove(g)
    bm.verts.ensure_lookup_table()
    mine = [f for f in bm.faces if sum(owners[v.index] == bone.name for v in f.verts) * 2 > len(f.verts)]
    keep = set(mine)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(c["seam"] / 2, 0, 0),
                           plane_no=(-1, 0, 0), dist=1e-6, clear_outer=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    # The edge tidied: no face hanging on by an edge, no notch, one piece.
    for _ in range(c.get("tidy", 4)):
        spurs = [f for f in bm.faces if sum(e.is_boundary for e in f.edges) >= 2]
        if not spurs:
            break
        bmesh.ops.delete(bm, geom=spurs, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    _largest_piece(bm)
    me = bpy.data.meshes.new("shell")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("shell", me)
    bpy.context.scene.collection.objects.link(obj)
    lod.decimate(obj, c["triangles"])
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(me)
    # The edge eased smooth along itself, and laid back on the skin; the
    # seam's edge kept straight on its line.
    skin = BVHTree.FromPolygons([Vector(q) for q in body.coords(src)], [list(f.vertices) for f in src.data.polygons])
    on_seam = lambda v: abs(v.co.x - c["seam"] / 2) < 1e-3
    for _ in range(c.get("ease", 6)):
        moves = {}
        for v in bm.verts:
            if not v.is_boundary or on_seam(v):
                continue
            ends = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(ends) == 2:
                moves[v] = v.co * 0.5 + (ends[0].co + ends[1].co) * 0.25
        for v, q in moves.items():
            hit = skin.find_nearest(q)
            v.co = hit[0] if hit[0] is not None else q
    bm.normal_update()
    # Stood off the skin, then the lip rolled in at the edge.
    for v in bm.verts:
        v.co += v.normal * c["out"]
    bm.normal_update()
    lip = {}
    for v in bm.verts:
        if v.is_boundary:
            lip[v] = bm.verts.new(v.co - v.normal * c["rim"])
    for e in [e for e in bm.edges if e.is_boundary]:
        a, b = e.verts
        f = e.link_faces[0]
        # Wound as the face it edges, outward.
        if any(lp.vert is a and lp.link_loop_next.vert is b for lp in f.loops):
            bm.faces.new([b, a, lip[a], lip[b]])
        else:
            bm.faces.new([a, b, lip[b], lip[a]])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.normal_update()
    edge = set(lip.values())
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(c.get("sharp", 40)):
            e.smooth = False
    # Unrolled round the bone, as a hull is; the lip a swatch.
    h, t = np.array(bone.head_local), np.array(bone.tail_local)
    axis = (t - h) / np.linalg.norm(t - h)
    back = np.cross(axis, [1.0, 0.0, 0.0])
    back /= np.linalg.norm(back)
    side = np.cross(axis, back)
    radius = float(np.median([np.linalg.norm((np.array(v.co) - h) - ((np.array(v.co) - h) @ axis) * axis)
                              for v in bm.verts]))
    faces = part.add(bm, lambda v: bone.name, lambda f: mat, left=True)
    for nf, f in zip(faces, bm.faces):
        if any(v in edge for v in f.verts):
            continue
        uv = []
        for v in f.verts:
            q = np.array(v.co) - h
            uv.append((math.atan2(q @ side, q @ back) * radius, float(q @ axis)))
        part.uvs[nf] = dict(zip(nf.verts, uv))
    bm.free()


def _largest_piece(bm):
    """Keeps only the bmesh's largest connected piece of faces."""
    seen, pieces = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        piece, todo = [], [f]
        seen.add(f)
        while todo:
            g = todo.pop()
            piece.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        todo.append(h)
        pieces.append(piece)
    pieces.sort(key=len)
    for piece in pieces[:-1]:
        bmesh.ops.delete(bm, geom=piece, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def finger_swatch(obj):
    """The material and the atlas place the close level's fingers are
    drawn with: their swatch."""
    names = {g.index: g.name for g in obj.vertex_groups}
    uvs = obj.data.uv_layers.active.data
    for f in obj.data.polygons:
        ws = obj.data.vertices[f.vertices[0]].groups
        if ws and names[max(ws, key=lambda g: g.weight).group].startswith(FINGERS):
            return f.material_index, [tuple(uvs[i].uv) for i in f.loop_indices]
    return 0, [(0.0, 0.0)]


def deck_fingers(obj, arm, spec, swatch):
    """The fingers made again at the deck level, after its collapse, which
    breaks their joints' small boxes into scattered faces: those go, and
    each joint is a whole box again, open at its root, on the fingers'
    swatch (finger_swatch, read before the collapse)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    deform = bm.verts.layers.deform.active
    uvs = bm.loops.layers.uv.active
    groups = {g.name: g.index for g in obj.vertex_groups}
    finger_groups = {i for n, i in groups.items() if n.startswith(FINGERS)}

    def on_finger(v):
        ws = v[deform]
        return bool(ws) and max(ws.items(), key=lambda kv: kv[1])[0] in finger_groups

    gone = [f for f in bm.faces if all(on_finger(v) for v in f.verts)]
    mat, swatch = swatch
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bones = arm.data.bones
    flip = Vector((-1, 1, 1))
    for name in FINGERS:
        first, second, third = (bones[f"{name}_0{k}_l"] for k in (1, 2, 3))
        w = spec["thumb" if name == "thumb" else "width"]
        t = w * spec["thick"]
        m = first.matrix_local.to_3x3()
        x, z = m.col[0].normalized(), m.col[2].normalized()
        for bone, a, e, k in ((first, first.head_local, first.tail_local, 0.9),
                              (second, second.head_local, second.tail_local, 0.9),
                              (third, third.head_local, third.tail_local, spec["tip"])):
            d = e - a
            a = a + d * (spec["gap"] / d.length)
            # The tip a little shorter: at this level's collapse a hand on
            # the gunwale must not reach into it.
            e = e - d * (spec["gap"] * (3 if bone is third else 1) / d.length)
            corners = [[at + (x * sx * w / 2 + z * sz * t / 2) * kk for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
                       for at, kk in ((a, 1.0), (e, k))]
            # The right hand's the left's mirror, exactly.
            for side, at_side in (("l", lambda q: q), ("r", lambda q: q * flip)):
                bone_side = bones[bone.name[:-2] + "_" + side]
                rings = [[bm.verts.new(at_side(q)) for q in ring] for ring in corners]
                a_s, e_s = at_side(a), at_side(e)
                faces = [bm.faces.new([rings[0][i], rings[0][(i + 1) % 4], rings[1][(i + 1) % 4], rings[1][i]])
                         for i in range(4)]
                faces.append(bm.faces.new(rings[1]))
                for v in rings[0] + rings[1]:
                    v[deform][groups[bone_side.name]] = 1.0
                bm.normal_update()
                # Outward from the finger's line: a box's faces face away.
                mid = (a_s + e_s) / 2
                if sum((f.calc_center_median() - mid).dot(f.normal) for f in faces) < 0:
                    bmesh.ops.reverse_faces(bm, faces=faces)
                for f in faces:
                    f.material_index = mat
                    f.smooth = False
                    # The swatch face's own corners: smaller than a
                    # texel, they cover no texel's middle.
                    for i, lp in enumerate(f.loops):
                        lp[uvs].uv = swatch[i % len(swatch)]
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def fingers(part, arm, spec, mats):
    """Each joint of each finger a box along its bone, narrowing to the
    tip, a little short of the next."""
    for b in arm.data.bones:
        if not (b.name.startswith(FINGERS) and b.name.endswith("_l")):
            continue
        thumb = b.name.startswith("thumb")
        w = spec["thumb" if thumb else "width"]
        t = w * spec["thick"]
        m = b.matrix_local.to_3x3()
        x, z = m.col[0].normalized(), m.col[2].normalized()
        h, tail = b.head_local, b.tail_local
        d = tail - h
        a = h + d * (spec["gap"] / d.length)
        e = tail - d * (spec["gap"] / d.length)
        tip = b.name.endswith("_03_l")
        rings = []
        for at, k in ((a, 1.0), (e, spec["tip"] if tip else 0.9)):
            rings.append([at + (x * sx * w / 2 + z * sz * t / 2) * k for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        vs, _ = part.grid(rings, mats.metal, b.name, closed=True, left=True)
        part.face(vs[0][::-1], mats.metal, False, True)
        part.face(vs[1], mats.metal, False, True)


# --- The frame ----------------------------------------------------------


def frame(part, src, owners, arm, hulls, spec, mat):
    """The frame under the plates: the body drawn in toward its bones,
    collapsed, dark, skinned as the body is; kept only near where the
    plates leave it seen. The head's own is the head's."""
    me = src.data.copy()
    tmp = bpy.data.objects.new("frame-tmp", me)
    bpy.context.scene.collection.objects.link(tmp)
    for g in src.vertex_groups:
        tmp.vertex_groups.new(name=g.name)
    bones = arm.data.bones
    inset = spec["inset"]
    for v, o in zip(me.vertices, owners):
        b = bones["neck_01" if o == "head" else o]
        h, t = b.head_local, b.tail_local
        d = t - h
        s = max(0.0, min(1.0, (v.co - h).dot(d) / d.length_squared))
        q = h + d * s
        off = v.co - q
        v.co = q + off * max(0.5, 1 - inset / max(off.length, 1e-6))
    # The head is solid: its frame goes.
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if owners[v.index] == "head"], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    lod.decimate(tmp, spec["triangles"])
    names = {g.index: g.name for g in tmp.vertex_groups}
    bm = bmesh.new()
    bm.from_mesh(tmp.data)
    bm.normal_update()
    deform = bm.verts.layers.deform.active
    # What the plates hide: a ray out along the frame's normal meets them
    # near; kept beside what shows.
    shown = {}
    for v in bm.verts:
        hit = hulls.ray_cast(v.co + v.normal * 1e-4, v.normal, spec["reach"])
        shown[v] = hit[0] is None
    seen = [v for v in bm.verts if shown[v]]
    from mathutils.kdtree import KDTree

    kd = KDTree(max(len(seen), 1))
    for i, v in enumerate(seen):
        kd.insert(v.co, i)
    kd.balance()
    keep = {v for v in bm.verts if shown[v] or (seen and kd.find(v.co)[2] <= spec["keep"])}
    # Kept with its mirror, so the frame stays its own mirror.
    every = KDTree(len(bm.verts))
    verts = list(bm.verts)
    for i, v in enumerate(verts):
        every.insert(v.co, i)
    every.balance()
    for v in list(keep):
        _, j, d = every.find((-v.co.x, v.co.y, v.co.z))
        if d < 0.003:
            keep.add(verts[j])
    gone = [f for f in bm.faces if not any(v in keep for v in f.verts)]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    index = {n: i for i, n in names.items()}
    _mirror_half(bm, {i: index.get(_other_side(n) if n.endswith("_l") else n[:-2] + "_l" if n.endswith("_r") else n, i)
                      for i, n in names.items()})
    keys = {}
    for v in bm.verts:
        ws = sorted(((w, names[g]) for g, w in v[deform].items() if w > 1e-4), reverse=True)[:4]
        total = sum(w for w, _ in ws) or 1.0
        key = f"@{len(part.weights)}"
        part.weights[key] = [(n, w / total) for w, n in ws] or [("pelvis", 1.0)]
        keys[v] = key
    for f in bm.faces:
        f.smooth = True
    part.add(bm, lambda v: keys[v], lambda f: mat)
    bm.free()
    old = tmp.data
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(old)


# --- The head -----------------------------------------------------------


def _frame_at(origin, forward, up):
    """An orthonormal frame: x across, y forward, z up."""
    f = Vector(forward).normalized()
    u = (Vector(up) - f * Vector(up).dot(f)).normalized()
    return f.cross(u).normalized(), f, u


class Head:
    def __init__(self, part, human, src, owners, marks, arm, p, mats):
        self.part = part
        self.src = src
        self.owners = owners
        self.marks = marks
        self.arm = arm
        self.p = p
        self.mats = mats
        self.eyes = {s: Vector(marks.joint(f"{s}-eye")) for s in ("l", "r")}
        self.ears = {s: Vector(ear(marks, s, p)) for s in ("l", "r")}
        self.centre = Vector((0.0, (self.ears["l"].y + self.ears["r"].y) / 2, self.ears["l"].z + 0.02))
        self.crown = marks.crown()
        eyes_z = (self.eyes["l"].z + self.eyes["r"].z) / 2
        self.lips = Vector((0.0, 0.0, eyes_z - 0.065))
        # The smooth head, for laying things on it.
        keep = np.array([o == "head" for o in owners])
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context="VERTS")
        bm.normal_update()
        self.smooth = BVHTree.FromBMesh(bm)
        hit = self.smooth.ray_cast(Vector((0, -1, self.lips.z)), Vector((0, 1, 0)), 2.0)
        if hit[0] is not None:
            self.lips.y = hit[0].y
        bm.free()

    def on(self, direction, off=0.0, origin=None):
        """Where a ray out from the head's middle meets its surface, stood
        off it by off; and the surface's normal there."""
        o = self.centre if origin is None else origin
        d = Vector(direction).normalized()
        flip = Vector((-1, 1, 1))
        # Met both ways round and the two made one: the head is its own
        # mirror only to a millimetre or two, what is laid on it exactly.
        hits = []
        for k in (Vector((1, 1, 1)), flip):
            dk, ok = d * k, o * k
            hit = self.smooth.ray_cast(ok + dk * 0.3, -dk, 0.3)
            if hit[0] is None:
                return None, None
            hits.append((hit[0] * k, hit[1] * k))
        at = (hits[0][0] + hits[1][0]) / 2
        n = (hits[0][1] + hits[1][1]).normalized()
        return at + n * off, n

    def make(self):
        self.face()
        self.cap()
        if self.p["head"].get("grille"):
            self.grille()
        for s in ("l",):
            self.ear_disc(s)
        self.neck()
        self.part.mirror_left()

    # The face, carved.
    def face(self):
        p = self.p["head"]
        src = self.src
        keep = np.array([o == "head" for o in self.owners])
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context="VERTS")
        for g in list(bm.verts.layers.deform):
            bm.verts.layers.deform.remove(g)
        # Its left half only, made again on the right, so the face is its
        # own mirror however it is cut and collapsed.
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0),
                               plane_no=(-1, 0, 0), dist=1e-6, clear_outer=True)
        for v in bm.verts:
            if abs(v.co.x) < 1e-5:
                v.co.x = 0.0
        # The ears go: the discs stand there.
        r = p["ear"]["radius"] * 0.9
        gone = [f for f in bm.faces if any((f.calc_center_median() - self.ears[s]).length < r for s in self.ears)]
        bmesh.ops.delete(bm, geom=gone, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        # The eyes cut open, almond-shaped; the upper lids drawn down over
        # them and forward, a calm, hooded gaze.
        e = p["eye"]
        cut = []
        for f in bm.faces:
            c = f.calc_center_median()
            for s in self.eyes:
                d = c - self.eyes[s]
                if c.y < self.eyes[s].y + 0.012 and (d.x / e["width"]) ** 2 + (d.z / e["height"]) ** 2 < 1:
                    cut.append(f)
                    break
        bmesh.ops.delete(bm, geom=cut, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        for loop in _loops(bm):
            c = sum((v.co for v in loop), Vector()) / len(loop)
            side = min(self.eyes, key=lambda s: (self.eyes[s] - c).length)
            if (self.eyes[side] - c).length > 0.03:
                continue
            for v in loop:
                if v.co.z > c.z:
                    v.co.z -= (v.co.z - c.z) * e["hood"]
                    v.co.y -= e["lid"]
        # The crown goes, above the cap's line: the cap's dome is there.
        n = self.cap_plane()
        brow = self.eyes["l"].z + p["brow"]
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=self.cap_at, plane_no=n,
                               dist=1e-5, clear_outer=True)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        # Collapsed to planes, the eyes and lips kept finest.
        me = bpy.data.meshes.new("head-carve")
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new("head-carve", me)
        bpy.context.scene.collection.objects.link(obj)
        co = body.coords(obj)
        keep_w = np.full(len(co), p["keep"])
        for s in self.eyes:
            keep_w[np.linalg.norm(co - np.array(self.eyes[s]), axis=1) < 0.022] = 1.0
        keep_w[np.linalg.norm(co - np.array(self.lips), axis=1) < 0.028] = p["lips"]
        lod.decimate(obj, p["triangles"], keep_w)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        old = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(old)
        # Carved: every face flat.
        darkened = set()
        for f in bm.faces:
            f.smooth = False
        self.sockets(bm)
        part = self.part
        glow = getattr(self, "_glow", {})
        part.add(bm, lambda v: "head", lambda f: glow.get(f, self.mats.metal), left=True)
        bm.free()

    def sockets(self, bm):
        """The eye holes made deep lamp sockets: walls in, a step, the lens."""
        p = self.p["head"]["eye"]
        glow = {}
        for loop in _loops(bm):
            c = sum((v.co for v in loop), Vector()) / len(loop)
            side = min(self.eyes, key=lambda s: (self.eyes[s] - c).length)
            if (self.eyes[side] - c).length > 0.03 or len(loop) > 40:
                continue
            into = (self.centre - c).normalized()
            into = (into + Vector((0, 1, 0))).normalized()
            rings = [loop]
            for depth, scale in p["steps"]:
                ring = []
                for v in loop:
                    q = c + (v.co - c) * scale + into * depth
                    ring.append(bm.verts.new(q))
                rings.append(ring)
            n = len(loop)
            for k, (a, b) in enumerate(zip(rings, rings[1:])):
                for i in range(n):
                    j = (i + 1) % n
                    try:
                        f = bm.faces.new([a[i], a[j], b[j], b[i]])
                    except ValueError:
                        continue
                    f.smooth = False
                    glow[f] = self.mats.socket if k == 0 else self.mats.glass
            last = rings[-1]
            mid = sum((v.co for v in last), Vector()) / n - into * p["bulge"]
            cv = bm.verts.new(mid)
            for i in range(n):
                f = bm.faces.new([last[i], last[(i + 1) % n], cv])
                f.smooth = True
                glow[f] = self.mats.glass
        bm.normal_update()
        # The walls face into the socket: the lens outward.
        for f, m in glow.items():
            if f.normal.dot(Vector((0, -1, 0))) < -0.2 and m is self.mats.glass:
                f.normal_flip()
        self._glow = glow

    def cap_plane(self):
        """The plane the cap's edge lies on: at the brow in front, at the
        boss behind. Its normal, up; its point in self.cap_at."""
        p = self.p["head"]
        c = p["cap"]
        front = Vector((0, self.eyes["l"].y, self.eyes["l"].z + p["brow"]))
        b = math.radians(c["boss"])
        back, _ = self.on(Vector((0, math.cos(b), math.sin(b))))
        back = back + Vector((0, 0, -c["below-boss"]))
        d = back - front
        n = Vector((0, -d.z, d.y)).normalized()
        if n.z < 0:
            n = -n
        self.cap_at = front
        return n

    def dome(self, c):
        """The skull under the cap: dark, drawn in, from the brow over to
        the boss and down to the temples."""
        rows = []
        start = math.radians(c["front"] - 12)
        end = math.pi - math.radians(c["boss"]) + math.radians(14)
        for k in range(c["dome"][0] + 1):
            pitch = start + (end - start) * k / c["dome"][0]
            sag = Vector((0, -math.cos(pitch), math.sin(pitch)))
            row = []
            for j in range(c["dome"][1] + 1):
                lat = math.radians(-82 + 164 * j / c["dome"][1])
                d = (sag * math.cos(lat) + Vector((math.sin(lat), 0, 0))).normalized()
                at, _ = self.on(d, -self.p["head"]["skull-in"])
                if at is None:
                    at = self.centre + d * 0.08
                row.append(at)
            rows.append(row)
        self.part.grid(rows, self.mats.dark, "head", flip=True)

    # The cap.
    def cap(self):
        p = self.p["head"]["cap"]
        part = self.part
        self.dome(p)
        n = p["strips"]
        boss = Vector((0, math.cos(math.radians(p["boss"])), math.sin(math.radians(p["boss"]))))
        for i in range(n):
            lat = (i / (n - 1) * 2 - 1) * p["spread"] if n > 1 else 0.0
            if lat > 1e-6:
                continue
            left = lat < -1e-6
            self.strip(lat, p, i, n, boss, left)
        # The boss the strips gather at.
        if p.get("boss-radius"):
            at, nrm = self.on(boss, p["lift"] + 0.004)
            if at is not None:
                self.disc(at, nrm, p["boss-radius"], 0.008, "head", self.mats.metal, self.mats.dark)
        if p.get("crest"):
            self.crest(p["crest"])

    def strip(self, lat, p, i, n, boss, left):
        """One strip of the cap, from the brow back over the crown to the
        boss, narrowing; the middle strips stand highest."""
        segs = p["segments"]
        start = math.radians(p["front"])
        end = math.radians(p["boss"])
        rows = []
        lift = p["lift"] + p["layer"] * (n // 2 - abs(i - n // 2))
        for k in range(segs + 1):
            s = k / segs
            pitch = start + (math.pi - end - start) * s
            sag = Vector((0, -math.cos(pitch), math.sin(pitch)))
            a = math.radians(lat) * (1 - s) ** p["gather"]
            d = (sag * math.cos(a) + Vector((math.sin(a), 0, 0))).normalized()
            at, nrm = self.on(d, lift)
            if at is None:
                return
            rows.append((at, nrm, s))
        pts_top, pts_low = [], []
        for k, (at, nrm, s) in enumerate(rows):
            nxt = rows[min(k + 1, len(rows) - 1)][0]
            prv = rows[max(k - 1, 0)][0]
            tan = (nxt - prv).normalized()
            across = tan.cross(nrm).normalized()
            w = p["width"][0] * (1 - s) + p["width"][1] * s
            row = [at + across * (w / 2 * x) for x in (-1, -0.4, 0.4, 1)]
            # The middle ridge raised: a strip, not a flat ribbon.
            row[1] = row[1] + nrm * p["ridge"]
            row[2] = row[2] + nrm * p["ridge"]
            pts_top.append(row)
            pts_low.append([row[0] - nrm * p["thick"], row[3] - nrm * p["thick"]])
        part = self.part
        top, _ = part.grid(pts_top, self.mats.metal, "head", left=left, flip=True)
        # The edges turned down to the skull.
        for edge, low in ((0, 0), (3, 1)):
            for k in range(len(pts_top) - 1):
                a, b = top[k][edge], top[k + 1][edge]
                lo_a = part.vert(pts_low[k][low], "head")
                lo_b = part.vert(pts_low[k + 1][low], "head")
                quad = [a, b, lo_b, lo_a] if edge == 0 else [b, a, lo_a, lo_b]
                part.face(quad, self.mats.metal, False, left)

    def crest(self, c):
        """A crest along the middle of the skull, from the brow to the
        nape: a fin standing up off the cap, its top rolled."""
        part = self.part
        segs = c["segments"]
        start, end = math.radians(c["from"]), math.radians(c["to"])
        rows = []
        for k in range(segs + 1):
            s = k / segs
            pitch = start + (end - start) * s
            d = Vector((0, -math.cos(pitch), math.sin(pitch)))
            at, nrm = self.on(d, c["base"])
            if at is None:
                continue
            h = c["height"] * math.sin(math.pi * min(1.0, s * 1.15)) ** 0.6 + 0.004
            rows.append((at, nrm, h))
        t = c["thick"] / 2
        left_side, right_side, ridge = [], [], []
        for at, nrm, h in rows:
            x = Vector((t, 0, 0))
            left_side.append([at + x, at + x + nrm * h])
            ridge.append(at + nrm * (h + t))
        # The left face, its top and the ends; the right is its mirror.
        vs, _ = part.grid([[r[0], r[1]] for r in left_side], self.mats.metal, "head", left=True)
        rv = [part.vert(q, "head") for q in ridge]
        for k in range(len(rv) - 1):
            part.face([vs[k][1], vs[k + 1][1], rv[k + 1], rv[k]], self.mats.metal, False, True)
        part.face([vs[0][0], vs[0][1], rv[0]], self.mats.metal, False, True)
        part.face([vs[-1][1], vs[-1][0], rv[-1]], self.mats.metal, False, True)

    def grille(self):
        """A slotted grille over the mouth and chin: bars across, the
        face dark behind."""
        g = self.p["head"]["grille"]
        part = self.part
        top = self.lips.z + g["above"]
        bottom = self.lips.z - g["below"]
        bars = g["bars"]
        for b in range(bars):
            z1 = top - (top - bottom) * b / bars
            z0 = z1 - (top - bottom) / bars * g["fill"]
            rows = []
            for z in (z1, z0):
                row = []
                for x in np.linspace(0, g["half"], 4):
                    hit = self.smooth.ray_cast(Vector((x, -1, z)), Vector((0, 1, 0)), 2.0)
                    if hit[0] is None:
                        break
                    row.append(hit[0] + Vector((0, -g["off"], 0)))
                rows.append(row)
            if any(len(r) < 4 for r in rows):
                continue
            front, _ = part.grid(rows, self.mats.metal, "head", left=True, flip=True)
            # The bar's top and bottom, back to the face.
            for row, z in ((front[0], z1), (front[1], z0)):
                back = [part.vert(v.co + Vector((0, g["off"] + 0.002, 0)), "head") for v in row]
                pair = [row, back] if z == z0 else [back, row]
                for i in range(len(row) - 1):
                    a, b = pair
                    part.face([a[i], a[i + 1], b[i + 1], b[i]], self.mats.metal, False, True)
            # The end at the side.
            e0, e1 = front[0][-1], front[1][-1]
            part.face([e0, e1, part.vert(e1.co + Vector((0, g["off"] + 0.002, 0)), "head"),
                       part.vert(e0.co + Vector((0, g["off"] + 0.002, 0)), "head")], self.mats.metal, False, True)

    def disc(self, at, normal, radius, depth, bone, metal, dark, left=False, light=None):
        """A disc standing off a surface: its rim, a dark face recessed in
        it, and a lamp at its middle if asked."""
        part = self.part
        n = Vector(normal).normalized()
        a = _across(n)
        b = n.cross(a)
        sides = 14

        def ring(r, off):
            return [at + n * off + (a * math.cos(2 * math.pi * k / sides) + b * math.sin(2 * math.pi * k / sides)) * r
                    for k in range(sides)]

        back = ring(radius * 0.92, -0.004)
        outer = ring(radius, depth)
        inner = ring(radius * 0.72, depth)
        well = ring(radius * 0.7, depth - 0.003)
        rows = [back, outer, inner, well]
        vs, _ = part.grid(rows[:3], metal, bone, closed=True, left=left)
        vw = [part.vert(q, bone) for q in well]
        for i in range(sides):
            j = (i + 1) % sides
            part.face([vs[2][i], vs[2][j], vw[j], vw[i]], dark, False, left)
        if light is not None:
            lamp = ring(radius * 0.28, depth - 0.003)
            vl = [part.vert(q, bone) for q in lamp]
            for i in range(sides):
                j = (i + 1) % sides
                part.face([vw[i], vw[j], vl[j], vl[i]], dark, False, left)
            part.fan(vl, at + n * (depth - 0.001), light, bone, left)
        else:
            part.fan(vw, at + n * (depth - 0.003), dark, bone, left)

    def ear_disc(self, side):
        p = self.p["head"]["ear"]
        at = self.ears[side]
        sign = 1.0 if side == "l" else -1.0
        n = Vector((sign, 0, 0))
        self.disc(at, n, p["radius"], p["stand"], EARS[side], self.mats.metal, self.mats.dark, left=True,
                  light=self.mats.glass if p.get("lamp") else None)

    def neck(self):
        """The neck's lames, each ring stepping out over the one above;
        and a piston each side behind."""
        c = self.p["neck"]
        bones = self.arm.data.bones
        nb = bones["neck_01"]
        h, t = nb.head_local, nb.tail_local
        z0 = h.z - c["below"]
        z1 = self.lips.z - c["under-jaw"]
        skin = self.marks.skin
        n = c["lames"]
        sides = c["sides"]
        part = self.part
        for k in range(n):
            za = z0 + (z1 - z0) * k / n
            zb = z0 + (z1 - z0) * (k + 1) / n + c["overlap"]
            out = c["out"] + c["step"] * (n - 1 - k)
            rings = []
            for z, extra in ((za, 0.0), (zb, -c["taper"])):
                axis = h + (t - h) * max(0.0, min(1.0, (z - h.z) / max(t.z - h.z, 1e-3)))
                axis = Vector((0.0, axis.y, axis.z))
                band = skin[np.abs(skin[:, 2] - z) < 0.006]
                band = np.concatenate([band, band * np.array([-1, 1, 1])])
                ring = []
                for j in range(sides):
                    a = 2 * math.pi * j / sides
                    d = np.array([math.sin(a), -math.cos(a)])
                    rel = band[:, :2] - np.array([axis.x, axis.y])
                    # The neck's radius that way: its section's furthest.
                    proj = rel @ d
                    along = np.abs(rel @ np.array([d[1], -d[0]]))
                    near = proj[along < 0.012]
                    r = float(near.max()) if len(near) else 0.05
                    ring.append(Vector((axis.x + d[0] * (r + out + extra), axis.y + d[1] * (r + out + extra), z)))
                rings.append(ring)
            # The lame's lip turned in at its bottom.
            lip = [axis_pt + (q - axis_pt) * 0.9 for q, axis_pt in
                   ((q, Vector((h.x, h.y, q.z))) for q in rings[0])]
            vs, _ = part.grid([lip, rings[0], rings[1]], self.mats.metal, "neck_01", closed=True, flip=True)
        # The pistons, behind each side, from the shoulders to the skull.
        pc = c["piston"]
        for side, sign in (("l", 1.0),):
            base = Vector((sign * pc["x"], h.y + pc["back"], z0))
            top = Vector((sign * pc["x"] * 0.8, h.y + pc["back"] - 0.01, z1 + 0.03))
            mid = base.lerp(top, 0.55)
            self.rod(base, mid, pc["radius"], "neck_01", self.mats.dark)
            self.rod(base.lerp(top, 0.4), top, pc["radius"] * 0.55, "head", self.mats.metal)

    def rod(self, a, b, r, bone, mat, sides=6, left=True):
        d = (b - a).normalized()
        u = _across(d)
        w = d.cross(u)
        rows = []
        for end in (a, b):
            rows.append([end + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * r
                         for k in range(sides)])
        vs, _ = self.part.grid(rows, mat, bone, closed=True, left=left, smooth=True)
        self.part.fan(vs[0], a, mat, bone, left=left, flip=True)
        self.part.fan(vs[1], b, mat, bone, left=left)


def _across(n):
    """A direction square to n, the figure's left where it can be (so a
    ring round n on the middle is its own mirror), else up."""
    for t in (Vector((1, 0, 0)), Vector((0, 0, 1))):
        a = t - n * t.dot(n)
        if a.length > 0.3:
            return a.normalized()
    return n.orthogonal().normalized()


def _loops(bm):
    """The bmesh's open edges as closed loops of vertices."""
    edges = [e for e in bm.edges if e.is_boundary]
    nxt = {}
    for e in edges:
        a, b = e.verts
        nxt.setdefault(a, []).append(b)
        nxt.setdefault(b, []).append(a)
    seen = set()
    out = []
    for start in nxt:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            cands = [x for x in nxt[cur] if x is not prev and x not in seen]
            if not cands:
                break
            prev, cur = cur, cands[0]
            loop.append(cur)
            seen.add(cur)
        if len(loop) > 2:
            out.append(loop)
    return out


def bury(skin, worn, ease, hips=True):
    """What of the plates and frame the coat's body hides, dropped but for
    a band beside what shows; never under its skirts, which part as the
    legs move. Returns how many faces went, by mesh."""
    over = [w for w in worn if w.kind == "garment" and not (w.spec.get("params") or {}).get("skirt")
            and w.spec["family"] != "cuffs"]
    if not over:
        return {}
    reach = max(ease[(w.spec.get("params") or {}).get("layer", w.spec["family"])] for w in over) + garment.COVER
    out = {"body": garment.bury(skin, [w.obj for w in over], reach, garment.BURY["body"])}
    # Under the skirts, the plates of the hips and the small of the back
    # only, which move with them.
    skirts = [w for w in worn if (w.spec.get("params") or {}).get("skirt")]
    if skirts and hips:
        reach = max(ease[(w.spec.get("params") or {}).get("layer", w.spec["family"])] for w in skirts) + garment.COVER
        out["hips"] = sum(_bury_on(skin, [w.obj for w in skirts], reach, b) for b in ("pelvis", "spine_01", "spine_02"))
    return out


def _bury_on(obj, overs, reach, bone):
    """Drops the faces wholly on one bone that a ray out along their
    normals finds the meshes over them within reach of, with their mirror
    images."""
    tree = _tree_of(overs)
    g = obj.vertex_groups[bone].index
    on = np.zeros(len(obj.data.vertices), bool)
    for v in obj.data.vertices:
        on[v.index] = any(x.group == g and x.weight > 0.999 for x in v.groups)
    gone = []
    for f in obj.data.polygons:
        # What the figure sits on stays: it seats the figure.
        if not all(on[i] for i in f.vertices) or (bone == "pelvis" and f.normal.z < 0.0):
            continue
        c = obj.matrix_world @ f.center
        if tree.ray_cast(c + f.normal * 1e-4, f.normal, reach)[0] is not None:
            gone.append(f.index)
    # Both sides lose the same.
    centres = np.array([tuple(f.center) for f in obj.data.polygons])
    from mathutils.kdtree import KDTree

    kd = KDTree(len(centres))
    for i, c in enumerate(centres):
        kd.insert(c, i)
    kd.balance()
    hidden = set(gone)
    both = [i for i in gone if kd.find((-centres[i][0], centres[i][1], centres[i][2]))[1] in hidden]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in both], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(both)


# --- Over the coat ------------------------------------------------------


def deck_keep(obj):
    """What the deck level keeps whole of what lies over the coat: the
    lantern, which tells a machine from behind."""
    g = obj.vertex_groups.get(LANTERN)
    out = np.zeros(len(obj.data.vertices))
    if g is not None:
        for v in obj.data.vertices:
            if any(x.group == g.index for x in v.groups):
                out[v.index] = 1.0
    return out


# The lantern's bone.
LANTERN = "spine_03"


def over_coat(job, v, arm, marks, worn):
    """What lies over the coat: the shoulder plates, laid on it, and the
    lantern at the nape. Returns them as worn, a part of kind "plate"."""
    p = params(job["look"], v)
    mats = Materials(p)
    coat = [w.obj for w in worn if w.kind == "garment"]
    tree = _tree_of(coat)
    part = Part("plates", mats)
    shoulder_plates(part, arm, marks, tree, p["shoulders"], mats)
    part.mirror_left()
    glass = lantern(part, arm, marks, tree, p["lantern"], mats)
    obj = part.object(arm)
    # Where the lantern's light is: the game hangs its glow there.
    obj["lantern"] = tuple(glass)
    return garment.Worn(obj, "plate", {"id": "plates", "region": "skin", "params": {}}, None)


def _tree_of(objs):
    verts, faces = [], []
    for o in objs:
        base = len(verts)
        verts.extend(o.matrix_world @ v.co for v in o.data.vertices)
        faces.extend([base + i for i in f.vertices] for f in o.data.polygons)
    return BVHTree.FromPolygons(verts, faces)


def shoulder_plates(part, arm, marks, coat, s, mats):
    """Layered plates over each shoulder, curved round the upper arm, each
    lying on the coat and stepping out over the one below."""
    b = arm.data.bones["upperarm_l"]
    h, t = b.head_local, b.tail_local
    axis = (t - h).normalized()
    up = (Vector((0, 0, 1)) - axis * axis.z).normalized()
    side = axis.cross(up).normalized()
    for k, (t0, t1, arc) in enumerate(s["lames"]):
        rows = []
        for tt in np.linspace(t0, t1, s["rows"]):
            row = []
            for phi in np.linspace(-arc, arc, s["columns"]):
                a = math.radians(phi)
                phi = abs(phi)
                d = up * math.cos(a) + side * math.sin(a)
                origin = h + axis * tt
                hit = coat.ray_cast(origin + d * 0.4, -d, 0.4)
                r = (hit[0] - origin).length if hit[0] is not None else 0.08
                # Standing off the coat at its crown, down to it at its sides.
                crown = math.cos(phi / arc * math.pi / 2) ** s["shape"]
                row.append(origin + d * (r + s["lift"] + (s["stand"] + s["step"] * (len(s["lames"]) - 1 - k)) * crown))
            rows.append(row)
        vs, _ = part.grid(rows, mats.metal, "upperarm_l", left=True, smooth=True, flip=True, uv=True)
        # The lower edge turned in toward the coat: the plate's thickness.
        last = vs[-1]
        lip = [part.vert(v.co - (v.co - (h + axis * t1)).normalized() * s["thick"], "upperarm_l") for v in last]
        for i in range(len(last) - 1):
            part.face([last[i], last[i + 1], lip[i + 1], lip[i]], mats.metal, False, True)
        first = vs[0]
        lip = [part.vert(v.co - (v.co - (h + axis * t0)).normalized() * s["thick"], "upperarm_l") for v in first]
        for i in range(len(first) - 1):
            part.face([first[i + 1], first[i], lip[i], lip[i + 1]], mats.metal, False, True)


def lantern(part, arm, marks, coat, c, mats):
    """A lantern at the nape, standing on the coat's collar: one solid, its
    base and roof metal, posts of dark iron at its corners and panes of
    glass between them, glowing; its top above the shoulder line. Returns
    the glass's middle."""
    nb = arm.data.bones["neck_01"]
    h = nb.head_local
    at = Vector((0, h.y + c["back"], h.z + c["up"]))
    hit = coat.ray_cast(at + Vector((0, 0, 0.3)), Vector((0, 0, -1)), 0.6)
    if hit[0] is not None:
        at.z = hit[0].z + 0.007
    r = c["radius"]
    height = c["height"]
    sides = 6
    post = c["post"]
    angles = []
    for k in range(sides):
        a = 2 * math.pi * k / sides + math.pi / 6
        angles += [a - post, a + post]
    bone = LANTERN

    def ring(scale, z):
        return [at + Vector((r * scale * math.cos(a), r * scale * math.sin(a), z)) for a in angles]

    # Bottom up: the base's foot and top, the step in to the glass, the
    # glass, the eave and its top; then the roof to its point.
    profile = [(1.15, -0.006, None), (1.15, 0.003, mats.metal), (0.92, 0.003, mats.metal),
               (0.92, height, "panes"), (1.2, height, mats.metal), (1.2, height + 0.004, mats.metal)]
    rings = [[part.vert(q, bone) for q in ring(sc, z)] for sc, z, _ in profile]
    n = len(angles)
    for k in range(1, len(profile)):
        m = profile[k][2]
        for i in range(n):
            j = (i + 1) % n
            mat = m
            if m == "panes":
                # A corner's post spans its two points; a pane, the corners
                # between.
                mat = mats.dark if i % 2 == 0 else mats.glass
            part.face([rings[k - 1][i], rings[k - 1][j], rings[k][j], rings[k][i]], mat)
    part.fan(rings[0], at - Vector((0, 0, 0.006)), mats.metal, bone, flip=True)
    part.fan(rings[-1], at + Vector((0, 0, height + c["roof"])), mats.metal, bone)
    return at + Vector((0, 0, height / 2))


class _Rods:
    """Enough of a Head for Head.rod on another part."""

    def __init__(self, part):
        self.part = part
