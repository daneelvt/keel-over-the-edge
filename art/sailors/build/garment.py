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
import math
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
import patterns

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
        params = version_params(spec, v)
        if spec["family"] not in FAMILIES:
            raise ValueError(f"{spec['id']}: no garment family {spec['family']!r}")
        path = os.path.join(garments_dir(job), f"{spec['id']}.{v}.mhclo")
        under = max([ease[layer(o)] for o in look["garments"] if ease[layer(o)] < ease[layer(spec)]] + [0.0])
        k = key(spec, v, params, job, look)
        if lod.made_from(path) != k:
            make(human, marks, spec, params, ease, path, k, under)
        obj = fit(human, path, spec["id"])
        if params.get("flare"):
            flare(obj, marks, params["flare"])
        # The fit is within a millimetre of the cut, unevenly: made its own
        # mirror again.
        mirror(obj)
        if params.get("ragged"):
            ragged(obj, params["ragged"])
        for poly in obj.data.polygons:
            poly.use_smooth = True
        obj.data.materials.clear()
        colour = atlas.linear(spec["colour"]) if spec["region"] == "fixed" else None
        mat = atlas.part(bpy.data.materials.new(spec["id"]), colour, spec["region"])
        if spec["region"] != "fixed" and params.get("shade"):
            # A shade of the chosen colour: a facing, a lining.
            mat["part_colour"] = [atlas.NEUTRAL * params["shade"]] * 3
        if params.get("pattern"):
            patterns.paint(mat, params["pattern"])
        obj.data.materials.append(mat)
        if params.get("skirt"):
            skirt_weights(obj, arm, marks, params.get("hips"))
        out.append(Worn(obj, "garment", spec, path))
    return out


def flare(obj, marks, f):
    """Wide legs, as slops are: below the crotch each vertex pushed out from
    its leg's middle, by nothing at the crotch growing to f["out"] at the
    knee and on below it (as the power f["power"] of the way down), less
    on the inner side, where the legs face each other (f["inner"], a
    share). Done on the fitted garment, so it is its body's own."""
    out, power, inner = f.get("out", 0.04), f.get("power", 1.3), f.get("inner", 0.3)
    top = marks.crotch()
    knee = min(marks.joint("l-knee")[2], marks.joint("r-knee")[2])
    middles = {}

    def middle_of(z, side):
        # The leg's section at z (the largest on its side: not a hand's).
        key = (round(z / 0.005), side)
        if key not in middles:
            legs = [o for o in marks.section.outlines(key[0] * 0.005) if o[:, 0].mean() * side > 0.02]
            middles[key] = max(legs, key=len).mean(0) if legs else None
        return middles[key]

    for v in obj.data.vertices:
        c = v.co
        if c.z >= top or abs(c.x) < 1e-4:
            continue
        t = min(1.0, (top - c.z) / max(top - knee, 1e-3)) ** power
        side = 1.0 if c.x > 0 else -1.0
        middle = middle_of(c.z, side)
        if middle is None:
            continue
        d = Vector((c.x - middle[0], c.y - middle[1], 0.0))
        if d.length < 1e-6:
            continue
        d.normalize()
        # 1 on the outer side, inner on the inner, between them round it.
        k = inner + (1 - inner) * (0.5 + 0.5 * d.x * side)
        v.co = c + d * (out * t * k)
    obj.data.update()


def ragged(obj, r):
    """A worn hem: torn back unevenly from its lowest edge. Round the
    garment the hem is cut back by up to depth metres, by a profile drawn
    at random (the same every build) over teeth pieces, some whole; the
    faces below it go. Done on the fitted garment, so its .mhclo is as it
    was made; not its own mirror (asymmetric)."""
    depth, teeth = r.get("depth", 0.03), r.get("teeth", 14)
    rng = np.random.default_rng(r.get("seed", 1))
    cuts = rng.uniform(0.0, 1.0, teeth) ** r.get("power", 1.5)
    cuts[rng.uniform(0, 1, teeth) < r.get("whole", 0.3)] = 0.0
    co = body.coords(obj)
    hem = float(co[:, 2].min())
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    gone = []
    for f in bm.faces:
        c = f.calc_center_median()
        a = (np.arctan2(c.x, -c.y) / (2 * np.pi)) % 1.0 * teeth
        i = int(a)
        t = a - i
        # A tooth's edge: from one cut to the next, a jagged line.
        cut = cuts[i] * (1 - t) + cuts[(i + 1) % teeth] * t
        cut += 0.35 * abs(np.sin(np.pi * a * 2.0)) * max(cuts[i], cuts[(i + 1) % teeth])
        if c.z < hem + depth * cut:
            gone.append(f)
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()


