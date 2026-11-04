# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The atlas: one texture a sailor, and its mask.

Every mesh of a sailor shares one UV map, "atlas", packed into one square:
the body keeps MPFB's UVs, the rest their own, the islands made one
texel density and then the head's grown until the face and head take
their share. Each material slot names its part's colour, its region and
whether it is metal (part()); the bake writes, through the atlas map:

- the base colour: the fixed parts in their colours, the option regions
  (main colour, skin, hair) as neutral grey, 0.5, which the game's shader
  multiplies by twice the colour chosen, so shading and painted variation
  survive any colour; times the ambient occlusion, as base × (0.55 +
  0.45 × occlusion);
- the mask: red the main colour's region, green the skin's, blue the
  hair's, alpha the metal.

Both are written as PNG, the base colour in sRGB, the mask as data.
"""

import os

import bmesh
import bpy
import numpy as np

ATLAS = "atlas"
REGIONS = ("main", "skin", "hair", "fixed")
NEUTRAL = 0.5


def part(material, colour=None, region="fixed", metal=False):
    """Marks a material slot as a part of the atlas: its colour (linear
    RGB, for a fixed part), its region, and whether it is metal."""
    if region not in REGIONS:
        raise ValueError(f"no region {region!r}")
    if region == "fixed" and colour is None:
        raise ValueError(f"{material.name}: a fixed part has its own colour")
    material["part_colour"] = list(colour) if colour is not None else [NEUTRAL] * 3
    material["part_region"] = region
    material["part_metal"] = bool(metal)
    return material


def linear(hex_colour):
    """#RRGGBB as linear RGB."""
    c = np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0
    return tuple(float(x) for x in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))


def prepare(obj):
    """Gives the mesh the atlas map, from its own first map or, without
    one, a projection, and makes it the only map."""
    me = obj.data
    if ATLAS not in me.uv_layers:
        if len(me.uv_layers) == 0:
            me.uv_layers.new(name=ATLAS)
            _project(obj)
        else:
            src = me.uv_layers[0]
            uv = np.empty(len(me.loops) * 2)
            src.data.foreach_get("uv", uv)
            dst = me.uv_layers.new(name=ATLAS)
            dst.data.foreach_set("uv", uv)
    for layer in list(me.uv_layers):
        if layer.name != ATLAS:
            me.uv_layers.remove(layer)
    me.uv_layers[ATLAS].active = True
    me.uv_layers[ATLAS].active_render = True


def _project(obj):
    _edit([obj])
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def islands(obj):
    """The mesh's islands in the atlas map: lists of face indices joined by
    edges whose two sides share their UVs."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv[ATLAS]
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            island.append(g.index)
            for loop in g.loops:
                for other in loop.edge.link_loops:
                    h = other.face
                    if h.index in seen:
                        continue
                    # The edge's ends in both faces' UVs.
                    a0, a1 = loop[uv].uv, loop.link_loop_next[uv].uv
                    b0, b1 = other.link_loop_next[uv].uv, other[uv].uv
                    if (a0 - b0).length < 1e-6 and (a1 - b1).length < 1e-6:
                        seen.add(h.index)
                        stack.append(h)
        out.append(island)
    bm.free()
    return out


def _uvs(obj):
    me = obj.data
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[ATLAS].data.foreach_get("uv", uv)
    return uv.reshape(-1, 2)


def _set_uvs(obj, uv):
    obj.data.uv_layers[ATLAS].data.foreach_set("uv", uv.ravel())


def _face_loops(obj):
    me = obj.data
    start = np.empty(len(me.polygons), np.int32)
    total = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_start", start)
    me.polygons.foreach_get("loop_total", total)
    return start, total


def grow(obj, faces_grown, factor):
    """Scales the islands most of whose faces are in faces_grown by factor
    about their own middles."""
    uv = _uvs(obj)
    start, total = _face_loops(obj)
    for island in islands(obj):
        if np.mean([faces_grown[f] for f in island]) < 0.5:
            continue
        loops = np.concatenate([np.arange(start[f], start[f] + total[f]) for f in island])
        mid = uv[loops].mean(0)
        uv[loops] = mid + (uv[loops] - mid) * factor
    _set_uvs(obj, uv)


def area(obj, faces=None):
    """The UV area of faces (all, by default), as a share of the square."""
    uv = _uvs(obj)
    start, total = _face_loops(obj)
    out = 0.0
    for f in range(len(start)) if faces is None else np.flatnonzero(faces):
        p = uv[start[f]:start[f] + total[f]]
        x, y = p[:, 0], p[:, 1]
        out += 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    return out


def layout(objs, head_faces, share, margin):
    """Packs every mesh's islands into the square, the head's grown until
    they take share of what the islands cover. head_faces maps an object
    to a mask of its faces in the head. Returns the share reached."""
    _edit(objs)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    factor = 1.0
    reached = 0.0
    for _ in range(4):
        head = sum(area(o, head_faces[o]) for o in objs if o in head_faces)
        whole = sum(area(o) for o in objs)
        reached = head / whole
        if abs(reached - share) < 0.02:
            break
        # The islands' areas grow as the square of the factor.
        step = np.sqrt(share * (whole - head) / (head * (1 - share)))
        factor *= step
        for o in objs:
            if o in head_faces:
                grow(o, head_faces[o], step)
    _edit(objs)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="ANY", scale=True,
                            merge_overlap=False, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in objs:
        uv = _uvs(o)
        if uv.min() < -1e-4 or uv.max() > 1 + 1e-4:
            raise AssertionError(f"{o.name}: UVs outside the atlas after packing")
    return reached


def _edit(objs):
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode="EDIT")


def bake(objs, size, margin_px, samples=32):
    """The atlas's base colour (sRGB, 0–1) and mask (data, RGBA), as arrays
    of size × size × 4, baked through each mesh's parts."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.seed = 0
    scene.cycles.samples = samples
    scene.render.bake.margin = margin_px
    scene.render.bake.margin_type = "EXTEND"
    world = scene.world or bpy.data.worlds.new("bake")
    scene.world = world

    out = {}
    for what in ("colour", "occlusion", "mask", "metal"):
        img = bpy.data.images.new(f"bake-{what}", size, size, alpha=False, float_buffer=True)
        img.colorspace_settings.name = "Non-Color"
        saved = [(o, list(o.data.materials)) for o in objs]
        for o in objs:
            for i, m in enumerate(o.data.materials):
                o.data.materials[i] = _bake_material(m, what, img)
        _select(objs)
        bpy.ops.object.bake(type="AO" if what == "occlusion" else "EMIT", margin=margin_px,
                            use_clear=True, target="IMAGE_TEXTURES")
        px = np.empty(size * size * 4, np.float32)
        img.pixels.foreach_get(px)
        out[what] = px.reshape(size, size, 4)
        for o, mats in saved:
            for i, m in enumerate(mats):
                o.data.materials[i] = m
        bpy.data.images.remove(img)
    for m in list(bpy.data.materials):
        if m.name.startswith("bake-") and m.users == 0:
            bpy.data.materials.remove(m)

    colour = out["colour"][..., :3] * (0.55 + 0.45 * out["occlusion"][..., :1])
    base = np.ones((size, size, 4), np.float32)
    base[..., :3] = _srgb(np.clip(colour, 0, 1))
    mask = np.ones((size, size, 4), np.float32)
    mask[..., :3] = np.clip(out["mask"][..., :3], 0, 1)
    mask[..., 3] = np.clip(out["metal"][..., 0], 0, 1)
    return base, mask


