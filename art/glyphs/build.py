# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The glyphs of the sailor's collection, as Blender runs them, from the
repository's root:

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python art/glyphs/build.py

A glyph is a small inked picture of one kind the log collects: every kind
of the sea's life (the catalog's life.kinds) and every boat (its boats),
drawn from the game's own models, one art/glyphs/<id>.webp each. The kinds
are read from the generated catalog (client/src/catalog/catalog.gen.json),
so a kind added there is drawn on the next run:

- a swimmer is its body in life/swimmers.glb (the node its swim.body
  names), in its own back and belly colours; a dolphin is posed as its
  kind swims (the spinner mid-leap), the bait is a ball of small fish;
- a flying bird is the mesh the game flies (client/src/render/birds.ts,
  a body and two wings of two panels and a tip), built here from the same
  numbers, its wings raised as far as its kind flaps rather than glides,
  seen from below and ahead, in its body, wing and tip colours;
- a boat is its model (boats/<model>.glb), sails set, seen from a little
  above and forward of the beam;
- the glowing water has no model: it is drawn here, a dark sea and its
  crests alight.

Each is drawn in the manner of the sailors' inked portraits
(art/sailors/build/portraits.py): rendered four times the size by Cycles,
an orthographic camera fitted to the figure; contours where the depth
jumps, where one part or material meets another and where the surface
folds, the outline thicker; tone by hatching in levels from one light from
the upper left on the model's own colours, compressed toward the middle,
the lines sections of the figure by parallel planes so they bend over it,
crossed only in the darkest; then each block of four by four pixels is ink
if half of it is. 96 x 96 pixels, lossless, three values only:
transparent round the figure, the paper (#EFE4C8) inside its silhouette,
and the ink (#2B2118), so the page can show a kind not yet met as a
silhouette from the alpha alone. Every run draws the same pixels.
"""

import json
import math
import os
import shutil
import sys
import tempfile
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CATALOG = os.path.join(ROOT, "client", "src", "catalog", "catalog.gen.json")
ART = os.path.join(ROOT, "art")

# The glyph's size, how much larger it is drawn, and the margin round the
# figure, in the glyph's pixels.
SIZE = 96
K = 4
MARGIN = 4
# The ink and the paper: the game's own (client/src/boot/styles.css).
INK = "#2B2118"
PAPER = "#EFE4C8"
# What the position pass adds to a point's place, so none is negative.
OFFSET = 1000.0

# The light, from the camera's upper left, and the sky's share.
LIGHT = (-0.8, 0.45, 0.9)
SUN = 3.2
SKY = 0.25
# Tone in levels by the light: paper above the first; then lines one
# pixel in three; two in three; and those crossed by lines one in three,
# the darkest.
LEVELS = (0.58, 0.36, 0.2)
# The hatching's period, in the glyph's pixels, and the planes its lines
# are sections by, in the camera's terms (right, up, toward): nearly level
# lines, crossed by nearly upright ones. The lines are placed at the
# glyph's own size, so each is whole pixels, never broken by the
# reduction.
PERIOD = 3
FIRST = (0.12, 1, 0.1)
SECOND = (1, -0.35, 0.15)
# A swimmer's dark marks (its eye, mouth, fins' edges) darken it this much.
MARK = 0.12
# What is painted this much darker than round it is drawn as a mark.
MARKS = 0.55


def linear(hex_colour):
    c = np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def bytes_of(hex_colour):
    return np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0


# --- The scene -----------------------------------------------------------------


def empty_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.lights,
                 bpy.data.cameras, bpy.data.worlds, bpy.data.collections, bpy.data.node_groups):
        for x in list(coll):
            coll.remove(x)


def setup():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = False
    scene.cycles.seed = 1
    scene.cycles.max_bounces = 2
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    scene.render.resolution_x = scene.render.resolution_y = SIZE * K
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"


def meshes():
    return sorted((o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render),
                  key=lambda o: o.name)


def points(objs):
    """Every vertex of the objects, in the world, as they are drawn."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        a = np.empty(len(me.vertices) * 3, np.float64)
        me.vertices.foreach_get("co", a)
        m = np.array(e.matrix_world)
        out.append(a.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        e.to_mesh_clear()
    return np.concatenate(out)


class View:
    """An orthographic camera from an azimuth (0: from starboard, +x, so
    the bow, +y, is to the right; 90: from ahead) and an elevation, fitted
    to the figure, with the light and the world."""

    def __init__(self, azimuth, elevation, roll=0.0):
        az, el = math.radians(azimuth), math.radians(elevation)
        toward = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
        up = Vector((0, 0, 1)) if abs(elevation) < 80 else Vector((-math.cos(az), -math.sin(az), 0)) * math.copysign(1, elevation)
        right = up.cross(toward).normalized()
        up = toward.cross(right)
        r = math.radians(roll)
        right, up = right * math.cos(r) + up * math.sin(r), up * math.cos(r) - right * math.sin(r)
        self.right, self.up, self.toward = right, up, toward
        pts = points(meshes())
        R = np.array(pts) @ np.array(right)
        U = np.array(pts) @ np.array(up)
        T = np.array(pts) @ np.array(toward)
        self.extent = max(R.max() - R.min(), U.max() - U.min())
        self.target = right * ((R.max() + R.min()) / 2) + up * ((U.max() + U.min()) / 2) + toward * ((T.max() + T.min()) / 2)
        depth = T.max() - T.min()
        # The figure fills the square less the margin and the outline's
        # outer half.
        self.scale = self.extent * SIZE / (SIZE - 2 * MARGIN - 2)
        self.mpp = self.scale / (SIZE * K)
        scene = bpy.context.scene
        camera = bpy.data.objects.new("glyph", bpy.data.cameras.new("glyph"))
        scene.collection.objects.link(camera)
        scene.camera = camera
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = self.scale
        camera.data.clip_start = 0.01
        camera.data.clip_end = depth + self.extent * 4
        camera.matrix_world = Matrix.Translation(self.target + toward * (depth / 2 + self.extent)) \
            @ Matrix((right, up, toward)).transposed().to_4x4()
        light = bpy.data.lights.new("glyph", "SUN")
        light.energy = SUN
        light.angle = math.radians(8)
        o = bpy.data.objects.new("glyph-light", light)
        scene.collection.objects.link(o)
        z = self.direction(LIGHT)
        x = Vector((0, 0, 1)).cross(z)
        x = (x if x.length > 1e-6 else Vector((1, 0, 0))).normalized()
        o.matrix_world = Matrix.Translation(self.target + z * self.extent) @ Matrix((x, z.cross(x), z)).transposed().to_4x4()
        world = bpy.data.worlds.new("glyph")
        world.color = (1, 1, 1)
        nt = world.node_tree
        bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
        bg.inputs["Color"].default_value = (1, 1, 1, 1)
        bg.inputs["Strength"].default_value = SKY
        scene.world = world

    def direction(self, f):
        return (self.right * f[0] + self.up * f[1] + self.toward * f[2]).normalized()


# Where the renders are written and read back, for the run.
WORK = tempfile.mkdtemp(prefix="glyphs-")


def render(name, samples, sharp=False):
    """Renders the frame, in linear values with the coverage as alpha, rows
    from the top. Sharp: one sample at each pixel's middle, never two
    surfaces mixed (the data passes)."""
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.pixel_filter_type = "BOX" if sharp else "BLACKMAN_HARRIS"
    scene.cycles.filter_width = 0.01 if sharp else 1.5
    path = os.path.join(WORK, f"glyph-{name}.exr")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(px)
    out = px.reshape(img.size[1], img.size[0], 4)[::-1].copy()
    bpy.data.images.remove(img)
    os.remove(path)
    return out


# --- Materials for each pass -----------------------------------------------------


def principled(m):
    return next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m and m.node_tree else None


def base_colour(m):
    """A material's base colour: the socket that feeds it, or its value."""
    p = principled(m)
    if p is None:
        return (0.8, 0.8, 0.8, 1)
    inp = p.inputs["Base Color"]
    return inp.links[0].from_socket if inp.is_linked else tuple(inp.default_value)


def surface(m, colour):
    """Rewires a material (a copy) to emit a colour (a socket or a value)."""
    nt = m.node_tree
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
    emit = nt.nodes.new("ShaderNodeEmission")
    if isinstance(colour, tuple):
        emit.inputs["Color"].default_value = colour
    else:
        nt.links.new(colour, emit.inputs["Color"])
    nt.links.new(emit.outputs[0], out.inputs["Surface"])
    for link in list(out.inputs["Displacement"].links):
        nt.links.remove(link)
    return emit


class Passes:
    """The figure's materials for each pass: lit white (the shading), and
    unlit data (where each point is, its normal, and which object and
    material it is with its colour's lightness)."""

    def __init__(self, objs):
        self.objs = objs
        for i, o in enumerate(objs):
            o.pass_index = i + 1
            if not o.material_slots:
                o.data.materials.append(bpy.data.materials.new("glyph-plain"))
        self.slots = {o.name: [s.material for s in o.material_slots] for o in objs}
        self.numbers = {}
        for o in objs:
            for m in self.slots[o.name]:
                self.numbers.setdefault(m.name, len(self.numbers) + 1)
        self.made = {}

    def use(self, kind):
        for o in self.objs:
            for j, m in enumerate(self.slots[o.name]):
                o.material_slots[j].material = self.material(kind, m)

    def material(self, kind, m):
        if m.name.split(".")[0] in UNDRAWN:
            kind = "undrawn"
        key = (kind, m.name if kind == "part" else "")
        if key not in self.made:
            self.made[key] = getattr(self, "_" + kind)(m)
        return self.made[key]

    def _undrawn(self, m):
        """Clear in every pass: what is too fine to draw at the glyph's size."""
        made = bpy.data.materials.new("glyph-undrawn")
        nt = made.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        clear = nt.nodes.new("ShaderNodeBsdfTransparent")
        nt.links.new(clear.outputs[0], out.inputs["Surface"])
        return made

    def _shade(self, m):
        made = bpy.data.materials.new("glyph-shade")
        nt = made.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
        diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
        nt.links.new(diffuse.outputs[0], out.inputs["Surface"])
        return made

    def _geometry(self, what):
        made = bpy.data.materials.new("glyph-" + what)
        nt = made.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        out.is_active_output = True
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        add = nt.nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        add.inputs[1].default_value = (OFFSET,) * 3 if what == "position" else (1, 1, 1)
        nt.links.new(geo.outputs["Position" if what == "position" else "Normal"], add.inputs[0])
        emit = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(add.outputs[0], emit.inputs["Color"])
        nt.links.new(emit.outputs[0], out.inputs["Surface"])
        return made

    def _position(self, m):
        return self._geometry("position")

    def _normal(self, m):
        return self._geometry("normal")

    def _part(self, m):
        """Red the object's number, green the material's, blue the
        lightness of its colour."""
        made = m.copy()
        made.name = "glyph-part-" + m.name
        nt = made.node_tree
        colour = base_colour(made)
        bw = nt.nodes.new("ShaderNodeRGBToBW")
        if isinstance(colour, tuple):
            bw.inputs[0].default_value = colour
        else:
            nt.links.new(colour, bw.inputs[0])
        info = nt.nodes.new("ShaderNodeObjectInfo")
        join = nt.nodes.new("ShaderNodeCombineColor")
        nt.links.new(info.outputs["Object Index"], join.inputs[0])
        join.inputs[1].default_value = self.numbers[m.name]
        nt.links.new(bw.outputs[0], join.inputs[2])
        surface(made, join.outputs[0])
        return made


# --- The drawing -----------------------------------------------------------------


def unpremultiply(rgba):
    a = rgba[..., 3:4]
    return np.where(a > 1e-4, rgba[..., :3] / np.maximum(a, 1e-4), 0)


def downsample(a, k):
    h, w = a.shape[:2]
    return a.reshape(h // k, k, w // k, k, *a.shape[2:]).mean(axis=(1, 3))


def box(a, r):
    """The sum over a square of side 2r + 1 round each pixel."""
    for axis in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in (0, 1)]), axis=axis)
        hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
        lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
        a = hi - lo
    return a


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


def outline(cover):
    """The outline: the figure's edge, drawn thick, half outside it."""
    r, d = neighbours(cover)
    edge = (cover != r) | (cover != d)
    return dilate(edge, K)


def contours(pos, nrm, part, cover, jump):
    """Where the depth jumps (one surface before another), where one part
    or material meets another, and where the surface folds sharply."""
    out = np.zeros(cover.shape, bool)
    ids = np.round(part[..., 0]).astype(np.int32) * 1000 + np.round(part[..., 1]).astype(np.int32)
    pr, pd = neighbours(pos)
    nr, nd = neighbours(nrm)
    ir, idn = neighbours(ids)
    cr, cd = neighbours(cover)
    for p2, n2, i2, c2 in ((pr, nr, ir, cr), (pd, nd, idn, cd)):
        both = cover & c2
        depth = np.linalg.norm(pos - p2, axis=-1) > jump
        # Both sides of a thin sheet (a sail, a wing) face either way.
        fold = np.abs((nrm * n2).sum(-1)) < 0.5
        out |= both & (depth | fold | (ids != i2))
    return dilate(out, K // 2 - 1)


def marks(albedo, cover):
    """What is painted dark, drawn: where the colour is much darker than
    round it (a swimmer's eye and fins' edges, a boat's boot-top)."""
    r = 2 * K
    weight = box(cover.astype(np.float32), r)
    near = box(np.where(cover, albedo, 0), r) / np.maximum(weight, 1e-6)
    return cover & (albedo < MARKS * near)


def hatching(view, light, pos, cover):
    """Tone in levels, lines that follow the form: sections by planes, a
    period of PERIOD of the glyph's pixels; crossed in the last level. At
    the glyph's size: each pixel's phase between two planes is the mean of
    its block's, its light the block's mean."""
    period = PERIOD * K * view.mpp
    rel = pos - np.array(view.target)
    w = cover.astype(np.float64)
    weight = downsample(w, K)

    def phase(f):
        t = 2 * math.pi * (rel @ np.array(view.direction(f))) / period
        return np.mod(np.arctan2(downsample(np.sin(t) * w, K), downsample(np.cos(t) * w, K)) / (2 * math.pi), 1.0)

    def line(a, pixels):
        """Where a line of so many pixels' width runs: the pixels within
        that many of the phase's steps to the next of the line's middle
        (0.5), so a line is unbroken whichever way it runs and however
        the form spreads or crowds the lines."""
        return np.abs(a - 0.5) <= np.clip(steps(a, weight), 0.15, 0.5) * pixels / 2

    a = phase(FIRST)
    b = phase(SECOND)
    lit = downsample(np.where(cover, light, 0), K) / np.maximum(weight, 1e-6)
    level = len(LEVELS) - np.digitize(lit, sorted(LEVELS))
    hatch = ((level == 1) & line(a, 1)) | ((level >= 2) & line(a, 2)) | ((level >= 3) & line(b, 1))
    return hatch & (weight >= 0.5)


def steps(a, weight):
    """How much a phase (in turns) changes from each pixel to the next,
    across or down, whichever more: the mean of its steps to the
    neighbours inside the figure."""
    def wrapped(d):
        return np.abs(np.mod(d + 0.5, 1.0) - 0.5)

    inside = weight >= 0.25
    out = []
    for axis in (0, 1):
        d = wrapped(np.diff(a, axis=axis))
        ok = np.logical_and(np.take(inside, range(0, a.shape[axis] - 1), axis), np.take(inside, range(1, a.shape[axis]), axis))
        d = np.where(ok, d, 0)
        pad = [(0, 0), (0, 0)]
        pad[axis] = (1, 0)
        before, before_ok = np.pad(d, pad), np.pad(ok, pad)
        pad[axis] = (0, 1)
        after, after_ok = np.pad(d, pad), np.pad(ok, pad)
        n = before_ok.astype(np.float64) + after_ok
        out.append((before + after) / np.maximum(n, 1))
    return np.maximum(*out)


def grey(albedo):
    """The tone's colour: the model's lightness compressed toward the
    middle, so a dark animal keeps an open lit side and a pale one its
    shadow."""
    return 0.12 + 0.8 * np.power(np.clip(albedo, 0, 1), 0.4)


def draw(view):
    """Renders the passes and draws the figure: the drawing's ink and the
    figure's coverage, at K times the glyph's size."""
    passes = Passes(meshes())
    passes.use("shade")
    shade = render("shade", 32)
    passes.use("position")
    pos = render("position", 1, sharp=True)
    passes.use("normal")
    nrm = render("normal", 1, sharp=True)
    passes.use("part")
    part = render("part", 1, sharp=True)
    cover = pos[..., 3] > 0.5
    albedo = part[..., 2]
    shading = np.where(shade[..., 3] > 1e-3, unpremultiply(shade)[..., 0], 1.0)
    light = shading * grey(albedo)
    if os.environ.get("GLYPHS_DEBUG"):
        print("debug", float(albedo[cover].mean()), float(albedo[cover].min()), float(albedo[cover].max()), float(shading[cover].mean()), float(light[cover].mean()), np.unique(np.round(part[cover][:, :2]), axis=0)[:8].tolist())
    p = pos[..., :3] - OFFSET
    lines = contours(p, nrm[..., :3] - 1, part, cover, view.mpp * 6)
    lines |= marks(albedo, cover)
    lines = (lines & cover) | outline(cover)
    return lines, cover, hatching(view, light, p, cover)


def glyph(lines, cover, hatch, specks=False):
    """The glyph: ink where half a block is drawn or hatched, paper in the
    figure's silhouette, transparent round it; a lone speck of ink in the
    paper dropped, unless specks are meant."""
    inside = downsample(cover.astype(np.float32), K) >= 0.5
    ink = (downsample(lines.astype(np.float32), K) >= 0.5) | (hatch & inside)
    if not specks:
        count = box(ink.astype(np.float32), 1) - ink
        ink &= (count > 0) | ~inside
    shape = ink | inside
    out = np.zeros((SIZE, SIZE, 4), np.float32)
    out[shape, :3] = bytes_of(PAPER)
    out[ink, :3] = bytes_of(INK)
    out[shape, 3] = 1
    return out


# --- Files -----------------------------------------------------------------------


def image(pixels, name):
    """A Blender image of rows from the top (values as stored)."""
    h, w = pixels.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(pixels[::-1]).ravel())
    return img


def write(pixels, path):
    """Writes rows from the top as lossless WebP (quality 100); returns
    its size in bytes."""
    img = image(pixels, os.path.basename(path))
    st = bpy.context.scene.render.image_settings
    saved = (st.file_format, st.color_mode, st.color_depth)
    st.file_format = "WEBP"
    st.color_mode = "RGBA"
    st.quality = 100
    img.save_render(path, scene=bpy.context.scene)
    st.file_format, st.color_mode = saved[:2]
    st.color_depth = saved[2]
    bpy.data.images.remove(img)
    return os.path.getsize(path)


# --- The subjects ------------------------------------------------------------------


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    return {o.name: o for o in bpy.context.scene.objects}


def colour_material(name, back, belly):
    """A swimmer's paint, as the game's: its vertices' red the back's share
    (back over belly), green a dark mark."""
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    p = principled(m)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "Color"
    split = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], split.inputs[0])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(split.outputs[0], mix.inputs[0])
    mix.inputs[6].default_value = (*linear(belly), 1)
    mix.inputs[7].default_value = (*linear(back), 1)
    dark = nt.nodes.new("ShaderNodeMix")
    dark.data_type = "RGBA"
    dark.blend_type = "MULTIPLY"
    nt.links.new(split.outputs[1], dark.inputs[0])
    nt.links.new(mix.outputs[2], dark.inputs[6])
    dark.inputs[7].default_value = (MARK, MARK, MARK, 1)
    nt.links.new(dark.outputs[2], p.inputs["Base Color"])
    return m