def version_params(spec, v):
    """A part's parameters for a version: its own, with the version's
    (given beside them or among them) over them."""
    params = dict(spec.get("params") or {})
    mine = params.pop(v, None) or {}
    for other in ("female", "male"):
        params.pop(other, None)
    params.update(mine)
    params.update(spec.get(v) or {})
    return params


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
    for f in (make, source, cut, keep_parts, ease_off, relax, band, rim, cover, loft, pleats, vent, opening,
              shoulder, sleeves, _hull_radii, _radial, _classes, _section_radii, symmetrize, _mirrors, Mirror, _forearm, _strip, _blob) \
            + tuple(FAMILIES.values()) + tuple(AFTER.values()):
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
    # The garment's own ease, if it says, may be less than its layer's
    # (which orders the layers): a coat close on the body, closer on the
    # sleeves.
    own = params.get("ease", ease[layer])
    if spec["family"] not in SHAPED:
        ease_off(bm, skin, own, pairs)
        relax(bm, skin, own, params.get("relax", 3), pairs)
        if params.get("arm-ease") is not None:
            sleeves(bm, skin, params["arm-ease"], pairs)
    if params.get("shoulder"):
        shoulder(bm, skin, marks, params["shoulder"], own, pairs, params.get("arm-ease", own))
    if spec["family"] in AFTER:
        AFTER[spec["family"]](bm, skin, marks, params, own)
        pairs.apply(bm)
    for b in params.get("bands", []):
        band(bm, skin, b, own)
        pairs.apply(bm)
    # The rim turns in no further than halfway to what is under it.
    rim(bm, min(params.get("rim", 0.004), max(own - under, 0.002) / 2))
    symmetrize(bm)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])

    me = bpy.data.meshes.new(spec["id"])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"] + "-made", me)
    bpy.context.scene.collection.objects.link(obj)
    for layer_uv in list(me.uv_layers)[1:]:
        me.uv_layers.remove(layer_uv)
    if params.get("triangles"):
        lod.decimate(obj, params["triangles"])
        me = obj.data
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


def cut(bm, point, normal, parts=None, side=0):
    """Cuts the faces of the given parts (all, if None) by a plane, keeping
    the side the normal points to; only the faces on one side of the body
    if side is 1 (its left, +x) or -1."""
    layer = bm.verts.layers.int["part"]
    point, normal = Vector(point), Vector(normal).normalized()

    def ours(f):
        return ((parts is None or all(v[layer] in parts for v in f.verts))
                and (side == 0 or all(v.co.x * side > 0 for v in f.verts)))

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
    full = p.get("ease", 0.024)
    # Its top tucked under the body it hangs from: the ease grows from
    # top-ease at the top to the full by the hips.
    top_ease = p.get("top-ease", full)
    sections = []
    follow = p.get("follow", 0.0)
    hung_mid, hung = _section_radii(marks, hip, columns)
    back = np.maximum(-np.cos(2 * np.pi * np.arange(columns) / columns), 0)
    for i in range(rows + 1):
        # Rows closer together toward the top, where the body curves.
        z = top + (hem - top) * (i / rows) ** p.get("bias", 1.0)
        if z >= hip:
            mid, radii = _section_radii(marks, z, columns)
        else:
            # Below the hips it hangs from the widest section above it; at
            # the back, if it follows, it comes in under the seat toward the
            # figure (the thighs' outline) by follow a metre of drop, and
            # then falls close.
            mid = hung_mid
            body = _hull_radii(marks, z, columns, mid)
            inward = np.maximum(body, hung - follow * (hip - z))
            radii = hung * (1 - back) + inward * back
        t = float(np.clip((top - z) / max(top - hip, 1e-3), 0, 1))
        ease = top_ease + (full - top_ease) * t * t * (3 - 2 * t)
        # Closer at the back if asked, below what is under it there.
        ease = ease + (p.get("back-ease", ease) - ease) * back * t
        sections.append((z, (mid, radii + ease), max(0.0, hip - z)))
    flare = p.get("flare", {"front": 0.05, "side": 0.25, "back": 0.2})
    bm = loft(sections, columns, flare)
    if p.get("pleats"):
        pleats(bm, **p["pleats"])
    if p.get("vent"):
        vent(bm, **p["vent"])
    for o in p["open"] if isinstance(p.get("open"), list) else [p["open"]] if p.get("open") else []:
        opening(bm, **o)
    return bm


