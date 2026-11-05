# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The portraits, as Blender runs them: blender -b --python portraits.py --
job.json (tools/sailors writes the job and runs this after a look's
build, or alone with -portraits).

Each version of a committed look is taken from its last run's close level
(the run's <version>.mask.glb, the level as built with its atlas and
mask, which Blender can read where the committed file's compressed
textures it cannot), after checking that run is what is committed. The
figure is posed for a portrait (the arms down from the rest pose's A, the
head and eyes turned a little toward the camera) and taken head and
shoulders, three-quarter, the same way for every look (tables.yaml,
portraits), into two pictures beside the look's levels:

- the colour portrait, <version>.portrait.avif (and .webp, for browsers
  without AVIF), rendered by Cycles: the fixed parts in their colours and
  the parts a sailor chooses the colour of in the atlas's neutral grey,
  shaded; transparent round the figure. With it its mask,
  <version>.portrait-mask.webp, lossless: red the main colour's share of
  each pixel, green the skin's (a machine's metal), blue the hair's. The
  game's compositor (client/src/account/portrait.ts) multiplies each
  region by twice its colour in linear light, as the sailor's material
  does, so one pair draws the look in any options. A machine's lamps are
  lit in the base, in their own light; its mask has no blue.
- the inked portrait, <version>.ink.webp: the figure drawn in the manner
  of a line engraving, on the logbook's paper. Contours from the picture
  itself (where the depth jumps, where one part meets another, the
  outline thicker); tone by hatching in levels, lines that follow the form
  (sections of the figure by parallel planes, so they bend over it as an
  engraver's do), crossed only in the darkest; the tone from one light
  from the upper left on the look's own colours compressed toward the
  middle, so a dark skin keeps an open lit side, and the face's ink
  capped. One bit: each pixel ink or paper; the paper's grain under it.

Each run of the version keeps the review's pictures (portrait.png: the
base, the mask, the look in its own colours at twice the size, and the
ink), and the measures (portraits.json).
"""

import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import export  # noqa: E402

VERSIONS = ("female", "male")
# The ink and the paper: the game's own (client/src/boot/styles.css).
INK = "#2B2118"
PAPER = "#EFE4C8"
# What the data passes add to a point's place, so none is negative.
OFFSET = 10.0


def linear(hex_colour):
    c = np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def lum(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


# --- The run and the figure ---------------------------------------------


def last_run(work, v):
    """The last run of the look that built the version: its folder."""
    runs = sorted((int(d) for d in os.listdir(work) if d.isdigit()), reverse=True) if os.path.isdir(work) else []
    for n in runs:
        if os.path.exists(os.path.join(work, str(n), v, f"{v}.mask.glb")):
            return os.path.join(work, str(n))
    raise AssertionError(f"{work}: no run has built the {v} version")


def check_committed(run, v, out):
    """Fails unless the run's close level is the one committed: the same
    meshes with the same triangles (gltfpack keeps both)."""
    built, _ = export.read(os.path.join(run, v, f"{v}.mask.glb"))
    committed, _ = export.read(os.path.join(out, f"{v}.glb"))
    if export.triangles(built) != export.triangles(committed):
        raise AssertionError(f"{run}: its {v} close level is not the one in {out}: build the look again")


def empty_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures,
                 bpy.data.lights, bpy.data.cameras, bpy.data.worlds):
        for x in list(coll):
            coll.remove(x)


class Figure:
    """The close level, read back, and posed for the portrait."""

    def __init__(self, glb):
        bpy.ops.import_scene.gltf(filepath=glb)
        self.arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
        # A rig's helper icosphere comes along with the file: not the figure's.
        self.meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.find_armature() is self.arm]
        for o in [o for o in bpy.data.objects if o.type == "MESH" and o not in self.meshes]:
            bpy.data.objects.remove(o, do_unlink=True)
        self.bones = self.arm.pose.bones

    def turn(self, bone, axis, degrees):
        """Turns a bone about a world axis through its posed head."""
        b = self.bones[bone]
        head = self.arm.matrix_world @ b.head
        m = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) \
            @ Matrix.Translation(-head) @ self.arm.matrix_world @ b.matrix
        b.matrix = self.arm.matrix_world.inverted() @ m
        bpy.context.view_layer.update()

    def world(self, bone):
        return self.arm.matrix_world @ self.bones[bone].head

    def pose(self, p):
        """The arms down from the rest pose's A; the head, then the eyes,
        turned toward the camera on the figure's left (+x; it faces -y)."""
        self.turn("upperarm_l", "Y", p["arms-down"])
        self.turn("upperarm_r", "Y", -p["arms-down"])
        self.turn("neck_01", "Z", p["head-turn"] * 0.4)
        self.turn("head", "Z", p["head-turn"] * 0.6)
        for eye in ("eye_l", "eye_r"):
            self.turn(eye, "Z", p["gaze"])

    def eyes(self):
        return (self.world("eye_l") + self.world("eye_r")) / 2


