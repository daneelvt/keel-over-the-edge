# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Clips from Quaternius' Universal Animation Library (CC0), retargeted.

The library's skeleton names its bones as MPFB's game_engine rig does,
case aside, so bones are matched by name. The retarget is by rotation,
each matched bone's world rotation from the source's, frame by frame:

- the arms (upper arm to fingers), which rest differently in the two rigs
  (the library's T-pose, MPFB's A-pose), point where the source's point
  and twist as it twists: for a bone with source rest Rs0 and target rest
  Rt0, A the least turn from the target's rest direction to the source's,
  its world rotation is Rs(t) Rs0⁻¹ A Rt0;
- the rest (the hips, spine, neck, head, clavicles, legs), which rest
  alike but whose joints the two rigs place differently (MPFB's pelvis
  joint points 48° away from the library's), turn from their rest as the
  source's turn from its: Rs(t) Rs0⁻¹ Rt0. Matching their directions would
  tilt the pelvis by the rigs' difference.

Directions are taken joint to joint (a bone's head to its chosen child's),
never from either rig's bone axes, which the importer guesses. The pelvis
is moved as the source's, scaled by the hips' heights. Bones the source
does not have (our own, the face) rest, but for those that follow others
(motion.Figure.derive).

The check, read back from the frames as set: every arm bone's direction
against the source's, and every other bone's turn from rest against the
source's, at every frame; the build fails over CHECK degrees (MPFB's pose
bones once ignored quaternion keys while set to Euler: 81–162° off). Feet
the clip stands on are then locked by IK where they stood, after its keys
are smoothed (SMOOTH, round a loop); and the clip is baked again.
"""

import math

import bpy
import numpy as np
from mathutils import Vector

import inputs
import motion

# The most a matched bone may point off the source's, in degrees.
CHECK = 0.5

# The bones matched by direction: those the rigs rest in different poses.
ALIGNED = ("upperarm", "lowerarm", "hand")
# The bones not matched: the fingers keep MPFB's relaxed rest (the
# library's rest flat, MPFB's curled; its idles hardly move them, and the
# lab poses the hands that hold anything).
UNMATCHED = ("thumb", "index", "middle", "ring", "pinky")

# The library's keys are smoothed over this many frames (a Gaussian's
# sigma), round a loop so its seam runs on smoothly: its idles have
# hitches the jerk gate finds.
SMOOTH = 2.0

# The child a bone points at, where it has more than one matched.
CHILD = {"root": "pelvis", "pelvis": "spine_01", "spine_03": "neck_01", "hand_l": "middle_01_l",
         "hand_r": "middle_01_r"}


def retarget(fig, name, spec, fps):
    """A clip of the library's, on the figure, checked; its Clip."""
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    fig.reset()
    fig.quiet()
    before = set(bpy.data.objects)
    actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=inputs.path(spec["file"]), bone_heuristic="TEMPERANCE")
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == "ARMATURE")
    act = src.animation_data.action
    first, last = (int(round(x)) for x in act.frame_range)

    tgt = fig.arm
    by_lower = {b.name.lower(): b.name for b in src.data.bones}
    pairs = {b.name: by_lower[b.name.lower()] for b in tgt.data.bones
             if b.name.lower() in by_lower and motion.kind(b.name) not in UNMATCHED}
    # A joint's position is in both rigs whether or not its bone is
    # matched: directions run to any child both have.
    both = {b.name: by_lower[b.name.lower()] for b in tgt.data.bones if b.name.lower() in by_lower}
    child = {t: _child(tgt, t, both) for t in pairs}

    # Rest: world rotations and joint-to-joint directions.
    sw = src.matrix_world
    rest_s = {t: _rotation(sw @ src.data.bones[s].matrix_local) for t, s in pairs.items()}
    rest_t = {t: tgt.data.bones[t].matrix_local.to_quaternion() for t in pairs}
    offset = {}
    for t, s in pairs.items():
        if motion.kind(t) in ALIGNED:
            dt = _direction(tgt.data.bones, t, child[t], lambda b: b.head_local)
            ds = _direction(src.data.bones, s, both.get(child[t]), lambda b: sw @ b.head_local)
            offset[t] = rest_s[t].inverted() @ dt.rotation_difference(ds) @ rest_t[t]
        else:
            offset[t] = rest_s[t].inverted() @ rest_t[t]
    hips_s = (sw @ src.data.bones[pairs["pelvis"]].head_local)
    hips_t = tgt.data.bones["pelvis"].head_local
    scale = hips_t.z / hips_s.z

    order = [b.name for b in tgt.data.bones]  # parents before children
    parent = {b.name: (b.parent.name if b.parent else None) for b in tgt.data.bones}
    rest_all = {b.name: b.matrix_local.to_quaternion() for b in tgt.data.bones}

    clip = motion.Clip(name, fps, bool(spec.get("loop")), bool(spec.get("idle")))
    sources = []
    for f in range(first, last + 1):
        scene.frame_set(f)
        world = {}
        rot = {}
        for b in order:
            p = parent[b]
            if b in pairs:
                pb = src.pose.bones[pairs[b]]
                world[b] = _rotation(sw @ pb.matrix) @ offset[b]
            else:
                # It rests on its parent.
                pw = world[p] if p else rest_all[b]
                world[b] = (pw @ rest_all[p].inverted() @ rest_all[b]) if p else rest_all[b]
            if p:
                rel = rest_all[p].inverted() @ rest_all[b]
                rot[b] = (rel.inverted() @ world[p].inverted() @ world[b]).normalized()
            else:
                rot[b] = (rest_all[b].inverted() @ world[b]).normalized()
        hips = sw @ src.pose.bones[pairs["pelvis"]].head
        sources.append({t: (_posed_direction(src, s, both.get(child[t])) if motion.kind(t) in ALIGNED
                            else _rotation(sw @ src.pose.bones[s].matrix) @ rest_s[t].inverted())
                        for t, s in pairs.items()})
        clip.frames.append({"rot": rot, "hips": hips_t + (hips - hips_s) * scale})

    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        if a not in actions:
            bpy.data.actions.remove(a)

    # The pelvis's translation, and the derived bones.
    for fr in clip.frames:
        fig.set_rotations(fr["rot"])
        pb = fig.bones["pelvis"]
        want = fr.pop("hips")
        fig.update()
        here = pb.head
        pb.location = pb.location + (pb.bone.matrix_local.to_3x3().inverted() @ (want - here)) \
            if pb.parent is None else _local_move(pb, want - here)
        fig.derive()
        fr["rot"] = fig.rotations()
        fr["pelvis"] = pb.location.copy()

    worst, where = check(fig, clip, sources, child, rest_t)
    clip.notes["direction error"] = round(worst, 3)
    if worst > CHECK:
        raise AssertionError(f"{name}: {where} points {worst:.1f}° off the source's (the most is {CHECK}°)")

    smooth(clip, SMOOTH)
    lock = spec.get("lock") or []
    if lock:
        _lock(fig, clip, lock)
        clip.planted = list(lock)
    fig.quiet(False)
    return clip


