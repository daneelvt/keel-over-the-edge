# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The levels a sailor is drawn at, and the body's proxy.

Close is the picker's, the portraits' and the own boat's near the camera;
deck, the own and watched boats' beyond and the near fleet's; far, the rest
of the fleet's, rigid and posed.

The close body is a proxy: the base body made coarser and saved as MPFB's
.proxy, its vertices tied to the base mesh's, so it fits every body MPFB
makes and takes the body's weights, extra bones' too, when it is fitted.
It is made once, by collapsing the base mesh's skin with the face kept
finest (a plain collapse spends its triangles on the toes and leaves the
face faceted), and kept beside the art; the build makes it again only when
what it is made from changes. Matching it to the base mesh is slow (tens of
seconds); fitting it is not.

The deck level is the close level's meshes collapsed each to its own
budget, keeping their UVs and weights, so it shares the close level's
atlas at a smaller size; the far level is the deck level posed seated (the
pose library's `far`), joined and collapsed again.
"""

import hashlib
import inspect
import json
import os
import uuid

import bmesh
import bpy
import numpy as np

import body
import mpfbx

HERE = os.path.dirname(os.path.abspath(__file__))
PROXIES = os.path.join(os.path.dirname(HERE), "proxies")

# Each proxy's triangles, and how strongly each region of the body keeps
# its own (1 keeps all, 0 none): the face most, the head and hands next,
# the feet least.
# The lips and lids are kept whole: collapsed, the lips' inner curl
# opened the mouth into a slit and the lids stood off the eyes.
PROXY = {
    "close": {"triangles": 6500, "keep": {"mouth": 1.0, "lids": 1.0, "face": 0.9, "head": 0.6, "hands": 0.45,
                                          "body": 0.25, "feet": 0.0}},
}

# How much further the far level's cloth stands off the body.
FAR_EASE = 0.01

# How strongly the deck level keeps each region of the body.
DECK_KEEP = {"mouth": 0.9, "lids": 0.9, "face": 0.7, "head": 0.45, "hands": 0.2, "body": 0.2, "feet": 0.0}

# What a proxy's fit may be off the shape it was made in, in metres: its
# file keeps four decimals.
FIT_TOLERANCE = 0.002

NAMESPACE = uuid.UUID("6b2f1f9e-3f53-4a76-9c8e-4f0e4c1d6a20")


def key(level):
    """What a proxy is made from: its settings, the code that makes it and
    MPFB."""
    h = hashlib.sha256()
    h.update(json.dumps(PROXY[level], sort_keys=True).encode())
    for f in (make_proxy, regions, decimate_to, apply):
        h.update(inspect.getsource(f).encode())
    h.update(mpfbx.version().encode())
    return h.hexdigest()[:16]


def path(level):
    return os.path.join(PROXIES, level + ".proxy")


def made_from(file):
    """The key a made file was made from, from its first lines."""
    try:
        with open(file, encoding="utf8") as f:
            for line in f:
                if line.startswith("# made from "):
                    return line.split()[-1]
    except FileNotFoundError:
        pass
    return None


def stamp(file, k):
    """Writes the key into a made file's header."""
    with open(file, encoding="utf8") as f:
        lines = f.readlines()
    lines.insert(1, f"# made from {k}\n")
    with open(file, "w", encoding="utf8") as f:
        f.writelines(lines)


def ensure_proxies():
    """Makes the proxies again if what they are made from changed."""
    made = []
    for level in PROXY:
        k = key(level)
        if made_from(path(level)) != k:
            make_proxy(level, k)
            made.append(level)
    return made


def regions(co, joint):
    """Each vertex's region of a body: mouth, lids, face, head, hands, feet
    or body, by where MPFB's joint markers are (joint(name) gives one)."""
    neck = joint("neck")[2]
    head = joint("head")
    eyes = (joint("l-eye") + joint("r-eye")) / 2
    hands = [joint("l-hand"), joint("r-hand")]
    ankle = max(joint("l-ankle")[2], joint("r-ankle")[2])
    out = np.full(len(co), "body", dtype=object)
    out[co[:, 2] < ankle + 0.03] = "feet"
    for h in hands:
        out[np.linalg.norm(co - h, axis=1) < 0.13] = "hands"
    out[co[:, 2] > neck + 0.03] = "head"
    # The face: in front of the head's joint, from the chin to the brow.
    face = (co[:, 2] > neck + 0.03) & (co[:, 1] < head[1] - 0.03) & (co[:, 2] < eyes[2] + 0.05)
    out[face] = "face"
    # The lips: on the face's front, about 6.5 cm below the eyes (MPFB's
    # mouth joint is the jaw's pivot, inside the head).
    lips_z = eyes[2] - 0.065
    middle = face & (np.abs(co[:, 0]) < 0.004) & (np.abs(co[:, 2] - lips_z) < 0.01)
    lips = np.array([0.0, co[middle, 1].min() if middle.any() else eyes[1] - 0.03, lips_z])
    out[face & (np.linalg.norm(co - lips, axis=1) < 0.024)] = "mouth"
    for side in ("l", "r"):
        out[face & (np.linalg.norm(co - joint(f"{side}-eye"), axis=1) < 0.019)] = "lids"
    return out


def make_proxy(level, k):
    spec = PROXY[level]
    print(f"build: making the {level} proxy ({spec['triangles']} triangles), once")
    body.clear_scene()
    human = mpfbx.service("HumanService")
    clothes = mpfbx.service("ClothesService")
    base = human.create_human()
    mpfbx.service("TargetService").bake_targets(base)

    # The skin alone, without MPFB's helpers.
    skin = body.in_group(base, "body")
    me = base.data.copy()
    proxy = bpy.data.objects.new(f"{level}-proxy", me)
    bpy.context.scene.collection.objects.link(proxy)
    co = body.coords(base)
    where = regions(co, lambda name: co[body.in_group(base, "joint-" + name)].mean(0))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not skin[v.index]], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    for g in list(proxy.vertex_groups):
        proxy.vertex_groups.remove(g)
    keep = proxy.vertex_groups.new(name="keep")
    kept = where[skin]
    for i, region in enumerate(kept):
        keep.add([i], spec["keep"][region], "REPLACE")

    mod = proxy.modifiers.new("decimate", "DECIMATE")
    mod.vertex_group = "keep"
    mod.invert_vertex_group = True
    mod.use_symmetry = True
    mod.symmetry_axis = "X"
    decimate_to(proxy, mod, spec["triangles"])
    apply(proxy, mod)
    bm = bmesh.new()
    bm.from_mesh(proxy.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges[:])
    bm.to_mesh(proxy.data)
    bm.free()
    # Matched against the base mesh's skin: a vertex matches only within
    # the group of its own name there.
    proxy.vertex_groups.clear()
    proxy.vertex_groups.new(name="body").add(range(len(proxy.data.vertices)), 1.0, "REPLACE")

    mhclo = clothes.create_mhclo_from_clothes_matching(base, proxy)
    mhclo.name = f"sailor-{level}"
    mhclo.uuid = str(uuid.uuid5(NAMESPACE, mhclo.name))
    mhclo.author = "Keel Over the Edge"
    mhclo.license = "LicenseRef-All-Rights-Reserved"
    mhclo.description = f"The sailors' {level} body"
    os.makedirs(PROXIES, exist_ok=True)
    mhclo.write_mhclo(path(level), reference_scale=clothes.get_reference_scale(base))
    stamp(path(level), k)

    # Fitted back to the body it was made on, it must be where it was made.
    made = body.coords(proxy)
    fitted = fit(base, level)
    err = float(np.abs(body.coords(fitted) - made).max())
    if err > FIT_TOLERANCE:
        os.remove(path(level))
        raise AssertionError(f"the {level} proxy fits {err * 1000:.1f} mm off the body it was made on")
    print(f"build: the {level} proxy: {triangles(fitted)} triangles, fitted within {err * 1000:.2f} mm")


