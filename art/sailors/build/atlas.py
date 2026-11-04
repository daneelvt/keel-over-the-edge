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
  hair's, alpha the metal. A machine has no hair: its blue is where its
  lamps glow, their glass kept in its own colour.

Both are written as PNG, the base colour in sRGB, the mask as data.

A part may be a swatch (part(swatch=True)): a colour with no texture of
its own, every face of it on one small patch of the atlas painted in its
colour. A machine's frame, glass and small fittings are: given islands of
their own, its hundreds of small parts would not pack. A swatch's faces
are each smaller than a texel and cover no texel's middle, so they share
the patch without lying on one another's texels; the packed islands leave
a strip at the atlas's right for the patches.
"""

import os

import bmesh
import bpy
import numpy as np

ATLAS = "atlas"
REGIONS = ("main", "skin", "hair", "fixed", "glow")
# The regions that keep their own colour in the atlas.
OWN_COLOUR = ("fixed", "glow")
NEUTRAL = 0.5
# A second map a painter reads (face.PAINT), kept until the bake.
PAINT = "paint"
# The strip the swatches' patches take at the atlas's right, a share of
# its width; and each patch's radius, a share of it.
SWATCH_STRIP = 0.07
SWATCH_RADIUS = 0.022
# Where each swatch's patch is, by its material's name (layout sets it for
# the bake).
_swatches = {}

# The painters of parts painted by shader rather than in one colour, by
# the name a material gives in "part_painter": each takes the bake
# material's node tree, the part's material and what is baked ("colour"
# or "mask") and returns a colour (a face.Col) to emit.
PAINTERS = {}


def part(material, colour=None, region="fixed", metal=False, swatch=False):
    """Marks a material slot as a part of the atlas: its colour (linear
    RGB, for a fixed part), its region, whether it is metal, and whether
    it is a swatch."""
    if region not in REGIONS:
        raise ValueError(f"no region {region!r}")
    if region in OWN_COLOUR and colour is None:
        raise ValueError(f"{material.name}: a fixed or glowing part has its own colour")
    material["part_colour"] = list(colour) if region in OWN_COLOUR else [NEUTRAL] * 3
    material["part_region"] = region
    material["part_metal"] = bool(metal)
    material["part_swatch"] = bool(swatch)
    return material


def _swatch_faces(obj):
    """A mask of the mesh's faces in swatch parts."""
    sw = [bool(m.get("part_swatch")) if m else False for m in obj.data.materials]
    idx = np.empty(len(obj.data.polygons), np.int32)
    obj.data.polygons.foreach_get("material_index", idx)
    return np.array(sw + [False])[np.minimum(idx, len(sw))] if sw else np.zeros(len(idx), bool)


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
        if layer.name not in (ATLAS, PAINT):
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
    they take share of what the islands cover; and the swatches' faces
    onto their patches. head_faces maps an object to a mask of its faces
    in the head. Returns the share reached."""
    swatched = {o: _swatch_faces(o) for o in objs}
    any_swatch = any(m.any() for m in swatched.values())
    _edit(objs)
    _select_faces(objs, swatched)
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
    # Islands grown past the square would be packed into tiles of their
    # own: all brought into it first, their sizes kept.
    uvs = [_uvs(o) for o in objs]
    lo = min(u.min() for u in uvs)
    hi = max(u.max() for u in uvs)
    if lo < 0 or hi > 1:
        for o, u in zip(objs, uvs):
            _set_uvs(o, (u - lo) / (hi - lo))
    _edit(objs)
    _select_faces(objs, swatched)
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="ANY", scale=True,
                            merge_overlap=False, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    if any_swatch:
        # A face whose UVs lie on another's (a fold the unrolling made) is
        # given to its swatch, where a mesh has one of its kind.
        for o in objs:
            swatched[o] |= _to_swatch(o, _overlapping(o, objs, swatched))
        _place_swatches(objs, swatched, margin)
    for o in objs:
        uv = _uvs(o)
        if uv.min() < -1e-4 or uv.max() > 1 + 1e-4:
            raise AssertionError(f"{o.name}: UVs outside the atlas after packing")
    return reached


def _overlapping(obj, objs, swatched, size=1024):
    """Faces of obj on a texel another face (of any mesh) covers too."""
    count = np.zeros((size, size), np.int32)
    tris = []
    for o in objs:
        uv = _uvs(o)
        start, total = _face_loops(o)
        for f in np.flatnonzero(~swatched[o]):
            for k in range(1, total[f] - 1):
                t = uv[[start[f], start[f] + k, start[f] + k + 1]] * size
                cells = _texels(t, size)
                if cells is not None:
                    count[cells] += 1
                    if o is obj:
                        tris.append((f, cells))
    return {f for f, cells in tris if (count[cells] > 1).any()}


def _to_swatch(obj, faces):
    """Moves the faces to the swatch of their region and metal, where the
    mesh has one. Returns the mesh's mask of faces now swatches."""
    out = np.zeros(len(obj.data.polygons), bool)
    mats = obj.data.materials
    for f in faces:
        p = obj.data.polygons[f]
        m = mats[p.material_index]
        for i, s in enumerate(mats):
            if s.get("part_swatch") and s["part_region"] == m["part_region"] and s["part_metal"] == m["part_metal"]:
                p.material_index = i
                out[f] = True
                break
    return out