def _bake_material(m, what, img):
    """A material that emits what is to be baked of the part m."""
    bm = bpy.data.materials.new(f"bake-{what}-{m.name}")
    nt = bm.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    if what == "occlusion":
        shader = nt.nodes.new("ShaderNodeBsdfDiffuse")
        shader.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1)
        nt.links.new(shader.outputs[0], out.inputs["Surface"])
    else:
        emit = nt.nodes.new("ShaderNodeEmission")
        region = m["part_region"]
        if what == "colour":
            c = m["part_colour"]
        elif what == "mask":
            c = [float(region == r) for r in ("main", "skin", "hair")]
        else:
            c = [float(m["part_metal"])] * 3
        emit.inputs["Color"].default_value = (*c, 1)
        nt.links.new(emit.outputs[0], out.inputs["Surface"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = ATLAS
    nt.links.new(uv.outputs[0], tex.inputs["Vector"])
    nt.nodes.active = tex
    return bm


def _select(objs):
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def _srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def save(pixels, path):
    """Writes an array of RGBA in 0–1 as an 8-bit PNG, as it is (no colour
    conversion: the base colour is already sRGB)."""
    h, w, _ = pixels.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(pixels, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def scaled(pixels, size):
    """The atlas at a smaller size, by averaging: for the deck and far
    levels, whose meshes keep the close level's UVs."""
    n = pixels.shape[0] // size
    return pixels.reshape(size, n, size, n, 4).mean(axis=(1, 3))


def untangle(obj, passes=40):
    """Unfolds UV triangles folded over their neighbours, which a collapse
    leaves at small sharp parts (fingertips, toes, the nose): a face whose
    UVs wind the other way from most of its island's has each of its UV
    corners moved to the middle of the corners round it, pass after pass,
    until none is folded. Returns how many faces were folded, and how many
    are still."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uvl = bm.loops.layers.uv.active
    ids = {}
    corners = []  # per face, its corners' UV vertex ids
    for f in bm.faces:
        c = []
        for lp in f.loops:
            u = lp[uvl].uv
            c.append(ids.setdefault((lp.vert.index, round(u.x, 6), round(u.y, 6)), len(ids)))
        corners.append(c)
    uv = np.zeros((len(ids), 2))
    for f, c in zip(bm.faces, corners):
        for lp, i in zip(f.loops, c):
            uv[i] = tuple(lp[uvl].uv)
    # Islands: UV vertices joined by the faces they share.
    parent = list(range(len(ids)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for c in corners:
        for i in c[1:]:
            a, b = find(c[0]), find(i)
            if a != b:
                parent[a] = b
    island = np.array([find(c[0]) for c in corners])
    near = [set() for _ in ids]
    for c in corners:
        for i in c:
            near[i].update(j for j in c if j != i)

    def areas():
        a = np.zeros(len(corners))
        for k, c in enumerate(corners):
            p = uv[c]
            a[k] = sum(p[i, 0] * p[(i + 1) % len(c), 1] - p[(i + 1) % len(c), 0] * p[i, 1] for i in range(len(c))) / 2
        return a

    def folded():
        a = areas()
        sign = {}
        for k, isl in enumerate(island):
            sign[isl] = sign.get(isl, 0.0) + a[k]
        return [k for k in range(len(corners)) if a[k] * sign[island[k]] < 0]

    first = bad = folded()
    for _ in range(passes):
        if not bad:
            break
        move = {i for k in bad for i in corners[k]}
        new = {i: uv[list(near[i])].mean(0) for i in move if near[i]}
        for i, p in new.items():
            uv[i] = p
        bad = folded()
    for f, c in zip(bm.faces, corners):
        for lp, i in zip(f.loops, c):
            lp[uvl].uv = uv[i]
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(first), len(bad)