def swimmer(name, swim, keep=False):
    """The body named, alone, painted in the kind's colours."""
    objs = import_glb(os.path.join(ART, "life", "swimmers.glb"))
    body = objs[name]
    body.parent = None
    for o in objs.values():
        if o is not body and not keep:
            bpy.data.objects.remove(o, do_unlink=True)
    body.data.materials.clear()
    body.data.materials.append(colour_material("glyph-" + name, swim["back"], swim["belly"]))
    return body


def turn(o, pitch=0.0, roll=0.0, yaw=0.0):
    """Turns an object: its nose up by pitch, rolled to starboard by roll,
    turned to port by yaw (degrees)."""
    o.rotation_mode = "XYZ"
    o.matrix_world = Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Rotation(math.radians(pitch), 4, "X") \
        @ Matrix.Rotation(math.radians(roll), 4, "Y") @ o.matrix_world
    bpy.context.view_layer.update()


# How each swimmer is turned and seen: (pitch, roll, yaw), (azimuth,
# elevation, roll of the view).
SWIMMERS = {
    "dolphin": ((6, 0, 0), (15, 14, 0)),
    "turtle": ((0, 0, 0), (35, 42, 0)),
    "tarpon": ((0, 0, 0), (10, 10, 0)),
    "flyingfish": ((0, 0, 0), (20, 42, 0)),
    "humpback": ((0, 0, 0), (20, 26, 0)),
    "sperm": ((0, 0, 0), (12, 14, 0)),
    "pilot": ((0, 0, 0), (12, 14, 0)),
    "ray": ((0, 0, 0), (40, 50, 0)),
    "shark": ((0, 0, 0), (15, 14, 0)),
    "booby": ((0, 0, 0), (0, 6, 0)),
}
# Each dolphin as its kind swims: the bottlenose rolling over a wave, the
# spinner mid-leap and turning.
DOLPHINS = {
    "spotted-dolphin": (6, 0, 0),
    "bottlenose-dolphin": (-10, 0, 0),
    "spinner-dolphin": (38, 55, 0),
}


