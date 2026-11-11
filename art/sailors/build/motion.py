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

# The export's file helpers; this module's own export() writes the clips.
import export as files

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
# The arms' bones, by kind, the collarbone to the fingers.
ARMS = ("clavicle", "upperarm", "lowerarm", "lowerarm_twist", "hand") + FINGERS

# How far round the pelvis the buttocks are looked for, seating a figure,
# how far over the deck they sit, and how far in from its outer edge.
SEAT_REACH = 0.22
SEAT_EDGE = 0.03
# The vertex group and modifier that lay the skirts on the seat.
SEAT_GROUP = "seat-lift"
SEAT_CLEAR = 0.006
# A leg through the boat in a clip is turned at the hip this many degrees a
# try, up to this many tries, until clear by the leg's own thickness under
# its joints: the hip, the knee, the ankle (the heel under it), the ball
# and the toe.
LEG_STEP = 2.0
LEG_STEPS = 20
LEG_CLEAR = (0.09, 0.09, 0.1, 0.04, 0.035)
# A step's lift for a foot going down to its place, as a share of the step.
STEP_DOWN = 0.7
# A foot set on the boat: the sines of its bone's pitch, least and most (at
# rest standing, about -0.49).
FOOT_PITCH = (-0.7, 0.6)
# The most a knee bends when IK holds its foot, degrees: within the motion
# gate's share of its range.
KNEE_MOST = 107.0
# Beyond this share of its most reach an arm's stretch eases toward the most.
SOFT = 0.92
# How far above what a foot stands on its ball joint and toe tip stay: the
# shoe's sole under them.
TOE_CLEAR = 0.025
# How far above what a foot stands on its ankle stays: the heel under it.
HEEL_CLEAR = 0.1
# A shoe's sole under the foot's bones, standing.
SOLE = 0.03
# Where the hips are outside the boat, climbing in: out from the gunwale and
# down from it.
OUTSIDE = (0.5, 0.1)
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
    """The pose library as the job holds it, its poses resolved, and its
    clips: a clip made on both sides is two, the second named with -port
    (each key's side the other way)."""

    def __init__(self, job):
        lib = job["poses"]
        self.raw = lib.get("poses", {})
        self.clips = {}
        for name, spec in (lib.get("clips") or {}).items():
            self.clips[name] = dict(spec, side=1)
            if spec.get("sides"):
                self.clips[name + PORT] = dict(spec, side=-1)
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
                   "shift": p.get("shift", base["shift"]),
                   "lie": p.get("lie", base["lie"]),
                   "ik": dict(base["ik"])}
            out["ik"].update(p.get("ik") or {})
            return out
        return {"turn": list(p.get("turn") or []), "place": p.get("place"), "shift": p.get("shift"),
                "lie": p.get("lie", 0.0), "ik": dict(p.get("ik") or {})}


# A clip made on the port side is named with this after the starboard one's.
PORT = "-port"


