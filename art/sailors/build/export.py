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
gltfpack compresses it (the geometry by meshopt, the colour by ETC1S, the
mask by UASTC), and both files are read back and checked. In the file the
figure faces +z with y up, its origin on the ground between its feet.
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


def write(path, meshes, arm, mat, mask_png, gltfpack, work):
    """Writes a level: meshes (and the skeleton arm, when not None)."""
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
    with_mask = raw.replace(".raw.glb", ".mask.glb")
    write_glb(with_mask, gltf, binary)
    subprocess.run([gltfpack, "-i", with_mask, "-o", path, "-c", "-kn", "-km", "-noq", "-tc", "-tu", "A"],
                   check=True, capture_output=True)
    gltf, _ = read(path)
    check(path, gltf, names, bones, textures=2)
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


def check(path, gltf, meshes, bones, textures):
    """Fails unless the file holds exactly what the level should."""
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
    if [mt.get("name") for mt in gltf.get("materials", [])] != [MATERIAL]:
        problems.append(f"materials {[mt.get('name') for mt in gltf.get('materials', [])]}, not one {MATERIAL!r}")
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