# --- The camera, the lights, the render -----------------------------------


class Studio:
    """The camera and the lights for one figure, and renders into arrays."""

    def __init__(self, fig, table, work):
        self.t = table
        self.work = work
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.use_denoising = False
        scene.cycles.seed = 1
        scene.cycles.max_bounces = 4
        scene.render.film_transparent = True
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "OPEN_EXR"
        scene.render.image_settings.color_depth = "32"
        scene.render.image_settings.color_mode = "RGBA"
        scene.view_settings.view_transform = "Standard"
        cam = table["camera"]
        camera = bpy.data.objects.new("portrait", bpy.data.cameras.new("portrait"))
        scene.collection.objects.link(camera)
        scene.camera = camera
        camera.data.lens = cam["lens"]
        camera.data.sensor_fit = "VERTICAL"
        camera.data.sensor_height = 24
        camera.data.clip_start, camera.data.clip_end = 0.05, 20
        az = math.radians(cam["azimuth"])
        toward = Vector((math.sin(az), -math.cos(az), 0))
        # The frame's middle: below the eyes by their place in it.
        height = cam["height"]
        self.target = fig.eyes() - Vector((0, 0, (0.5 - cam["eyes"]) * height))
        distance = height * cam["lens"] / 24
        up = Vector((0, 0, 1))
        self.right = up.cross(toward).normalized()
        self.up = toward.cross(self.right)
        self.toward = toward
        camera.matrix_world = Matrix.Translation(self.target + toward * distance) \
            @ Matrix((self.right, self.up, toward)).transposed().to_4x4()
        self.camera = camera
        self.fig = fig
        self.lights = []
        self.world = bpy.data.worlds.new("portrait")
        scene.world = self.world

    def direction(self, f):
        return (self.right * f[0] + self.up * f[1] + self.toward * f[2]).normalized()

    def light(self, name, kind, f, watts, size, colour, cone=None):
        light = bpy.data.lights.new(name, kind)
        light.energy = watts
        light.color = colour
        if kind == "SPOT":
            light.shadow_soft_size = size
            light.spot_size = math.radians(cone)
            light.spot_blend = 1.0
        elif kind == "SUN":
            light.angle = math.radians(size)
        else:
            light.size = size
        o = bpy.data.objects.new(name, light)
        bpy.context.scene.collection.objects.link(o)
        z = self.direction(f)
        x = Vector((0, 0, 1)).cross(z).normalized()
        o.matrix_world = Matrix.Translation(self.target + z * 3) @ Matrix((x, z.cross(x), z)).transposed().to_4x4()
        self.lights.append(o)

    def colour_lights(self, unshadowing=()):
        """The colour portrait's lights. The key casts no shadow of the
        meshes named unshadowing (the hat): as a portrait's key is kept
        off the face's shadow, so the brim never hides the face."""
        lights = self.t["lights"]
        for name in ("key", "fill", "below", "rim"):
            spec = lights[name]
            kind = "SPOT" if "cone" in spec else "AREA"
            self.light(name, kind, spec["from"], spec["watts"], spec["size"], spec["colour"], spec.get("cone"))
        self.unshadow(self.lights[0], unshadowing)
        sky_sea(self.world, lights["sky"], lights["sea"], lights["ambient"])

    def unshadow(self, light, names):
        """The light casts no shadow of the meshes named."""
        blockers = [o for o in self.fig.meshes if o.name not in names]
        if len(blockers) < len(self.fig.meshes):
            coll = bpy.data.collections.get("portrait-shadows") or bpy.data.collections.new("portrait-shadows")
            for o in blockers:
                if o.name not in coll.objects:
                    coll.objects.link(o)
            light.light_linking.blocker_collection = coll

    def ink_light(self, unshadowing=()):
        """One light from the upper left, the hat casting no shadow, and a
        little of the sky."""
        self.clear_lights()
        ink = self.t["ink"]["light"]
        self.light("ink", "SUN", ink["from"], ink["strength"], 8, (1, 1, 1))
        self.unshadow(self.lights[0], unshadowing)
        sky_sea(self.world, (1, 1, 1), (0.6, 0.6, 0.6), ink["sky"])

    def clear_lights(self):
        for o in self.lights:
            bpy.data.objects.remove(o, do_unlink=True)
        self.lights = []
        sky_sea(self.world, (0, 0, 0), (0, 0, 0), 0)

    def render(self, name, size, samples, sharp=False):
        """Renders the frame at size, in linear values with the coverage
        as alpha, rows from the top. Sharp: one sample at each pixel's
        middle, never two surfaces mixed (the data passes)."""
        scene = bpy.context.scene
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.cycles.samples = samples
        scene.cycles.use_adaptive_sampling = not sharp
        scene.cycles.pixel_filter_type = "BOX" if sharp else "BLACKMAN_HARRIS"
        scene.cycles.filter_width = 0.01 if sharp else 1.5
        path = os.path.join(self.work, f"portrait-{name}.exr")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path)
        px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
        img.pixels.foreach_get(px)
        out = px.reshape(img.size[1], img.size[0], 4)[::-1].copy()
        bpy.data.images.remove(img)
        os.remove(path)
        return out