def fit(human, level, rigged=False):
    """The proxy, fitted to the human (and weighted, when it is rigged)."""
    obj = mpfbx.service("HumanService").add_mhclo_asset(
        path(level), human, asset_type="Proxymeshes", subdiv_levels=0, material_type="NONE",
        set_up_rigging=rigged, interpolate_weights=rigged, import_subrig=False, import_weights=False)
    obj.name = obj.data.name = f"{human.name}-{level}"
    for m in list(obj.modifiers):
        if m.type == "SUBSURF":
            obj.modifiers.remove(m)
    return obj


def decimate(obj, triangles_wanted, keep=None):
    """Collapses the mesh to about triangles_wanted, symmetric about x,
    keeping its UVs and weights; keep, a weight a vertex, protects some
    more than others."""
    if triangles(obj) <= triangles_wanted:
        return
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.use_symmetry = True
    mod.symmetry_axis = "X"
    if keep is not None:
        g = obj.vertex_groups.new(name="keep")
        for i, w in enumerate(keep):
            g.add([i], float(w), "REPLACE")
        mod.vertex_group = "keep"
        mod.invert_vertex_group = True
    decimate_to(obj, mod, triangles_wanted)
    apply(obj, mod)
    if keep is not None:
        obj.vertex_groups.remove(obj.vertex_groups["keep"])
    clean(obj)


