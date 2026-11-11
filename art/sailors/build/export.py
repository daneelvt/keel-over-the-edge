# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The export: an explicit selection to glTF, read back and checked.

A sailor's level is one glTF binary: its meshes, named; one material,
"sailor", whose base colour is the atlas and whose occlusion texture holds
the mask (red the main colour's region, green the skin's, blue the hair's,
alpha the metal: the game's sailor material reads it as the mask, never as
occlusion, and gltfpack keeps only the textures a material uses); and, but
for the far level, the skeleton and the skin. Nothing else: no morph
targets, no animation, no stray object the exporter picked up (a rig's
helper icosphere once was). Blender writes it, this module adds the mask,
gltfpack compresses it (the geometry by meshopt, its normals, UVs and
weights quantized but its positions kept as floats, so no node takes a
transform to undo them; the colour by ETC1S, the mask by UASTC), and both files are read back and checked. In the file the
figure faces +z with y up, its origin on the ground between its feet.

Where a pose seats the figure in the game's dinghy goes in the file as an
empty named node (add_places): its transform takes the figure's own space
to the boat model's, as build/motion.py placed it, so the game seats it
where it was judged. The far level has one, `place`, for the pose it is
made in; the clips file one a clip, `place-<clip>`, the identity for a
clip not placed in the boat.
"""

import json
import os
import struct
import subprocess

import bpy

MATERIAL = "sailor"


def material(base_png):
    """The one material every mesh of a level shares, its base colour the
    atlas through the atlas map."""
    old = bpy.data.materials.get(MATERIAL)
    if old is not None:
        # The last level's: the name is this one's.
        old.name = MATERIAL + "-done"
    m = bpy.data.materials.new(MATERIAL)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.8
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(base_png)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return m


def write(path, meshes, arm, mat, mask_png, gltfpack, work, places=None):
    """Writes a level: meshes (and the skeleton arm, when not None), and
    the places by name (add_places)."""
    for o in meshes:
        o.data.materials.clear()
        o.data.materials.append(mat)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in meshes + ([arm] if arm else []):
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    raw = os.path.join(work, os.path.basename(path).replace(".glb", ".raw.glb"))
    bpy.ops.export_scene.gltf(
        filepath=raw, export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_vertex_color="NONE", export_extras=False,
        export_skins=arm is not None, export_def_bones=False, export_influence_nb=4, export_all_influences=False,
        export_leaf_bone=False, export_rest_position_armature=True, export_morph=False, export_animations=False,
        export_image_format="AUTO", export_unused_images=False, export_unused_textures=False)
    names = sorted(o.name for o in meshes)
    bones = [b.name for b in arm.data.bones] if arm else None
    gltf, binary = read(raw)
    check(raw, gltf, names, bones, textures=1)
    binary = add_mask(gltf, binary, mask_png)
    add_places(gltf, places or {})
    with_mask = raw.replace(".raw.glb", ".mask.glb")
    write_glb(with_mask, gltf, binary)
    subprocess.run([gltfpack, "-i", with_mask, "-o", path, "-c", "-kn", "-km", "-vpf", "-tc", "-tu", "A"],
                   check=True, capture_output=True)
    gltf, _ = read(path)
    check(path, gltf, names, bones, textures=2)
    return triangles(gltf)


def write_plain(path, meshes, arm, gltfpack, work, places=None):
    materials = [m.name for o in meshes for m in o.data.materials]
    """Writes meshes in their own materials, colours with no texture
    (gear outside the atlas: the trapeze's harness), skinned to the
    skeleton arm, and the places by name (add_places)."""
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in meshes + [arm]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    raw = os.path.join(work, os.path.basename(path).replace(".glb", ".raw.glb"))
    bpy.ops.export_scene.gltf(
        filepath=raw, export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
        export_texcoords=False, export_normals=True, export_vertex_color="NONE", export_extras=False,
        export_skins=True, export_def_bones=False, export_influence_nb=4, export_all_influences=False,
        export_leaf_bone=False, export_rest_position_armature=True, export_morph=False, export_animations=False)
    names = sorted(o.name for o in meshes)
    bones = [b.name for b in arm.data.bones]
    gltf, binary = read(raw)
    check(raw, gltf, names, bones, textures=0, materials=materials)
    add_places(gltf, places or {})
    placed = raw.replace(".raw.glb", ".placed.glb")
    write_glb(placed, gltf, binary)
    subprocess.run([gltfpack, "-i", placed, "-o", path, "-c", "-kn", "-km", "-vpf"], check=True, capture_output=True)
    gltf, _ = read(path)
    check(path, gltf, names, bones, textures=0, materials=materials)
    return triangles(gltf)


def read(path):
    """A glTF binary's JSON and binary chunk."""
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise AssertionError(f"{path} is not a glTF 2 binary")
    off, gltf, binary = 12, None, b""
    while off < length:
        size, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8:off + 8 + size]
        if kind == 0x4E4F534A:
            gltf = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = chunk
        off += 8 + size
    return gltf, binary