def subject_swimmer(kind):
    swim = kind["swim"]
    body = swimmer(swim["body"], swim)
    pose, view = SWIMMERS.get(swim["body"], ((0, 0, 0), (15, 14, 0)))
    pose = DOLPHINS.get(kind["id"], pose)
    turn(body, *pose)
    return View(*view)


def subject_bait(kind, catalog):
    """A ball of small fish circling: the tarpon's body, many times over, in
    rings about the vertical, each a little out of line."""
    rng = np.random.default_rng(7)
    fish = next(k for k in catalog["life"]["kinds"] if k.get("swim", {}).get("body") == "tarpon")["swim"]
    first = swimmer("tarpon", fish)
    first.hide_render = True
    length = 1.5
    size = 0.3 / length
    n = 0
    for lat, count in ((-42, 5), (-12, 7), (18, 7), (46, 4)):
        for i in range(count):
            lon = 2 * math.pi * (i + rng.uniform(-0.2, 0.2)) / count
            radius = 0.55 * math.cos(math.radians(lat))
            o = bpy.data.objects.new(f"bait-{n:02d}", first.data)
            bpy.context.scene.collection.objects.link(o)
            o.matrix_world = Matrix.Translation((radius * math.cos(lon), radius * math.sin(lon), 0.55 * math.sin(math.radians(lat))
                                                 + rng.uniform(-0.04, 0.04))) \
                @ Matrix.Rotation(lon + rng.uniform(-0.25, 0.25), 4, "Z") @ Matrix.Rotation(rng.uniform(-0.3, 0.3), 4, "X") \
                @ Matrix.Diagonal((size, size, size, 1))
            n += 1
    bpy.data.objects.remove(first, do_unlink=True)
    bpy.context.view_layer.update()
    return View(20, 18)


