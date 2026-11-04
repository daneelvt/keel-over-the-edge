# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The motion gate: what code checks of every clip, played back.

Each clip is read from its baked action a frame at a time (so a key the
skeleton ignores is caught, as quaternion keys on Euler bones once were),
and measured against tables.yaml's motion.gate, the motion study's
thresholds:

- the head's jerk on idles, the forearms' and hands' on every clip;
- the elbows' speed; the reach of an arm IK holds, shoulder to wrist over
  its length (a straight arm on a target pops);
- contacts held: a hand on the tiller or sheet, a locked foot, on its
  target; the ankles of a figure planted on the boat not drifting;
- the hands and fingers clear of the head, the torso and the hat;
- no joint beyond its share of its range (tables.yaml's motion.ranges);
- a loop's end its start, in pose and in speed (the change of speed across
  the seam beyond what the acceleration either side accounts for);
- in each ramp, the chain's onsets staggered (the torso hips to head, or
  the head first when it leads; an arm's joints apart);
- the head's peak speed against its median, on the lab's own clips:
  neither mechanical nor twitchy.

Strips and curves of each clip are review.py's.
"""

import math

import numpy as np
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree

import motion

# The chains whose onsets are checked: the arms by the upper arm (IK moves
# it and the forearm together) and the hand; the torso.
CHAINS = {
    "torso": ("spine_01", "spine_02", "spine_03", "neck_01", "head"),
    "arm_l": ("clavicle_l", "upperarm_l", "hand_l"),
    "arm_r": ("clavicle_r", "upperarm_r", "hand_r"),
}
# The chains drawn in the curves.
CURVES = {
    "torso": ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head"),
    "arm_l": ("clavicle_l", "upperarm_l", "lowerarm_l", "hand_l"),
    "arm_r": ("clavicle_r", "upperarm_r", "lowerarm_r", "hand_r"),
    "leg_l": ("thigh_l", "calf_l", "foot_l"),
    "leg_r": ("thigh_r", "calf_r", "foot_r"),
}
# A joint moves in a ramp when it turns faster than this, degrees a second;
# its onset is when it first reaches this share of its peak there.
MOVING = 5.0
ONSET = 0.2
# The parts the hands keep clear of, by the bone that carries them.
CLEAR_OF = ("head", "neck_01", "spine_01", "spine_02", "spine_03", "pelvis")
FINGER_TIPS = ("thumb_03", "index_03", "middle_03", "ring_03", "pinky_03")


class Track:
    """A clip played back: per frame, the world positions and rotations of
    the bones the gate reads."""

    def __init__(self, fig, clip, act, slot):
        import bpy

        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        scene = bpy.context.scene
        self.n = len(clip.frames)
        self.pos = {}
        self.rot = {}
        self.basis = {}
        names = [b.name for b in fig.arm.data.bones]
        for f in range(self.n):
            scene.frame_set(f)
            for b in names:
                pb = fig.bones[b]
                m = fig.arm.matrix_world @ pb.matrix
                self.pos.setdefault(b, []).append(np.array(m.to_translation()))
                self.rot.setdefault(b, []).append(m.to_quaternion())
                self.basis.setdefault(b, []).append(pb.rotation_quaternion.copy())
            self.pos.setdefault("head.tail", []).append(np.array(fig.arm.matrix_world @ fig.bones["head"].tail))
            for s in ("l", "r"):
                for tip in FINGER_TIPS:
                    b = f"{tip}_{s}"
                    self.pos.setdefault(b + ".tail", []).append(np.array(fig.arm.matrix_world @ fig.bones[b].tail))
        for k in self.pos:
            self.pos[k] = np.array(self.pos[k])
        motion.stop(fig.arm)

    def speed(self, b, fps, local=False):
        """A bone's angular speed, degrees a second, per frame: in the
        world, or against its parent (local)."""
        r = self.basis[b] if local else self.rot[b]
        out = [0.0] + [math.degrees(motion.angle(r[i - 1], r[i])) * fps for i in range(1, self.n)]
        return np.array(out)


def jerk(p, fps, where=False):
    """The largest jerk along a path sampled at fps, m/s³ (and the frame
    it is at)."""
    if len(p) < 4:
        return (0.0, 0) if where else 0.0
    j = np.linalg.norm(np.diff(p, n=3, axis=0) * fps ** 3, axis=1)
    i = int(np.argmax(j))
    return (float(j[i]), i + 2) if where else float(j[i])


def check(fig, clip, act, slot, gate, ranges, proxies):
    """The clip's measures and whether each passes."""
    fps = clip.fps
    tr = Track(fig, clip, act, slot)
    out = {}

    def add(name, value, limit, ok, **detail):
        out[name] = {"value": _r(value), "limit": _r(limit), "ok": bool(ok), **{k: _r(v) for k, v in detail.items()}}

    head = (tr.pos["head"] + tr.pos["head.tail"]) / 2
    if clip.idle:
        j, f = jerk(head, fps, where=True)
        add("head jerk", j, gate["head-jerk-idle"], j <= gate["head-jerk-idle"], at=f"frame {f}")
    j = max(max(jerk((tr.pos[f"lowerarm_{s}"] + tr.pos[f"hand_{s}"]) / 2, fps), jerk(tr.pos[f"hand_{s}"], fps))
            for s in ("l", "r"))
    add("hand jerk", j, gate["hand-jerk"], j <= gate["hand-jerk"])
    v = max(float(np.linalg.norm(np.diff(tr.pos[f"lowerarm_{s}"], axis=0), axis=1).max(initial=0.0)) * fps
            for s in ("l", "r"))
    add("elbow speed", v, gate["elbow-speed"], v <= gate["elbow-speed"])
    # The reach of the arms IK holds: a straight arm on a target pops.
    arms = [e[-1] for e in clip.ik if e.startswith("hand")]
    if arms:
        reach = 0.0
        for s in arms:
            length = fig.arm.data.bones[f"upperarm_{s}"].length + fig.arm.data.bones[f"lowerarm_{s}"].length
            d = np.linalg.norm(tr.pos[f"hand_{s}"] - tr.pos[f"upperarm_{s}"], axis=1)
            reach = max(reach, float(d.max()) / length)
        add("reach", reach, gate["reach"], reach <= gate["reach"])

    # Contacts.
    worst = 0.0
    for f, cs in enumerate(clip.contacts):
        for e, p in cs.items():
            end = tr.pos[motion.EFFECTORS[e][2]][f]
            worst = max(worst, float(np.linalg.norm(end - np.array(p))))
    add("contacts", worst, gate["contact"], worst <= gate["contact"], frames=sum(1 for c in clip.contacts if c))
    drift = 0.0
    for e in clip.planted:
        p = tr.pos[motion.EFFECTORS[e][2]]
        drift = max(drift, float(np.linalg.norm(p.max(0) - p.min(0))))
    add("ankle drift", drift, gate["ankle-drift"], drift <= gate["ankle-drift"], planted=list(clip.planted))

    # The hands clear of the head, the torso and the hat.
    least, where = math.inf, None
    for s in ("l", "r"):
        points = [f"hand_{s}"] + [f"{t}_{s}" for t in FINGER_TIPS] + [f"{t}_{s}.tail" for t in FINGER_TIPS]
        for f in range(tr.n):
            for b, tree in proxies.items():
                inv = _inverse(tr, b, f, fig)
                for pt in points:
                    q = inv @ Vector(tr.pos[pt][f])
                    hit = tree.find_nearest(q)
                    if hit[0] is not None and hit[3] < least:
                        least, where = hit[3], f"{pt} by the {b} at frame {f}"
    add("hand clearance", least, gate["hand-clearance"], least >= gate["hand-clearance"], at=where)

    # Ranges.
    worst, where = 0.0, None
    for b, qs in tr.basis.items():
        r = motion.table(ranges, b)
        if r is None:
            continue
        for f, q in enumerate(qs):
            share = math.degrees(motion.angle(Quaternion(), q)) / r
            if share > worst:
                worst, where = share, f"{b} at frame {f}"
    add("range", worst, gate["range-share"], worst <= gate["range-share"], at=where)

    # A loop's seam: its pose, and the change of speed across it beyond
    # what the acceleration either side accounts for.
    if clip.loop:
        pose = speed = 0.0
        where = None
        for b, qs in tr.basis.items():
            pose = max(pose, math.degrees(motion.angle(qs[0], qs[-1])))
            ring = qs[:-1]
            v = [motion.log(ring[k].inverted() @ ring[(k + 1) % len(ring)]) * fps for k in (-3, -2, -1, 0, 1)]
            before, across, after = v[1] - v[0], v[3] - v[2], v[4] - v[3]
            d = math.degrees(float(np.linalg.norm(across - (before + after) / 2)))
            if d > speed:
                speed, where = d, b
        add("loop pose", pose, gate["loop-degrees"], pose <= gate["loop-degrees"])
        add("loop speed", speed, gate["loop-speed"], speed <= gate["loop-speed"], at=where)

    # Onsets down the chains, in each ramp.
    bad = []
    for first, last, lead in clip.ramps:
        for chain, bones in CHAINS.items():
            order = bones[::-1] if lead == "head" and chain == "torso" else bones
            onsets = []
            for b in order:
                w = tr.speed(b, fps, local=True)
                window = w[first:min(last + 15, tr.n)]
                if len(window) == 0 or window.max() < MOVING or w[first] >= ONSET * window.max():
                    continue
                onsets.append((b, first + int(np.argmax(window >= ONSET * window.max()))))
            if chain == "torso":
                for (a, fa), (b, fb) in zip(onsets, onsets[1:]):
                    if fb <= fa:
                        bad.append(f"{b} at {fb} not after {a} at {fa}")
            else:
                # The wrist may lead the arm (a falling hand): apart is
                # enough.
                for (a, fa), (b, fb) in zip(onsets, onsets[1:]):
                    if fb == fa:
                        bad.append(f"{b} at {fb} with {a}")
    if clip.ramps:
        add("onsets", len(bad), 0, not bad, out_of_order=bad[:6])

    # The head's peak speed against its median, on the lab's clips: what
    # the threshold was found on (a retargeted clip's head moves as its
    # maker made it).
    w = tr.speed("head", fps)[1:]
    lo, hi = gate["head-peak-to-median"]
    if clip.made and len(w) and w.max() >= MOVING:
        ratio = float(w.max() / max(np.median(w), 1e-6))
        add("head peak to median", ratio, [lo, hi], lo <= ratio <= hi, peak=float(w.max()), median=float(np.median(w)))
    out["frames"] = tr.n
    out["notes"] = dict(clip.notes)
    return out, tr


