# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Garments: cut from MPFB's helpers, eased off the body, saved as .mhclo.

A garment is made by its family's cut (FAMILIES) from parameters, on the
body of the version that wears it, and saved as MPFB's .mhclo: its vertices
tied to the base mesh's, so it fits that body and takes its weights. Each
is made once a version (the woman's and the man's are cut apart, each on
her or his own body) and kept: matching is slow, fitting is not. The build
makes it again when its parameters, the body or this code change.

The cut:

- the source: MPFB's helper-tights (a clean quad bodysuit with arms), which
  follows every body, or a loft of the body's own sections for a skirt;
- the planes it is cut by, placed on the body's landmarks (the neck, the
  waist and hips, a fraction down the forearm, below the knee), cutting
  only the part of the body they name, so a hem at the hip leaves the
  hanging sleeves whole;
- the ease: every vertex set off the skin by its layer's ease (tables'
  ease: a coat stands off a waistcoat stands off a shirt), then relaxed;
- the edges: bands (a cuff, a waistband, a knee band) stood out from the
  garment, and a rim turned in at every open edge, so the cloth has one;
- for skirts, tails and aprons: a loft hung from the widest section above,
  flared by azimuth, fan pleats and a vent, and weights on the skeleton's
  skirt chains, never the legs';
- the delete group: the skin the garment covers, by rays out along the
  skin's normals, less one ring at its edges, which the body then drops;
- the cloth made its own mirror.

Once fitted, what cannot be seen is buried at every level (bury): the
skin under the clothes, a garment under another, each but for a band at
its edges; and what is left under a garment is drawn in wherever a pose
the sailors are judged in would bring it through (settle), so that
nothing hidden comes through when the figure moves.
"""

import hashlib
import inspect
import json
import os
import uuid
from collections import namedtuple

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import atlas
import body
import landmarks
import lod
import mpfbx

Worn = namedtuple("Worn", "obj kind spec path")

NAMESPACE = uuid.UUID("0c8d6c55-8a6b-4f3e-9a1e-2b77a8e3f4d1")

# Which part of the body each bone moves.
ARM = ("clavicle", "upperarm", "lowerarm", "hand", "thumb", "index", "middle", "ring", "pinky")
LEG = ("thigh", "calf", "foot", "ball")
TORSO = ("pelvis", "spine", "neck", "head")

# How far past its ease a ray from the skin may find the garment and the
# skin still count as covered.
COVER = 0.02

# What is kept of a buried surface beside what shows, in metres: of the
# skin, so a cuff seen into shows no gap; of a garment under another (a
# shirt tucked into breeches), its tuck.
BURY = {"body": 0.01, "garment": 0.025}


def dress(job, v, human, arm, marks, work):
    """Fits the look's garments to the human, making each first if what it
    is made from changed."""
    look = job["look"]
    ease = job["tables"]["ease"]
    out = []

    def layer(spec):
        return (spec.get("params") or {}).get("layer", spec["family"])

    for spec in look.get("garments") or []:
        params = dict(spec.get("params") or {})
        params.update(spec.get(v) or {})
        if spec["family"] not in FAMILIES:
            raise ValueError(f"{spec['id']}: no garment family {spec['family']!r}")
        path = os.path.join(garments_dir(job), f"{spec['id']}.{v}.mhclo")
        under = max([ease[layer(o)] for o in look["garments"] if ease[layer(o)] < ease[layer(spec)]] + [0.0])
        k = key(spec, v, params, job, look)
        if lod.made_from(path) != k:
            make(human, marks, spec, params, ease, path, k, under)
        obj = fit(human, path, spec["id"])
        # The fit is within a millimetre of the cut, unevenly: made its own
        # mirror again.
        mirror(obj)
        obj.data.materials.clear()
        colour = atlas.linear(spec["colour"]) if spec["region"] == "fixed" else None
        obj.data.materials.append(atlas.part(bpy.data.materials.new(spec["id"]), colour, spec["region"]))
        if params.get("skirt"):
            skirt_weights(obj, arm, marks)
        out.append(Worn(obj, "garment", spec, path))
    return out


def garments_dir(job):
    """Where a look's garments are kept: beside the art for the game's
    looks, in .dev for the build's own."""
    if job["look"]["committed"]:
        return os.path.join(job["root"], "art", "sailors", "garments", job["look"]["id"])
    return os.path.join(os.path.dirname(os.path.dirname(job["work"])), "garments", job["look"]["id"])