def sky_sea(world, sky, sea, strength):
    """The world: the sky above the horizon and the sea below, which metal
    reflects."""
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = -0.15
    ramp.inputs["From Max"].default_value = 0.25
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*sea, 1)
    mix.inputs[7].default_value = (*sky, 1)
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    # The ray's height: Generated is the view direction for a world.
    nt.links.new(sep.outputs["Z"], ramp.inputs["Value"])
    nt.links.new(ramp.outputs[0], mix.inputs[0])
    nt.links.new(mix.outputs[2], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs[0])


# --- Materials -------------------------------------------------------------


class Materials:
    """The figure's materials for each pass, from its atlas and mask."""

    def __init__(self, fig, base_png, mask_png, machine, lamp):
        self.fig = fig
        self.base = bpy.data.images.load(base_png)
        self.mask = bpy.data.images.load(mask_png)
        self.mask.colorspace_settings.name = "Non-Color"
        self.mask.alpha_mode = "CHANNEL_PACKED"
        self.machine = machine
        self.lamp = lamp
        self.made = {}

    def use(self, kind, **kw):
        if kind not in self.made:
            self.made[kind] = getattr(self, "_" + kind.split(":")[0])(kind, **kw)
        for o in self.fig.meshes:
            o.data.materials.clear()
            o.data.materials.append(self.made[kind])

    def _tree(self, name):
        m = bpy.data.materials.new("portrait-" + name)
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = self.fig.meshes[0].data.uv_layers[0].name
        base = nt.nodes.new("ShaderNodeTexImage")
        base.image = self.base
        mask = nt.nodes.new("ShaderNodeTexImage")
        mask.image = self.mask
        for t in (base, mask):
            nt.links.new(uv.outputs[0], t.inputs["Vector"])
        regions = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(mask.outputs["Color"], regions.inputs[0])
        return m, nt, out, base, mask, regions

    def _colour(self, kind):
        """Lit: the atlas as it is (the regions grey), metal where the
        mask's alpha says, cloth matte, skin less so, metal smoother; a
        machine's lamps alight."""
        m, nt, out, base, mask, regions = self._tree(kind)
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(mask.outputs["Alpha"], bsdf.inputs["Metallic"])
        skin = _mix_float(nt, regions.outputs[1], 0.82, 0.55)
        rough = _mix_float(nt, mask.outputs["Alpha"], skin.outputs[0], 0.35)
        nt.links.new(rough.outputs[0], bsdf.inputs["Roughness"])
        if self.machine:
            nt.links.new(regions.outputs[2], bsdf.inputs["Emission Strength"])
            bsdf.inputs["Emission Color"].default_value = (*self.lamp, 1)
            # The strength is the mask's blue times the lamp's.
            scale = nt.nodes.new("ShaderNodeMath")
            scale.operation = "MULTIPLY"
            nt.links.new(regions.outputs[2], scale.inputs[0])
            scale.inputs[1].default_value = self.lamp_strength
            nt.links.new(scale.outputs[0], bsdf.inputs["Emission Strength"])
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        return m

    def _mask(self, kind):
        """Unlit: the mask's regions (a machine's without its lamps)."""
        m, nt, out, base, mask, regions = self._tree(kind)
        emit = nt.nodes.new("ShaderNodeEmission")
        if self.machine:
            join = nt.nodes.new("ShaderNodeCombineColor")
            nt.links.new(regions.outputs[0], join.inputs[0])
            nt.links.new(regions.outputs[1], join.inputs[1])
            nt.links.new(join.outputs[0], emit.inputs["Color"])
        else:
            nt.links.new(mask.outputs["Color"], emit.inputs["Color"])
        nt.links.new(emit.outputs[0], out.inputs[0])
        return m

    def _tone(self, kind, image):
        """Matte, in the look's own colours (image) compressed toward the
        middle."""
        m, nt, out, base, mask, regions = self._tree(kind)
        base.image = image
        diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
        nt.links.new(base.outputs["Color"], diffuse.inputs["Color"])
        nt.links.new(diffuse.outputs[0], out.inputs[0])
        return m

    def _data(self, kind, **kw):
        """Unlit data: where each point is in the world (x, y, z plus
        OFFSET, so never negative), its normal (plus one), or which part
        it is (its mesh's number, and the skin's and hair's shares)."""
        m, nt, out, base, mask, regions = self._tree(kind)
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        emit = nt.nodes.new("ShaderNodeEmission")
        what = kind.split(":")[1]
        if what == "albedo":
            base.image = kw["image"]
            nt.links.new(base.outputs["Color"], emit.inputs["Color"])
        elif what in ("position", "normal"):
            add = nt.nodes.new("ShaderNodeVectorMath")
            add.operation = "ADD"
            add.inputs[1].default_value = (OFFSET,) * 3 if what == "position" else (1, 1, 1)
            nt.links.new(geo.outputs["Position" if what == "position" else "Normal"], add.inputs[0])
            nt.links.new(add.outputs[0], emit.inputs["Color"])
        else:
            info = nt.nodes.new("ShaderNodeObjectInfo")
            join = nt.nodes.new("ShaderNodeCombineColor")
            nt.links.new(info.outputs["Object Index"], join.inputs[0])
            nt.links.new(regions.outputs[1], join.inputs[1])
            nt.links.new(regions.outputs[2], join.inputs[2])
            nt.links.new(join.outputs[0], emit.inputs["Color"])
        nt.links.new(emit.outputs[0], out.inputs[0])
        return m


