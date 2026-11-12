# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The review sheet: one fixed layout of named views, for every build.

A picture is judged by questions answered from named views (rubric.md),
never by "does it look good": so the views are always the same, always
named, and include what settled misreadings before (the top view, the
profile). Drawn by Workbench, which renders a frame in milliseconds
without a window, onto one PNG a version (sheet.png in the run), with the
previous run's sheet beside it (compare.png):

- the look at rest, orthographic: front, side, back, top; three-quarter;
  the face close;
- wireframe, normals (as colours), a UV checker;
- the poke-through map: what came through the clothes, in red, in the
  pose where most did;
- the posed set: every test pose, the seated ones in the boat;
- the whole boat, the figure seated at the helm: abeam, from the quarter,
  from astern, and the seat close from astern, to see its scale and its
  seat;
- the game's camera, behind and above, at 64 pixels;
- the silhouettes of every look built, in black at that size.

Each clip gets its strips: frames across it from the front, the side
(the figure's left), the profile (its right) and the top, and beneath
them the curves of every chain, each joint's speed through the clip.
"""

import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

import motion

PANEL = 256
GAME = 64
BACKGROUND = (0.86, 0.86, 0.84)
INK = (0.12, 0.12, 0.14)
RED = (0.85, 0.1, 0.08)
# The chase camera's resting view (client/src/render/camera.ts): from
# astern, elevation and distance, looking at a point this high over the
# boat.
CHASE = {"elevation": 0.3, "distance": 16.0, "look": 1.8}
# The views of the figure: where the camera stands, in the figure's own
# axes (x its left, y back, z up), looking at it.
VIEWS = {
    "front": (0, -1, 0),
    "side": (1, 0, 0),
    "profile": (-1, 0, 0),
    "back": (0, 1, 0),
    "top": (0, 0, 1),
    "three-quarter": (0.7, -0.7, 0.3),
}


class Renderer:
    """Workbench, a camera, and renders into arrays."""

    def __init__(self, work):
        self.work = work
        scene = bpy.context.scene
        self.saved = scene.render.engine
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.render.film_transparent = True
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.show_shadows = False
        scene.display.shading.show_cavity = False
        scene.view_settings.view_transform = "Standard"
        cam = bpy.data.cameras.new("review")
        self.cam = bpy.data.objects.new("review", cam)
        scene.collection.objects.link(self.cam)
        scene.camera = self.cam
        self.path = os.path.join(work, "view.png")

    def close(self):
        scene = bpy.context.scene
        scene.render.engine = self.saved
        scene.render.film_transparent = False
        bpy.data.objects.remove(self.cam, do_unlink=True)

    def look_at(self, centre, direction, scale, size, ortho=True, up=(0, 0, 1)):
        """Stands the camera along direction from centre, framing scale
        metres (ortho) or, perspective, (angle, distance); up is the
        frame's up."""
        cam = self.cam.data
        d = Vector(direction).normalized()
        cam.type = "ORTHO" if ortho else "PERSP"
        if ortho:
            cam.ortho_scale = scale
            dist = 10.0
        else:
            cam.angle, dist = scale
        cam.clip_start, cam.clip_end = 0.01, 100.0
        self.distance = dist
        u = Vector(up).normalized()
        if abs(d.dot(u)) > 0.99:
            u = Vector((0, 1, 0))
        x = u.cross(d).normalized()
        y = d.cross(x)
        rot = Matrix((x, y, d)).transposed()
        self.cam.matrix_world = Matrix.Translation(Vector(centre) + d * dist) @ rot.to_4x4()
        scene = bpy.context.scene
        scene.render.resolution_x = scene.render.resolution_y = size
        scene.render.resolution_percentage = 100

    def render(self, colour="TEXTURE", light="STUDIO", single=(0.8, 0.8, 0.8)):
        scene = bpy.context.scene
        sh = scene.display.shading
        sh.color_type = colour
        sh.light = light
        sh.single_color = single
        scene.render.filepath = self.path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(self.path)
        px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
        img.pixels.foreach_get(px)
        out = px.reshape(img.size[1], img.size[0], 4)[::-1].copy()
        bpy.data.images.remove(img)
        return out


def flatten(rgba, background=BACKGROUND):
    a = rgba[..., 3:4]
    return rgba[..., :3] * a + np.array(background) * (1 - a)


def bounds(points):
    p = np.asarray(points)
    lo, hi = p.min(0), p.max(0)
    return (lo + hi) / 2, float((hi - lo).max())


def figure_points(fig):
    pts = [motion.coords_posed(o)[0] for o in fig.meshes if not o.hide_render]
    return np.concatenate(pts)


def turned(fig, v):
    """A direction in the figure's axes, in the boat's."""
    return fig.arm.matrix_world.to_quaternion() @ Vector(v)


def view(fig, name):
    """A named view's direction and up, as the figure stands: from above,
    its back at the top of the frame."""
    up = turned(fig, (0, 1, 0)) if name == "top" else Vector((0, 0, 1))
    return turned(fig, VIEWS[name]), up


# --- Colours ------------------------------------------------------------


def recoloured(base, mask, palette):
    """The atlas as the game would show it with the palette: each option
    region × 2 × its colour, in linear light. A machine's palette has no
    hair: its blue is its lamps, in their own colour."""
    import atlas

    lin = np.where(base[..., :3] <= 0.04045, base[..., :3] / 12.92, ((base[..., :3] + 0.055) / 1.055) ** 2.4)
    out = lin.copy()
    for ch, region in enumerate(("main", "skin", "hair")):
        if region not in palette:
            continue
        c = np.array(atlas.linear(palette[region]))
        m = mask[..., ch:ch + 1]
        out = out * (1 - m) + np.clip(lin * 2 * c, 0, 1) * m
    img = np.ones(base.shape, np.float32)
    img[..., :3] = out
    return img


class Look:
    """Temporary materials for the views: the look, a checker, plain."""

    def __init__(self, meshes, base, mask, palette):
        self.meshes = meshes
        self.saved = {o.name: list(o.data.materials) for o in meshes}
        size = base.shape[0]
        self.image = bpy.data.images.new("review-look", size, size, alpha=True, float_buffer=True)
        self.image.colorspace_settings.name = "Linear Rec.709"
        self.image.pixels.foreach_set(np.ascontiguousarray(recoloured(base, mask, palette)).ravel())
        self.checker = bpy.data.images.new("review-checker", 1024, 1024)
        self.checker.generated_type = "COLOR_GRID"
        self.look = self._material("review-look", self.image)
        self.grid = self._material("review-checker", self.checker)
        self.wire = bpy.data.materials.new("review-wire")
        self.wire.diffuse_color = (0.08, 0.08, 0.1, 1)
        self.plain = bpy.data.materials.new("review-plain")
        self.plain.diffuse_color = (0.85, 0.85, 0.83, 1)

    def _material(self, name, image):
        m = bpy.data.materials.new(name)
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = "atlas"
        nt.links.new(uv.outputs[0], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
        nt.nodes.active = tex
        return m

    def use(self, *mats):
        for o in self.meshes:
            o.data.materials.clear()
            for m in mats:
                o.data.materials.append(m)

    def restore(self):
        for o in self.meshes:
            o.data.materials.clear()
            for m in self.saved[o.name]:
                o.data.materials.append(m)
        for img in (self.image, self.checker):
            bpy.data.images.remove(img)
        for m in (self.look, self.grid, self.wire, self.plain):
            bpy.data.materials.remove(m)


def with_colours(meshes, colours):
    """A colour attribute on each mesh, per vertex (an array a mesh, or a
    function of its vertices' rest coordinates and normals)."""
    for o in meshes:
        me = o.data
        attr = me.color_attributes.get("review") or me.color_attributes.new("review", "FLOAT_COLOR", "POINT")
        c = colours(o)
        rgba = np.ones((len(me.vertices), 4), np.float32)
        rgba[:, :3] = c
        attr.data.foreach_set("color", rgba.ravel())
        me.color_attributes.active_color = attr


def drop_colours(meshes):
    for o in meshes:
        a = o.data.color_attributes.get("review")
        if a is not None:
            o.data.color_attributes.remove(a)


# --- The sheet ----------------------------------------------------------


class Sheet:
    """Named panels, laid out in rows, with their names written over."""

    def __init__(self, title):
        self.title = title
        self.rows = []

    def row(self, panels):
        self.rows.append([(name, flatten(img) if img.shape[2] == 4 else img) for name, img in panels])

    def image(self):
        pad = 8
        label = 18
        widths = [sum(p.shape[1] for _, p in r) + pad * (len(r) + 1) for r in self.rows]
        heights = [max(p.shape[0] for _, p in r) + label + pad for r in self.rows]
        w = max(widths + [400])
        h = sum(heights) + 30
        out = np.ones((h, w, 3), np.float32) * np.array([0.97, 0.97, 0.95])
        text(out, self.title, pad, 8, 2)
        y = 30
        for r, rh in zip(self.rows, heights):
            x = pad
            for name, p in r:
                text(out, name, x, y + 2, 2)
                out[y + label:y + label + p.shape[0], x:x + p.shape[1]] = p
                x += p.shape[1] + pad
            y += rh
        return out


def save(img, path):
    h, w = img.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(img[..., :3], 0, 1)
    pic = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    pic.colorspace_settings.name = "Non-Color"
    pic.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    pic.filepath_raw = path
    pic.file_format = "PNG"
    pic.save()
    bpy.data.images.remove(pic)


def load(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(px)
    out = px.reshape(img.size[1], img.size[0], 4)[::-1, :, :3].copy()
    bpy.data.images.remove(img)
    return out


def upscale(img, k):
    return np.repeat(np.repeat(img, k, axis=0), k, axis=1)


def views(r, fig, look, size=PANEL * 3 // 2):
    """The look at rest from its named sides, and the face close."""
    fig.reset()
    centre, extent = bounds(figure_points(fig))
    look.use(look.look)
    out = []
    for name in ("front", "side", "back", "top", "three-quarter"):
        d, up = view(fig, name)
        r.look_at(centre, d, extent * 1.08, size, up=up)
        out.append((name, r.render("TEXTURE")))
    head = fig.world("head").lerp(fig.world("head", "tail"), 0.5)
    r.look_at(head + Vector((0, -0.02, 0.0)), (0.25, -1, 0.05), 0.34, size)
    out.append(("face", r.render("TEXTURE")))
    return out


def faces(r, fig, look, size=2 * PANEL):
    """The head close from the front, three-quarter and in profile, with
    its hair and hat: what the picker and the portraits show."""
    fig.reset()
    look.use(look.look)
    head = fig.world("head").lerp(fig.world("head", "tail"), 0.45)
    out = []
    for name, d in (("face front", (0, -1, 0)), ("face three-quarter", (0.6, -1, 0.08)),
                    ("face profile", (1, 0, 0)), ("head behind", (0.35, 1, 0.25))):
        r.look_at(head + Vector((0, -0.01, -0.01)), d, 0.3, size)
        out.append((name, r.render("TEXTURE")))
    return out


def technical(r, fig, look, size=PANEL):
    """Wireframe, normals and the UV checker, from the front and back."""
    fig.reset()
    centre, extent = bounds(figure_points(fig))
    out = []
    mods = []
    look.use(look.plain, look.wire)
    for o in fig.meshes:
        m = o.modifiers.new("review-wire", "WIREFRAME")
        m.thickness = 0.0012
        m.use_replace = False
        m.material_offset = 1
        mods.append((o, m.name))
    r.look_at(centre, VIEWS["front"], extent * 1.08, size)
    out.append(("wireframe", r.render("MATERIAL")))
    for o, name in mods:
        o.modifiers.remove(o.modifiers[name])
    with_colours(fig.meshes, lambda o: _normals(o))
    look.use(look.plain)
    for v in ("front", "back"):
        r.look_at(centre, VIEWS[v], extent * 1.08, size)
        out.append((f"normals {v}", r.render("VERTEX", "FLAT")))
    drop_colours(fig.meshes)
    look.use(look.grid)
    for v in ("front", "back"):
        r.look_at(centre, VIEWS[v], extent * 1.08, size)
        out.append((f"uv {v}", r.render("TEXTURE")))
    return out


def _normals(o):
    no = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("normal", no)
    return no.reshape(-1, 3) * 0.5 + 0.5


def poke_map(r, fig, look, lib, maps, size=PANEL, what="poke"):
    """The figure with the vertices that came through in red (through the
    clothes, or through the boat with it shown), in the pose where most
    did (or at rest)."""
    counts = {k: sum(len(v) for v in hits.values()) for k, hits in maps.items()}
    worst = max(counts, key=counts.get) if counts and max(counts.values()) else next(iter(maps), "rest")
    if worst == "rest":
        fig.reset()
    else:
        fig.pose(lib.poses[worst])
    hits = maps.get(worst, {})
    look.use(look.plain)
    if what == "seat":
        fig.stage.show(True)

    def colour(o):
        c = np.tile(np.array([0.78, 0.78, 0.76]), (len(o.data.vertices), 1))
        for i in hits.get(o.name, []):
            c[i] = RED
        return c

    with_colours(fig.meshes, colour)
    centre, extent = bounds(figure_points(fig))
    out = []
    for v in (("front", "back") if what == "poke" else ("three-quarter", "back")):
        d, up = view(fig, v)
        r.look_at(centre, d, extent * (1.08 if what == "poke" else 1.3), size, up=up)
        out.append((f"{what} {worst} {v} {counts.get(worst, 0)}", r.render("VERTEX", "STUDIO")))
    drop_colours(fig.meshes)
    fig.stage.show(False)
    fig.reset()
    return out


def posed(r, fig, look, lib, names, size=PANEL):
    """Every test pose from three-quarters, the seated ones in the boat."""
    look.use(look.look)
    out = []
    for name in names:
        pose = lib.poses[name]
        fig.pose(pose)
        in_boat = pose["place"] is not None
        fig.stage.show(in_boat)
        centre, extent = bounds(figure_points(fig))
        r.look_at(centre, turned(fig, VIEWS["three-quarter"]), extent * 1.15, size)
        out.append((name, r.render("TEXTURE")))
    fig.stage.show(False)
    fig.reset()
    return out


def game(r, fig, look, lib, pose="seated"):
    """The game's camera behind and above the boat, the figure seated at
    the helm about GAME pixels high; and its silhouette."""
    fig.pose(lib.poses[pose])
    for o in fig.stage.objects:
        o.hide_render = o.type != "MESH"
    centre, extent = bounds(figure_points(fig))
    el = CHASE["elevation"]
    d = Vector((0, -math.cos(el), math.sin(el)))
    angle = 2 * math.atan(extent * 0.55 / CHASE["distance"])
    look.use(look.look)
    r.look_at(centre, d, (angle, CHASE["distance"]), GAME, ortho=False)
    pic = r.render("TEXTURE")
    for o in fig.stage.objects:
        o.hide_render = True
    sil = r.render("SINGLE", "FLAT", (0, 0, 0))
    fig.stage.show(False)
    fig.reset()
    return pic, sil


def boat_views(r, fig, look, lib, pose="seated", size=448):
    """The figure seated at the helm in the whole boat, to see its scale:
    the boat abeam (from the figure's side) and from the quarter, mast and
    sail and all; from astern; and the seat close from astern."""
    fig.pose(lib.poses[pose])
    shown = [o for o in fig.stage.objects if o.type == "MESH"]
    for o in shown:
        o.hide_render = False
    corners = np.array([np.array(o.matrix_world @ Vector(c)) for o in shown for c in o.bound_box])
    centre, extent = bounds(np.concatenate([corners, figure_points(fig)]))
    look.use(look.look)
    out = []
    side = 1 if fig.world("pelvis").x > 0 else -1
    for name, d in (("jolly boat abeam", (side, 0, 0.05)), ("jolly boat from the quarter", (side * 0.7, -0.7, 0.35))):
        r.look_at(centre, d, extent * 1.05, size)
        out.append((name, r.render("TEXTURE")))
    # From astern: the hull's breadth and the figure, the mast cut off.
    hull = np.array([np.array(fig.stage.solid[0].matrix_world @ Vector(c)) for c in fig.stage.solid[0].bound_box])
    body = figure_points(fig)
    lo = np.minimum(hull.min(0), body.min(0))
    hi = np.maximum(hull.max(0), body.max(0))
    mid = (lo + hi) / 2
    r.look_at(mid, (0, -1, 0), float(max(hi[0] - lo[0], hi[2] - lo[2])) * 1.1, size)
    out.append(("astern", r.render("TEXTURE")))
    hips = fig.world("pelvis")
    r.look_at(hips + Vector((0, 0, -0.1)), (0, -1, 0), 0.75, size)
    out.append(("the seat close, from astern", r.render("TEXTURE")))
    fig.stage.show(False)
    fig.reset()
    return out


# --- Strips and curves ----------------------------------------------------


def clip_sheet(r, fig, look, clip, act, slot, track, path, chains, frames=8, size=160):
    """A clip's frames from four sides, and its chains' curves beneath."""
    motion.play(fig.arm, act, slot)
    fig.arm.matrix_world = clip.place
    scene = bpy.context.scene
    n = len(clip.frames)
    picks = [round(i * (n - 1) / (frames - 1)) for i in range(frames)]
    in_boat = clip.place != Matrix()
    cat = getattr(clip, "cat", None)
    fig.stage.show(in_boat, wheel=getattr(clip, "standing", False), trapeze=getattr(clip, "trapeze", False),
                   rail=getattr(clip, "rail", False), ship=bool(getattr(clip, "ship", None)),
                   cat=("capsized" if cat == motion.CAT_STAND else "upright") if cat else None)
    look.use(look.look)
    pts = []
    for f in picks:
        scene.frame_set(f)
        pts.append(np.array([np.array(p) for p in track_points(fig)]))
    centre, extent = bounds(np.concatenate(pts))
    sheet = Sheet(f"{clip.name}: {n} frames at {clip.fps} a second, frames {', '.join(str(f) for f in picks)}")
    on_ship = bool(getattr(clip, "ship", None))
    for name in ("front", "side", "profile", "top"):
        row = []
        for f in picks:
            scene.frame_set(f)
            d, up = view(fig, name)
            r.look_at(centre, d, extent * 1.2, size, up=up)
            if on_ship:
                # Cut away what of the ship is between the camera and the
                # figure.
                r.cam.data.clip_start = r.distance - extent * 0.75
            row.append((f"{name} {f}" if f == picks[0] else str(f), r.render("TEXTURE")))
        sheet.row(row)
    fig.stage.show(False)
    motion.stop(fig.arm)
    width = (frames * (size + 8) - 8) // 3 - 6
    panels = [(name, curves(track, bones, clip.fps, width, 110)) for name, bones in chains.items()]
    sheet.row(panels[:3])
    sheet.row(panels[3:])
    save(sheet.image(), path)


def track_points(fig):
    return [fig.world(b.name) for b in fig.arm.data.bones if motion.kind(b.name) in
            ("pelvis", "head", "hand", "foot", "calf", "lowerarm", "spine_03")] + \
        [fig.world("head", "tail")]


COLOURS = [(0.85, 0.2, 0.15), (0.95, 0.6, 0.1), (0.2, 0.6, 0.2), (0.15, 0.45, 0.85), (0.5, 0.25, 0.7),
           (0.3, 0.3, 0.3)]


def curves(track, bones, fps, w, h):
    """Each joint's speed (degrees a second) through the clip, one line a
    joint, its name in its colour."""
    img = np.ones((h, w, 3), np.float32) * 0.99
    speeds = [track.speed(b, fps) for b in bones]
    top = max(max(float(s.max()) for s in speeds), 1.0)
    n = len(speeds[0])
    img[h - 12, :] = 0.6
    for k, (b, s) in enumerate(zip(bones, speeds)):
        c = COLOURS[k % len(COLOURS)]
        xs = np.linspace(0, w - 1, n)
        ys = (h - 13) - s / top * (h - 26)
        for i in range(1, n):
            _line(img, xs[i - 1], ys[i - 1], xs[i], ys[i], c)
        text(img, b, 4 + (k % 3) * (w // 3), h - 10 if k < 3 else 2, 1, c)
    text(img, f"{top:.0f}/S", w - 40, 14, 1)
    return img


def _line(img, x0, y0, x1, y1, c):
    steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    for t in np.linspace(0, 1, steps + 1):
        x, y = int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t))
        if 0 <= y < img.shape[0] and 0 <= x < img.shape[1]:
            img[y, x] = c


# --- Lettering ------------------------------------------------------------

GLYPHS = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 10001 11001 10101 10011 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 10001 01010 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    "-": "00000 00000 00000 11111 00000 00000 00000", ".": "00000 00000 00000 00000 00000 01100 01100",
    ":": "00000 01100 01100 00000 01100 01100 00000", "/": "00001 00010 00010 00100 01000 01000 10000",
    "(": "00010 00100 01000 01000 01000 00100 00010", ")": "01000 00100 00010 00010 00010 00100 01000",
    ",": "00000 00000 00000 00000 01100 00100 01000", "%": "11000 11001 00010 00100 01000 10011 00011",
    "_": "00000 00000 00000 00000 00000 00000 11111", " ": "00000 00000 00000 00000 00000 00000 00000",
}


def text(img, s, x, y, k=1, colour=INK):
    """Writes s at (x, y), top left, in the 5 × 7 letters at k times."""
    for ch in s.upper():
        g = GLYPHS.get(ch, GLYPHS[" "])
        for row, bits in enumerate(g.split()):
            for col, bit in enumerate(bits):
                if bit == "1":
                    y0, x0 = y + row * k, x + col * k
                    img[max(y0, 0):max(y0 + k, 0), max(x0, 0):max(x0 + k, 0)] = colour
        x += 6 * k
        if x > img.shape[1]:
            return