def key(spec, v, params, job, look):
    """What a garment is made from: its parameters, the ease, the body, the
    code that cuts it and MPFB."""
    h = hashlib.sha256()
    version = look["versions"][v]
    h.update(json.dumps([spec, v, params, job["tables"]["ease"], job["bases"][version["base"]], version],
                        sort_keys=True).encode())
    for f in (make, source, cut, keep_parts, ease_off, relax, band, rim, cover, loft, pleats, vent, _classes,
              _section_radii, symmetrize, _mirrors, Mirror) + tuple(FAMILIES.values()):
        h.update(inspect.getsource(f).encode())
    h.update(mpfbx.version().encode())
    return h.hexdigest()[:16]


def make(human, marks, spec, params, ease, path, k, under=0.0):
    name = os.path.basename(path)
    print(f"build: making {name}, once")
    skin = Skin(human)
    bm = FAMILIES[spec["family"]](human, marks, params)
    # The cut is its own mirror; every step after keeps it so (the nearest
    # skin between the legs may be either leg's).
    pairs = Mirror(bm)
    layer = params.get("layer", spec["family"])
    if layer not in ease:
        raise ValueError(f"{spec['id']}: no ease for the layer {layer!r}")
    if spec["family"] != "skirt":
        ease_off(bm, skin, ease[layer], pairs)
        relax(bm, skin, ease[layer], params.get("relax", 3), pairs)
    for b in params.get("bands", []):
        band(bm, skin, b, ease[layer])
        pairs.apply(bm)
    # The rim turns in no further than halfway to what is under it.
    rim(bm, min(params.get("rim", 0.004), (ease[layer] - under) / 2))
    symmetrize(bm)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])

    me = bpy.data.meshes.new(spec["id"])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"] + "-made", me)
    bpy.context.scene.collection.objects.link(obj)
    for layer_uv in list(me.uv_layers)[1:]:
        me.uv_layers.remove(layer_uv)
    # A vertex matches only within the base mesh's group of the same name.
    group = "helper-skirt" if spec["family"] == "skirt" else "helper-tights"
    obj.vertex_groups.new(name=group).add(range(len(me.vertices)), 1.0, "REPLACE")

    deleted = cover(human, obj, ease[layer])
    dg_name = "delete-" + spec["id"]
    dg = human.vertex_groups.new(name=dg_name)
    dg.add(deleted, 1.0, "REPLACE")

    clothes = mpfbx.service("ClothesService")
    mhclo = clothes.create_mhclo_from_clothes_matching(human, obj, delete_group=dg_name)
    mhclo.name = spec["id"]
    mhclo.uuid = str(uuid.uuid5(NAMESPACE, name))
    mhclo.author = "Keel Over the Edge"
    mhclo.license = "LicenseRef-All-Rights-Reserved"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mhclo.write_mhclo(path, reference_scale=clothes.get_reference_scale(human))
    lod.stamp(path, k)
    human.vertex_groups.remove(dg)

    made = body.coords(obj)
    fitted = fit(human, path, spec["id"] + "-check")
    err = float(np.abs(body.coords(fitted) - made).max())
    bpy.data.objects.remove(fitted, do_unlink=True)
    bpy.data.objects.remove(obj, do_unlink=True)
    if err > lod.FIT_TOLERANCE:
        os.remove(path)
        raise AssertionError(f"{name} fits {err * 1000:.1f} mm off the body it was made on")
    print(f"build: {name}: {len(made)} vertices, {len(deleted)} of the body's covered, fitted within {err * 1000:.2f} mm")