def _mix_float(nt, factor, a, b):
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "FLOAT"
    nt.links.new(factor, mix.inputs[0])
    for i, v in ((2, a), (3, b)):
        if isinstance(v, (int, float)):
            mix.inputs[i].default_value = v
        else:
            nt.links.new(v, mix.inputs[i])
    return mix


# --- Pictures --------------------------------------------------------------


def unpremultiply(rgba):
    a = rgba[..., 3:4]
    return np.where(a > 1e-4, rgba[..., :3] / np.maximum(a, 1e-4), 0)


def image(pixels, name):
    """A Blender image of rows from the top (values as stored)."""
    h, w = pixels.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :pixels.shape[2]] = pixels
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    return img


def write(pixels, path, fmt, quality, alpha):
    """Writes rows from the top as AVIF, WebP or PNG (quality 100: lossless
    WebP); returns its size in bytes."""
    img = image(pixels, os.path.basename(path))
    scene = bpy.context.scene
    st = scene.render.image_settings
    saved = (st.file_format, st.color_mode, st.quality, st.color_depth)
    st.file_format = fmt
    st.color_mode = "RGBA" if alpha else "RGB"
    st.quality = quality
    if fmt == "AVIF":
        st.color_depth = "8"
    img.save_render(path, scene=scene)
    st.file_format, st.color_mode, st.quality = saved[:3]
    if saved[0] == "OPEN_EXR":
        st.color_depth = saved[3]
    bpy.data.images.remove(img)
    return os.path.getsize(path)