def write_glb(path, gltf, binary):
    binary += b"\0" * (-len(binary) % 4)
    gltf["buffers"][0]["byteLength"] = len(binary)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


def add_mask(gltf, binary, mask_png):
    """Adds the mask as the material's occlusion texture; returns the
    binary chunk with the image in it."""
    with open(mask_png, "rb") as f:
        png = f.read()
    binary += b"\0" * (-len(binary) % 4)
    offset = len(binary)
    gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": offset, "byteLength": len(png)})
    gltf.setdefault("images", []).append({"name": "mask", "mimeType": "image/png", "bufferView": len(gltf["bufferViews"]) - 1})
    sampler = gltf["textures"][0].get("sampler")
    tex = {"source": len(gltf["images"]) - 1}
    if sampler is not None:
        tex["sampler"] = sampler
    gltf["textures"].append(tex)
    (mat,) = gltf["materials"]
    mat["occlusionTexture"] = {"index": len(gltf["textures"]) - 1}
    return binary + png


def add_places(gltf, places):
    """Adds each place, a matrix in Blender's boat space (z up), as an
    empty node of its name in the scene, in glTF's axes (y up): gltfpack
    keeps a named node (-kn)."""
    for name, m in sorted(places.items()):
        # Blender's (x, y, z) is glTF's (x, z, -y): the same turn on both
        # sides of the matrix.
        c = ((1, 0, 0), (0, 0, 1), (0, -1, 0))
        r = [[sum(c[i][k] * m[k][l] * c[j][l] for k in range(3) for l in range(3)) for j in range(3)]
             for i in range(3)]
        t = [sum(c[i][k] * m[k][3] for k in range(3)) for i in range(3)]
        # Column-major, as glTF has it.
        matrix = [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0,
                  r[0][2], r[1][2], r[2][2], 0, t[0], t[1], t[2], 1]
        gltf["nodes"].append({"name": name, "matrix": [round(float(x), 6) + 0.0 for x in matrix]})
        gltf["scenes"][gltf.get("scene", 0)]["nodes"].append(len(gltf["nodes"]) - 1)


def place_names(gltf):
    """The places a file holds, by name: each node's local matrix, column-major."""
    return {n["name"]: n.get("matrix") for n in gltf.get("nodes", []) if n.get("name", "").startswith("place")}


def check(path, gltf, meshes, bones, textures, materials=(MATERIAL,)):
    """Fails unless the file holds exactly what the level should (in the
    one material, or those named)."""
    problems = []
    named = mesh_names(gltf)
    got = sorted(named.values())
    if got != meshes:
        problems.append(f"meshes {got}, not {meshes}")
    for i, m in enumerate(gltf.get("meshes", [])):
        for p in m["primitives"]:
            if "targets" in p:
                problems.append(f"{named.get(i)} has morph targets")
            if p.get("mode", 4) != 4:
                problems.append(f"{named.get(i)} is not triangles")
    if gltf.get("animations"):
        problems.append("it has animations")
    if [mt.get("name") for mt in gltf.get("materials", [])] != list(materials):
        problems.append(f"materials {[mt.get('name') for mt in gltf.get('materials', [])]}, not {list(materials)}")
    if len(gltf.get("textures", [])) != textures:
        problems.append(f"{len(gltf.get('textures', []))} textures, not {textures}")
    skins = gltf.get("skins", [])
    if bones is None:
        if skins:
            problems.append("a skin on a rigid level")
    else:
        if len(skins) != 1:
            problems.append(f"{len(skins)} skins, not 1")
        else:
            names = [gltf["nodes"][j]["name"] for j in skins[0]["joints"]]
            if sorted(names) != sorted(bones):
                missing = sorted(set(bones) - set(names))
                extra = sorted(set(names) - set(bones))
                problems.append(f"the skin's joints differ from the skeleton's: missing {missing}, extra {extra}")
        for i, m in enumerate(gltf.get("meshes", [])):
            for p in m["primitives"]:
                if "JOINTS_0" not in p["attributes"] or "JOINTS_1" in p["attributes"]:
                    problems.append(f"{named.get(i)} is not skinned by four joints a vertex")
    if problems:
        raise AssertionError(f"{os.path.basename(path)}: " + "; ".join(problems))