# The bird of the game (client/src/render/birds.ts, its #make): a unit
# span, x across the wings, y up, z from the tail (+) to the bill (-); each
# triangle its corners, each corner's share out along the wing, and its
# part: 0 the body, 1 a wing, 2 a tip.
def bird_triangles():
    tris = [
        ([0, 0, -0.35], [0.06, 0, 0.1], [-0.06, 0, 0.1], [0, 0, 0], 0),
        ([-0.06, 0, 0.1], [0.06, 0, 0.1], [0, 0, 0.3], [0, 0, 0], 0),
    ]
    for side in (1, -1):
        tris.append(([0.05 * side, 0, -0.1], [0.3 * side, 0, -0.06], [0.05 * side, 0, 0.08], [0.1, 0.6, 0.1], 1))
        tris.append(([0.3 * side, 0, -0.06], [0.3 * side, 0, 0.06], [0.05 * side, 0, 0.08], [0.6, 0.6, 0.1], 1))
        tris.append(([0.3 * side, 0, -0.06], [0.5 * side, 0, 0.02], [0.3 * side, 0, 0.06], [0.6, 1, 0.6], 2))
    return tris


def subject_bird(kind):
    """The game's bird at its kind's span, its wings raised as the game
    raises them mid-beat (the share out times 0.35 of the span), as far as
    the kind flaps rather than glides; seen from below and ahead."""
    look = kind["look"]
    span = look["span"]
    beat = 0.85 * (1 - look["glide"])
    verts, faces, parts = [], [], []
    for a, b, c, out, part in bird_triangles():
        face = []
        for p, s in zip((a, b, c), out):
            x, y, z = (q * span for q in p)
            y += beat * s * span * 0.35
            # The game's frame to Blender's: -z (the bill) to +y, y up to +z.
            verts.append((x, -z, y))
            face.append(len(verts) - 1)
        faces.append(face)
        parts.append(part)
    me = bpy.data.meshes.new(kind["id"])
    me.from_pydata(verts, [], faces)
    for name, colour in (("body", look["body"]), ("wing", look["wing"]), ("tip", look["tip"])):
        m = bpy.data.materials.new(f"{kind['id']}-{name}")
        principled(m).inputs["Base Color"].default_value = (*linear(colour), 1)
        me.materials.append(m)
    for poly, part in zip(me.polygons, parts):
        poly.material_index = part
    o = bpy.data.objects.new(kind["id"], me)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.update()
    return View(90, -35)