def mirrored(pose):
    """A pose as its mirror image, the figure's left for its right: its
    turns of the other side's bones, about x the same and about y and z
    the other way; its hands' and feet's targets swapped, a bone's offset
    and a pole across the other way. A stage target needs no change: the
    stage's own places are of the side the pose is set on."""
    def other(name):
        for a, b in (("_l", "_r"), ("_r", "_l")):
            if name.endswith(a):
                return name[: -len(a)] + b
            if f"{a}_" in name:
                return name.replace(f"{a}_", f"{b}_")
        return name

    def across(v):
        return None if v is None else [-v[0], v[1], v[2]]

    # A bone's own x axis on one side is the other's mirrored and reversed:
    # a turn about it keeps its sign, as one about the figure's x does.
    turn = [[other(b), axis, d if axis in ("x", "lx") else -d] for b, axis, d in pose["turn"]]
    ik = {}
    for eff, spec in pose["ik"].items():
        t = dict(spec)
        if t["at"] == "bone":
            t["bone"] = other(t["bone"])
            t["offset"] = across(t.get("offset", (0, 0, 0)))
        if t.get("pole") is not None:
            t["pole"] = across(t["pole"])
        ik[other(eff)] = t
    return {"turn": turn, "place": pose["place"], "shift": pose.get("shift"), "lie": pose.get("lie", 0.0), "ik": ik}


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
        # The clips made on it, by name: (action, slot, clip).
        self.made = {}

    # --- Posing --------------------------------------------------------

    def reset(self):
        for pb in self.bones:
            pb.matrix_basis.identity()
        self.arm.matrix_world.identity()
        self.on_seat(False)
        self.update()

    def lay_on_seat(self, meshes, above=None):
        """Lays the skirts on the boat whenever the figure is in it, as the
        game will (springs on the seat's plane up close, the vertex lifted
        to it further off): each vertex of a mesh the skirt chains move that
        is below the seat's plane is lifted, straight up, to it, and then
        onto the deck where the deck, rising with the sheer, is above that;
        each layer a little higher than the one under it (above, by mesh,
        how much). Modifiers after the skeleton's, on while the figure is
        placed in the boat; the files never carry them."""
        self.seat_mods = []
        if self.stage is None:
            return
        for o in meshes:
            names = {g.index: g.name for g in o.vertex_groups}
            # All of a skirted mesh: above the hips its cloth is the pelvis's,
            # and seated that is at the deck too. What is above the deck
            # stays where it is.
            if not any(names.get(g.group, "").startswith("skirt_") for v in o.data.vertices for g in v.groups):
                continue
            lift = o.vertex_groups.get(SEAT_GROUP) or o.vertex_groups.new(name=SEAT_GROUP)
            lift.add(range(len(o.data.vertices)), 1.0, "REPLACE")
            # The dinghy's seat and deck; and the rail's deck, if staged:
            # each lifts only what is straight under it.
            lifts = [(SEAT_GROUP, self.stage.plane, "ABOVE_SURFACE"),
                     (SEAT_GROUP + "-deck", self.stage.solid[0], "OUTSIDE_SURFACE")]
            if self.stage.rail is not None:
                lifts += [(SEAT_GROUP + "-rail", self.stage.rail.plane, "ABOVE_SURFACE"),
                          (SEAT_GROUP + "-rail-deck", self.stage.rail.solid[0], "OUTSIDE_SURFACE")]
            # The ship's hatch, its cloth laid on its grating.
            if self.stage.ship is not None:
                lifts += [(SEAT_GROUP + "-hatch", self.stage.ship.hatch_plane, "ABOVE_SURFACE"),
                          (SEAT_GROUP + "-ship-deck", self.stage.ship.deck, "OUTSIDE_SURFACE")]
            planes = (self.stage.plane,) + ((self.stage.rail.plane,) if self.stage.rail is not None else ()) + \
                ((self.stage.ship.hatch_plane,) if self.stage.ship is not None else ())
            for name, target, mode in lifts:
                m = o.modifiers.get(name) or o.modifiers.new(name, "SHRINKWRAP")
                m.target = target
                m.wrap_method = "PROJECT"
                m.use_project_z = True
                m.use_positive_direction = True
                m.use_negative_direction = False
                m.wrap_mode = mode
                # From under the deck its underside faces the ray: only its
                # top is found.
                m.cull_face = "FRONT" if target not in planes else "OFF"
                m.offset = SEAT_CLEAR + (above or {}).get(o.name, 0.0) + \
                    (SHIP_DECK_CLEAR if name == SEAT_GROUP + "-ship-deck" else 0.0)
                m.project_limit = 2.0 if target in planes else 0.3
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
        # Only the pelvis moves: what setting a bone's matrix leaves in
        # another's place (its rounding) is not the clip's, which keeps
        # turns alone.
        for pb in self.bones:
            if pb.name != "pelvis" and pb.location.length_squared > 0.0:
                pb.location = (0.0, 0.0, 0.0)
        bpy.context.view_layer.update()

    def turn(self, turns):
        """Turns bones about the figure's axes, each about its posed head,
        root first (as listed), carrying its children; or, axis lx, about
        the bone's own x axis as it lies (a finger's curl, toward the palm)."""
        for name, axis, degrees in turns:
            pb = self.bones[name]
            self.update()
            head = pb.matrix.to_translation()
            about = pb.matrix.to_3x3().col[0].normalized() if axis == "lx" else axis.upper()
            r = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, about) @ Matrix.Translation(-head)
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

    def placement(self, place, side=1, lie=0.0):
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
        if place == "cockpit":
            # Crouched on the cockpit's floor over the centreline, facing
            # forward: the soles on the floor, the hips over the keel.
            pelvis = self.bones["pelvis"].head
            low = min(min(self.bones[f"{b}_{s}"].head.z, self.bones[f"{b}_{s}"].tail.z)
                      for b in ("foot", "ball") for s in ("l", "r")) - SOLE
            contact = Vector((pelvis.x, pelvis.y, low))
            at = Vector((0.0, st.floor.y, st.floor.z))
            return Matrix.Translation(at) @ Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation(-contact)
        if place == "wheel":
            # Standing at the wheel on the deck, facing forward: the soles
            # on the deck, the hips over the helmsman's point.
            pelvis = self.bones["pelvis"].head
            low = min(min(self.bones[f"{b}_{s}"].head.z, self.bones[f"{b}_{s}"].tail.z)
                      for b in ("foot", "ball") for s in ("l", "r")) - SOLE
            contact = Vector((pelvis.x, pelvis.y, low))
            at = st.point("deck", side)
            return Matrix.Translation(at) @ Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation(-contact)
        if place == TRAPEZE:
            # On the trapeze: standing on the rack's edge facing inboard, as
            # a sailor sits facing inboard on a side deck, and lying back
            # out over the water (the pose's lie, about the feet): the
            # ankles' middle above the edge, as high as a heel stands.
            feet = (self.bones["foot_l"].head + self.bones["foot_r"].head) / 2
            at = st.point("rack", side) + Vector((0.0, 0.0, ANKLE_UP))
            back = Matrix.Rotation(math.radians(-lie), 4, "X")
            return Matrix.Translation(at) @ st.facing(side) @ back @ Matrix.Translation(-feet)
        if place == RAIL:
            # On the rail: sat on the deck's edge facing outboard, the legs
            # over the side, the backs of the knees just past the edge (the
            # knees' joints the tables' `knee` out from it) and the lowest
            # of what is under the hips (the body and its fitted clothes)
            # on the deck; lifted, as on the seat, until nothing lying on
            # the cambered deck is under it.
            rail = st.rail
            # The thighs lie on the deck: their cloth as the derived bones
            # (the hips' correctors) put it.
            self.derive()
            pelvis = self.bones["pelvis"].head
            co = self.dressed(self.sitting)
            near = np.hypot(co[:, 0] - pelvis.x, co[:, 1] - pelvis.y) < SEAT_REACH
            below = near & (co[:, 2] < pelvis.z)
            low = float(co[below, 2].min()) - SEAT_CLEAR
            knees = (self.bones["calf_l"].head + self.bones["calf_r"].head) / 2
            contact = Vector((pelvis.x, knees.y, low))
            at = st.point("rail", side) + Vector((side * rail.spec["knee"], 0.0, 0.0))
            m = Matrix.Translation(at) @ st.facing(-side) @ Matrix.Translation(-contact)
            # The arms hang as they rest till the IK takes the hands where
            # they go: they lie on nothing.
            placed = (co @ np.array(m)[:3, :3].T + np.array(m)[:3, 3])[~self.armed(self.sitting)]
            lift = 0.0
            for x, y, z in placed:
                if rail.inner + 0.05 <= side * x <= rail.edge.x:
                    top = rail.down(x, y)
                    if top is not None and top - 0.15 < z < top + SEAT_CLEAR:
                        lift = max(lift, top + SEAT_CLEAR - z)
            return Matrix.Translation((0, 0, lift)) @ m
        if place in SHIP_STANDS:
            return self._on_ship(place, side)
        if place == "outside":
            # In the water at the side, facing in, the chest at the gunwale:
            # where a sailor climbing back in starts.
            g = st.point("gunwale", side)
            at = Vector((g.x + side * OUTSIDE[0], g.y, g.z - OUTSIDE[1]))
            return Matrix.Translation(at) @ st.facing(side) @ Matrix.Translation(-self.bones["pelvis"].head)
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
        if not below.any():
            raise AssertionError(f"nothing below the pelvis {tuple(round(c, 3) for c in pelvis)} within reach: "
                                 f"{len(co)} vertices, x {co[:, 0].min():.3f}..{co[:, 0].max():.3f}, "
                                 f"y {co[:, 1].min():.3f}..{co[:, 1].max():.3f}, z {co[:, 2].min():.3f}..{co[:, 2].max():.3f}")
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

    def _on_ship(self, place, side):
        """Standing on the ship (stage.Ship): the soles on what is under
        them, the hips over the place: hauling, beside the brace's fall
        (inboard of it) facing its lead; in the main top, out toward its
        shrouds, facing forward; on the main topsail yard's footrope, aft
        of the yard, facing forward."""
        ship = self.stage.ship
        pelvis = self.bones["pelvis"].head
        low = min(min(self.bones[f"{b}_{s}"].head.z, self.bones[f"{b}_{s}"].tail.z)
                  for b in ("foot", "ball") for s in ("l", "r")) - SOLE
        contact = Vector((pelvis.x, pelvis.y, low))
        if place == BRACE:
            along = ship.brace_along(side)
            heading = math.atan2(along.x, -along.y)
            at = ship.point("haul-deck", side)
        elif place == TOP:
            # Out toward the shrouds as far as leaves the hand that holds
            # one its easy reach from the shoulder.
            at = ship.point("aloft", side)
            heading = math.pi
            s = "r" if side > 0 else "l"
            # The shoulder as it is at rest over the hips, the same for every
            # key: the figure stays where it stands.
            bones = self.arm.data.bones
            sh = self.bones["pelvis"].head + (bones[f"upperarm_{s}"].head_local - bones["pelvis"].head_local)
            arm = self.arm.data.bones[f"upperarm_{s}"].length + self.arm.data.bones[f"lowerarm_{s}"].length
            grip = ship.point("topmast-shroud", side)
            rel = Vector((-(sh.x - contact.x), -(sh.y - contact.y), sh.z - contact.z))
            dy, dz = grip.y - (at.y + rel.y), grip.z - (at.z + rel.z)
            span = (TOP_REACH * arm) ** 2 - dy * dy - dz * dz
            if span > 0:
                at.x = grip.x - rel.x - side * math.sqrt(span)
            self.top_out = abs(at.x - ship.at.x)
            # Where the feet stand there, for their targets.
            self.top_at = at.copy()
        else:
            # Lying over the yard: the hips as high as it, and as far aft of
            # it as keeps the body (not its arms, which reach over it) its
            # radius and a little from its axis: the belly on it. The feet
            # reach down to the footrope.
            co = self.dressed()[self.carried(YARD_BODY)]
            r = ship.yard_radius + YARD_CLEAR
            # The hips as high over the yard as the legs, nearly straight,
            # reach down to the footrope's from, and no lower than YARD_HIPS.
            bones = self.arm.data.bones
            legs = bones["thigh_l"].length + bones["calf_l"].length
            rope = ship.footrope_at(ship.YARD_AT, side).z
            hips = max(YARD_HIPS, rope + HEEL_CLEAR + YARD_LEGS * legs - ship.point("yard", side).z)
            self.yard_hips = hips
            dz = co[:, 2] - (pelvis.z - hips)
            lo, hi = 0.0, 1.0
            for _ in range(30):
                aft = (lo + hi) / 2
                dy = co[:, 1] - (pelvis.y - aft)
                if float(np.hypot(dy, dz).min()) < r:
                    lo = aft
                else:
                    hi = aft
            # And no nearer than the legs standing down to the footrope
            # keep their thighs clear of it.
            self.yard_aft = max(hi, YARD_AFT)
            at = ship.point("yard", side) + Vector((0.0, -self.yard_aft, hips))
            contact = pelvis.copy()
            heading = math.pi
        return Matrix.Translation(at) @ Matrix.Rotation(heading, 4, "Z") @ Matrix.Translation(-contact)

    def carried(self, kinds, meshes=None):
        """Which vertices of the figure (or of meshes), in dressed()'s
        order, a bone of these kinds (or starting so) weighs most on."""
        out = []
        for o in meshes or self.meshes:
            names = {g.index: g.name for g in o.vertex_groups}
            out.append(np.array([bool(v.groups) and any(
                kind(b) == k or b.startswith(k) for k in kinds
                for b in (max((g.weight, names.get(g.group, "")) for g in v.groups)[1],)) for v in o.data.vertices]))
        return np.concatenate(out)

    def armed(self, meshes=None):
        """Which vertices of the figure (or of meshes), in dressed()'s
        order, the arms carry: those an arm's bone (the collarbone to the
        fingers) weighs most on."""
        cache = self.__dict__.setdefault("_armed", {})
        out = []
        for o in meshes or self.meshes:
            if o.name not in cache:
                names = {g.index: g.name for g in o.vertex_groups}
                cache[o.name] = np.array([bool(v.groups) and kind(max(
                    (g.weight, names.get(g.group, "")) for g in v.groups)[1]) in ARMS for v in o.data.vertices])
            out.append(cache[o.name])
        return np.concatenate(out)

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
        if spec["at"] == "aloft" and getattr(self, "top_at", None) is not None:
            # In the top where the figure was placed, out toward the shrouds.
            p = self.top_at.copy()
        frame = self.stage.frame(side).to_3x3()
        off = spec.get("offset")
        if off and spec["at"] in (BRACE, "haul-deck"):
            # Along the brace's fall toward its lead, across it inboard, and up.
            along = self.stage.ship.brace_along(side)
            inboard = Vector((-side, 0.0, 0.0))
            inboard = (inboard - along * inboard.dot(along)).normalized()
            p = p + along * off[0] + inboard * off[1] + Vector((0.0, 0.0, off[2]))
            if spec.get("reach") and effector:
                p = self._along(p, along, spec["reach"], effector, exact=True)
            return p
        if off and spec["at"] == YARD and spec.get("reach") and effector:
            # Brought straight toward the shoulder until the arm is no more
            # than that share of its length from it.
            return self._along(p + frame @ Vector(off), None, spec["reach"], effector)
        elif off:
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

    def _along(self, p, way, reach, effector, least=None, exact=False):
        """A target moved along a line (a rope) until the arm is no more
        than reach and no less than least (shares of its length) from its
        shoulder, the same stretch on any body: by the least move when too
        far, out along the line's way when too near; or (exact) to the
        furthest point along the way at reach. Where the line never comes so
        near, its nearest point; or straight toward the shoulder (way
        None)."""
        upper, lower, _ = EFFECTORS[effector]
        root = self.world(upper)
        arm = self.arm.data.bones[upper].length + self.arm.data.bones[lower].length
        d = p - root
        want = reach * arm if exact or d.length > reach * arm else \
            (least * arm if least and d.length < least * arm else None)
        if want is None:
            return p
        if way is None:
            return root + d.normalized() * want
        b = d.dot(way)
        disc = b * b - (d.length_squared - want * want)
        if disc <= 0:
            return p - way * b
        roots = (-b + math.sqrt(disc), -b - math.sqrt(disc))
        # Too near: out along the line's way; too far: the least move.
        t = roots[0] if exact or want > d.length else min(roots, key=abs)
        return p + way * t

    def solve(self, effector, target, pole=None, grip=None, side=1):
        """Two-bone IK: the chain's end to target, the middle joint toward
        its pole (POLES, or an offset from the chest), within the reach
        the tables allow; and a hand that grips (grip: its fingers' aim and
        its palm's facing, forward, inboard and up in the stage's frame on
        the side; weight, how far from the hand's own turn) turned so."""
        upper, lower, end = EFFECTORS[effector]
        s = self.world(upper)
        l1 = self.arm.data.bones[upper].length
        l2 = self.arm.data.bones[lower].length
        t = Vector(target)
        d = t - s
        most = self.motion["reach"]["arm" if effector.startswith("hand") else "leg"] * (l1 + l2)
        if effector.startswith("hand") and d.length > SOFT * most:
            # Toward the most it reaches, an arm's stretch eases in: a hard
            # stop kinks the hand's path where a passing target leaves its
            # reach.
            knee = SOFT * most
            over = (d.length - knee) / (most - knee)
            t = s + d.normalized() * (knee + (most - knee) * (1 - math.exp(-over)))
            d = t - s
            if over > 1:
                self.clamped += 1
        elif d.length > most:
            t = s + d.normalized() * most
            d = t - s
            self.clamped += 1
        least = abs(l1 - l2) + 1e-3
        if effector.startswith("foot"):
            # A knee bent no further than its share of its range: the foot
            # kept that far from the hip.
            bend = math.radians(KNEE_MOST)
            least = math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * math.cos(bend))
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
        if grip is not None and effector.startswith("hand"):
            self.grip(end, grip, side)

    def grip(self, name, grip, side=1):
        """Turns a hand so its fingers point along grip["aim"] and its palm
        (the bone's own z) faces grip["palm"], both in the stage's frame
        on the side (forward, inboard, up), as far as grip["weight"] (1 if
        not said) from its turn as it is."""
        self.update()
        frame = self.stage.frame(side).to_3x3()
        y = (frame @ Vector(grip["aim"])).normalized()
        z = frame @ Vector(grip["palm"])
        z = (z - y * z.dot(y)).normalized()
        x = y.cross(z)
        want = Matrix((x, y, z)).transposed().to_quaternion()
        m = self.world_matrix(name)
        now = m.to_quaternion()
        q = now.slerp(want, grip.get("weight", 1.0))
        local = self.arm.matrix_world.inverted() @ Matrix.LocRotScale(m.to_translation(), q, None)
        self.bones[name].matrix = local
        self.update()

    def clear_leg(self, s):
        """Turns a leg at the hip, a few degrees at a time, the least way
        that takes its thigh, shin and foot (and the sole and shin's
        thickness under them) clear of the boat: up, or out, whichever
        clears first. A leg already clear is left as it is."""
        if self.stage is None:
            return
        names = (f"thigh_{s}", f"calf_{s}", f"foot_{s}", f"ball_{s}")

        def through():
            pts = [self.world(n) for n in names] + [self.world(f"ball_{s}", "tail")]
            # The leg's thickness under it and toward the boat's middle.
            low = [p - Vector((0, 0, c)) for p, c in zip(pts, LEG_CLEAR)]
            near = [p - Vector((math.copysign(c, p.x), 0, 0)) for p, c in zip(pts, LEG_CLEAR)]
            return self.stage.crossings(pts[:-1] + low[:-1] + near[:-1], pts[1:] + low[1:] + near[1:])

        if not through():
            return
        thigh = self.bones[f"thigh_{s}"]
        start = thigh.rotation_quaternion.copy()
        # Never past the end of the hip's range.
        most = math.radians(self.motion["ranges"]["thigh"] * self.motion["gate"]["range-strain"]) - 0.01
        for step in range(1, LEG_STEPS + 1):
            # Out to the side first, then back, then up: the least strain.
            for axis, sign in (("y", 1 if s == "l" else -1), ("x", 1), ("x", -1)):
                thigh.rotation_quaternion = start
                self.update()
                self.turn([(f"thigh_{s}", axis, sign * LEG_STEP * step)])
                if angle(Quaternion(), thigh.rotation_quaternion) <= most and not through():
                    return
        thigh.rotation_quaternion = start
        self.update()

    def toes(self, effector):
        """The lowest of a foot's ball joint and toe tip, in the boat."""
        ball = self.bones["ball_" + effector[-1]]
        m = self.arm.matrix_world
        return min((m @ ball.head).z, (m @ ball.tail).z)

    def level_foot(self, effector):
        """A foot on its target set on the boat: its toes never dug down
        (or lifted) beyond what a foot on a floor does, whichever way the
        shin leans; its heading the shin's."""
        _, shin, name = EFFECTORS[effector]
        self.update()
        head = self.world_matrix(name).to_translation()
        bones = self.arm.data.bones
        rest = (bones[name].tail_local - bones[name].head_local).normalized()
        # Where the foot would point with the ankle as at rest: its heading.
        neutral = self.world_matrix(shin).to_quaternion() @ (
            bones[shin].matrix_local.to_quaternion().inverted() @ rest)
        flat = Vector((neutral.x, neutral.y, 0.0))
        if flat.length < 1e-6:
            return
        flat.normalize()
        # The ankle as it is, unless the toes would dig down (or point up)
        # further than a foot set on the boat does: then bent to that.
        pitch = max(FOOT_PITCH[0], min(FOOT_PITCH[1], neutral.normalized().z))
        want = flat * math.sqrt(1 - pitch * pitch) + Vector((0, 0, pitch))
        self._aim(name, head + want)

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
        if getattr(self, "hang", None):
            self._hang(self.hang)

    def _hang(self, shares):
        """The skirt chains turned toward the world's down, each about its
        head, root first, by its chain's share: cloth hanging from a body
        lying out. A chain named with its bone's number (front_02) turns
        that bone only: the cloth beyond a knee falling over it."""
        down = (self.arm.matrix_world.inverted().to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        for name, share in shares.items():
            place, _, only = name.partition("_0")
            for s in ("l", "r"):
                for i in ((int(only),) if only else (1, 2)):
                    pb = self.bones.get(f"skirt_{place}_{s}_0{i}")
                    if pb is None:
                        continue
                    along = pb.tail - pb.head
                    if along.length < 1e-6:
                        continue
                    q = Quaternion().slerp(along.normalized().rotation_difference(down), share)
                    head = pb.head.copy()
                    pb.matrix = Matrix.Translation(head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-head) @ pb.matrix
                    self.update()

    # --- A pose, whole -------------------------------------------------

    def key(self, pose, side=1):
        """A key pose: its rotations without IK, its placement, its
        targets; on the port side (side -1), the pose's mirror image. The
        figure is left in it, IK unsolved."""
        if side < 0:
            pose = mirrored(pose)
        self.reset()
        self.turn(pose["turn"])
        rot = self.rotations()
        place = self.placement(pose["place"], side, pose.get("lie", 0.0))
        if pose.get("shift"):
            # Moved forward, inboard and up in the seat's frame.
            place = Matrix.Translation(self.stage.frame(side).to_3x3() @ Vector(pose["shift"])) @ place
        self.arm.matrix_world = place
        # Standing at a wheel, on the trapeze or on the ship, nothing lies on a seat.
        self.on_seat(pose["place"] not in (None, STANDS, TRAPEZE) + SHIP_STANDS)
        self.update()
        at = {}
        for eff in EFFECTORS:
            spec = pose["ik"].get(eff)
            # A planted target is where the pose itself puts the effector on
            # the stage's surface (a crouch's feet where its turns set them).
            at[eff] = self.target(spec, side, eff) if spec and not spec.get("planted") \
                else self.world(EFFECTORS[eff][2])
            if spec and spec.get("planted") and eff.startswith("foot") and spec["at"] != "free":
                # A foot planted on what it stands on, its heel not under it.
                at[eff].z = max(at[eff].z, self.stage.point(spec["at"], side).z + HEEL_CLEAR)
        if pose["place"] in (STANDS, BRACE, TOP):
            # Standing, a foot's target as high as its toes need to be on
            # the deck with the foot set on it (a trailing foot's heel off
            # it), so the bake never lifts it off its target.
            for eff, spec in pose["ik"].items():
                if eff.startswith("foot") and spec["at"] not in ("bone", "free") and not spec.get("planted"):
                    surface = self.stage.point(spec["at"], side).z
                    if pose["place"] in SHIP_STANDS:
                        # On the ship, held there whatever the clip does
                        # after: a boot's sole kept clear.
                        surface += SHIP_SOLE
                    for _ in range(3):
                        self.solve(eff, at[eff], spec.get("pole"))
                        self.level_foot(eff)
                        low = min(self.toes(eff) - TOE_CLEAR, self.world(EFFECTORS[eff][2]).z - HEEL_CLEAR) - surface
                        if low >= -1e-4:
                            break
                        at[eff].z -= low
        for eff, spec in pose["ik"].items():
            if spec.get("grip") is not None and eff.startswith("hand"):
                # A hand that grips: turned to it with the arm on its target,
                # and kept so against the forearm, as a joint of the key.
                self.solve(eff, at[eff], spec.get("pole"), spec["grip"], side)
                rot[eff] = self.bones[eff].rotation_quaternion.copy()
        return {"rot": rot, "place": place, "ik": pose["ik"], "side": side, "at": at,
                "pelvis": self.bones["pelvis"].location.copy()}

    def pose(self, pose, side=1):
        """Sets a pose from the library, placed and IK solved."""
        k = self.key(pose, side)
        for eff, spec in k["ik"].items():
            self.solve(eff, self.target(spec, side, eff), spec.get("pole"), spec.get("grip"), side)
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
        # Placed standing at the wheel, every key: nothing lies on a seat.
        self.standing = False
        # Placed on the trapeze, every key: nothing lies on a seat, and the
        # cloth hangs from a body lying out.
        self.trapeze = False
        # Placed on the rail, every key: sat on the deck's edge, the legs
        # over the side.
        self.rail = False
        # Placed on the ship (stage.Ship), every key: at which of her
        # places; and whether sat there (on her hatch), its cloth laid on it.
        self.ship = None
        self.seated = False
        # The file it is written to beside the look's clips, if not theirs.
        self.group = None


def make(fig, lib, name):
    """Bakes one clip of the library on the figure."""
    spec = lib.clips[name]
    m = lib.motion
    fps = m["fps"]
    keys = spec["keys"]
    # The clip's side, and each key's: a key may sit on the other side
    # (a tack's cross ends there), which on the port side's clip is the
    # starboard.
    side = spec.get("side", 1)
    sides = [side * (-1 if k.get("side") == "port" else 1) for k in keys]
    kp = [fig.key(lib.poses[k["pose"]], s) for k, s in zip(keys, sides)]
    # The placement is the first key's: a clip sits where it starts. A key
    # placed elsewhere is moved there by the hips, which carry everything.
    place = kp[0]["place"]
    for p in kp[1:]:
        travel(fig, p, place)
    n = len(keys)
    loop = bool(spec.get("loop"))

    # The timeline: each key's hold, after the ramp into it.
    names = fig.names
    logs = [{b: log(p["rot"][b]) for b in names} for p in kp]
    for b in names:
        for i in range(1, n):
            logs[i][b] = nearest(logs[i][b], logs[i - 1][b])
    for i, p in enumerate(kp):
        logs[i][PELVIS_AT] = np.array(p["pelvis"], float)
    channels = names + [PELVIS_AT]
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
    clip.standing = all(lib.poses[k["pose"]]["place"] == STANDS for k in keys)
    clip.trapeze = all(lib.poses[k["pose"]]["place"] == TRAPEZE for k in keys)
    clip.rail = all(lib.poses[k["pose"]]["place"] == RAIL for k in keys)
    # Placed on the ship, every key: from her place of its pose's (the
    # brace's fall, the top, the yard).
    ship = lib.poses[keys[0]["pose"]]["place"]
    clip.ship = ship if ship in SHIP_STANDS and all(lib.poses[k["pose"]]["place"] == ship for k in keys) else None
    clip.group = spec.get("group")
    # On the trapeze the skirts hang from the body as it lies (Figure.hang);
    # any clip may hang its chains so (on the rail, the coat's back).
    fig.hang = spec.get("hang") or (HANG if clip.trapeze else None)
    # Feet that stay where they are: in the boat, never stepping elsewhere.
    still = all(p["place"] == place for p in kp)
    if still and clip_ship_place(lib, keys):
        # On the ship a foot every key sets on the same place stands on one
        # point: the first key's (each key's own differs by the toes' set).
        for e in ("foot_l", "foot_r"):
            if all(p["ik"].get(e) == kp[0]["ik"].get(e) for p in kp) and e in kp[0]["at"]:
                for p in kp[1:]:
                    p["at"][e] = kp[0]["at"][e].copy()
    clip.planted = ["foot_l", "foot_r"] if all(p["place"] for p in kp) and still else []
    # The hips carry the figure elsewhere: their turn is a journey, not a
    # joint's.
    clip.notes["travels"] = not still
    # The joints the clip strains toward the ends of their ranges, as the
    # hike does (climbing in, a knee to the chest).
    clip.notes["strain"] = list(spec.get("strain") or [])
    if clip.ship == YARD:
        clip.notes["hips aft of the yard"] = round(fig.yard_aft, 4)
        clip.notes["hips over the yard"] = round(fig.yard_hips, 4)
    if clip.ship == TOP:
        clip.notes["out in the top"] = round(fig.top_out, 4)
    # How far each key's hands' and feet's targets are from their
    # shoulders and hips, as a share of the limb: past the reach the tables
    # allow, the IK falls short.
    reach = []
    for p in kp:
        fig.set_rotations(p["rot"], p["pelvis"])
        fig.arm.matrix_world = p["place"]
        for e in ("hand_l", "hand_r", "foot_l", "foot_r"):
            if e in p["ik"]:
                up, lo, _ = EFFECTORS[e]
                arm = fig.arm.data.bones[up].length + fig.arm.data.bones[lo].length
                reach.append(round((p["at"][e] - fig.world(up)).length / arm, 3))
    clip.notes["reach"] = reach

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
        if b in phases and b != PELVIS_AT:
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
    u = np.stack([raw(b, times) for b in channels], axis=1)  # time × channel × 3
    w = 2 * math.pi * filt["hz"]
    zeta = np.array([[filt["zeta"]["proximal"] if table(delays, b, 0) <= 2 else filt["zeta"]["distal"]]
                     for b in channels])
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
    out = {b: series[:, j] for j, b in enumerate(channels)}

    # The hands' targets, a blend of each key's, at each frame. The meshes
    # are left out meanwhile: only the skeleton need be evaluated.
    effs = sorted({e for p in kp for e in p["ik"]})
    clip_strain = set(spec.get("strain") or [])
    # A clip that clears its legs of the boat (climbing in over the side).
    clear = bool(spec.get("clear")) and any(p["place"] != Matrix() for p in kp)
    fig.quiet()
    fig.arm.matrix_world = place
    for f in range(frames + 1):
        s = f * dt
        rot = {b: exp(out[b][f]) for b in names}
        fig.set_rotations(rot, Vector(out[PELVIS_AT][f]))
        contacts = {}
        for e in effs:
            at = _effector_target(fig, kp, segs, e, s - delays["effector"] / fps, length, loop, side, contacts)
            if at is None:
                continue
            p, weight, x = at
            upper, lower, _ = EFFECTORS[e]
            fk = (fig.bones[upper].rotation_quaternion.copy(), fig.bones[lower].rotation_quaternion.copy())
            pole = _pole(kp, segs, e, s - delays["effector"] / fps, length, loop)
            fig.solve(e, p, pole)
            foot = None
            surface = _surface(fig, kp, segs, e, s - delays["effector"] / fps, length, loop) \
                if e.startswith("foot") else None
            if surface is not None:
                foot = fig.bones[EFFECTORS[e][2]].rotation_quaternion.copy()
                fig.level_foot(e)
                # The toes never under what the foot stands on: the foot
                # lifted, if they would be.
                # (On the ship a foot is held where its key set it: its
                # soles are judged against her deck, clip_ship.)
                for _ in range(0 if clip.ship else 2):
                    low = min(fig.toes(e) - TOE_CLEAR, fig.world(EFFECTORS[e][2]).z - HEEL_CLEAR) - surface
                    if low >= 0:
                        break
                    p = p + Vector((0.0, 0.0, -low))
                    fig.solve(e, p, pole)
                    fig.level_foot(e)
            if weight < 1.0:
                # Taken up or let go: the limb turned between its own pose
                # and the target's, not snapped to the target's elbow.
                for b, q in zip((upper, lower), fk):
                    fig.bones[b].rotation_quaternion = q.slerp(fig.bones[b].rotation_quaternion, weight)
                if foot is not None:
                    b = EFFECTORS[e][2]
                    fig.bones[b].rotation_quaternion = foot.slerp(fig.bones[b].rotation_quaternion, weight)
                fig.update()
        if "thigh" in clip_strain:
            # A strained hip at most at the end of its range.
            most = math.radians(m["ranges"]["thigh"] * m["gate"]["range-strain"]) - 0.01
            for side_name in ("l", "r"):
                pb = fig.bones["thigh_" + side_name]
                a = angle(Quaternion(), pb.rotation_quaternion)
                if a > most:
                    pb.rotation_quaternion = Quaternion().slerp(pb.rotation_quaternion, most / a)
            fig.update()
        if clear:
            # Nothing of a leg through the boat: a leg that would be is
            # lifted clear (as a ground-contact pass does); not one whose
            # foot is held on the boat.
            for side_name in ("l", "r"):
                if "foot_" + side_name not in contacts:
                    fig.clear_leg(side_name)
        fig.derive()
        clip.frames.append(fig.frame())
        clip.contacts.append(contacts)
    fig.quiet(False)
    for start, ramp, hold, a, ki, k in segs:
        # A loop of one key returns to itself: no move.
        if a is not None and ramp > 0 and a != ki:
            clip.ramps.append((int(round(start * fps)), int(round((start + ramp) * fps)), k.get("lead", "hips")))
    if loop and (clip.trapeze or clip.ship):
        # The IK's turns follow the frame before: round a loop they come
        # back a few tenths of a degree from where they began. The gap is
        # shared out over the loop, so its seam is smooth; not the hips'
        # nor the legs', whose feet stay where they press on the rack or the
        # ship's deck, her top or her footrope (and are put back on it).
        last = clip.frames[-1]
        for b in names:
            legs = kind(b) in ("thigh", "calf", "foot", "ball") or b.startswith("thigh_corrector")
            if kind(b) in ("Root", "pelvis") or legs:
                continue
            q0, q1 = clip.frames[0]["rot"][b], last["rot"][b]
            gap = q1.inverted() @ (q0 if q0.dot(q1) >= 0 else -q0)
            for i, fr in enumerate(clip.frames):
                fr["rot"][b] = fr["rot"][b] @ Quaternion().slerp(gap, i / frames)
        if clip.ship:
            fig.quiet()
            fig.arm.matrix_world = place
            for fr, contacts in zip(clip.frames, clip.contacts):
                feet = [e for e in contacts if e.startswith("foot")]
                if not feet:
                    continue
                fig.set_rotations(fr["rot"], fr["pelvis"])
                for e in feet:
                    fig.solve(e, contacts[e], _pole(kp, segs, e, 0.0, length, loop))
                fig.derive()
                fr["rot"] = fig.rotations()

            fig.quiet(False)
    if loop:
        # The end is the start.
        clip.frames[-1] = {"rot": {b: q.copy() for b, q in clip.frames[0]["rot"].items()},
                           "pelvis": clip.frames[0]["pelvis"].copy()}
    clip.notes["clamped"] = fig.clamped
    clip.made = True
    clip.ik = effs
    fig.hang = None
    return clip


# The place a figure stands at, not sits: at the wheel.
STANDS = "wheel"
# The place a figure stands on and lies out from: the trapeze's rack.
TRAPEZE = "trapeze"
# The place a figure sits at facing outboard, its legs over the side: a
# keelboat's rail.
RAIL = "rail"
# On the trapeze, the ankles this far above the rack's edge their feet
# press on.
ANKLE_UP = 0.08
# On the trapeze, how far each skirt chain is turned from where it follows
# the thighs to hang straight down: the back and the sides hang from the
# body lying out; the front lies along the thighs, as it does standing.
HANG = {"back": 1.0, "side": 0.85}


def clip_ship_place(lib, keys):
    """Whether every key of a clip is placed on the ship."""
    return all(lib.poses[k["pose"]]["place"] in SHIP_STANDS for k in keys)


# The places on the ship a pose stands at (stage.Ship's): hauling on the
# main brace beside its fall; in the main top; on the main topsail yard's
# footrope.
BRACE = "brace"
TOP = "top"
YARD = "yard"
SHIP_STANDS = (BRACE, TOP, YARD)
# The targets that are ropes a foot stands on, not floors: the footrope's.
ON_ROPE = ("yard-foot-in", "yard-foot-out")
# On the yard, the hips this far over its axis and at least this far aft of
# it, the body (not its arms) this far clear of it beyond its radius.
# In the top, the hand on the shroud this share of the arm from the
# shoulder.
TOP_REACH = 0.77
YARD_HIPS = 0.26
# Cloth laid on the ship's deck this much further off it than on a seat:
# her planks' seams are uneven.
SHIP_DECK_CLEAR = 0.006
# A foot standing on the ship's deck or top, this much higher than a foot
# set on a floor: it is held where its key sets it, and a boot's sole is
# thick.
SHIP_SOLE = 0.012
# The legs on the footrope straight to this share of their length.
YARD_LEGS = 0.9
YARD_AFT = 0.42
YARD_CLEAR = 0.03
# What of the body lies on the yard: what the hips, the back and the thighs
# carry (and the cloth on them); not the arms or the head.
YARD_BODY = ("pelvis", "spine_01", "spine_02", "spine_03", "thigh", "thigh_corrector", "skirt")


# The channel of the hips' place, beside the bones' turns.
PELVIS_AT = "pelvis.location"


# --- The skirts clear of the legs ---------------------------------------

# How far out of what it hangs over a skirt is kept, in every frame: the
# game's springs let it sag toward the legs by about half of this.
SKIRT_CLEAR = 0.015
# A figure this far or less aft of the ship's stage's place in the scene is
# on her (her stern is 16 m aft of it, and every other stage far aft).
SHIP_NEAR = 25.0
# How far in from a vertex a ray looks for the cloth over it.
SKIRT_DEPTH = 0.03
# The most a skirt bone is turned off its clip's pose, and in one step.
SKIRT_MOST = math.radians(100)
SKIRT_STEP = math.radians(20)
# Frames over which a skirt bone's turn is held and eased: a turn made for
# one frame grows before it and dies after it.
SKIRT_HOLD = 10
SKIRT_EASE = 8.0
# How far over the cloth laid on the seat a part of a leg must be to be
# judged against it: below, it sits on the cloth, not through it.
SKIRT_LAID = 0.005
# The least share of the cloth a skirt bone carries to be turned for it.
SKIRT_SHARE = 0.25
# Under this far through the cloth, a part touches it (metrics.TOUCH).
SKIRT_TOUCH = 0.003


def clear_skirts(fig, clip, under, skirts, rounds=16, passes=5, most=None):
    """Turns a clip's skirt chains, frame by frame, out of the way of what
    they hang over: a thigh swung back in a stride, a knee raised climbing,
    a leg kicking in the water. Where a ray in from a vertex of the thighs
    or knees (under: the mesh and its vertices) meets a skirt from outside
    within SKIRT_CLEAR of it, or inside it, the skirt bone that cloth hangs
    from is turned about its head to carry the cloth out; each bone's turns
    held and eased over the frames around, so the cloth moves as cloth
    does; and again, a few passes, where the easing left a frame short.
    No bone turned further than most off the clip's pose (SKIRT_MOST if not
    said). The skirts laid on the seat as the game lays them. Returns how
    many frames were changed."""
    if not under or not skirts:
        return 0
    chains = {s.name: _chains_of(s) for s in skirts}
    seated = clip.place != Matrix() and not getattr(clip, "standing", False) and \
        (not getattr(clip, "ship", None) or clip.seated)
    n = len(clip.frames)
    # A loop's last frame is its first again: the turns wrap round the
    # frames before it.
    m = n - 1 if clip.loop else n

    def at(g):
        return g % m if clip.loop else min(max(g, 0), n - 1)

    span = int(math.ceil(3 * SKIRT_EASE))
    w = np.exp(-0.5 * (np.arange(-span, span + 1) / SKIRT_EASE) ** 2)
    changed = set()
    for _ in range(passes):
        turns = []
        for fr in clip.frames[:m]:
            before = {b: q.copy() for b, q in fr["rot"].items() if b.startswith("skirt_")}
            turns.append(_solve_frame(fig, clip, fr, under, skirts, chains, seated, rounds, most or SKIRT_MOST))
            fr["rot"].update(before)
        names = sorted({c for t in turns for c in t})
        if not names:
            break
        changed |= {f for f, t in enumerate(turns) if t}
        # Each bone's turn, as a rotation vector in its own space: held over
        # the frames around, eased.
        for c in names:
            turn = np.array([np.array(turns[f].get(c, np.zeros(3)), float) for f in range(m)])
            size = np.linalg.norm(turn, axis=1)
            held = np.array([turn[max((at(g) for g in range(f - SKIRT_HOLD, f + SKIRT_HOLD + 1)),
                                      key=lambda g: size[g])] for f in range(m)])
            for f in range(m):
                near = [at(g) for g in range(f - span, f + span + 1)]
                eased = (held[near] * w[:, None]).sum(0) / w.sum()
                fr = clip.frames[f]
                fr["rot"][c] = (fr["rot"][c] @ exp(eased)).normalized()
    if clip.loop:
        clip.frames[-1] = {"rot": {b: q.copy() for b, q in clip.frames[0]["rot"].items()},
                           "pelvis": clip.frames[0]["pelvis"].copy()}
    fig.reset()
    return len(changed)


def laid(fig):
    """How high the cloth laid on the seat lies, while the figure sits on
    it (Figure.lay_on_seat): what of the legs is below it sits on the
    seat under the cloth. Off the seat, None."""
    ship = fig.stage.ship
    if ship is not None and fig.world("pelvis").y > ship.at.y - SHIP_NEAR:
        # On the ship: her hatch's, the only seat she has.
        on = [o.modifiers[n] for o, n in getattr(fig, "seat_mods", [])
              if o.modifiers[n].show_viewport and o.modifiers[n].target is ship.hatch_plane]
        return ship.hatch.z + max(m.offset for m in on) + SKIRT_LAID if on else None
    on = [o.modifiers[n] for o, n in getattr(fig, "seat_mods", [])
          if o.modifiers[n].show_viewport and o.modifiers[n].target is fig.stage.plane]
    return fig.stage.seat.z + max(m.offset for m in on) + SKIRT_LAID if on else None


def skirt_lines(fig, body, idx, skirts):
    """What of the body is through a skirt as the figure stands: each
    vertex's bone, where it is, its normal, and the skirt bone the cloth
    hangs from (or the pelvis) and the cloth's point."""
    from mathutils.bvhtree import BVHTree

    floor = laid(fig)
    co, no = coords_posed(body)
    names = {g.index: g.name for g in body.vertex_groups}
    out = []
    for s in skirts:
        chains = _chains_of(s)
        sco, _ = coords_posed(s)
        tree = BVHTree.FromPolygons([Vector(p) for p in sco], [list(f.vertices) for f in s.data.polygons])
        for i in idx:
            if floor is not None and co[i][2] < floor:
                continue
            n = Vector(no[i])
            hit = tree.ray_cast(Vector(co[i]) - n * 1e-4, -n, SKIRT_DEPTH)
            if hit[0] is not None and (Vector(co[i]) - hit[0]).dot(hit[1]) > 0 and hit[3] > SKIRT_TOUCH:
                bone = max((g.weight, names[g.group]) for g in body.data.vertices[i].groups)[1]
                out.append([bone, [round(float(x), 3) for x in co[i]], [round(float(x), 2) for x in n],
                            (chains[hit[2]] or [("pelvis", 1.0)])[0][0], [round(float(x), 3) for x in hit[0]]])
    return out


def _chains_of(obj):
    """Each face of a skirt's mesh: the skirt bones its cloth hangs from
    (skirt_back_l_02), each with its share, the most first; empty above
    them."""
    names = {g.index: g.name for g in obj.vertex_groups}
    per = []
    for v in obj.data.vertices:
        ws = {}
        for g in v.groups:
            n = names.get(g.group, "")
            if n.startswith("skirt_"):
                ws[n] = ws.get(n, 0.0) + g.weight
        per.append(ws)
    out = []
    for p in obj.data.polygons:
        total = {}
        for i in p.vertices:
            for c, w in per[i].items():
                total[c] = total.get(c, 0.0) + w
        out.append(sorted(((c, w / len(p.vertices)) for c, w in total.items()), key=lambda x: -x[1]))
    return out


def _solve_frame(fig, clip, fr, under, skirts, chains, seated, rounds, most=None):
    """One frame's skirt bones turned clear, in place in the frame: the
    bone that carries most of the cloth met, about its head (turning the
    bones below it). Returns each bone turned and its turn, a rotation
    vector in its own space."""
    from mathutils.bvhtree import BVHTree

    body, idx = under
    fig.set_rotations(fr["rot"], fr["pelvis"])
    fig.arm.matrix_world = clip.place
    fig.on_seat(seated and fig.world("pelvis").z > fig.stage.seat.z - 0.2)
    fig.update()
    start = {}
    floor = laid(fig)
    for _ in range(rounds):
        co, no = coords_posed(body)
        worst = {}
        for s in skirts:
            sco, _ = coords_posed(s)
            tree = BVHTree.FromPolygons([Vector(p) for p in sco], [list(f.vertices) for f in s.data.polygons])
            for i in idx:
                if floor is not None and co[i][2] < floor:
                    continue
                n = Vector(no[i])
                p = Vector(co[i])
                hit = tree.ray_cast(p + n * SKIRT_CLEAR, -n, SKIRT_DEPTH + SKIRT_CLEAR)
                # Cloth met from its inner side is beside the part, not
                # over it.
                if hit[0] is None or (p + n * SKIRT_CLEAR - hit[0]).dot(hit[1]) <= 0:
                    continue
                # Each bone that carries a good share of the cloth there
                # turned: the cloth between two chains moves with both.
                carried = [(c, w) for c, w in chains[s.name][hit[2]] if w >= SKIRT_SHARE]
                total = sum(w for _, w in carried)
                for c, _ in carried:
                    need = hit[3] / max(total, SKIRT_SHARE)
                    if need > worst.get(c, (0.0,))[0]:
                        worst[c] = (need, hit[0], n)
        if not worst:
            break
        a = fig.arm.matrix_world.to_3x3()
        for c, (d, q, n) in worst.items():
            pb = fig.bones[c]
            start.setdefault(c, pb.rotation_quaternion.copy())
            h = fig.world(c)
            r = q - h
            w = r.cross(n) * ((d + 0.002) / max(r.length_squared, 1e-6))
            if w.length < 1e-6:
                continue
            w = w.normalized() * min(w.length, SKIRT_STEP)
            # The turn, from the boat into the skeleton's space, about the
            # bone's head.
            turn = (a.inverted() @ Quaternion(w.normalized(), w.length).to_matrix() @ a).to_4x4()
            hl = pb.head.copy()
            pb.matrix = Matrix.Translation(hl) @ turn @ Matrix.Translation(-hl) @ pb.matrix
            pb.location = (0.0, 0.0, 0.0)
            pb.scale = (1.0, 1.0, 1.0)
            # Never further than the most off the clip's pose.
            most = most or SKIRT_MOST
            off = start[c].rotation_difference(pb.rotation_quaternion)
            if off.angle > most:
                pb.rotation_quaternion = start[c].slerp(pb.rotation_quaternion, most / off.angle)
        fig.update()
    out = {}
    for c, q in start.items():
        now = fig.bones[c].rotation_quaternion.copy()
        fr["rot"][c] = now
        out[c] = log(q.inverted() @ now)
    return out


def travel(fig, key, place):
    """A key placed elsewhere than the clip, moved there by the hips: its
    pelvis's turn and place in the figure's space so that, with the figure
    where the clip is placed, it is where the key's own placement puts it."""
    rel = place.inverted() @ key["place"]
    if all(abs(x) < 1e-9 for row in (rel - Matrix()) for x in row):
        return
    fig.set_rotations(key["rot"], key["pelvis"])
    pb = fig.bones["pelvis"]
    pb.matrix = rel @ pb.matrix
    fig.update()
    key["rot"]["pelvis"] = pb.rotation_quaternion.copy()
    key["pelvis"] = pb.location.copy()


def nearest(v, near):
    """A turn as a vector (its axis times its angle), as the one of its
    equals nearest another: a turn of more than half way round is also the
    turn the other way, and blending toward the wrong one goes the long way."""
    angle = float(np.linalg.norm(v))
    if angle < 1e-9:
        return v
    axis = v / angle
    best = v
    for k in (-1, 1):
        w = v + k * 2 * math.pi * axis
        if np.linalg.norm(w - near) < np.linalg.norm(best - near):
            best = w
    return best


def _ramp(fig, a, b, la, lb, m):
    """A ramp's length: the base, more for the largest turn, more for the
    furthest a target moves."""
    angle = max(float(np.linalg.norm(lb[n] - la[n])) for n in la if n != PELVIS_AT)
    # The hips' own travel, a key placed elsewhere.
    move = float(np.linalg.norm(lb[PELVIS_AT] - la[PELVIS_AT]))
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


def _key_target(fig, key, spec, e):
    """A key's target for an effector: on the figure, where that bone is
    now; on the boat, where the key found it (a reach is measured from the
    key's own pose, not from wherever the hips are on the way to it)."""
    if spec["at"] == "bone":
        return fig.target(spec, key["side"], e)
    return key["at"][e].copy()


def _surface(fig, kp, segs, e, s, length, loop):
    """The height of what a foot's target at s stands on in the boat (a
    floor, the strap, the deck), the higher of a ramp's two; None when it is
    on the figure or there is none."""
    s = s % length if loop else min(max(s, 0.0), length)
    for start, ramp, hold, a, ki, k in reversed(segs):
        if s >= start:
            break
    heights = []
    for key in (kp[ki],) + ((kp[a],) if a is not None and s < start + ramp else ()):
        t = key["ik"].get(e)
        # A foot against the rack's edge on the trapeze presses on it with
        # its ball, its sole across the rail: it stands on no floor.
        if t is not None and t["at"] not in ("bone", "free", "rack") + ON_ROPE:
            heights.append(fig.stage.point(t["at"], key["side"]).z)
    return max(heights) if heights else None


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
    """An effector's target at s (already delayed) and how much it holds
    the limb: the key's, or the blend of two keys' across a ramp, with the
    arc; None when neither key has one (the effector follows its bones).
    Across a ramp from a key without a target to one with, or back, the
    target is the one key's, taken up or let go by its weight."""
    s = s % length if loop else min(max(s, 0.0), length)
    for start, ramp, hold, a, ki, k in reversed(segs):
        if s >= start:
            break
    to = kp[ki]["ik"].get(e)
    if a is None or s >= start + ramp:
        if to is None:
            return None
        p = _key_target(fig, kp[ki], to, e)
        if to["at"] != "bone":
            contacts[e] = p
        return p, 1.0, None
    frm = kp[a]["ik"].get(e)
    if frm is None and to is None:
        return None
    x = (s - start) / ramp
    if frm is None:
        return _key_target(fig, kp[ki], to, e), ease(x), x
    if to is None:
        return _key_target(fig, kp[a], frm, e), 1.0 - ease(x), x
    pa = _key_target(fig, kp[a], frm, e)
    if frm == to and kp[a]["side"] == kp[ki]["side"]:
        if to["at"] != "bone":
            contacts[e] = pa
        return pa, 1.0, None
    pb = _key_target(fig, kp[ki], to, e)
    p = pa.lerp(pb, ease(x))
    if e.startswith("foot") and k.get("step"):
        # A step: the foot lifted clear of what is between its places; less
        # for a foot going down to its place.
        lift = k["step"] * (1.0 if pb.z >= pa.z - 0.02 else STEP_DOWN)
        p = p + Vector((0.0, 0.0, lift * bump(x)))
    arc = k.get("arc")
    if arc:
        # Out and up at the middle; less out on the way down.
        sign = 1.0 if e.endswith("_l") else -1.0
        out = fig.arm.matrix_world.to_quaternion() @ Vector((sign * arc[0], 0.0, arc[1]))
        p = p + out * bump(x) * (1.0 if pb.z > pa.z else 0.4)
    return p, 1.0, x


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


def export(path, arm, actions, gltfpack, work, places=None, fps=30):
    """The clips with the skeleton alone, packed: rotations and the
    pelvis's translation, a key a frame at fps (the scene's rate, which
    the exporter times the keys by); and where each clip is placed, by
    name (export.add_places)."""
    bpy.context.scene.render.fps = fps
    bpy.context.scene.render.fps_base = 1.0
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
    gltf, binary = files.read(raw)
    files.add_places(gltf, places or {})
    files.write_glb(raw, gltf, binary)
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