def proxies(fig, kinds):
    """What the hands keep clear of, each part in its bone's rest space:
    the skin of the head, neck and torso, and the hair and hat on the
    head."""
    import bpy

    by_bone = {b: ([], []) for b in CLEAR_OF}
    for o in fig.meshes:
        k = kinds.get(o.name, "body")
        if k not in ("body", "hair", "hat"):
            continue
        me = o.data
        names = {g.index: g.name for g in o.vertex_groups}
        best = []
        for v in me.vertices:
            ws = [(g.weight, names.get(g.group)) for g in v.groups]
            best.append(max(ws)[1] if ws else None)
        for p in me.polygons:
            owners = {best[i] for i in p.vertices}
            if len(owners) != 1:
                continue
            (b,) = owners
            if k in ("hair", "hat"):
                b = "head"
            if b not in by_bone:
                continue
            verts, faces = by_bone[b]
            base = len(verts)
            verts.extend(o.matrix_world @ me.vertices[i].co for i in p.vertices)
            faces.append(list(range(base, base + len(p.vertices))))
    out = {}
    for b, (verts, faces) in by_bone.items():
        if faces:
            # Into the bone's rest space.
            inv = fig.arm.data.bones[b].matrix_local.inverted()
            out[b] = BVHTree.FromPolygons([inv @ v for v in verts], faces)
    bpy.context.view_layer.update()
    return out


def _inverse(tr, b, f, fig):
    """From the boat into a bone's rest space, at frame f."""
    from mathutils import Matrix

    m = Matrix.LocRotScale(Vector(tr.pos[b][f]), tr.rot[b][f], None)
    return m.inverted()


def _r(v):
    if isinstance(v, float):
        return None if math.isinf(v) else round(v, 4)
    if isinstance(v, (list, tuple)):
        return [_r(x) for x in v]
    if isinstance(v, (np.floating, np.integer)):
        return _r(v.item())
    return v