# Materials too fine to draw at a glyph's size: a boat's ropes (her
# shrouds and stays, sheets and wires) would be lines as thick as her mast.
UNDRAWN = ("rope",)
# Parts of a boat the glyph leaves out: the downwind sail (in its bag), the
# trapeze's crew wires, the telltales.
HIDDEN = ("kite", "telltales", "trapeze-crew-port", "trapeze-crew-starboard")
# A square-rigged ship's yards are braced round this far, so her square
# sails face the camera.
BRACE = -28


def subject_boat(boat):
    objs = import_glb(os.path.join(ART, boat["art"]["model"]))
    for name, o in objs.items():
        if name in HIDDEN or any(p.name in HIDDEN for p in parents(o)):
            o.hide_render = True
        if name.endswith("-yards") and o.parent and o.parent.name == "boat":
            o.matrix_world = Matrix.Translation(o.matrix_world.translation) @ Matrix.Rotation(math.radians(BRACE), 4, "Z") \
                @ Matrix.Translation(-o.matrix_world.translation) @ o.matrix_world
    bpy.context.view_layer.update()
    return View(*[float(v) for v in os.environ.get("BV", "40,22").split(",")])


def parents(o):
    while o.parent:
        o = o.parent
        yield o


# --- The glowing water, drawn ----------------------------------------------------