def read(path):
    """An image file's pixels, rows from the top, as stored."""
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(px)
    out = px.reshape(img.size[1], img.size[0], 4)[::-1].copy()
    bpy.data.images.remove(img)
    return out


def composite(base, mask, palette):
    """What the game's compositor draws (client/src/account/portrait.ts),
    in sRGB with alpha: each region × 2 × its colour in linear light."""
    lin = np.where(base[..., :3] <= 0.04045, base[..., :3] / 12.92, ((base[..., :3] + 0.055) / 1.055) ** 2.4)
    tint = np.ones_like(lin)
    for ch, region in enumerate(("main", "skin", "hair")):
        if region in palette:
            tint = tint + mask[..., ch:ch + 1] * (2 * linear(palette[region]) - 1)
    return np.concatenate([srgb(lin * tint), base[..., 3:4]], -1)


def downsample(a, k):
    h, w = a.shape[:2]
    return a.reshape(h // k, k, w // k, k, *a.shape[2:]).mean(axis=(1, 3))


# --- The colour portrait -----------------------------------------------------


def colour_portrait(studio, mats, table, hats):
    size = table["colour"]["size"]
    studio.colour_lights(hats)
    mats.use("colour")
    lit = studio.render("colour", size, table["colour"]["samples"])
    studio.clear_lights()
    mats.use("mask")
    regions = studio.render("mask", size, table["colour"]["mask-samples"])
    # The coverage is the colour render's; the mask's shares are of what
    # its own render covered.
    alpha = lit[..., 3:4]
    base = np.concatenate([srgb(unpremultiply(lit)), alpha], -1)
    shares = np.clip(unpremultiply(regions), 0, 1)
    total = shares.sum(-1, keepdims=True)
    shares = np.where(total > 1, shares / np.maximum(total, 1e-6), shares)
    steps = table["mask-steps"]
    shares = np.round(shares * steps) / steps
    shares[alpha[..., 0] < 1 / 255] = 0
    base[alpha[..., 0] < 1 / 255, :3] = 0
    return base, shares


# --- The inked portrait ------------------------------------------------------


def own_colours(base_png, mask_png, palette):
    """The atlas in the look's own colours, compressed toward the middle
    in lightness (the image for the tone), so a dark skin or coat is never
    a block of ink; and its lightness as it is (for what is painted)."""
    base = read(base_png)
    mask = read(mask_png)
    rgb = composite(base, mask, palette)[..., :3]
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    light = lum(lin)
    # Skin compressed the most: every tone's lit side stays open.
    skin = mask[..., 1]
    grey = (0.32 + 0.5 * np.sqrt(np.clip(light, 0, 1))) * (1 - skin) + (0.5 + 0.35 * np.sqrt(np.clip(light, 0, 1))) * skin
    made = []
    for name, value in (("compressed", grey), ("own", light)):
        img = image(np.repeat(value[..., None], 3, -1), "portrait-" + name)
        # Cycles reads a made image from its packed file, not its pixels.
        img.pack()
        made.append(img)
    return made


def ink_portrait(studio, mats, fig, table, palette, base_png, mask_png, seed, hats):
    ink = table["ink"]
    k = ink["scale"]
    w, h = ink["size"]
    size = (w * k, h * k)
    for i, o in enumerate(fig.meshes):
        o.pass_index = i + 1
    studio.ink_light(hats)
    compressed, own = own_colours(base_png, mask_png, palette)
    mats.use("tone", image=compressed)
    tone = studio.render("tone", size, 64)
    studio.clear_lights()
    mats.use("data:position")
    pos = studio.render("position", size, 1, sharp=True)
    mats.use("data:normal")
    nrm = studio.render("normal", size, 1, sharp=True)
    mats.use("data:part")
    part = studio.render("part", size, 1, sharp=True)
    mats.use("data:albedo", image=own)
    albedo = studio.render("albedo", size, 1, sharp=True)[..., 0]
    cover = pos[..., 3] > 0.5
    eyes = [i + 1 for i, o in enumerate(fig.meshes) if o.name == "eyes"]
    face = (part[..., 1] > 0.5) | np.isin(np.round(part[..., 0]), eyes)
    light = np.where(tone[..., 3] > 1e-3, lum(unpremultiply(tone)), 1.0)
    lines = engrave(studio, light, pos[..., :3] - OFFSET, nrm[..., :3] - 1, part, cover, k)
    lines |= marks(albedo, face & cover, k, ink["marks"])
    small = downsample(lines.astype(np.float32), k) >= 0.5
    paper = grain((h, w), seed)
    picture = np.where(small[..., None], srgb(linear(INK)), paper)
    return picture, {"ink share": round(float(small.mean()), 3),
                     "face ink": face_ink(small, downsample(part[..., 1] * cover, k) > 0.5)}


def marks(albedo, face, k, darker):
    """What is painted dark on the face, drawn: the brows, the lash line,
    the eyes, the line of the lips; where the face is much darker than
    round it."""
    r = 3 * k
    weight = box(face.astype(np.float32), r)
    near = box(np.where(face, albedo, 0), r) / np.maximum(weight, 1e-6)
    return face & (albedo < darker * near)


def box(a, r):
    """The sum over a square of side 2r + 1 round each pixel."""
    for axis in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in (0, 1)]), axis=axis)
        hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
        lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
        a = hi - lo
    return a