def fit(human, path, name):
    """The garment, fitted to the human, and weighted when it is rigged."""
    rigged = human.parent is not None
    # MPFB would copy the garment's delete group onto the proxy, finding the
    # proxy's file among its own assets, where ours is not: the build hides
    # what is covered itself (hide), so the proxy is set aside meanwhile.
    props = mpfbx.entity("objectproperties", "GeneralObjectProperties")
    aside = [o for o in bpy.data.objects if props.get_value("object_type", entity_reference=o) == "Proxymeshes"]
    for o in aside:
        props.set_value("object_type", "Sailorbody", entity_reference=o)
    try:
        obj = mpfbx.service("HumanService").add_mhclo_asset(
            path, human, asset_type="Clothes", subdiv_levels=0, material_type="NONE",
            set_up_rigging=rigged, interpolate_weights=rigged, import_subrig=False, import_weights=False)
    finally:
        for o in aside:
            props.set_value("object_type", "Proxymeshes", entity_reference=o)
    for m in list(obj.modifiers):
        if m.type in ("SUBSURF", "MASK"):
            obj.modifiers.remove(m)
    obj.name = obj.data.name = name
    # MPFB hides what the garment covers by a modifier on the base mesh;
    # the build drops it from the proxy itself (hide).
    for m in list(human.modifiers):
        if m.type == "MASK" and m.name != "Hide helpers":
            human.modifiers.remove(m)
    return obj


# --- The body under the garment ----------------------------------------


class Skin:
    """The body's skin, for nearest points."""

    def __init__(self, human):
        mask = body.in_group(human, "body")
        bm = bmesh.new()
        bm.from_mesh(human.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not mask[v.index]], context="VERTS")
        bm.normal_update()
        self.tree = BVHTree.FromBMesh(bm)
        bm.free()

    def nearest(self, p):
        loc, normal, _, dist = self.tree.find_nearest(p)
        return loc, normal, dist


def _classes(human):
    """Each vertex of the base mesh: "arm", "leg" or "torso", by the bone
    that moves it most."""
    names = {g.index: g.name for g in human.vertex_groups}
    out = np.full(len(human.data.vertices), "torso", dtype=object)
    for v in human.data.vertices:
        best, w = None, 0.0
        for g in v.groups:
            n = names[g.group]
            if g.weight > w and n.startswith(ARM + LEG + TORSO):
                best, w = n, g.weight
        if best and best.startswith(ARM):
            out[v.index] = "arm"
        elif best and best.startswith(LEG):
            out[v.index] = "leg"
    return out


# --- The cut ------------------------------------------------------------

PARTS = {"torso": 0, "arm": 1, "leg": 2}


def source(human, group):
    """A bmesh of a helper's faces, each vertex's part of the body in its
    layer "part" (PARTS)."""
    mask = body.in_group(human, group)
    classes = _classes(human)
    bm = bmesh.new()
    bm.from_mesh(human.data)
    layer = bm.verts.layers.int.new("part")
    for v in bm.verts:
        v[layer] = PARTS[classes[v.index]]
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not mask[v.index]], context="VERTS")
    for g in list(bm.verts.layers.deform):
        bm.verts.layers.deform.remove(g)
    return bm


def cut(bm, point, normal, parts=None):
    """Cuts the faces of the given parts (all, if None) by a plane, keeping
    the side the normal points to."""
    layer = bm.verts.layers.int["part"]
    point, normal = Vector(point), Vector(normal).normalized()

    def ours(f):
        return parts is None or all(v[layer] in parts for v in f.verts)

    faces = [f for f in bm.faces if ours(f)]
    geom = list({e for f in faces for e in f.edges}) + faces + list({v for f in faces for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=point, plane_no=normal, dist=1e-5)
    drop = [f for f in bm.faces if ours(f) and sum((v.co - point).dot(normal) for v in f.verts) / len(f.verts) < -1e-6]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def keep_parts(bm, parts):
    """Drops the faces not wholly of the given parts of the body."""
    layer = bm.verts.layers.int["part"]
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not all(v[layer] in parts for v in f.verts)], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


# --- The families --------------------------------------------------------