def _select_faces(objs, swatched):
    """In edit mode: every face selected but the swatches'."""
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in objs:
        sel = ~swatched[o]
        o.data.polygons.foreach_set("select", sel)
    bpy.ops.object.mode_set(mode="EDIT")


def _place_swatches(objs, swatched, margin):
    """The packed islands drawn left into the square less the strip; each
    swatch's faces made tiny on its patch in the strip."""
    _swatches.clear()
    names = []
    for o in objs:
        for m in o.data.materials:
            if m and m.get("part_swatch") and m.name not in names:
                names.append(m.name)
    step = 1.0 / (len(names) + 1)
    for k, n in enumerate(names):
        _swatches[n] = (1.0 - SWATCH_STRIP / 2, step * (k + 1))
    texel = 1.0 / 1024
    for o in objs:
        uv = _uvs(o)
        start, total = _face_loops(o)
        sw = swatched[o]
        kept = np.ones(len(uv), bool)
        for f in np.flatnonzero(sw):
            kept[start[f]:start[f] + total[f]] = False
        uv[kept] *= (1.0 - SWATCH_STRIP - margin)
        for f in np.flatnonzero(sw):
            c = np.array(_swatches[o.data.materials[o.data.polygons[f].material_index].name])
            # A corner of the texel at the patch's middle: the face covers
            # no texel's middle, and is under a texel in area.
            corner = (np.floor(c / texel) + 0.1) * texel
            n = total[f]
            for i in range(n):
                a = 2 * np.pi * i / n
                uv[start[f] + i] = corner + texel * (0.2 + 0.15 * np.array([np.cos(a), np.sin(a)]))
        _set_uvs(o, uv)


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

    # The painters' maps have done their work.
    for o in objs:
        if PAINT in o.data.uv_layers:
            o.data.uv_layers.remove(o.data.uv_layers[PAINT])
        o.data.uv_layers[ATLAS].active = True
    colour = out["colour"][..., :3] * (0.55 + 0.45 * out["occlusion"][..., :1])
    base = np.ones((size, size, 4), np.float32)
    base[..., :3] = _srgb(np.clip(colour, 0, 1))
    mask = np.ones((size, size, 4), np.float32)
    mask[..., :3] = np.clip(out["mask"][..., :3], 0, 1)
    mask[..., 3] = np.clip(out["metal"][..., 0], 0, 1)
    # Each swatch's patch, painted in its colour (the image's rows run
    # from the bottom, as v does).
    ys, xs = np.mgrid[0:size, 0:size]
    for name, (u, v) in _swatches.items():
        m = bpy.data.materials.get(name)
        if m is None:
            continue
        inside = (xs + 0.5 - u * size) ** 2 + (ys + 0.5 - v * size) ** 2 <= (SWATCH_RADIUS * size) ** 2
        region = m["part_region"]
        base[inside, :3] = _srgb(np.clip(np.array(m["part_colour"]), 0, 1))
        mask[inside, :3] = [float(region == "main"), float(region == "skin"), float(region in ("hair", "glow"))]
        mask[inside, 3] = float(m["part_metal"])
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
    elif what in ("colour", "mask") and m.get("part_painter") in PAINTERS:
        emit = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(PAINTERS[m["part_painter"]](nt, m, what).socket(), emit.inputs["Color"])
        nt.links.new(emit.outputs[0], out.inputs["Surface"])
    else:
        emit = nt.nodes.new("ShaderNodeEmission")
        region = m["part_region"]
        if what == "colour":
            c = m["part_colour"]
        elif what == "mask":
            c = [float(region == r) for r in ("main", "skin")] + [float(region in ("hair", "glow"))]
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


def drop_overlaps(obj, size):
    """Drops the faces whose UVs share a texel (at size) with a face kept
    before them, the smallest first. Returns how many went."""
    me = obj.data
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[ATLAS].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2) * size
    order = sorted(me.polygons, key=lambda p: -p.area)
    taken = np.zeros((size, size), bool)
    gone = []
    for p in order:
        pts = uv[list(p.loop_indices)]
        cells = _texels(pts, size)
        if cells is None:
            continue
        if taken[cells].any():
            gone.append(p.index)
        else:
            taken[cells] = True
    if gone:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in gone], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(me)
        bm.free()
        me.update()
    return len(gone)


def _texels(pts, size):
    """The texels whose middles a polygon of UV points (in texels) covers,
    as an index into a size × size grid; None if none."""
    lo = np.clip(np.floor(pts.min(0)).astype(int), 0, size - 1)
    hi = np.clip(np.ceil(pts.max(0)).astype(int), 0, size)
    if (hi <= lo).any():
        return None
    xs, ys = np.meshgrid(np.arange(lo[0], hi[0]) + 0.5, np.arange(lo[1], hi[1]) + 0.5)
    inside = np.zeros(xs.shape, bool)
    for k in range(1, len(pts) - 1):
        a, b, c = pts[0], pts[k], pts[k + 1]

        def side(p, q):
            return (q[0] - p[0]) * (ys - p[1]) - (q[1] - p[1]) * (xs - p[0])

        s1, s2, s3 = side(a, b), side(b, c), side(c, a)
        inside |= ((s1 >= 0) & (s2 >= 0) & (s3 >= 0)) | ((s1 <= 0) & (s2 <= 0) & (s3 <= 0))
    if not inside.any():
        return None
    return (ys[inside].astype(int), xs[inside].astype(int))