# The breaking wave the glowing water is drawn as: its outline, in shares
# of the square (y down), from the sea's foot at the left up its back to
# the crest, round the curl and its lip, down the face and out to the
# right.
WAVE = (
    (0.03, 0.88), (0.03, 0.70), (0.14, 0.64), (0.27, 0.56), (0.39, 0.45), (0.49, 0.32),
    (0.58, 0.22), (0.68, 0.16), (0.78, 0.17), (0.87, 0.23), (0.92, 0.32), (0.90, 0.40),
    (0.84, 0.43), (0.79, 0.40), (0.79, 0.34), (0.83, 0.31), (0.78, 0.27), (0.71, 0.28),
    (0.65, 0.35), (0.63, 0.46), (0.67, 0.57), (0.76, 0.63), (0.87, 0.66), (0.97, 0.67),
    (0.97, 0.88),
)
# Sparks over the water: their middles and reach.
SPARKS = ((0.17, 0.33, 0.075), (0.33, 0.17, 0.06), (0.09, 0.12, 0.045))


def inside(poly, x, y):
    """Whether each point is inside the outline (even-odd)."""
    out = np.zeros(x.shape, bool)
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        if y0 == y1:
            continue
        crosses = (y0 > y) != (y1 > y)
        at = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        out ^= crosses & (x < at)
    return out