def mesh_names(gltf):
    """Each mesh's name, by the node that draws it (gltfpack keeps nodes'
    names, not meshes')."""
    return {n["mesh"]: n.get("name", "") for n in gltf.get("nodes", []) if "mesh" in n}


def triangles(gltf):
    """Each mesh's triangles, by its node's name."""
    named = mesh_names(gltf)
    out = {}
    for i, m in enumerate(gltf["meshes"]):
        n = 0
        for p in m["primitives"]:
            acc = gltf["accessors"][p["indices"]] if "indices" in p else gltf["accessors"][p["attributes"]["POSITION"]]
            n += acc["count"] // 3
        out[named[i]] = n
    return out


def merge_clips(path, added_path):
    """Adds the clips of one packed clips' file (added_path) to another's
    (path), in place: each clip of the first replaces the second's of its
    name, and the second's other clips are kept as they are, their data
    the same bytes at the same places. Both are gltfpack's, compressed
    (EXT_meshopt_compression): the added clips' compressed data goes after
    the other's, each view as it was. Returns how far the two files'
    skeletons are apart at rest: the most a joint's place differs (m), and
    its turn (the quaternions' largest component's difference)."""
    apart, turned = skeletons_apart(path, added_path)
    gltf, binary = read(path)
    new, new_binary = read(added_path)
    names = {a["name"] for a in new.get("animations", [])}
    _drop_clips(gltf, names)
    binary = binary[:gltf["buffers"][0]["byteLength"]]
    by_name = {n.get("name"): i for i, n in enumerate(gltf["nodes"])}
    data = next(i for i, b in enumerate(gltf["buffers"]) if not b.get("extensions"))
    fallback = next(i for i, b in enumerate(gltf["buffers"]) if b.get("extensions"))
    views, accessors = {}, {}
    for a in new["animations"]:
        samplers = []
        for s in a["samplers"]:
            samplers.append(dict(s, input=_take(new, new_binary, gltf, s["input"], views, accessors, data, fallback),
                                 output=_take(new, new_binary, gltf, s["output"], views, accessors, data, fallback)))
        channels = []
        for c in a["channels"]:
            target = dict(c["target"], node=by_name[new["nodes"][c["target"]["node"]]["name"]])
            channels.append(dict(c, target=target))
        gltf["animations"].append(dict(a, samplers=samplers, channels=channels))
    # The added data, at the end of the data buffer: each view's compressed
    # bytes, aligned as gltfpack aligns them.
    out = bytearray(binary)
    for old, (index, start) in sorted(views.items(), key=lambda kv: kv[1][0]):
        ext = new["bufferViews"][old]["extensions"]["EXT_meshopt_compression"]
        out += b"\0" * (start - len(out))
        out += new_binary[ext["byteOffset"]:ext["byteOffset"] + ext["byteLength"]]
    scene = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    for n in new["nodes"]:
        if n.get("name", "").startswith("place-") and n["name"][len("place-"):] in names:
            gltf["nodes"].append(dict(n))
            scene.append(len(gltf["nodes"]) - 1)
    gltf["buffers"][data]["byteLength"] = len(out)
    write_glb(path, gltf, bytes(out))
    return apart, turned


def skeletons_apart(path, other):
    """How far two packed files' skeletons are apart at rest, joint by
    joint by name: the most a joint's place differs (m), and its turn (the
    quaternions' largest component's difference)."""
    a, _ = read(path)
    b, _ = read(other)
    by_name = {n.get("name"): n for n in a["nodes"]}
    apart, turned = 0.0, 0.0
    for n in b["nodes"]:
        o = by_name.get(n.get("name"))
        if o is None or n.get("name", "").startswith("place"):
            continue
        for key in ("translation", "rotation"):
            x, y = o.get(key), n.get(key)
            if x is None and y is None:
                continue
            x = x or ([0, 0, 0] if key == "translation" else [0, 0, 0, 1])
            y = y or ([0, 0, 0] if key == "translation" else [0, 0, 0, 1])
            d = max(abs(p - q) for p, q in zip(x, y))
            if key == "rotation":
                turned = max(turned, min(d, max(abs(p + q) for p, q in zip(x, y))))
            else:
                apart = max(apart, d)
    return apart, turned