def clean(obj):
    """Drops what a collapse leaves of no area: faces, edges and vertices
    with nothing to hold."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-9], context="FACES")
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def decimate_to(obj, mod, triangles_wanted):
    """Sets a collapse's ratio to leave about triangles_wanted."""
    lo, hi = 0.01, 1.0
    for _ in range(14):
        mod.ratio = (lo + hi) / 2
        if triangles(obj, evaluated=True, only=mod) > triangles_wanted:
            hi = mod.ratio
        else:
            lo = mod.ratio
    mod.ratio = lo


def far(meshes, arm, triangles_wanted, posing, cloth=()):
    """The far level: the meshes posed seated (posing poses the skeleton:
    the pose library's far pose), each collapsed to its share of the
    budget (by its triangles), the cloth eased out a little more so the
    coarse body does not come through it, and made one rigid mesh."""
    posing()
    total = sum(triangles(o) for o in meshes)
    bm = bmesh.new()
    for o in meshes:
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        p = bpy.data.objects.new(o.name + "-posed", me)
        bpy.context.scene.collection.objects.link(p)
        p.vertex_groups.clear()
        if o.name in cloth:
            for v in me.vertices:
                v.co += v.normal * FAR_EASE
        decimate(p, max(12, int(triangles_wanted * triangles(o) / total)))
        # In the skeleton's own space, wherever the pose placed it.
        p.data.transform(arm.matrix_world.inverted() @ o.matrix_world)
        bm.from_mesh(p.data)
        bpy.data.objects.remove(p, do_unlink=True)
    figure = bpy.data.meshes.new("figure")
    bm.to_mesh(figure)
    bm.free()
    obj = bpy.data.objects.new("figure", figure)
    bpy.context.scene.collection.objects.link(obj)
    # Each collapse lands near its share, not on it; and leaves nothing
    # loose.
    decimate(obj, triangles_wanted)
    manifold(obj)
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    arm.matrix_world.identity()
    return obj


def manifold(obj):
    """Where three faces share an edge, the smallest of them goes; and what
    is left with no face."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for _ in range(4):
        over = [e for e in bm.edges if len(e.link_faces) > 2]
        if not over:
            break
        for e in over:
            if e.is_valid and len(e.link_faces) > 2:
                extra = sorted(e.link_faces, key=lambda f: f.calc_area())[:len(e.link_faces) - 2]
                bmesh.ops.delete(bm, geom=extra, context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def triangles(obj, evaluated=False, only=None):
    if evaluated:
        # Only this modifier counts: an armature's would pose the mesh.
        # (Blender hands out a new wrapper each time: compared by name.)
        hidden = [m for m in obj.modifiers if only is not None and m.name != only.name and m.show_viewport]
        for m in hidden:
            m.show_viewport = False
        dg = bpy.context.evaluated_depsgraph_get()
        e = obj.evaluated_get(dg)
        me = e.to_mesh()
        n = sum(len(p.vertices) - 2 for p in me.polygons)
        e.to_mesh_clear()
        for m in hidden:
            m.show_viewport = True
        return n
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def apply(obj, mod):
    """Applies one modifier, by the evaluated mesh with the others off: no
    operator, no context."""
    others = [m for m in obj.modifiers if m.name != mod.name and m.show_viewport]
    for m in others:
        m.show_viewport = False
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    for m in others:
        m.show_viewport = True
    obj.modifiers.remove(mod)
    old = obj.data
    name = old.name
    obj.data = me
    bpy.data.meshes.remove(old)
    me.name = name