def shirt(human, marks, p):
    """A shirt: the torso from the neck to below the hips (tucked in), the
    sleeves to a share of the forearm."""
    bm = source(human, "helper-tights")
    m = marks.measure()
    keep_parts(bm, (PARTS["torso"], PARTS["arm"]))
    cut(bm, (0, 0, marks.joint("neck")[2] - p.get("neck", 0.02)), (0, 0, -1), parts=(PARTS["torso"],))
    cut(bm, (0, 0, m["heights"]["hip"] - p.get("below-hip", 0.02)), (0, 0, 1), parts=(PARTS["torso"],))
    for side in ("l", "r"):
        elbow, wrist = Vector(marks.joint(f"{side}-elbow")), Vector(marks.joint(f"{side}-hand"))
        at = elbow + (wrist - elbow) * p.get("sleeve", 0.9)
        cut(bm, at, elbow - wrist, parts=(PARTS["arm"],))
    return bm


def breeches(human, marks, p):
    """Breeches: the waist to below the knee."""
    bm = source(human, "helper-tights")
    m = marks.measure()
    keep_parts(bm, (PARTS["torso"], PARTS["leg"]))
    cut(bm, (0, 0, m["heights"]["waist"] + p.get("rise", 0.02)), (0, 0, -1))
    knee = min(marks.joint("l-knee")[2], marks.joint("r-knee")[2])
    cut(bm, (0, 0, knee - p.get("below-knee", 0.06)), (0, 0, 1), parts=(PARTS["leg"],))
    return bm


def skirt(human, marks, p):
    """A skirt or coat's tails hung from the waist, lofted from the body's
    sections: close at the hips, flaring below them by azimuth (to the
    sides and back more than the front), with fan pleats and a vent if
    asked."""
    m = marks.measure()
    top = m["heights"]["waist"] + p.get("rise", 0.0)
    hem = top - p.get("length", 0.5)
    hip = m["heights"]["hip"]
    rows = p.get("rows", 10)
    columns = p.get("columns", 48)
    ease = p.get("ease", 0.024)
    sections = []
    for i in range(rows + 1):
        z = top + (hem - top) * i / rows
        # Below the hips it hangs from the widest section above it.
        mid, radii = _section_radii(marks, max(z, hip), columns)
        sections.append((z, (mid, radii + ease), max(0.0, hip - z)))
    flare = p.get("flare", {"front": 0.05, "side": 0.25, "back": 0.2})
    bm = loft(sections, columns, flare)
    if p.get("pleats"):
        pleats(bm, **p["pleats"])
    if p.get("vent"):
        vent(bm, **p["vent"])
    return bm


FAMILIES = {"shirt": shirt, "breeches": breeches, "skirt": skirt}


def _section_radii(marks, z, columns):
    """The body's outline at height z as a radius at each of columns
    azimuths about its middle (0 the front, turning to the figure's left)."""
    o = marks.section.outline(z, marks.near(z))
    mid = np.array(marks.near(z))
    radii = []
    for c in range(columns):
        a = 2 * np.pi * c / columns
        d = np.array([np.sin(a), -np.cos(a)])
        radii.append(float(max((o - mid) @ d)) if len(o) else 0.1)
    return mid, np.array(radii)


def loft(sections, columns, flare):
    """A tube through sections, each (z, (middle, radii), drop below the
    widest), its radii flared by azimuth in proportion to the drop, with a
    UV grid."""
    bm = bmesh.new()
    part = bm.verts.layers.int.new("part")
    uv = bm.loops.layers.uv.new("UVMap")
    rings = []
    for z, (mid, radii), drop in sections:
        ring = []
        for c in range(columns):
            a = 2 * np.pi * c / columns
            front = np.cos(a)
            share = flare["front"] * max(front, 0) + flare["back"] * max(-front, 0) + flare["side"] * (1 - abs(front))
            rad = radii[c] + share * drop
            v = bm.verts.new((mid[0] + rad * np.sin(a), mid[1] - rad * np.cos(a), z))
            v[part] = PARTS["torso"]
            ring.append(v)
        rings.append(ring)
    for r in range(len(rings) - 1):
        for c in range(columns):
            n = (c + 1) % columns
            f = bm.faces.new((rings[r][c], rings[r][n], rings[r + 1][n], rings[r + 1][c]))
            for loop, (u, w) in zip(f.loops, ((c, r), (c + 1, r), (c + 1, r + 1), (c, r + 1))):
                loop[uv].uv = (u / columns, 1 - w / (len(rings) - 1))
    bm.normal_update()
    return bm