def _take(src, src_binary, dst, accessor, views, accessors, data, fallback):
    """An accessor of src copied into dst with its view (once each),
    returning its index there. A copied view's compressed bytes are placed
    after dst's (views: by src's view, its index in dst and where its bytes
    go)."""
    if accessor in accessors:
        return accessors[accessor]
    acc = dict(src["accessors"][accessor])
    v = acc["bufferView"]
    if v not in views:
        view = src["bufferViews"][v]
        ext = dict(view["extensions"]["EXT_meshopt_compression"])
        end = max([dst["buffers"][data]["byteLength"]] + [s + src["bufferViews"][o]["extensions"]
                   ["EXT_meshopt_compression"]["byteLength"] for o, (_, s) in views.items()])
        start = end + (-end % 4)
        fb = dst["buffers"][fallback]["byteLength"]
        fb += -fb % 16
        ext.update(buffer=data, byteOffset=start)
        dst["bufferViews"].append(dict(view, buffer=fallback, byteOffset=fb,
                                       extensions={"EXT_meshopt_compression": ext}))
        dst["buffers"][fallback]["byteLength"] = fb + view["byteLength"]
        views[v] = (len(dst["bufferViews"]) - 1, start)
    acc["bufferView"] = views[v][0]
    dst["accessors"].append(acc)
    accessors[accessor] = len(dst["accessors"]) - 1
    return accessors[accessor]


def _drop_clips(gltf, names):
    """Drops the clips of these names and their places from a packed
    clips' file, and what only they used: their accessors, and their
    views, which must come after every view kept (as merge_clips adds
    them), so the data kept is the same bytes at the same places."""
    if not any(a["name"] in names for a in gltf.get("animations", [])):
        return
    gltf["animations"] = [a for a in gltf["animations"] if a["name"] not in names]
    # The places, by their nodes; the scene's list renumbered.
    drop = {i for i, n in enumerate(gltf["nodes"])
            if n.get("name", "").startswith("place-") and n["name"][len("place-"):] in names}
    keep = [i for i in range(len(gltf["nodes"])) if i not in drop]
    renumber = {old: new for new, old in enumerate(keep)}
    if any(i > min(drop) for i in keep if not gltf["nodes"][i].get("name", "").startswith("place")):
        raise AssertionError("a place comes before a joint: the clips cannot be dropped")
    gltf["nodes"] = [gltf["nodes"][i] for i in keep]
    for s in gltf["scenes"]:
        s["nodes"] = [renumber[i] for i in s["nodes"] if i in renumber]
    # The accessors still used, and their views.
    used = set()
    for a in gltf["animations"]:
        for s in a["samplers"]:
            used |= {s["input"], s["output"]}
    for s in gltf.get("skins", []):
        if "inverseBindMatrices" in s:
            used.add(s["inverseBindMatrices"])
    acc = sorted(used)
    acc_map = {old: new for new, old in enumerate(acc)}
    views = sorted({gltf["accessors"][i]["bufferView"] for i in acc})
    if views != list(range(len(views))):
        raise AssertionError("the clips dropped share views with those kept: the clips cannot be dropped")
    gltf["accessors"] = [gltf["accessors"][i] for i in acc]
    for a in gltf["animations"]:
        for s in a["samplers"]:
            s["input"], s["output"] = acc_map[s["input"]], acc_map[s["output"]]
    for s in gltf.get("skins", []):
        if "inverseBindMatrices" in s:
            s["inverseBindMatrices"] = acc_map[s["inverseBindMatrices"]]
    gltf["bufferViews"] = gltf["bufferViews"][:len(views)]
    last = gltf["bufferViews"][-1]
    ext = last["extensions"]["EXT_meshopt_compression"]
    data, fallback = ext["buffer"], last["buffer"]
    gltf["buffers"][data]["byteLength"] = max(v["extensions"]["EXT_meshopt_compression"]["byteOffset"] +
                                              v["extensions"]["EXT_meshopt_compression"]["byteLength"]
                                              for v in gltf["bufferViews"])
    gltf["buffers"][fallback]["byteLength"] = max(v["byteOffset"] + v["byteLength"] for v in gltf["bufferViews"])