def glowing_water():
    """The night sea, a wave breaking alight: the water dark in close
    lines, crossed; the crest and the face under the curl a band of paper
    stippled with light; sparks over the water. At the drawing's size; no
    model."""
    n = SIZE * K
    y, x = (np.mgrid[0:n, 0:n].astype(np.float64) + 0.5) / n
    rng = np.random.default_rng(11)
    cover = inside(WAVE, x, y)
    # The crest: the water within a band of its top.
    band = int(0.075 * n)
    above = np.zeros_like(cover)
    above[band:] = cover[:-band]
    crest = cover & ~above
    # The dark water, at the glyph's size: two rows in three, crossed.
    row, col = np.mgrid[0:SIZE, 0:SIZE]
    dark = (row % PERIOD != 0) | ((col + row // 3) % PERIOD == 0)
    hatch = dark & ~(downsample(crest.astype(np.float32), K) >= 0.5)
    # The light: specks of ink in the crest, one in a few of the glyph's
    # pixels.
    specks = np.kron(rng.random((SIZE, SIZE)) < 0.2, np.ones((K, K), bool))
    lines = crest & specks
    for cx, cy, r in SPARKS:
        star = np.sqrt(np.abs(x - cx)) + np.sqrt(np.abs(y - cy)) < math.sqrt(r)
        lines |= star
        cover |= star
    return (lines & cover) | outline(inside(WAVE, x, y)), cover, hatch


# --- The run -------------------------------------------------------------------------


def subjects(catalog):
    """Every kind to draw: its id and what draws it."""
    out = []
    for kind in catalog["life"]["kinds"]:
        if kind["form"] == "glow":
            out.append((kind["id"], None))
        elif kind["form"] == "bait":
            out.append((kind["id"], lambda k=kind: subject_bait(k, catalog)))
        elif kind.get("swim"):
            out.append((kind["id"], lambda k=kind: subject_swimmer(k)))
        elif kind["form"] == "bird":
            out.append((kind["id"], lambda k=kind: subject_bird(k)))
        else:
            raise SystemExit(f"glyphs: no way to draw {kind['id']} ({kind['form']})")
    for boat in catalog["boats"]:
        out.append((boat["id"], lambda b=boat: subject_boat(b)))
    return out


def main():
    with open(CATALOG, encoding="utf8") as f:
        catalog = json.load(f)
    only = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    setup()
    total = 0
    start = time.time()
    for name, make in subjects(catalog):
        if only and name not in only:
            continue
        t = time.time()
        empty_scene()
        if make is None:
            drawn = glowing_water()
        else:
            drawn = draw(make())
        size = write(glyph(*drawn, specks=make is None), os.path.join(HERE, f"{name}.webp"))
        total += size
        print(f"glyphs: {name} {size} B, {time.time() - t:.1f} s")
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"glyphs: {total / 1024:.1f} KB in all, {time.time() - start:.0f} s")


if __name__ == "__main__":
    main()
