# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The face: the eyes, the lashes, and what is painted on the skin.

The eyes are MPFB's eyeball helpers on the shaped body, their front kept
(the back is inside the skull), each on its eye bone, painted by a shader
of our own: a warm sclera darkening to the corners, an iris graded from
its centre with a dark limbal ring, the pupil, and a catchlight high on
the side the light comes from. The lashes are the upper lash helper,
collapsed to a strip and drawn opaque on the upper lid's bone.

The skin is painted where the atlas is baked, by shader nodes evaluated at
each texel's place on the body at rest, so the paint is as sharp as the
atlas allows, whatever the mesh: the lips (MPFB's lip mask, in the base
mesh's UVs), blush on the cheeks and the tip of the nose, a tint on the
lids, the lash line along both lids, and the brows, an arch above each eye
through three points (inner end, peak, tail) each with its thickness. The
skin's paint is relative to the skin's own colour, so it holds at every
tone (the game multiplies the skin's grey by twice the tone chosen); the
brows are painted into the hair's region of the mask, so they take the
hair's colour.

Everything is placed from the eyes: their centres and radius, measured
from the helpers.
"""

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import atlas
import body
import lod
import mpfbx

# The UV map the painters read: the base mesh's own on the skin, the
# eye's front projected on the eyes. Dropped once the atlas is baked.
PAINT = "paint"


class Eyes:
    """Where the eyes are: each side's centre and the eyes' radius."""

    def __init__(self, human):
        co = body.coords(human)
        self.centre = {}
        radii = []
        for side in ("l", "r"):
            pts = co[body.in_group(human, f"helper-{side}-eye")]
            c = (pts.min(0) + pts.max(0)) / 2
            self.centre[side] = c
            radii.append(float(np.ptp(pts[:, 0])) / 2)
        self.radius = float(np.mean(radii))


def make(spec, human, arm, budget):
    """The eyes and, if the face asks for them, the lashes: meshes skinned
    to their bones and painted, ready for the atlas."""
    where = Eyes(human)
    out = [eyes(human, arm, where, spec)]
    if spec.get("lashes"):
        out.append(lashes(human, arm, spec["lashes"], budget))
    return out, where


def _helper(human, groups, name):
    """A new mesh of the faces wholly in the helpers' groups."""
    masks = [body.in_group(human, g) for g in groups]
    keep = np.logical_or.reduce(masks)
    bm = bmesh.new()
    bm.from_mesh(human.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context="VERTS")
    for g in list(bm.verts.layers.deform):
        bm.verts.layers.deform.remove(g)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for layer in list(me.uv_layers):
        me.uv_layers.remove(layer)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def eyes(human, arm, where, spec):
    """Both eyeballs' fronts, each on its bone, a projection of the front
    as the paint's UVs (the centre the pupil, a radius of 0.5 the eye's)."""
    obj = _helper(human, ("helper-l-eye", "helper-r-eye"), "eyes")
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    r = where.radius

    def side(co):
        return "l" if co.x > 0 else "r"

    # The back of the ball is inside the head, and its sides under the
    # lids: only its front is kept (seen from the front, its UVs do not
    # fold).
    gone = [f for f in bm.faces
            if f.calc_center_median().y > where.centre[side(f.calc_center_median())][1] - 0.1 * r]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    uv = bm.loops.layers.uv.new(PAINT)
    for f in bm.faces:
        for lp in f.loops:
            c = where.centre[side(lp.vert.co)]
            lp[uv].uv = (0.5 + (lp.vert.co.x - c[0]) / (2 * r), 0.5 + (lp.vert.co.z - c[2]) / (2 * r))
    for f in bm.faces:
        f.smooth = True
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    _on_bones(obj, arm, lambda co: f"eye_{side(co)}")
    mat = atlas.part(bpy.data.materials.new("eye"), (0.5, 0.5, 0.5), "fixed")
    painters_eye(mat, spec.get("eyes") or {})
    obj.data.materials.append(mat)
    return obj


def lashes(human, arm, spec, budget):
    """The upper lashes: MPFB's upper lash helper, collapsed, opaque, on
    the upper lids' bones."""
    obj = _helper(human, ("helper-l-eyelashes-2", "helper-r-eyelashes-2"), "lashes")
    for p in obj.data.polygons:
        p.use_smooth = True
    lod.decimate(obj, spec.get("triangles", 60))
    _on_bones(obj, arm, lambda co: f"lid_upper_{'l' if co.x > 0 else 'r'}")
    obj.data.materials.append(atlas.part(bpy.data.materials.new("lashes"), atlas.linear(spec["colour"]), "fixed"))
    return obj


def _on_bones(obj, arm, bone_of):
    """Weights each vertex wholly to the bone bone_of(its place) names."""
    groups = {}
    for v in obj.data.vertices:
        name = bone_of(v.co)
        if name not in groups:
            groups[name] = obj.vertex_groups.new(name=name)
        groups[name].add([v.index], 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm


# --- Painting ------------------------------------------------------------

# What each painted material paints with, by its name.
_PAINT = {}


def painters_eye(mat, p):
    _PAINT[mat.name] = ("eye", p)
    mat["part_painter"] = "face"


def paint_skin_uv(skin):
    """Gives the skin, before the atlas takes its UVs, a copy of the base
    mesh's: the lip mask is in them."""
    me = skin.data
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[0].data.foreach_get("uv", uv)
    me.uv_layers.new(name=PAINT).data.foreach_set("uv", uv)


def paint_skin(mat, where, p):
    """Marks the skin's material to be painted: the lips, blush, lids, lash
    line and brows."""
    skin = next(o for o in bpy.data.objects if o.type == "MESH" and mat.name in o.data.materials)
    _PAINT[mat.name] = ("skin", {"p": p, "where": where, "nose": _nose_tip(skin, where)})
    mat["part_painter"] = "face"


def _nose_tip(skin, where):
    """The nose's tip: the furthest forward point of the skin between and
    below the eyes."""
    co = body.coords(skin)
    cz = where.centre["l"][2]
    near = co[(np.abs(co[:, 0]) < 0.01) & (co[:, 2] < cz) & (co[:, 2] > cz - 0.06)]
    return near[int(np.argmin(near[:, 1]))]


def painter(nt, material, what):
    """The colour a painted material emits for a bake (atlas.PAINTERS):
    "colour" its base colour in linear values, "mask" its regions."""
    kind, p = _PAINT[material.name]
    ex = Expr(nt)
    if kind == "eye":
        return _eye(ex, p, what)
    return _skin(ex, p, what)


def _eye(ex, p, what):
    if what == "mask":
        return ex.rgb(0, 0, 0)
    u, v = ex.uv(PAINT)
    du, dv = u - 0.5, v - 0.5
    rho = (du * du + dv * dv).sqrt() * 2
    iris_r = p.get("iris", 0.42)
    pupil_r = p.get("pupil", 0.15)
    inner, outer = _lin(p.get("iris-inner", "#7A8A52")), _lin(p.get("iris-outer", "#3B4A2C"))
    limbal = _lin(p.get("limbal", "#120A05"))
    sclera, edge = _lin(p.get("sclera", "#E2D9CF")), _lin(p.get("sclera-edge", "#A88A7C"))
    # The sclera, darker toward the corners and under the lids.
    s = ex.smooth(iris_r * 1.1, 1.0, rho)
    col = ex.mix(ex.rgb(*sclera), ex.rgb(*edge), s * 0.85)
    # The iris: graded out from the pupil, a dark ring at its edge, and
    # faint spokes.
    t = ex.smooth(pupil_r, iris_r, rho)
    angle = ex.atan2(dv, du)
    spokes = (angle * 37).sin() * 0.5 + 0.5
    iris = ex.mix(ex.rgb(*inner), ex.rgb(*outer), t ** 1.2)
    iris = iris * (spokes * 0.18 + 0.91)
    iris = ex.mix(iris, ex.rgb(*limbal), ex.smooth(iris_r * 0.78, iris_r, rho) * 0.9)
    col = ex.mix(col, iris, 1 - ex.smooth(iris_r * 0.98, iris_r * 1.04, rho))
    # The pupil.
    col = ex.mix(col, ex.rgb(0.004, 0.003, 0.003), 1 - ex.smooth(pupil_r * 0.85, pupil_r * 1.1, rho))
    # The catchlight: a soft spot high on the light's side.
    cx, cy, size = p.get("catchlight", [-0.2, 0.22, 0.06])
    dc = ((du - cx / 2) ** 2 + (dv - cy / 2) ** 2).sqrt() * 2
    col = ex.mix(col, ex.rgb(0.9, 0.9, 0.88), (1 - ex.smooth(size * 0.5, size, dc)) * 0.9)
    return col


def _skin(ex, q, what):
    p, where, nose = q["p"], q["where"], q["nose"]
    x, y, z = ex.position()
    ax = x.abs()
    cx, cy, cz = where.centre["l"]
    r = where.radius
    front = 1 - ex.smooth(cy - 0.004, cy + 0.012, y)

    # The brows: an arch above each eye through three points, outward from
    # the eye's middle, each (out, up, thickness).
    b = p["brow"]
    pts = np.array([b["inner"], b["peak"], b["tail"]])
    arch = ex.poly(ax - cx, pts[:, 0], pts[:, 1]) + cz
    thick = ex.poly(ax - cx, pts[:, 0], pts[:, 2])
    off = (z - arch).abs()
    edge = b.get("soft", 0.4)
    brow = 1 - ex.smooth(thick * (0.5 - edge / 2), thick * 0.5 + 0.0006, off)
    along = ex.smooth(pts[0, 0] - 0.002, pts[0, 0] + 0.004, ax - cx) * (1 - ex.smooth(pts[2, 0] - 0.004, pts[2, 0] + 0.0008, ax - cx))
    # Sparser at the inner end.
    density = ex.smooth(pts[0, 0], pts[1, 0], ax - cx) * (1 - b.get("inner-density", 0.6)) + b.get("inner-density", 0.6)
    brow = brow * along * density * front * b.get("amount", 1.0)

    if what == "mask":
        return ex.combine(0, 1 - brow, brow)

    skin_ref = np.array(_lin(p.get("reference", "#D9AE90")))

    def ratio(hexc):
        return tuple(float(c) for c in np.array(_lin(hexc)) / skin_ref)

    col = ex.rgb(atlas.NEUTRAL, atlas.NEUTRAL, atlas.NEUTRAL)
    # Blush on the cheekbones and the tip of the nose.
    bl = p["blush"]
    dx = ax - (cx + bl.get("out", 0.006))
    dz = z - (cz + bl.get("down", -0.024))
    sigma = bl.get("size", 0.016)
    cheek = ex.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma)) * front
    nx, nz = x - float(nose[0]), z - float(nose[2])
    ns = bl.get("nose-size", 0.008)
    tip = ex.exp(-(nx * nx + nz * nz) / (2 * ns * ns)) * front * bl.get("nose", 0.6)
    col = col * ex.mix(ex.rgb(1, 1, 1), ex.rgb(*ratio(bl["colour"])), (cheek + tip).clamp() * bl.get("amount", 0.25))
    # The lids: a tint over the eye's ball, below the brow.
    d = ((x.abs() - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2).sqrt()
    lid = p["lid"]
    upper = ex.smooth(cz - 0.002, cz + 0.004, z)
    over = (1 - ex.smooth(r + 0.004, r + 0.009, d)) * upper * front
    col = col * ex.mix(ex.rgb(1, 1, 1), ex.rgb(*ratio(lid["colour"])), over * lid.get("amount", 0.2))
    # The lash line: the lids' edges where they meet the ball, the upper
    # heavier and widening outward.
    ll = p["lash-line"]
    out = ex.smooth(0.0, r * 0.9, x.abs() - cx)
    width = ll.get("width", 0.0016) * (out * ll.get("flare", 0.6) + 1)
    rim = 1 - ex.smooth(r + 0.0004, r + 0.0004 + width, d)
    line_up = rim * ex.smooth(cz - 0.003, cz + 0.001, z) * front
    line_low = rim * (1 - ex.smooth(cz - 0.003, cz + 0.001, z)) * front * ll.get("lower", 0.35)
    dark = (line_up + line_low).clamp() * ll.get("amount", 0.85)
    col = col * ex.mix(ex.rgb(1, 1, 1), ex.rgb(*[ll.get("value", 0.12)] * 3), dark)
    # The lips, by MPFB's mask in the base mesh's UVs.
    lips = ex.image(mpfbx.data("textures", "mpfb_lips.jpg"), PAINT)
    col = col * ex.mix(ex.rgb(1, 1, 1), ex.rgb(*ratio(p["lip"]["colour"])), lips * p["lip"].get("amount", 0.8))
    # Under the brows, the base the hair's region multiplies.
    col = ex.mix(col, ex.rgb(*[atlas.NEUTRAL * b.get("value", 0.85)] * 3), brow)
    return col


def _lin(hex_colour):
    return atlas.linear(hex_colour)


# --- Shader expressions --------------------------------------------------


class Expr:
    """Shader nodes written as arithmetic: an Expr makes the nodes, its
    values (Val) combine by the usual operators into Math and Mix nodes."""

    def __init__(self, nt):
        self.nt = nt

    def node(self, kind, **kw):
        n = self.nt.nodes.new(kind)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def val(self, x):
        if isinstance(x, Val):
            return x
        n = self.node("ShaderNodeValue")
        n.outputs[0].default_value = float(x)
        return Val(self, n.outputs[0])

    def math(self, op, a, b=None, c=None):
        n = self.node("ShaderNodeMath", operation=op)
        for i, x in enumerate((a, b, c)):
            if x is None:
                continue
            if isinstance(x, Val):
                self.nt.links.new(x.s, n.inputs[i])
            else:
                n.inputs[i].default_value = float(x)
        return Val(self, n.outputs[0])

    def smooth(self, e0, e1, x):
        """smoothstep(e0, e1, x), clamped."""
        n = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP", clamp=True)
        for i, v in ((0, x), (1, e0), (2, e1)):
            if isinstance(v, Val):
                self.nt.links.new(v.s, n.inputs[i])
            else:
                n.inputs[i].default_value = float(v)
        n.inputs[3].default_value = 0.0
        n.inputs[4].default_value = 1.0
        return Val(self, n.outputs[0])

    def exp(self, x):
        return self.math("EXPONENT", x)

    def atan2(self, a, b):
        return self.math("ARCTAN2", a, b)

    def poly(self, x, xs, ys):
        """The parabola through three points (xs, ys), at x."""
        a, b, c = np.polyfit(np.asarray(xs, float), np.asarray(ys, float), 2)
        return (x * float(a) + float(b)) * x + float(c)

    def position(self):
        tc = self.node("ShaderNodeTexCoord")
        sep = self.node("ShaderNodeSeparateXYZ")
        self.nt.links.new(tc.outputs["Object"], sep.inputs[0])
        return tuple(Val(self, sep.outputs[i]) for i in range(3))

    def uv(self, name):
        n = self.node("ShaderNodeUVMap", uv_map=name)
        sep = self.node("ShaderNodeSeparateXYZ")
        self.nt.links.new(n.outputs[0], sep.inputs[0])
        return Val(self, sep.outputs[0]), Val(self, sep.outputs[1])

    def image(self, path, uv_map):
        n = self.node("ShaderNodeTexImage")
        n.image = bpy.data.images.load(path, check_existing=True)
        n.image.colorspace_settings.name = "Non-Color"
        uvn = self.node("ShaderNodeUVMap", uv_map=uv_map)
        self.nt.links.new(uvn.outputs[0], n.inputs["Vector"])
        sep = self.node("ShaderNodeSeparateColor")
        self.nt.links.new(n.outputs["Color"], sep.inputs[0])
        return Val(self, sep.outputs[0])

    def rgb(self, r, g, b):
        return Col(self, tuple(self.val(c) if isinstance(c, Val) else float(c) for c in (r, g, b)))

    def combine(self, r, g, b):
        return Col(self, (r, g, b))

    def mix(self, a, b, t):
        """a toward b by t, channel by channel, for colours or values."""
        if isinstance(a, Col) or isinstance(b, Col):
            a, b = self._col(a), self._col(b)
            return Col(self, tuple(ca + (cb - ca) * t if isinstance(ca, Val) or isinstance(cb, Val) or isinstance(t, Val)
                                   else ca + (cb - ca) * t for ca, cb in zip(a.c, b.c)))
        return a + (b - a) * t

    def _col(self, c):
        return c if isinstance(c, Col) else Col(self, (c, c, c))


class Val:
    """A float socket, with arithmetic."""

    def __init__(self, ex, socket):
        self.ex, self.s = ex, socket

    def _op(self, op, other, swap=False):
        if isinstance(other, Col):
            return NotImplemented
        a, b = (other, self) if swap else (self, other)
        return self.ex.math(op, a, b)

    def __add__(self, o):
        return self._op("ADD", o)

    def __radd__(self, o):
        return self._op("ADD", o, True)

    def __sub__(self, o):
        return self._op("SUBTRACT", o)

    def __rsub__(self, o):
        return self._op("SUBTRACT", o, True)

    def __mul__(self, o):
        return self._op("MULTIPLY", o)

    def __rmul__(self, o):
        return self._op("MULTIPLY", o, True)

    def __truediv__(self, o):
        return self._op("DIVIDE", o)

    def __rtruediv__(self, o):
        return self._op("DIVIDE", o, True)

    def __pow__(self, o):
        return self._op("POWER", o)

    def __neg__(self):
        return self.ex.math("MULTIPLY", self, -1.0)

    def abs(self):
        return self.ex.math("ABSOLUTE", self)

    def sqrt(self):
        return self.ex.math("SQRT", self)

    def sin(self):
        return self.ex.math("SINE", self)

    def clamp(self):
        return self.ex.math("MINIMUM", self.ex.math("MAXIMUM", self, 0.0), 1.0)


class Col:
    """A colour as three channels, each a Val or a float."""

    def __init__(self, ex, c):
        self.ex, self.c = ex, tuple(c)

    def __mul__(self, o):
        if isinstance(o, Col):
            return Col(self.ex, tuple(_m(a, b) for a, b in zip(self.c, o.c)))
        return Col(self.ex, tuple(_m(a, o) for a in self.c))

    __rmul__ = __mul__

    def __pow__(self, o):
        return Col(self.ex, tuple(a ** o for a in self.c))

    def socket(self):
        """The colour as one socket, for the emission's input."""
        n = self.ex.node("ShaderNodeCombineColor")
        for i, a in enumerate(self.c):
            if isinstance(a, Val):
                self.ex.nt.links.new(a.s, n.inputs[i])
            else:
                n.inputs[i].default_value = float(a)
        return n.outputs[0]


def _m(a, b):
    if isinstance(a, Val) or isinstance(b, Val):
        return (a if isinstance(a, Val) else b) * (b if isinstance(a, Val) else a)
    return a * b


atlas.PAINTERS["face"] = painter


def close_mouth(skin):
    """Drops the mouth's inside (the lips' inner faces and the cavity
    behind them), which the closed lips hide and whose base mesh UVs lie
    over others' in the atlas. Returns how many faces went."""
    lips = _LIPS.get(skin.name)
    if lips is None:
        return 0
    # Inside the mouth: behind the lips' front, facing the cavity's middle.
    cavity = lips + Vector((0, 0.045, 0))
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bm.normal_update()
    gone = []
    for f in bm.faces:
        c = f.calc_center_median()
        if abs(c.x) > 0.04 or abs(c.z - lips.z) > 0.035 or c.y < lips.y + 0.002:
            continue
        if f.normal.dot(cavity - c) > 0:
            gone.append(f)
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(skin.data)
    bm.free()
    skin.data.update()
    return len(gone)


# The lips' front middle point, by the skin's name (set by lips_at).
_LIPS = {}


def lips_at(skin, marks):
    """Finds and keeps the lips' front middle point: on the face's front,
    about 6.5 cm below the eyes."""
    co = body.coords(skin)
    eyes = (marks.joint("l-eye") + marks.joint("r-eye")) / 2
    z = eyes[2] - 0.065
    near = co[(np.abs(co[:, 0]) < 0.004) & (np.abs(co[:, 2] - z) < 0.01) & (co[:, 1] < eyes[1])]
    if len(near):
        _LIPS[skin.name] = Vector((0.0, float(near[:, 1].min()), z))