def _channels(frames):
    """Each bone's turns as vectors from the first frame's, and the
    pelvis's moves: arrays a frame a row."""
    names = list(frames[0]["rot"])
    base = {b: frames[0]["rot"][b] for b in names}
    chans = [np.array([motion.log(base[b].inverted() @ fr["rot"][b]) for fr in frames]) for b in names]
    chans.append(np.array([list(fr["pelvis"]) for fr in frames]))
    return names, base, chans


def _unchannel(frames, names, base, chans):
    for i, fr in enumerate(frames):
        fr["rot"] = {b: (base[b] @ motion.exp(chans[j][i])).normalized() for j, b in enumerate(names)}
        fr["pelvis"] = Vector(chans[-1][i])


def smooth(clip, sigma):
    """Every channel through a Gaussian of sigma frames: round a loop,
    or held at a clip's ends."""
    frames = clip.frames[:-1] if clip.loop else clip.frames
    n = len(frames)
    r = int(math.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    names, base, chans = _channels(frames)
    for arr in chans:
        if clip.loop:
            out = sum(w * np.roll(arr, -(i - r), axis=0) for i, w in enumerate(k))
        else:
            pad = np.concatenate([np.repeat(arr[:1], r, 0), arr, np.repeat(arr[-1:], r, 0)])
            out = sum(w * pad[i:i + n] for i, w in enumerate(k))
        arr[:] = out
    _unchannel(frames, names, base, chans)
    if clip.loop:
        clip.frames[-1] = {"rot": dict(frames[0]["rot"]), "pelvis": frames[0]["pelvis"].copy()}


def _child(arm, name, pairs):
    """The matched child a bone points at, or None."""
    kids = [c.name for c in arm.data.bones[name].children if c.name in pairs]
    want = CHILD.get(name.lower())
    if want in kids:
        return want
    return kids[0] if len(kids) == 1 else None


def _direction(bones, name, child, at):
    """A bone's rest direction: to its child's head, or along it."""
    b = bones[name]
    if child is not None:
        return (at(bones[child]) - at(b)).normalized()
    return (b.matrix_local.to_quaternion() @ Vector((0, 1, 0))).normalized()


def _posed_direction(arm, name, child):
    if child is None:
        return None
    m = arm.matrix_world
    return (m @ arm.pose.bones[child].head - m @ arm.pose.bones[name].head).normalized()


def _local_move(pb, move):
    """A pose bone's location after moving its head by move, in the
    armature's space."""
    parent = pb.parent.matrix @ pb.parent.bone.matrix_local.inverted() @ pb.bone.matrix_local
    return pb.location + parent.to_3x3().inverted() @ move


def check(fig, clip, sources, child, rest):
    """The worst angle, in degrees, between a matched bone and the
    source's, over every frame, read back from the frames as set; and
    where: an arm bone's direction against the source's, any other's turn
    from rest against the source's. The root's turn is not the pelvis's
    move, which is by the hips' heights."""
    worst, where = 0.0, None
    for f, (fr, src) in enumerate(zip(clip.frames, sources)):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        for t, want in src.items():
            if motion.kind(t) in ALIGNED:
                if want is None:
                    continue
                got = (fig.world(child[t]) - fig.world(t)).normalized()
                a = math.degrees(got.angle(want, 0.0))
            else:
                turn = fig.world_matrix(t).to_quaternion() @ rest[t].inverted()
                a = math.degrees(motion.angle(turn, want))
            if a > worst:
                worst, where = a, f"{t} at frame {f}"
    return worst, where


def _rotation(m):
    """A matrix's rotation, its scale taken out first."""
    return m.to_3x3().normalized().to_quaternion()


def _lock(fig, clip, effectors):
    """Holds the feet where they stood, through the clip, by IK."""
    at = {}
    for e in effectors:
        ps = []
        for fr in clip.frames:
            fig.set_rotations(fr["rot"], fr["pelvis"])
            ps.append(np.array(fig.world(motion.EFFECTORS[e][2])))
        at[e] = Vector(np.median(np.array(ps), axis=0))
    clip.contacts = []
    for fr in clip.frames:
        fig.set_rotations(fr["rot"], fr["pelvis"])
        for e in effectors:
            fig.solve(e, at[e])
        fig.derive()
        fr["rot"] = fig.rotations()
        clip.contacts.append(dict(at))