def pleats(bm, azimuths, count=6, depth=0.02, spread=0.6, apex=0.0):
    """Fan pleats: at each azimuth (degrees from the front), count folds
    over spread radians, folded in and out by depth, growing from nothing
    at the apex (a share of the length from the top) to the hem."""
    zs = [v.co.z for v in bm.verts]
    top, hem = max(zs), min(zs)
    for v in bm.verts:
        a = np.arctan2(v.co.x, -v.co.y)
        t = (top - v.co.z) / (top - hem)
        if t <= apex:
            continue
        grow = (t - apex) / (1 - apex)
        for az in azimuths:
            d = (a - np.radians(az) + np.pi) % (2 * np.pi) - np.pi
            if abs(d) < spread / 2:
                wave = np.sin(np.pi * count * (d / spread + 0.5))
                out = Vector((v.co.x, v.co.y, 0)).normalized()
                v.co += out * depth * wave * grow * np.cos(np.pi * d / spread)


def vent(bm, azimuth=180.0, start=0.4, lap=0.01):
    """Opens the skirt along its column at an azimuth (the back's) from a
    share of its length down, the left side lapped over the right."""
    zs = [v.co.z for v in bm.verts]
    top, hem = max(zs), min(zs)
    below = top - start * (top - hem) + 1e-6
    target = np.radians(azimuth)

    def off(v):
        return ((np.arctan2(v.co.x, -v.co.y) - target + np.pi) % (2 * np.pi)) - np.pi

    seam = [e for e in bm.edges if all(abs(off(v)) < 1e-3 and v.co.z <= below for v in e.verts)]
    bmesh.ops.split_edges(bm, edges=seam)
    # Of each pair the split made, the vertex whose faces lie to the left.
    for v in bm.verts:
        if abs(off(v)) < 1e-3 and v.co.z <= below and v.link_faces:
            side = np.mean([off_f for off_f in (((np.arctan2(f.calc_center_median().x, -f.calc_center_median().y)
                                                  - target + np.pi) % (2 * np.pi)) - np.pi for f in v.link_faces)])
            if side > 0:
                v.co += Vector((v.co.x, v.co.y, 0)).normalized() * lap


# --- Fitting it to the body ---------------------------------------------


def ease_off(bm, skin, ease, pairs=None):
    """Sets every vertex nearer the skin than the ease out to it, along the
    skin's normal at its nearest point; the pairs, if given, kept mirrored."""
    for v in bm.verts:
        loc, normal, _ = skin.nearest(v.co)
        if loc is not None and (v.co - loc).dot(normal) < ease:
            v.co = loc + normal * ease
    if pairs is not None:
        pairs.apply(bm)


def relax(bm, skin, ease, passes, pairs=None):
    """Smooths the cloth and sets it back off the skin, passes times: the
    helper's creases go, the ease stays."""
    for _ in range(passes):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        ease_off(bm, skin, ease, pairs)
    bm.normal_update()


class Mirror:
    """A mesh's vertices paired with their mirrors across x, as it is cut
    (exactly: MPFB's mesh is its own mirror); apply sets each pair's
    left-hand vertex (x < 0) to the mirror of its right, and the middle's
    onto it."""

    def __init__(self, bm):
        bm.verts.ensure_lookup_table()
        co = np.array([tuple(v.co) for v in bm.verts])
        pair = _mirrors(co, 1e-5)
        self.pairs = [(i, int(j)) for i, j in enumerate(pair) if co[i, 0] > 1e-6 and j != i]
        self.middle = [i for i in range(len(co)) if abs(co[i, 0]) <= 1e-6]

    def apply(self, bm):
        bm.verts.ensure_lookup_table()
        for i, j in self.pairs:
            c = bm.verts[i].co
            bm.verts[j].co = Vector((-c.x, c.y, c.z))
        for i in self.middle:
            bm.verts[i].co.x = 0.0