def face_ink(ink, skin):
    return round(float(ink[skin].mean()), 3) if skin.any() else 0.0


def engrave(studio, light, pos, nrm, part, cover, k):
    """The drawing at the render's size: contours and hatching."""
    t = studio.t["ink"]
    # Tone in levels, by the light: paper, then lines thin to thick, then
    # crossed; the face never past its cap.
    level = len(t["levels"]) - np.digitize(light, sorted(t["levels"]))
    skin = part[..., 1] > 0.5
    level = np.where(skin, np.minimum(level, t["face-cap"]), level)
    # Hair is always drawn in lines, however light: an engraver's hair is
    # never bare paper, and so a beard or hair on the face is told from
    # the skin by its lines, not an outline.
    level = np.where(part[..., 2] > 0.5, np.maximum(level, t["hair"]), level)
    # Lines that follow the form: sections by planes, a period of this
    # many pixels of the drawing at the frame's middle.
    period = t["period"] * k / studio_pixels_per_metre(studio, k)
    rel = pos - np.array(studio.target)
    a = np.mod(rel @ np.array(studio.direction(t["first"])) / period, 1.0)
    b = np.mod(rel @ np.array(studio.direction(t["second"])) / period, 1.0)
    width = np.array([0] + t["widths"])[level]
    hatch = np.abs(a - 0.5) * 2 < width
    cross = (level >= len(t["levels"])) & (np.abs(b - 0.5) * 2 < t["cross"])
    drawn = (hatch | cross) & cover
    return (drawn | contours(pos, nrm, part, cover, k)) & (cover | outline(cover, k))