def stockings(human, marks, p):
    """Stockings: the feet and legs, to above the knee (gartered under the
    breeches)."""
    bm = source(human, "helper-tights")
    keep_parts(bm, (PARTS["leg"],))
    knee = max(marks.joint("l-knee")[2], marks.joint("r-knee")[2])
    cut(bm, (0, 0, knee + p.get("above-knee", 0.07)), (0, 0, -1))
    return bm


def shoes(human, marks, p):
    """Shoes: the feet below a line that rises from the heel to a tongue
    over the instep; the sole made flat (AFTER)."""
    bm = source(human, "helper-tights")
    keep_parts(bm, (PARTS["leg"],))
    ankle = marks.joint("l-ankle")
    k = p.get("rise", 0.45)
    cut(bm, (0, ankle[1], ankle[2] + p.get("at", -0.015)), (0, k, -1))
    return bm


def _shoes_after(bm, skin, marks, p, ease):
    """The sole flat and a little under the foot, the toe squared."""
    sole = p.get("sole", 0.006)
    flat = p.get("flat", 0.018)
    for v in bm.verts:
        if v.co.z < flat:
            t = max(v.co.z, 0.0) / flat
            v.co.z = -sole + (flat + sole) * t ** 2.2


def bodice(human, marks, p):
    """A body: the torso from a neckline (lower at the front by its slope)
    to a little below the waist, with sleeves to a share of the forearm or
    armholes; open down the front if asked (the opening's half width at the
    neck, at the bust if given, and at the hem; its edges laid straight on
    that line if straight)."""
    bm = source(human, "helper-tights")
    m = marks.measure()
    parts = (PARTS["torso"], PARTS["arm"]) if p.get("sleeve") else (PARTS["torso"],)
    keep_parts(bm, parts)
    neck = marks.joint("neck")[2]
    cut(bm, (0, marks.joint("neck")[1], neck - p.get("neck", 0.015)), (0, p.get("neck-slope", 0.3), -1),
        parts=(PARTS["torso"],))
    cut(bm, (0, 0, m["heights"]["waist"] - p.get("below-waist", 0.03)), (0, 0, 1), parts=(PARTS["torso"],))
    if p.get("sleeve"):
        for side in ("l", "r"):
            elbow, wrist = _forearm(marks, side)
            at = elbow + (wrist - elbow) * p["sleeve"]
            cut(bm, at, elbow - wrist, parts=(PARTS["arm"],))
    if p.get("open"):
        o = p["open"]
        top, low = neck, m["heights"]["waist"] - p.get("below-waist", 0.03)
        # The edge straight from the neck to the hem, or by the bust's
        # height if it is given there.
        zs, halves = [low, top], [o["hem"], o["neck"]]
        if o.get("bust") is not None:
            zs, halves = [low, marks.bust()[0], top], [o["hem"], o["bust"], o["neck"]]
        layer = bm.verts.layers.int["part"]
        gone = []
        for f in bm.faces:
            c = f.calc_center_median()
            half = float(np.interp(c.z, zs, halves))
            if c.y < marks.near(c.z)[1] and abs(c.x) < half and all(v[layer] == PARTS["torso"] for v in f.verts):
                gone.append(f)
        bmesh.ops.delete(bm, geom=gone, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        # The fronts' edges laid on the opening's line if asked (straight):
        # straight, not the stair of the faces cut away.
        for v in bm.verts if o.get("straight") else ():
            half = float(np.interp(v.co.z, zs, halves))
            if (v.is_boundary and low + 0.01 < v.co.z < top - 0.01 and v.co.y < marks.near(v.co.z)[1]
                    and half <= abs(v.co.x) < half + 0.035 and v[layer] == PARTS["torso"]):
                v.co.x = math.copysign(half, v.co.x)
    return bm


def _forearm(marks, side):
    return Vector(marks.joint(f"{side}-elbow")), Vector(marks.joint(f"{side}-hand"))


def cuffs(human, marks, p):
    """Turned-back cuffs: a ring of the sleeve between two shares of the
    forearm, deeper at the back; flared toward its top (AFTER)."""
    bm = source(human, "helper-tights")
    keep_parts(bm, (PARTS["arm"],))
    for side, sign in (("l", 1), ("r", -1)):
        elbow, wrist = _forearm(marks, side)
        d = (wrist - elbow).normalized()
        lo = elbow + (wrist - elbow) * p.get("to", 0.85)
        hi = elbow + (wrist - elbow) * p.get("from", 0.5)
        # The top tipped so the back of the cuff stands higher.
        tip = Vector((0, p.get("back", 0.25), 0))
        cut(bm, lo, -d, parts=(PARTS["arm"],), side=sign)
        cut(bm, hi, (d + tip).normalized(), parts=(PARTS["arm"],), side=sign)
    # What is left of the hands' side is not a cuff: only rings round the
    # forearms remain.
    return bm


def _cuffs_after(bm, skin, marks, p, ease):
    """Stands each cuff further out toward its top, as a turned-back cuff
    does."""
    flare = p.get("flare", 0.012)
    for v in bm.verts:
        side = "l" if v.co.x > 0 else "r"
        elbow, wrist = _forearm(marks, side)
        t = float(np.clip((v.co - elbow).dot((wrist - elbow).normalized()) / (wrist - elbow).length, 0, 1))
        top, bottom = p.get("from", 0.5), p.get("to", 0.85)
        share = float(np.clip((bottom - t) / max(bottom - top, 1e-3), 0, 1))
        loc, n, _ = skin.nearest(v.co)
        if loc is not None:
            v.co = loc + n * (ease + flare * share)


def neckcloth(human, marks, p):
    """A neckcloth: a band wound round the neck (open at the back, under
    the hair, if asked), a knot at the throat if asked, and its two ends
    falling over the chest."""
    columns = p.get("columns", 24)
    ease = p.get("ease", 0.005)
    neck = marks.joint("neck")[2]
    lo, hi = neck - p.get("below", 0.005), neck + p.get("height", 0.045)
    # The neck's own sections, each row's; what reaches past the neck's
    # middle radius (half way up it) by more than a quarter is the
    # shoulders' or the jaw's, and cut back.
    _, middle = _section_radii(marks, neck + 0.015, columns)
    most = np.median(middle) * 1.25
    sections = []
    for i in range(4):
        z = lo + (hi - lo) * i / 3
        mid, radii = _section_radii(marks, z, columns)
        sections.append((z, (mid, np.minimum(radii, most) + ease), 0.0))
    bm = loft(sections, columns, {"front": 0, "side": 0, "back": 0})
    if p.get("open-back"):
        # Its ends tucked in under the hair at the back.
        opening(bm, azimuth=180, width=p["open-back"])
    skin = Skin(human)
    front_mid, front_r = _section_radii(marks, lo + 0.01, columns)
    throat = Vector((0, front_mid[1] - front_r[0] - ease, lo + 0.008))
    if p.get("knot"):
        k = p["knot"]
        _blob(bm, throat + Vector((0, -k[1] * 0.4, 0)), k)
    ends = dict(p.get("ends", {"length": 0.1, "width": 0.026, "spread": 0.006, "off": 0.02}))
    # From the band, standing out to their height over their first rows.
    ends["from"] = ease
    # One end laid on the chest, the other its mirror.
    right = _strip(bm, skin, throat, 1, ends)
    left = [[bm.verts.new((-v.co.x, v.co.y, v.co.z)) for v in row] for row in right]
    part = bm.verts.layers.int["part"]
    uv = bm.loops.layers.uv.active
    rows = len(left) - 1
    for r, (a, b) in enumerate(zip(left, left[1:])):
        f = bm.faces.new((a[1], a[0], b[0], b[1]))
        for v in f.verts:
            v[part] = PARTS["torso"]
        for lp in f.loops:
            col = 0 if lp.vert in (a[0], b[0]) else 1
            row = r if lp.vert in a else r + 1
            lp[uv].uv = (4 + col * ends["width"] / ends["length"], row / rows)
    return bm


def _blob(bm, centre, size, rings=4, sides=8):
    out = bmesh.ops.create_uvsphere(bm, u_segments=sides, v_segments=rings, radius=1.0, calc_uvs=True)
    layer = bm.verts.layers.int["part"]
    uv = bm.loops.layers.uv.active
    for f in {f for v in out["verts"] for f in v.link_faces}:
        for lp in f.loops:
            lp[uv].uv = (lp[uv].uv.x + 3, lp[uv].uv.y)
    for v in out["verts"]:
        v.co = centre + Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        v[layer] = PARTS["torso"]


def _strip(bm, skin, top, sign, e, rows=6):
    """One of a neckcloth's ends: a strip from top falling down the chest,
    off the skin by e["off"], to one side of the middle by spread and
    widening a little."""
    layer = bm.verts.layers.int["part"]
    grid = []
    for r in range(rows + 1):
        t = r / rows
        z = top.z - e["length"] * t
        x = sign * (e["spread"] + e["width"] * 0.5 * (0.8 + 0.4 * t))
        row = []
        for u in (-0.5, 0.5):
            px = x + u * e["width"] * (0.8 + 0.4 * t)
            loc, n, _ = skin.nearest(Vector((px, top.y + 0.05, z)))
            off = e.get("from", e["off"]) + (e["off"] - e.get("from", e["off"])) * min(1.0, r / 2)
            hit = loc + n * off
            v = bm.verts.new((px, hit.y, z))
            v[layer] = PARTS["torso"]
            row.append(v)
        grid.append(row)
    uv = bm.loops.layers.uv.active
    for r, (a, b) in enumerate(zip(grid, grid[1:])):
        f = bm.faces.new((a[0], a[1], b[1], b[0]) if sign > 0 else (a[1], a[0], b[0], b[1]))
        for lp in f.loops:
            col = 0 if lp.vert in (a[0], b[0]) else 1
            row = r if lp.vert in a else r + 1
            lp[uv].uv = (5 + sign + col * e["width"] / e["length"], row / rows)
    return grid


FAMILIES = {"shirt": shirt, "breeches": breeches, "skirt": skirt, "stockings": stockings, "shoes": shoes,
            "bodice": bodice, "cuffs": cuffs, "neckcloth": neckcloth}

# The families that shape themselves, not eased off the skin by make.
SHAPED = {"skirt", "neckcloth"}

# What a family does after it is eased off the body.
AFTER = {"shoes": _shoes_after, "cuffs": _cuffs_after}


def _section_radii(marks, z, columns):
    """The body's outline at height z as a radius at each of columns
    azimuths about its middle (0 the front, turning to the figure's left)."""
    o = marks.section.outline(z, marks.near(z))
    mid = np.array(marks.near(z))
    return mid, _radial(o, mid, columns)


def _hull_radii(marks, z, columns, mid):
    """The radius at each of columns azimuths about mid of everything the
    body's section at z holds (both thighs, below the seat)."""
    pts = [o for o in marks.section.outlines(z)]
    if not pts:
        return np.zeros(columns)
    return _radial(np.concatenate(pts), np.asarray(mid), columns)


def _radial(points, mid, columns):
    """How far points reach from mid along each of columns azimuths: the
    furthest within each azimuth's sector (not the furthest along its
    direction, which at an angle to a flat back reaches round to the
    side), the sectors none falls in filled from their neighbours."""
    if len(points) == 0:
        return np.full(columns, 0.1)
    d = points - mid
    a = np.arctan2(d[:, 0], -d[:, 1]) % (2 * np.pi)
    r = np.hypot(d[:, 0], d[:, 1])
    sector = 2 * np.pi / columns
    out = np.full(columns, np.nan)
    for c in range(columns):
        off = np.abs((a - c * sector + np.pi) % (2 * np.pi) - np.pi)
        inside = off <= sector * 0.75
        if inside.any():
            out[c] = r[inside].max()
    known = np.flatnonzero(~np.isnan(out))
    if len(known) < columns:
        idx = np.arange(columns)
        out = np.interp(idx, known, out[known], period=columns)
    # The body is its own mirror; a point on a sector's edge may fall in
    # on one side and not the other: the radii made their own mirror too.
    return (out + np.roll(out[::-1], 1)) / 2


def loft(sections, columns, flare):
    """A tube through sections, each (z, (middle, radii), drop below the
    widest), its radii flared by azimuth in proportion to the drop, with a
    UV grid, its faces facing out."""
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
            # Wound so the faces' normals point out from the body.
            f = bm.faces.new((rings[r][c], rings[r + 1][c], rings[r + 1][n], rings[r][n]))
            for loop, (u, w) in zip(f.loops, ((c, r), (c, r + 1), (c + 1, r + 1), (c + 1, r))):
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


def opening(bm, azimuth=0.0, width=0.04, start=0.0):
    """Opens a skirt down its front (or at azimuth, degrees): drops its
    faces within half the width (metres, at the skirt's top) either side,
    from a share of its length down."""
    zs = [v.co.z for v in bm.verts]
    top, hem = max(zs), min(zs)
    below = top - start * (top - hem) + 1e-6
    target = np.radians(azimuth)
    top_r = np.mean([np.hypot(v.co.x, v.co.y) for v in bm.verts if v.co.z > top - 1e-4])
    half = width / 2 / max(top_r, 1e-3)
    gone = []
    for f in bm.faces:
        c = f.calc_center_median()
        a = (np.arctan2(c.x, -c.y) - target + np.pi) % (2 * np.pi) - np.pi
        if abs(a) < half and c.z <= below:
            gone.append(f)
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def sleeves(bm, skin, ease, pairs=None):
    """Lays the sleeves (the arm's part) at their own ease, then smooths
    them a little."""
    part = bm.verts.layers.int["part"]
    arm = [v for v in bm.verts if v[part] == PARTS["arm"]]
    for _ in range(2):
        for v in arm:
            loc, n, _ = skin.nearest(v.co)
            if loc is not None:
                v.co = loc + n * ease
        if pairs is not None:
            pairs.apply(bm)
        bmesh.ops.smooth_vert(bm, verts=arm, factor=0.4, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    ease_off(bm, skin, min(ease, 0.004), pairs)


def shoulder(bm, skin, marks, spec, ease, pairs=None, arm_ease=None):
    """A set-in sleeve: within reach of each shoulder's joint, above the
    armpit, the cloth laid on the skin at the shoulder's own ease, easing
    back to the garment's (the sleeve's, on the arm) over the outer half of
    the reach, so the sleeve's cap sits on the deltoid and the top follows
    the shoulder's line."""
    reach, tight = spec["reach"], spec["ease"]
    part = bm.verts.layers.int["part"]
    for v in bm.verts:
        side = "l" if v.co.x > 0 else "r"
        j = Vector(marks.joint(f"{side}-shoulder"))
        d = (v.co - j).length
        if d >= reach or v.co.z < j.z - spec.get("below", 0.04):
            continue
        t = float(np.clip((d - reach / 2) / (reach / 2), 0, 1))
        t = t * t * (3 - 2 * t)
        far = arm_ease if arm_ease is not None and v[part] == PARTS["arm"] else ease
        loc, n, _ = skin.nearest(v.co)
        if loc is not None:
            v.co = loc + n * (tight + (far - tight) * t)
    if pairs is not None:
        pairs.apply(bm)
    # Smoothed only a little: more lifts it out of the hollows by the neck.
    bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.15, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    ease_off(bm, skin, min(tight, ease), pairs)


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


def bury_above(under, z, keep):
    """Drops the faces of under wholly above the height z (inside a hat's
    crown), but for a band keep metres wide beside what shows. Returns how
    many faces went."""
    me = under.data
    co = body.coords(under)
    shown = co[:, 2] <= z
    if shown.any() and keep > 0:
        tree = KDTree(int(shown.sum()))
        for i in np.flatnonzero(shown):
            tree.insert(co[i], int(i))
        tree.balance()
        for i in np.flatnonzero(~shown):
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
    # The scalp under the hair and the hat.
    over_head = [w.obj for w in worn if w.kind in ("hair", "hat")]
    if over_head:
        out["body under hair"] = bury(skin, over_head, 0.03, BURY["body"])
    # A headscarf under a hat: what the crown covers, above its band.
    hats = [w.obj for w in worn if w.kind == "hat"]
    if len(hats) > 1 and "band" in hats[-1]:
        out[hats[0].name] = bury_above(hats[0], hats[-1]["band"] + 0.004, BURY["garment"])
    for i, inner in enumerate(garments):
        # A cuff is turned back over the sleeve's end: what is under it
        # stays, so it rests on something.
        outer = [w for w in garments[i + 1:] if w.spec["family"] != "cuffs"]
        if outer:
            out[inner.obj.name] = bury(inner.obj, [w.obj for w in outer], COVER, BURY["garment"])
    # What burying leaves of a garment in specks, apart from it.
    for w in garments:
        out[w.obj.name + " specks"] = drop_fragments(w.obj)
    return out


def drop_fragments(obj, fewest=12):
    """Drops the islands of fewer than fewest faces, but for the largest."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, islands = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, isl = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        islands.append(isl)
    islands.sort(key=len, reverse=True)
    gone = [f for isl in islands[1:] if len(isl) < fewest for f in isl]
    if gone:
        bmesh.ops.delete(bm, geom=gone, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(obj.data)
        obj.data.update()
    bm.free()
    return len(gone)


def mirror(obj, within=0.005, greedy=False):
    """symmetrize, on a fitted mesh: within the fit's few millimetres, or
    as far as asked (a coarse collapse, greedily)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    symmetrize(bm, within, greedy)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def settle(fig, lib, poses, worn, ease, gap=0.004, rounds=8, most=0.05):
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
    # How far each vertex has gone, over every round: never more than most.
    total = {}
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
                # A skinning nearly singular would carry it far: no further
                # at rest than as posed.
                if np.linalg.norm(rest) > most:
                    rest *= most / np.linalg.norm(rest)
                if np.linalg.norm(rest) > np.linalg.norm(push.get((mesh, i), np.zeros(3))):
                    push[(mesh, i)] = rest
        fig.reset()
        if not push:
            break
        # Each move made on both sides, so the figure stays its own mirror.
        for mesh in {m for m, _ in push}:
            o = next(m for m in fig.meshes if m.name == mesh)
            pair = _mirrors(body.coords(o), 0.005)
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
                gone = total.get((mesh, j), np.zeros(3))
                after = gone + d
                if np.linalg.norm(after) > most:
                    after *= most / np.linalg.norm(after)
                    d = after - gone
                total[(mesh, j)] = after
                o.data.vertices[j].co += Vector(d)
                moved.add((mesh, j))
            o.data.update()
    return len(moved)


def symmetrize(bm, within=0.003, greedy=False):
    """Makes the cloth its own mirror: each vertex and its mirror moved to
    their mean, the middle's onto it."""
    co = np.array([tuple(v.co) for v in bm.verts])
    pair = _mirrors(co, within)
    # Only mutual pairs: two vertices on one side may both find the same
    # one on the other.
    pair = np.where(pair[pair] == np.arange(len(pair)), pair, np.arange(len(pair)))
    # Then, after a coarse collapse, those left, greedily, nearest first.
    alone_r = [i for i in range(len(co)) if greedy and pair[i] == i and co[i, 0] > 0.004]
    alone_l = [i for i in range(len(co)) if pair[i] == i and co[i, 0] < -0.004]
    if alone_r and alone_l:
        cand = sorted((float(np.linalg.norm(co[i] * np.array([-1, 1, 1]) - co[j])), i, j)
                      for i in alone_r for j in alone_l)
        used = set()
        for d, i, j in cand:
            if d > within:
                break
            if i in used or j in used:
                continue
            pair[i], pair[j] = j, i
            used.update((i, j))
    verts = list(bm.verts)
    for i, v in enumerate(verts):
        j = pair[i]
        if abs(co[i, 0]) < 1e-4 or j == i and abs(co[i, 0]) < min(within, 0.004):
            v.co.x = 0.0
        elif j != i and co[i, 0] > 0:
            m = (co[i] + co[j] * np.array([-1, 1, 1])) / 2
            v.co = Vector(m)
            verts[j].co = Vector((-m[0], m[1], m[2]))


def skirt_weights(obj, arm, marks, hips=None):
    """Weights a skirt on the skirt chains below the hips, by azimuth (the
    two nearest chains) and height (the upper bone, then the lower), and
    on the pelvis above them. With hips ({share, band}), the cloth above
    the hips at the front and sides is carried in part by the thighs' hip
    correctors (which turn half as far as the thighs), most at the hips'
    height and none by band above them: the cloth over the hip joints gives
    as a thigh turns into it, sitting or with a knee raised."""
    chains = {b.name[: -len("_01")]: b for b in arm.data.bones if b.name.startswith("skirt_") and b.name.endswith("_01")}
    hip = marks.measure()["heights"]["hip"]
    azimuth = {n: np.arctan2(b.head_local.x, -b.head_local.y) for n, b in chains.items()}
    obj.vertex_groups.clear()
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in arm.data.bones if b.name.startswith(("skirt_", "pelvis"))}

    def apart(a, b):
        return abs(((a - b + np.pi) % (2 * np.pi)) - np.pi)

    corr = {s: obj.vertex_groups.new(name="thigh_corrector_" + s) for s in ("l", "r")} if hips else {}
    for v in obj.data.vertices:
        if v.co.z >= hip:
            share = 0.0
            if hips:
                # Front and sides only: behind, the cloth hangs off the
                # seat, which the thighs turn away from.
                front = 1 - max(-np.cos(np.arctan2(v.co.x, -v.co.y)), 0.0)
                share = hips["share"] * max(0.0, 1 - (v.co.z - hip) / hips["band"]) * front
            groups["pelvis"].add([v.index], 1.0 - share, "REPLACE")
            if share > 0:
                left = float(np.clip(0.5 + v.co.x / 0.08, 0, 1))
                for s, w in (("l", left), ("r", 1 - left)):
                    if w * share > 1e-4:
                        corr[s].add([v.index], w * share, "REPLACE")
            continue
        a = np.arctan2(v.co.x, -v.co.y)
        near = sorted(azimuth, key=lambda n: apart(a, azimuth[n]))[:2]
        # Mostly the nearer chain's: two chains turned far apart (a front
        # panel over the thighs, a side spread on the seat) averaged evenly
        # would fold the cloth between them in on itself.
        d = [apart(a, azimuth[n]) ** 3 for n in near]
        share = [d[1] / (d[0] + d[1] + 1e-12), d[0] / (d[0] + d[1] + 1e-12)]
        first = arm.data.bones[near[0] + "_01"]
        lower = float(np.clip((first.head_local.z - v.co.z) / max(first.length, 1e-3) - 0.5, 0, 1))
        for n, w in zip(near, share):
            groups[n + "_01"].add([v.index], w * (1 - lower), "ADD")
            groups[n + "_02"].add([v.index], w * lower, "ADD")


def measure(marks, meshes):
    """The dressed figure's widths at the bare body's heights."""
    return marks.measure(dressed=landmarks.Section.of_many(meshes))