def _boundary_loops(bm):
    """The garment's open edges, as lists of vertices, one a hole."""
    edges = {e for e in bm.edges if e.is_boundary}
    loops = []
    while edges:
        e = edges.pop()
        loop = [e.verts[0], e.verts[1]]
        while True:
            nxt = next((f for f in loop[-1].link_edges if f in edges), None)
            if nxt is None:
                break
            edges.discard(nxt)
            v = nxt.other_vert(loop[-1])
            if v is loop[0]:
                break
            loop.append(v)
        loops.append(loop)
    return loops


def band(bm, skin, spec, ease):
    """Stands a band out from the garment beside its open edges: at "top"
    (a waistband), "bottom" (knee bands, a hem), or "ends" (the cuffs, the
    outermost). spec: {at, height, out}, in metres."""
    loops = _boundary_loops(bm)
    if not loops:
        return
    heights = [np.mean([v.co.z for v in lp]) for lp in loops]
    if spec["at"] == "top":
        chosen = [loops[int(np.argmax(heights))]]
    elif spec["at"] == "bottom":
        chosen = [lp for lp, h in zip(loops, heights) if h < min(heights) + 0.05]
    else:
        chosen = sorted(loops, key=lambda lp: -max(abs(v.co.x) for v in lp))[:2]
    for lp in chosen:
        edge = np.array([tuple(v.co) for v in lp])
        for v in bm.verts:
            if np.min(np.linalg.norm(edge - np.array(tuple(v.co)), axis=1)) < spec["height"]:
                loc, normal, _ = skin.nearest(v.co)
                if loc is not None:
                    v.co = loc + normal * (ease + spec["out"])