def studio_pixels_per_metre(studio, k):
    cam = studio.t["camera"]
    return studio.t["ink"]["size"][1] * k / cam["height"]


def neighbours(a):
    """Each pixel's right and lower neighbours (edge-padded)."""
    right = np.concatenate([a[:, 1:], a[:, -1:]], 1)
    down = np.concatenate([a[1:], a[-1:]], 0)
    return right, down


def dilate(mask, r):
    out = mask.copy()
    for _ in range(r):
        o = out.copy()
        o[1:] |= out[:-1]
        o[:-1] |= out[1:]
        o[:, 1:] |= out[:, :-1]
        o[:, :-1] |= out[:, 1:]
        out = o
    return out


def outline(cover, k):
    """The outline: the figure's edge, drawn thick, half outside it."""
    r, d = neighbours(cover)
    edge = (cover != r) | (cover != d)
    return dilate(edge, k + 1)


def contours(pos, nrm, part, cover, k):
    """Where the depth jumps (one surface before another), where one part
    meets another, and where the surface folds sharply; and the outline."""
    out = np.zeros(cover.shape, bool)
    ids = np.round(part[..., 0]).astype(np.int32)
    hair = part[..., 2] > 0.5
    skin = part[..., 1] > 0.5
    pr, pd = neighbours(pos)
    nr, nd = neighbours(nrm)
    ir, idn = neighbours(ids)
    cr, cd = neighbours(cover)
    hr, hd = neighbours(hair)
    sr, sd = neighbours(skin)
    jump = 0.012
    for p2, n2, i2, c2, h2, s2 in ((pr, nr, ir, cr, hr, sr), (pd, nd, idn, cd, hd, sd)):
        both = cover & c2
        depth = np.linalg.norm(pos - p2, axis=-1) > jump
        fold = (nrm * n2).sum(-1) < 0.55
        # Where hair lies on the skin (a beard, a lock) no line: its own
        # lines tell it apart.
        parts = (ids != i2) & ~((hair & s2) | (skin & h2))
        out |= both & (depth | fold | parts)
    return dilate(out, max(1, k // 2)) | outline(cover, k)


def grain(shape, seed):
    """The paper: its colour, mottled a little, in sRGB."""
    rng = np.random.default_rng(seed)
    h, w = shape
    noise = rng.standard_normal((h // 8 + 2, w // 8 + 2))
    # Smooth, then enlarged: a slow mottle the encoder keeps cheaply.
    for _ in range(2):
        noise = (noise + np.roll(noise, 1, 0) + np.roll(noise, -1, 0) + np.roll(noise, 1, 1) + np.roll(noise, -1, 1)) / 5
    noise = np.kron(noise, np.ones((8, 8)))[:h, :w]
    noise = noise / (np.abs(noise).max() + 1e-6)
    paper = srgb(linear(PAPER))
    return np.clip(paper[None, None, :] * (1 + 0.035 * noise[..., None]), 0, 1)


# --- One version, and the look ---------------------------------------------


def make(job, v, table):
    look = job["look"]
    work = job["work"]
    out = job["out"]
    run = last_run(work, v)
    check_committed(run, v, out)
    start = time.time()
    empty_scene()
    there = os.path.join(run, v)
    fig = Figure(os.path.join(there, f"{v}.mask.glb"))
    fig.pose(table["pose"])
    studio = Studio(fig, table, there)
    machine = bool(look.get("machine"))
    lamp = table["lights"]["lamp"]
    mats = Materials(fig, os.path.join(there, "close.base.png"), os.path.join(there, "close.mask.png"),
                     machine, tuple(linear(lamp["colour"])))
    mats.lamp_strength = lamp["strength"]
    hats = [p["id"] for p in (look.get("hat"), look.get("scarf")) if p]
    base, shares = colour_portrait(studio, mats, table, hats)
    q = table["quality"]
    sizes = {
        "avif": write(base, os.path.join(out, f"{v}.portrait.avif"), "AVIF", q["avif"], True),
        "webp": write(base, os.path.join(out, f"{v}.portrait.webp"), "WEBP", q["webp"], True),
        "mask": write(shares, os.path.join(out, f"{v}.portrait-mask.webp"), "WEBP", 100, False),
    }
    seconds = {"colour": round(time.time() - start, 1)}
    start = time.time()
    palette = look["palette"]
    picture, ink = ink_portrait(studio, mats, fig, table, palette, os.path.join(there, "close.base.png"),
                                os.path.join(there, "close.mask.png"), seed=sum(map(ord, look["id"] + v)), hats=hats)
    sizes["ink"] = write(picture, os.path.join(out, f"{v}.ink.webp"), "WEBP", q["ink"], False)
    seconds["ink"] = round(time.time() - start, 1)
    review(there, out, v, palette)
    measures = {"run": os.path.basename(run), "bytes": sizes, "seconds": seconds, **ink}
    with open(os.path.join(there, "portraits.json"), "w", encoding="utf8") as f:
        json.dump(measures, f, indent=1)
    return measures


def review(there, out, v, palette):
    """The run's picture of the portraits as written: the base, the mask,
    the look in its own colours twice the size, and the ink."""
    base = read(os.path.join(out, f"{v}.portrait.avif"))
    mask = read(os.path.join(out, f"{v}.portrait-mask.webp"))
    ink = read(os.path.join(out, f"{v}.ink.webp"))[..., :3]
    back = srgb(linear(PAPER))

    def on(rgba):
        return rgba[..., :3] * rgba[..., 3:4] + back * (1 - rgba[..., 3:4])

    own = on(composite(base, mask, palette))
    big = np.repeat(np.repeat(own, 2, 0), 2, 1)
    h = big.shape[0]
    pad = np.ones((h, 8, 3))
    col = np.concatenate([on(base), mask[..., :3]], 0)
    sheet = np.concatenate([col, pad, big, pad, ink], 1)
    write(sheet, os.path.join(there, "portrait.png"), "PNG", 100, False)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 1:
        raise SystemExit("usage: blender -b --python portraits.py -- job.json")
    with open(args[0], encoding="utf8") as f:
        job = json.load(f)
    look = job["look"]
    if not look.get("committed"):
        print(f"portraits: {look['id']} is not a look the game offers: none made")
        return
    table = job["tables"]["portraits"]
    for v in VERSIONS:
        if v not in look["versions"]:
            continue
        m = make(job, v, table)
        print(f"portraits: {look['id']} {v} from run {m['run']}: " +
              ", ".join(f"{k} {b / 1024:.1f} KB" for k, b in m["bytes"].items()) +
              f"; ink {m['ink share']:.0%} ({m['face ink']:.0%} of the face); " +
              ", ".join(f"{k} {s} s" for k, s in m["seconds"].items()))


if __name__ == "__main__":
    main()
