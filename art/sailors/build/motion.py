# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The motion lab: key poses, the clips made from them, and the bake.

A pose (poses/*.yaml) is turns of bones about the figure's own axes, its
place in the boat, and targets for its hands and feet. A clip is key poses
in order, each held, joined by ramps the maker shapes as the motion study
found reads natural:

- a ramp's length scaled by the largest turn and the furthest reach in it;
- eased (smootherstep), with anticipation as a smooth bump the other way
  first (64 t³(1 − t)³: a sine's ends would jump in speed);
- each bone's ramp delayed down its chain (the hips first, the hands
  last; the head first when it leads a look), then through a lightly
  underdamped second-order filter, so the ends follow through;
- the hands on one blended IK target each, the target easing from one
  key's to the next along an arc (out and up at the middle; up and down by
  different paths), the wrist trailing on the way up and leading on the
  way down, the fingers after it;
- holds that drift, so nothing is ever still;
- two-bone IK with the poles on the chest, the targets kept within
  tables.yaml's share of the reach.

The bones of our own follow: the hip correctors turn half as far as the
thighs, the forearm twists take half the hand's twist. Everything is baked
to keys, a frame at a time at the clip's rate, by reading each bone's pose
after the IK (visual keying), into an action of its own; the clips are
exported with the skeleton alone, and only the pelvis keeps a translation.
"""

import math
import os
import subprocess

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

# The two-bone chains IK moves, by the bone at their end.
EFFECTORS = {
    "hand_l": ("upperarm_l", "lowerarm_l", "hand_l"),
    "hand_r": ("upperarm_r", "lowerarm_r", "hand_r"),
    "foot_l": ("thigh_l", "calf_l", "foot_l"),
    "foot_r": ("thigh_r", "calf_r", "foot_r"),
}

# Where each chain's pole is: a bone, and an offset along the figure's
# axes as it stands at rest (x its left, y back, z up). The elbows out,
# back and down from the chest; the knees forward of the hips.
POLES = {
    "hand_l": ("spine_03", (0.45, 0.4, -0.4)),
    "hand_r": ("spine_03", (-0.45, 0.4, -0.4)),
    "foot_l": ("pelvis", (0.1, -0.8, 0.0)),
    "foot_r": ("pelvis", (-0.1, -0.8, 0.0)),
}

# How the skirt chains follow the thighs, by the share of a thigh's turn
# (against the hips') each bone of a chain takes, upper then lower:
# negative, the other way. Seated, the front lies over the lap, the side
# half way, the back hangs down the buttocks and then lies out along the
# seat behind.
SKIRT_FOLLOW = {"front": (0.95, 0.05), "side": (0.55, 0.3), "back": (0.0, -0.9)}

# The torso, root to head: its delays turn round when the head leads.
TORSO = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head")
# Where the holds drift.
DRIFTS = ("spine_02", "spine_03", "neck_01", "head")
FINGERS = ("thumb", "index", "middle", "ring", "pinky")

# How far round the pelvis the buttocks are looked for, seating a figure,
# how far over the deck they sit, and how far in from its outer edge.
SEAT_REACH = 0.22
SEAT_EDGE = 0.03
# The vertex group and modifier that lay the skirts on the seat.
SEAT_GROUP = "seat-lift"
SEAT_CLEAR = 0.006
# How far short of the far side deck's edge an ankle stays, in the cockpit:
# the toes reach about 0.17 m past it.
COCKPIT_MARGIN = 0.25


def kind(name):
    """A bone's kind: its name without its side and number (upperarm,
    index, spine_02)."""
    for s in ("_l", "_r"):
        if name.endswith(s):
            name = name[: -len(s)]
    parts = name.split("_")
    if parts[0] in FINGERS:
        return parts[0]
    return name


def table(values, name, default=None):
    """A bone's value in a table keyed by kinds."""
    k = kind(name)
    return values.get(k, values.get(name, default))


def bump(x):
    """A smooth bump over [0, 1], 1 at the middle, its speed and
    acceleration zero at both ends."""
    x = min(max(x, 0.0), 1.0)
    return 64.0 * x ** 3 * (1 - x) ** 3


def ease(x):
    """Smootherstep: from 0 to 1 with no jump in speed or acceleration."""
    x = min(max(x, 0.0), 1.0)
    return x * x * x * (x * (6 * x - 15) + 10)


def _ease(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * x * (x * (6 * x - 15) + 10)


def _bump(x):
    x = np.clip(x, 0.0, 1.0)
    return 64.0 * x ** 3 * (1 - x) ** 3


def log(q):
    """A rotation as a vector, its axis times its angle, in double
    precision: by atan2, which is exact for small turns where acos (and
    mathutils' angle, in single precision) rounds them to 0.04°."""
    w, x, y, z = (float(c) for c in q)
    if w < 0:
        w, x, y, z = -w, -x, -y, -z
    n = math.sqrt(x * x + y * y + z * z)
    if n < 1e-15:
        return np.zeros(3)
    return np.array((x, y, z)) / n * 2.0 * math.atan2(n, w)


def exp(v):
    angle = float(np.linalg.norm(v))
    if angle < 1e-15:
        return Quaternion()
    s = math.sin(angle / 2) / angle
    return Quaternion((math.cos(angle / 2), v[0] * s, v[1] * s, v[2] * s))


def angle(a, b):
    """The angle between two rotations, in radians, in double precision."""
    aw, ax, ay, az = (float(c) for c in a)
    bw, bx, by, bz = (float(c) for c in b)
    # a⁻¹ b
    w = aw * bw + ax * bx + ay * by + az * bz
    x = aw * bx - ax * bw - ay * bz + az * by
    y = aw * by + ax * bz - ay * bw - az * bx
    z = aw * bz - ax * by + ay * bx - az * bw
    return 2.0 * math.atan2(math.sqrt(x * x + y * y + z * z), abs(w))


class Library:
    """The pose library as the job holds it, its poses resolved."""

    def __init__(self, job):
        lib = job["poses"]
        self.raw = lib.get("poses", {})
        self.clips = lib.get("clips", {})
        self.retargets = lib.get("retarget", {})
        self.motion = job["tables"]["motion"]
        self.poses = {name: self._resolve(name, ()) for name in self.raw}

    def _resolve(self, name, seen):
        if name in seen:
            raise ValueError(f"the pose {name} comes from itself")
        p = self.raw[name]
        if p.get("from"):
            base = self._resolve(p["from"], seen + (name,))
            out = {"turn": base["turn"] + list(p.get("turn") or []),
                   "place": p.get("place", base["place"]),
                   "ik": dict(base["ik"])}
            out["ik"].update(p.get("ik") or {})
            return out
        return {"turn": list(p.get("turn") or []), "place": p.get("place"), "ik": dict(p.get("ik") or {})}


class Figure:
    """A sailor's skeleton and meshes, posed and placed."""

    def __init__(self, arm, meshes, stage, motion):
        self.arm = arm
        self.meshes = meshes
        self.stage = stage
        self.motion = motion
        self.names = [b.name for b in arm.data.bones]
        self.bones = arm.pose.bones
        for pb in self.bones:
            pb.rotation_mode = "QUATERNION"
        self.clamped = 0
        # What the figure sits on: all of it, unless told (not its skirts).
        self.sitting = meshes

    # --- Posing --------------------------------------------------------

    def reset(self):
        for pb in self.bones:
            pb.matrix_basis.identity()
        self.arm.matrix_world.identity()
        self.on_seat(False)
        self.update()

    def lay_on_seat(self, meshes):
        """Lays the skirts on the boat whenever the figure is in it, as the
        game will (springs on the seat's plane up close, the vertex lifted
        to it further off): each vertex the skirt chains move is lifted,
        straight up, out of the deck it hangs through, as far as they move
        it. A modifier after the skeleton's, on while the figure is placed
        in the boat; the files never carry it."""
        self.seat_mods = []
        if self.stage is None:
            return
        for o in meshes:
            names = {g.index: g.name for g in o.vertex_groups}
            lift = o.vertex_groups.get(SEAT_GROUP) or o.vertex_groups.new(name=SEAT_GROUP)
            any_ = False
            for v in o.data.vertices:
                w = sum(g.weight for g in v.groups if names.get(g.group, "").startswith("skirt_"))
                if w > 0:
                    lift.add([v.index], min(w, 1.0), "REPLACE")
                    any_ = True
            if not any_:
                o.vertex_groups.remove(lift)
                continue
            m = o.modifiers.get(SEAT_GROUP) or o.modifiers.new(SEAT_GROUP, "SHRINKWRAP")
            m.target = self.stage.solid[0]
            m.wrap_method = "PROJECT"
            m.use_project_z = True
            m.use_positive_direction = True
            m.use_negative_direction = False
            m.wrap_mode = "OUTSIDE_SURFACE"
            m.offset = SEAT_CLEAR
            m.project_limit = 0.5
            m.vertex_group = SEAT_GROUP
            m.show_viewport = m.show_render = False
            self.seat_mods.append((o, m.name))

    def on_seat(self, on):
        for o, name in getattr(self, "seat_mods", []):
            m = o.modifiers.get(name)
            if m is not None:
                m.show_viewport = m.show_render = on

    def quiet(self, on=True):
        """Leaves every mesh the skeleton moves out of the scene's
        evaluation (on), or puts them back: baking and reading clips need
        only the bones."""
        for o in bpy.data.objects:
            if o.type == "MESH" and any(m.type == "ARMATURE" and m.object == self.arm for m in o.modifiers):
                o.hide_viewport = on

    def update(self):
        bpy.context.view_layer.update()

    def turn(self, turns):
        """Turns bones about the figure's axes, each about its posed head,
        root first (as listed), carrying its children."""
        for name, axis, degrees in turns:
            pb = self.bones[name]
            self.update()
            head = pb.matrix.to_translation()
            r = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis.upper()) @ Matrix.Translation(-head)
            pb.matrix = r @ pb.matrix
        self.update()

    def rotations(self):
        return {pb.name: pb.rotation_quaternion.copy() for pb in self.bones}

    def set_rotations(self, rot, pelvis=None):
        for pb in self.bones:
            pb.rotation_quaternion = rot[pb.name]
        if pelvis is not None:
            self.bones["pelvis"].location = pelvis
        self.update()

    def world(self, name, where="head"):
        """A bone's posed head or tail in the boat."""
        pb = self.bones[name]
        return self.arm.matrix_world @ (pb.head if where == "head" else pb.tail)

    def world_matrix(self, name):
        return self.arm.matrix_world @ self.bones[name].matrix

    def anchored(self, bone, offset):
        """A point that moves with a bone: offset along the figure's rest
        axes from the bone's head."""
        rest = self.arm.data.bones[bone].matrix_local.to_quaternion()
        posed = self.world_matrix(bone)
        return posed.to_translation() + posed.to_quaternion() @ (rest.inverted() @ Vector(offset))

    # --- Placing -------------------------------------------------------

    def placement(self, place, side=1):
        """Where a posed figure stands in the boat: on the seat or the
        gunwale facing inboard, its lowest point under the hips on the
        deck (the body's and its fitted clothes', not a skirt's, which lies
        on the seat by its chains); seated, wholly on the deck, not over its
        outer edge; or at the origin."""
        if place is None:
            return Matrix()
        if self.stage is None:
            raise ValueError(f"a pose placed on the {place} needs the stage")
        st = self.stage
        if place == "seat":
            at = st.point("seat", side)
        elif place == "gunwale":
            g = st.point("gunwale", side)
            x = g.x - side * st.spec["hike"]["in"]
            at = Vector((x, g.y, st.down(abs(x), g.y)))
        else:
            raise ValueError(f"no place {place!r}")
        pelvis = self.bones["pelvis"].head
        co = self.dressed(self.sitting)
        near = np.hypot(co[:, 0] - pelvis.x, co[:, 1] - pelvis.y) < SEAT_REACH
        below = near & (co[:, 2] < pelvis.z)
        # Clear of the deck, not on it: the legs' IK, after, moves the cloth
        # under the thighs a little.
        low = float(co[below, 2].min()) - SEAT_CLEAR
        contact = Vector((pelvis.x, pelvis.y, low))
        m = Matrix.Translation(at) @ st.facing(side) @ Matrix.Translation(-contact)

        def boat(points):
            return points @ np.array(m)[:3, :3].T + np.array(m)[:3, 3]

        if place == "seat":
            # The buttocks on the deck, not hanging over its outer edge.
            over = float((side * boat(co[below])[:, 0]).max()) - (st.gunwale.x - SEAT_EDGE)
            if over > 0:
                m = Matrix.Translation((-side * over, 0, 0)) @ m
        # The deck is cambered, higher inboard: lifted until nothing lying
        # on the side deck (well in from its edge, where the legs go down)
        # is under it.
        lift = 0.0
        for x, y, z in boat(co):
            if st.edge + 0.05 <= side * x <= st.gunwale.x:
                top = st.down(x, y)
                if top is not None and top - 0.15 < z < top + SEAT_CLEAR:
                    lift = max(lift, top + SEAT_CLEAR - z)
        return Matrix.Translation((0, 0, lift)) @ m

    def dressed(self, meshes=None):
        """Every vertex of the figure (or of meshes) as posed, in the
        armature's space."""
        dg = bpy.context.evaluated_depsgraph_get()
        out = []
        inv = self.arm.matrix_world.inverted()
        for o in meshes or self.meshes:
            e = o.evaluated_get(dg)
            me = e.to_mesh()
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            m = np.array(inv @ o.matrix_world)
            co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            out.append(co)
            e.to_mesh_clear()
        return np.concatenate(out)

    # --- Targets and IK ------------------------------------------------

    def target(self, spec, side=1, effector=None):
        """Where a target is now, in the boat. A target with a reach is
        moved inboard (along the seat's inboard axis) until it is that
        share of the leg's or arm's length from the chain's root: the same
        stretch on any body."""
        if spec["at"] == "bone":
            return self.anchored(spec["bone"], spec.get("offset", (0, 0, 0)))
        p = self.stage.point(spec["at"], side)
        frame = self.stage.frame(side).to_quaternion()
        off = spec.get("offset")
        if off:
            p = p + frame @ Vector(off)
        if spec.get("reach") and effector:
            upper, lower, _ = EFFECTORS[effector]
            root = self.world(upper)
            length = spec["reach"] * (self.arm.data.bones[upper].length + self.arm.data.bones[lower].length)
            inboard = frame @ Vector((0, 1, 0))
            d = p - root
            along = d.dot(inboard)
            across = (d - inboard * along).length
            if length > across:
                p = p + inboard * (math.sqrt(length * length - across * across) - along)
            # Within the cockpit: short of the far side deck's edge.
            far = self.stage.edge - COCKPIT_MARGIN
            if side * p.x < -far:
                p.x = -side * far
        return p

    def solve(self, effector, target, pole=None):
        """Two-bone IK: the chain's end to target, the middle joint toward
        its pole (POLES, or an offset from the chest), within the reach
        the tables allow."""
        upper, lower, end = EFFECTORS[effector]
        s = self.world(upper)
        l1 = self.arm.data.bones[upper].length
        l2 = self.arm.data.bones[lower].length
        t = Vector(target)
        d = t - s
        most = self.motion["reach"]["arm" if effector.startswith("hand") else "leg"] * (l1 + l2)
        if d.length > most:
            t = s + d.normalized() * most
            d = t - s
            self.clamped += 1
        least = abs(l1 - l2) + 1e-3
        if d.length < least:
            t = s + d.normalized() * least
            d = t - s
        bone, offset = POLES[effector]
        pole = self.anchored(bone, pole or offset)
        dn = d.normalized()
        toward = pole - s
        toward = (toward - dn * toward.dot(dn)).normalized()
        a = (l1 * l1 - l2 * l2 + d.length_squared) / (2 * d.length)
        h = math.sqrt(max(l1 * l1 - a * a, 0.0))
        elbow = s + dn * a + toward * h
        self._aim(upper, elbow)
        self._aim(lower, t)

    def _aim(self, name, point):
        """Turns a bone by the least turn that points it at point."""
        self.update()
        m = self.world_matrix(name)
        head = m.to_translation()
        now = (m.to_quaternion() @ Vector((0, 1, 0))).normalized()
        want = (Vector(point) - head).normalized()
        q = now.rotation_difference(want) @ m.to_quaternion()
        local = self.arm.matrix_world.inverted() @ Matrix.LocRotScale(head, q, None)
        self.bones[name].matrix = local
        self.update()

    def derive(self):
        """The bones of our own: the hip correctors half the thighs' turn,
        the forearm twists half the hands' twist about their length, and
        the skirt chains after the thighs (SKIRT_FOLLOW): seated, the front
        over the lap, the back down the buttocks and out along the seat."""
        bones = self.arm.data.bones
        self.update()
        pelvis = (self.bones["pelvis"].matrix.to_quaternion() @ bones["pelvis"].matrix_local.to_quaternion().inverted())
        for s in ("l", "r"):
            thigh = self.bones["thigh_" + s].rotation_quaternion
            self.bones["thigh_corrector_" + s].rotation_quaternion = Quaternion().slerp(thigh, 0.5)
            hand = self.bones["hand_" + s].rotation_quaternion
            twist = Quaternion((hand.w, 0.0, hand.y, 0.0))
            twist = twist.normalized() if twist.magnitude > 1e-9 else Quaternion()
            self.bones["lowerarm_twist_" + s].rotation_quaternion = Quaternion().slerp(twist, 0.5)
            # The thigh's turn against the hips', in the skeleton's axes.
            turn = (self.bones["thigh_" + s].matrix.to_quaternion()
                    @ bones["thigh_" + s].matrix_local.to_quaternion().inverted())
            turn = pelvis.inverted() @ turn
            for place, shares in SKIRT_FOLLOW.items():
                for i, share in enumerate(shares):
                    name = f"skirt_{place}_{s}_0{i + 1}"
                    part = Quaternion().slerp(turn if share >= 0 else turn.inverted(), abs(share))
                    rest = bones[name].matrix_local.to_quaternion()
                    self.bones[name].rotation_quaternion = rest.inverted() @ part @ rest
        self.update()

    # --- A pose, whole -------------------------------------------------

    def key(self, pose, side=1):
        """A key pose: its rotations without IK, its placement, its
        targets. The figure is left in it, IK solved."""
        self.reset()
        self.turn(pose["turn"])
        rot = self.rotations()
        place = self.placement(pose["place"], side)
        self.arm.matrix_world = place
        self.on_seat(pose["place"] is not None)
        self.update()
        at = {}
        for eff in EFFECTORS:
            spec = pose["ik"].get(eff)
            at[eff] = self.target(spec, side, eff) if spec else self.world(EFFECTORS[eff][2])
        return {"rot": rot, "place": place, "ik": pose["ik"], "side": side, "at": at}

    def pose(self, pose, side=1):
        """Sets a pose from the library, placed and IK solved."""
        k = self.key(pose, side)
        for eff, spec in k["ik"].items():
            self.solve(eff, self.target(spec, side, eff), spec.get("pole"))
        self.derive()
        return k

    def frame(self):
        """The pose now, as keys: every bone's rotation, and the pelvis's
        translation."""
        return {"rot": self.rotations(), "pelvis": self.bones["pelvis"].location.copy()}


# --- Clips --------------------------------------------------------------


class Clip:
    """A clip's frames, and what the gate needs to know of how it was
    made: its transitions, the contacts it holds."""

    def __init__(self, name, fps, loop, idle):
        self.name = name
        self.fps = fps
        self.loop = loop
        self.idle = idle
        self.frames = []
        # (first frame, last frame, lead) of each ramp.
        self.ramps = []
        # Per frame: {effector: point in the boat it must be on}.
        self.contacts = []
        # Effectors whose ends must not move.
        self.planted = []
        self.place = Matrix()
        self.notes = {}
        # Made by the lab (not retargeted), and the effectors it holds by
        # IK.
        self.made = False
        self.ik = []


def make(fig, lib, name):
    """Bakes one clip of the library on the figure."""
    spec = lib.clips[name]
    m = lib.motion
    fps = m["fps"]
    keys = spec["keys"]
    side = 1
    kp = [fig.key(lib.poses[k["pose"]], side) for k in keys]
    # The placement is the first key's: a clip sits where it starts.
    place = kp[0]["place"]
    n = len(keys)
    loop = bool(spec.get("loop"))

    # The timeline: each key's hold, after the ramp into it.
    names = fig.names
    logs = [{b: log(p["rot"][b]) for b in names} for p in kp]
    segs = []  # (start s, ramp s, hold s, from key, to key, key spec)
    t = 0.0
    order = list(range(n)) + ([0] if loop else [])
    prev = None
    for i, ki in enumerate(order):
        k = keys[ki] if i < n else {"pose": keys[0]["pose"], "hold": 0.0, "ramp": keys[0].get("ramp"),
                                    "lead": keys[0].get("lead")}
        if prev is None:
            ramp = 0.0
        else:
            ramp = k.get("ramp") or _ramp(fig, kp[prev], kp[ki], logs[prev], logs[ki], m)
        hold = k.get("hold", 0.0) if i < n else 0.0
        segs.append((t, ramp, hold, prev, ki, k))
        t += ramp + hold
        prev = ki
    # A whole number of frames: the last ramp (a loop's, back to its
    # start) or hold made as much longer as that takes.
    frames = int(math.ceil(t * fps - 1e-9))
    extra = frames / fps - t
    start, ramp, hold, a, ki, k = segs[-1]
    segs[-1] = (start, ramp + extra, hold, a, ki, k) if loop else (start, ramp, hold + extra, a, ki, k)
    length = frames / fps
    clip = Clip(name, fps, loop, bool(spec.get("idle")))
    clip.place = place
    clip.planted = ["foot_l", "foot_r"] if all(p["place"] for p in kp) else []

    delays = m["delays"]
    filt = m["filter"]
    dt = 1.0 / fps
    rng = np.random.default_rng(_seed(name))
    phases = {b: rng.uniform(0, 2 * math.pi, (2, 3)) for b in DRIFTS}
    ramps = [sg for sg in segs if sg[3] is not None and sg[1] > 0]

    def delay(b, sg):
        """A bone's delay in a ramp, in seconds: down the chain from the
        hips, or from the head when it leads; the wrist trailing a hand
        that rises and leading one that falls, the fingers after it."""
        start, ramp, hold, a, ki, k = sg
        kd = kind(b)
        d = table(delays, b, 0)
        if kd in TORSO and k.get("lead") == "head":
            d = max(delays[x] for x in TORSO) - d
        if kd == "hand" or kd in FINGERS:
            e = "hand" + b[-2:]
            if kp[ki]["at"][e].z < kp[a]["at"][e].z - 0.02:
                d = delays["hand-leads"] + (d - delays["hand"])
        return d / fps

    def raw(b, s):
        """A bone's eased signal at the times s (seconds, an array),
        before its filter: the first key's, and each ramp's change eased
        in after the bone's delay (on a loop, the last round's ramps too,
        which may run on past its end); with the holds' drift."""
        v = np.tile(logs[0][b], (len(s), 1))
        here = s % length if loop else np.clip(s, 0.0, length)
        rounds = (here, here + length) if loop else (here,)
        for t in rounds:
            for sg in ramps:
                start, ramp, hold, a, ki, k = sg
                x = np.clip((t - start - delay(b, sg)) / ramp, 0.0, None)
                e = _ease(x) - k.get("anticipate", 0.0) * _bump(x / 0.4)
                v += np.outer(e, logs[ki][b] - logs[a][b])
        if b in phases:
            for start, ramp, hold, a, ki, k in segs:
                inside = (here >= start + ramp) & (here < start + ramp + hold)
                for i in np.flatnonzero(inside):
                    v[i] += _drift(b, here[i] - start - ramp, hold, phases, m["drift"])
        return v

    # The filtered channels, every bone at once: run twice round a loop so
    # the filter's state at its end is its state at its start.
    warm = frames if loop else 0
    sub = 4
    times = np.arange(-warm, frames + 1) * dt
    u = np.stack([raw(b, times) for b in names], axis=1)  # time × bone × 3
    w = 2 * math.pi * filt["hz"]
    zeta = np.array([[filt["zeta"]["proximal"] if table(delays, b, 0) <= 2 else filt["zeta"]["distal"]]
                     for b in names])
    x = u[0].copy()
    vel = np.zeros_like(x)
    h = dt / sub
    series = np.empty((frames + 1,) + x.shape)
    for f in range(len(times)):
        for _ in range(sub):
            vel += (w * w * (u[f] - x) - 2 * zeta * w * vel) * h
            x = x + vel * h
        if f >= warm:
            series[f - warm] = x
    out = {b: series[:, j] for j, b in enumerate(names)}

    # The hands' targets, a blend of each key's, at each frame. The meshes
    # are left out meanwhile: only the skeleton need be evaluated.
    effs = sorted({e for p in kp for e in p["ik"]})
    fig.quiet()
    fig.arm.matrix_world = place
    for f in range(frames + 1):
        s = f * dt
        rot = {b: exp(out[b][f]) for b in names}
        fig.set_rotations(rot, Vector())
        contacts = {}
        for e in effs:
            p = _effector_target(fig, kp, segs, e, s - delays["effector"] / fps, length, loop, side, contacts)
            if p is not None:
                fig.solve(e, p, _pole(kp, segs, e, s - delays["effector"] / fps, length, loop))
        fig.derive()
        clip.frames.append(fig.frame())
        clip.contacts.append(contacts)
    fig.quiet(False)
    for start, ramp, hold, a, ki, k in segs:
        if a is not None and ramp > 0:
            clip.ramps.append((int(round(start * fps)), int(round((start + ramp) * fps)), k.get("lead", "hips")))
    if loop:
        # The end is the start.
        clip.frames[-1] = {"rot": {b: q.copy() for b, q in clip.frames[0]["rot"].items()},
                           "pelvis": clip.frames[0]["pelvis"].copy()}
    clip.notes["clamped"] = fig.clamped
    clip.made = True
    clip.ik = effs
    return clip


def _ramp(fig, a, b, la, lb, m):
    """A ramp's length: the base, more for the largest turn, more for the
    furthest a target moves."""
    angle = max(float(np.linalg.norm(lb[n] - la[n])) for n in la)
    move = 0.0
    for e in set(a["ik"]) | set(b["ik"]):
        if a["ik"].get(e) != b["ik"].get(e):
            move = max(move, (a["at"][e] - b["at"][e]).length)
    r = m["ramp"]
    return r["base"] + r["per-degree"] * math.degrees(angle) + r["per-metre"] * move


def _pole(kp, segs, e, s, length, loop):
    """The pole a key's target names, eased between two keys'."""
    s = s % length if loop else min(max(s, 0.0), length)
    for start, ramp, hold, a, ki, k in reversed(segs):
        if s >= start:
            break
    default = POLES[e][1]
    to = (kp[ki]["ik"].get(e) or {}).get("pole") or default
    if a is None or s >= start + ramp:
        return to
    frm = (kp[a]["ik"].get(e) or {}).get("pole") or default
    x = ease((s - start) / ramp)
    return tuple(f + (t - f) * x for f, t in zip(frm, to))


def _seed(name):
    return sum((i + 1) * ord(c) for i, c in enumerate(name))


def _drift(b, into, hold, phases, spec):
    """A hold's drift: a slow wander of a few bones, faded in and out at
    the hold's ends."""
    if b not in phases or hold <= 0:
        return np.zeros(3)
    fade = min(1.0, into / 0.3, (hold - into) / 0.3)
    if fade <= 0:
        return np.zeros(3)
    amp = math.radians(spec["head"] if b == "head" else spec["degrees"])
    slow = spec["period"]
    out = np.zeros(3)
    for i, p in enumerate((slow, slow / 1.618)):
        out += np.sin(2 * math.pi * into / p + phases[b][i]) * amp * (0.6 if i else 1.0)
    return out * fade


def _effector_target(fig, kp, segs, e, s, length, loop, side, contacts):
    """An effector's target at s (already delayed): the key's, or the
    blend of two keys' across a ramp, with the arc; None when neither key
    has one (the effector follows its bones)."""
    s = s % length if loop else min(max(s, 0.0), length)
    for start, ramp, hold, a, ki, k in reversed(segs):
        if s >= start:
            break
    to = kp[ki]["ik"].get(e)
    if a is None or s >= start + ramp:
        if to is None:
            return None
        p = fig.target(to, side, e)
        if to["at"] != "bone":
            contacts[e] = p
        return p
    frm = kp[a]["ik"].get(e)
    if frm is None and to is None:
        return None
    pa = fig.target(frm, side, e) if frm else fig.world(EFFECTORS[e][2])
    if frm == to:
        if to["at"] != "bone":
            contacts[e] = pa
        return pa
    pb = fig.target(to, side, e) if to else fig.world(EFFECTORS[e][2])
    x = (s - start) / ramp
    p = pa.lerp(pb, ease(x))
    arc = k.get("arc")
    if arc:
        # Out and up at the middle; less out on the way down.
        sign = 1.0 if e.endswith("_l") else -1.0
        out = fig.arm.matrix_world.to_quaternion() @ Vector((sign * arc[0], 0.0, arc[1]))
        p = p + out * bump(x) * (1.0 if pb.z > pa.z else 0.4)
    return p


# --- Actions and the clips' file -----------------------------------------


def write_action(arm, name, frames, fps):
    """An action of the frames, a key a frame: every bone's rotation and
    the pelvis's translation."""
    act = bpy.data.actions.new(name)
    slot = act.slots.new(id_type="OBJECT", name=arm.name)
    bag = anim_utils.action_ensure_channelbag_for_slot(act, slot)
    n = len(frames)
    t = np.arange(n, dtype=float)
    for b in [pb.name for pb in arm.pose.bones]:
        qs = np.array([list(fr["rot"][b]) for fr in frames])
        # Each the same side of the sphere as the one before.
        for i in range(1, n):
            if np.dot(qs[i], qs[i - 1]) < 0:
                qs[i] = -qs[i]
        _curves(bag, b, "rotation_quaternion", t, qs)
    _curves(bag, "pelvis", "location", t, np.array([list(fr["pelvis"]) for fr in frames]))
    act.use_fake_user = False
    return act, slot


def _curves(bag, bone, prop, t, values):
    for i in range(values.shape[1]):
        fc = bag.fcurves.new(f'pose.bones["{bone}"].{prop}', index=i, group_name=bone)
        fc.keyframe_points.add(len(t))
        co = np.empty(2 * len(t))
        co[0::2] = t
        co[1::2] = values[:, i]
        fc.keyframe_points.foreach_set("co", co)
        fc.keyframe_points.foreach_set("interpolation", [1] * len(t))  # LINEAR
        fc.update()


def play(arm, act, slot):
    """Puts an action on the skeleton, to be read frame by frame."""
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = act
    ad.action_slot = slot


def stop(arm):
    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()


def export(path, arm, actions, gltfpack, work):
    """The clips with the skeleton alone, packed: rotations and the
    pelvis's translation, at 30 frames a second."""
    stop(arm)
    keep = {a.name for a, _ in actions}
    for a in list(bpy.data.actions):
        if a.name not in keep:
            bpy.data.actions.remove(a)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    saved = arm.matrix_world.copy()
    arm.matrix_world.identity()
    raw = os.path.join(work, os.path.basename(path).replace(".glb", ".raw.glb"))
    bpy.ops.export_scene.gltf(
        filepath=raw, export_format="GLB", use_selection=True, export_yup=True, export_skins=True,
        export_def_bones=False, export_leaf_bone=False, export_rest_position_armature=True, export_morph=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_reset_pose_bones=True, export_extras=False)
    arm.matrix_world = saved
    subprocess.run([gltfpack, "-i", raw, "-o", path, "-c", "-kn", "-af", "30", "-ar", "12"],
                   check=True, capture_output=True)
    return raw


def coords_posed(obj):
    """A mesh's vertices as posed, in the boat."""
    dg = bpy.context.evaluated_depsgraph_get()
    e = obj.evaluated_get(dg)
    me = e.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    no = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", no)
    e.to_mesh_clear()
    m = np.array(obj.matrix_world)
    co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    no = no.reshape(-1, 3) @ m[:3, :3].T
    no /= np.linalg.norm(no, axis=1, keepdims=True) + 1e-12
    return co, no