def rim(bm, depth):
    """Turns every open edge in toward the body by depth, so the cloth
    shows an edge, not a paper line."""
    bm.normal_update()
    edges = [e for e in bm.edges if e.is_boundary]
    if not edges or depth <= 0:
        return
    normals = {v: v.normal.copy() for e in edges for v in e.verts}
    out = bmesh.ops.extrude_edge_only(bm, edges=edges)
    made = [g for g in out["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in made:
        # The vertex it was extruded from shares its place.
        src = next(s for s in (e.other_vert(v) for e in v.link_edges) if s in normals)
        v.co = src.co - normals[src] * depth


def cover(human, garment, ease):
    """The base mesh's skin vertices the garment covers: a ray out along a
    vertex's normal meets it within its ease and a little more; less one
    ring at the edges, so no gap opens where the cloth ends."""
    bm = bmesh.new()
    bm.from_mesh(garment.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    mask = body.in_group(human, "body")
    me = human.data
    covered = set()
    for v in me.vertices:
        if mask[v.index]:
            hit = tree.ray_cast(v.co + v.normal * 0.001, v.normal, ease + COVER)
            if hit[0] is not None:
                covered.add(v.index)
    edge = set()
    for e in me.edges:
        a, b = e.vertices
        if mask[a] and mask[b] and (a in covered) != (b in covered):
            edge.update((a, b))
    return sorted(covered - edge)


def hide(human, skin, worn):
    """Drops the proxy's faces over skin the garments cover (their delete
    groups). Returns how many."""
    mhclo_cls = mpfbx.entity("clothes.mhclo", "Mhclo")
    deleted = set()
    for w in worn:
        if w.path is None:
            continue
        m = mhclo_cls()
        m.load(w.path)
        deleted.update(int(i) for i in (m.delverts or []))
    if not deleted:
        return 0
    proxy = mhclo_cls()
    proxy.load(lod.path("close"))
    hidden = np.zeros(len(skin.data.vertices), bool)
    for i, line in proxy.verts.items():
        hidden[i] = all(int(x) in deleted for x in line["verts"])
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    gone = [f for f in bm.faces if all(hidden[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(skin.data)
    bm.free()
    skin.data.update()
    return len(gone)


def bury(under, overs, reach, keep):
    """Drops the faces of under that the meshes over it hide, but for a
    band keep metres wide beside what shows. A vertex is hidden when a ray
    out along its normal meets one of overs within reach, or the nearest
    point of one is within reach and not at its open edge (so the skin in
    a crease is found, where the ray misses, and the skin past a hem is
    not); and only with its mirror, so both sides lose the same. Returns
    how many faces went."""
    me = under.data
    if not overs or not me.polygons:
        return 0
    co = body.coords(under)
    no = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", no)
    no = no.reshape(-1, 3)
    parts = []
    for o in overs:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        edge = {v.index for v in bm.verts if v.is_boundary}
        rim_faces = {f.index for f in bm.faces if any(v.index in edge for v in f.verts)}
        parts.append((BVHTree.FromBMesh(bm), rim_faces))
        bm.free()
    hidden = np.zeros(len(co), bool)
    for i, (p, n) in enumerate(zip(co, no)):
        p, n = Vector(p), Vector(n)
        for tree, rim_faces in parts:
            if tree.ray_cast(p + n * 1e-4, n, reach)[0] is not None:
                hidden[i] = True
                break
            loc, _, face, d = tree.find_nearest(p, reach)
            if loc is not None and face not in rim_faces:
                hidden[i] = True
                break
    hidden &= hidden[_mirrors(co)]
    shown = ~hidden
    if shown.any() and keep > 0:
        tree = KDTree(int(shown.sum()))
        for i in np.flatnonzero(shown):
            tree.insert(co[i], int(i))
        tree.balance()
        for i in np.flatnonzero(hidden):
            if tree.find(co[i])[2] <= keep:
                shown[i] = True
    bm = bmesh.new()
    bm.from_mesh(me)
    gone = [f for f in bm.faces if not any(shown[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(gone)


def _mirrors(co, within=0.002):
    """Each vertex's mirror across x (itself where it has none)."""
    tree = KDTree(len(co))
    for i, p in enumerate(co):
        tree.insert(p, i)
    tree.balance()
    out = np.arange(len(co))
    for i, p in enumerate(co):
        _, j, d = tree.find((-p[0], p[1], p[2]))
        if d <= within:
            out[i] = j
    return out


def bury_all(skin, worn, ease):
    """The skin under the garments, and each garment under those over it,
    dropped but for a band at their edges (BURY). Returns how many faces
    went, by mesh."""
    garments = sorted((w for w in worn if w.kind == "garment"),
                      key=lambda w: ease[(w.spec.get("params") or {}).get("layer", w.spec["family"])])
    out = {}

    def reach(w):
        return ease[(w.spec.get("params") or {}).get("layer", w.spec["family"])] + COVER

    if garments:
        out["body"] = bury(skin, [w.obj for w in garments], max(reach(w) for w in garments), BURY["body"])
    for i, inner in enumerate(garments):
        outer = garments[i + 1:]
        if outer:
            out[inner.obj.name] = bury(inner.obj, [w.obj for w in outer], COVER, BURY["garment"])
    return out


def mirror(obj):
    """symmetrize, on a fitted mesh: within the fit's few millimetres."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    symmetrize(bm, 0.005)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def settle(fig, lib, poses, worn, ease, gap=0.004, rounds=4, most=0.03):
    """Draws in what is under a garment wherever, in any of the poses (and
    at rest), it would come through what is over it: each vertex that does
    is moved in at rest by as much as it came through and gap more, along
    its normal as posed, taken back through its own skinning, and its
    mirror with it. What moves is hidden in the poses where it would have
    shown; at most `most`. Returns how many vertices moved."""
    import metrics

    lay = metrics.layers(worn, ease)
    arm = fig.arm
    moved = set()
    for _ in range(rounds):
        fig.reset()
        pairs = metrics.under_pairs(fig.meshes, lay)
        push = {}
        for name in ("rest",) + tuple(poses):
            if name == "rest":
                fig.reset()
            else:
                fig.pose(lib.poses[name])
            depths = {}
            metrics.poke(fig, pairs, depths)
            if not depths:
                continue
            inv = arm.matrix_world.inverted().to_3x3()
            skin = {b.name: np.array((pb.matrix @ b.matrix_local.inverted()).to_3x3())
                    for b, pb in zip(arm.data.bones, arm.pose.bones)}
            for (mesh, i), (depth, normal) in depths.items():
                o = next(m for m in fig.meshes if m.name == mesh)
                names = {g.index: g.name for g in o.vertex_groups}
                m = sum(g.weight * skin[names[g.group]] for g in o.data.vertices[i].groups if names[g.group] in skin)
                d = -(np.array(inv @ Vector(normal))) * min(depth + gap, most)
                rest = np.linalg.solve(m, d)
                if np.linalg.norm(rest) > np.linalg.norm(push.get((mesh, i), np.zeros(3))):
                    push[(mesh, i)] = rest
        fig.reset()
        if not push:
            break
        # Each move made on both sides, so the figure stays its own mirror.
        for mesh in {m for m, _ in push}:
            o = next(m for m in fig.meshes if m.name == mesh)
            pair = _mirrors(body.coords(o))
            both = {}
            for (m, i), d in push.items():
                if m != mesh:
                    continue
                if pair[i] == i:
                    # On the middle: it stays there.
                    d = d * np.array([0, 1, 1])
                for j, dj in ((i, d), (pair[i], d * np.array([-1, 1, 1]))):
                    if np.linalg.norm(dj) > np.linalg.norm(both.get(j, np.zeros(3))):
                        both[j] = dj
            for j, d in both.items():
                o.data.vertices[j].co += Vector(d)
                moved.add((mesh, j))
            o.data.update()
    return len(moved)


def symmetrize(bm, within=0.003):
    """Makes the cloth its own mirror: each vertex and its mirror moved to
    their mean, the middle's onto it."""
    co = np.array([tuple(v.co) for v in bm.verts])
    pair = _mirrors(co, within)
    verts = list(bm.verts)
    for i, v in enumerate(verts):
        j = pair[i]
        if abs(co[i, 0]) < 1e-4 or j == i and abs(co[i, 0]) < within:
            v.co.x = 0.0
        elif j != i and co[i, 0] > 0:
            m = (co[i] + co[j] * np.array([-1, 1, 1])) / 2
            v.co = Vector(m)
            verts[j].co = Vector((-m[0], m[1], m[2]))


def skirt_weights(obj, arm, marks):
    """Weights a skirt on the skirt chains below the hips, by azimuth (the
    two nearest chains) and height (the upper bone, then the lower), and
    on the pelvis above them."""
    chains = {b.name[: -len("_01")]: b for b in arm.data.bones if b.name.startswith("skirt_") and b.name.endswith("_01")}
    hip = marks.measure()["heights"]["hip"]
    azimuth = {n: np.arctan2(b.head_local.x, -b.head_local.y) for n, b in chains.items()}
    obj.vertex_groups.clear()
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in arm.data.bones if b.name.startswith(("skirt_", "pelvis"))}

    def apart(a, b):
        return abs(((a - b + np.pi) % (2 * np.pi)) - np.pi)

    for v in obj.data.vertices:
        if v.co.z >= hip:
            groups["pelvis"].add([v.index], 1.0, "REPLACE")
            continue
        a = np.arctan2(v.co.x, -v.co.y)
        near = sorted(azimuth, key=lambda n: apart(a, azimuth[n]))[:2]
        d = [apart(a, azimuth[n]) for n in near]
        share = [d[1] / (d[0] + d[1] + 1e-9), d[0] / (d[0] + d[1] + 1e-9)]
        first = arm.data.bones[near[0] + "_01"]
        lower = float(np.clip((first.head_local.z - v.co.z) / max(first.length, 1e-3) - 0.5, 0, 1))
        for n, w in zip(near, share):
            groups[n + "_01"].add([v.index], w * (1 - lower), "ADD")
            groups[n + "_02"].add([v.index], w * lower, "ADD")


def measure(marks, meshes):
    """The dressed figure's widths at the bare body's heights."""
    return marks.measure(dressed=landmarks.Section.of_many(meshes))
