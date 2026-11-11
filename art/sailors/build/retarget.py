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

A clip on a deck (`deck`) is set on a flat one, the soles at its height:
the whole body moved down or up by where the soles mostly are, its back
bent (and the neck and head the other way, so the eyes keep their line)
as far as keeps the head's joint under `head` over the deck while the hips
are down in a crouch, and each foot, while it bears on the deck, held to
it by IK: its lowest point (the heel under the ankle, or the sole under
the ball or the toes, as the build stands feet: motion.HEEL_CLEAR,
TOE_CLEAR) on the deck, and moving back at the clip's `speed`, the speed
it walks at over the ground (still, if none). What the IK takes up is let
go again while the foot is in the air. A foot bears on the deck while its
lowest point is within PLANTED of it, and is free past FREE.

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
from mathutils import Matrix, Quaternion, Vector

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
    # On a deck, crouched, the coat hangs from the body as it bends
    # (motion.Figure.hang).
    fig.hang = CROUCH_HANG if spec.get("deck") else None
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
    # Played over its own length, or slowed (or quickened) to `seconds`.
    count = last - first + 1
    if spec.get("seconds"):
        count = int(round(spec["seconds"] * fps)) + 1
    for i in range(count):
        t = first + (last - first) * i / max(count - 1, 1)
        scene.frame_set(int(math.floor(t)), subframe=t - math.floor(t))
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
    for e in spec.get("still") or []:
        _still(fig, clip, e[-1])

    smooth(clip, SMOOTH)
    # The file it is written to, beside the look's clips, if not theirs.
    clip.group = spec.get("group")
    lock = spec.get("lock") or []
    clip.deck = bool(spec.get("deck"))
    # Where on the ship it is set, if anywhere: leaning on her rail, sat on
    # her hatch.
    clip.ship = spec.get("stage")
    clip.seated = clip.ship == SHIP_HATCH
    if spec.get("deck"):
        _ground(fig, clip)
        if spec.get("head") is not None:
            _stoop(fig, clip, spec["head"])
        if clip.ship == SHIP_RAIL:
            rail = _lean(fig, clip)
        elif clip.seated:
            _sit(fig, clip)
        before = [{"rot": dict(fr["rot"]), "pelvis": fr["pelvis"].copy()} for fr in clip.frames]
        _plant(fig, clip, spec.get("speed", 0.0))
        if clip.notes["off the deck"] > 0.0005:
            # A straight leg short of the deck it pushes off: the body
            # lowered by as much, and the feet planted again.
            clip.frames = before
            _lower(fig, clip, clip.notes["off the deck"] + 0.001)
            _plant(fig, clip, spec.get("speed", 0.0))
        if clip.ship == SHIP_RAIL:
            _on_rail(fig, clip, rail)
        _hands_up(fig, clip)
        _clearance(fig, clip)
        if clip.loop:
            _steady_seam(clip)
        if clip.ship == SHIP_RAIL:
            # The hands where they rest on the rail as the clip has them
            # now, the rail's lock judged apart (the forearms on its line).
            for fr, cs in zip(clip.frames, clip.contacts):
                fig.set_rotations(fr["rot"], fr["pelvis"])
                for e in [e for e in cs if e.startswith("hand")]:
                    cs[e] = fig.world(e).copy()
            fig.clip = clip
            clip.place = _rail_place(fig, rail)
            clip.notes["rail moved out"] = round(rail["out"], 4)
        elif clip.seated:
            clip.place = _hatch_place(fig, clip)
    elif lock:
        _lock(fig, clip, lock)
        clip.planted = list(lock)
    if clip.ship:
        # Its contacts, made in the figure's space, where it is placed.
        clip.contacts = [{e: clip.place @ p for e, p in cs.items()} for cs in clip.contacts]
    # The joints it takes toward the ends of their ranges, as the hike
    # does (a deep crouch's knees and ankles).
    clip.notes["strain"] = list(spec.get("strain") or [])
    fig.hang = None
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


# A foot bears on the deck with its lowest point within this of it, and
# none past FREE: between, by a smooth share. Walking, it bears only while
# it moves back at BACK of the walk's speed or more.
PLANTED = 0.015
FREE = 0.035
BACK = 0.5
# Which of a foot's points bears is softened over this height, and how
# much a foot bears, and what the IK takes up, eased over this many frames
# (a Gaussian's sigma).
SOFT = 0.01
EASE = 1.5
# How far the coat's chains hang toward straight down from the body as it
# bends in a crouch: all the way, a coat's or an apron's front falling
# between the knees rather than laid along the raised thighs.
CROUCH_HANG = {"back": 1.0, "side": 1.0, "front": 1.0}
# A knee's thickness under its joint; and how far clear of the deck the
# fingers' tips are kept.
KNEE = 0.06
HANDS = 0.015
# The hips are down in a crouch this share of their height standing under
# where they stand.
CROUCH = 0.45
# The back is bent this far, at most, to keep the head down (degrees).
STOOP_MOST = 30.0


def _sole(fig, s):
    """A foot's points on what it stands on, as the build stands feet: the
    ankle above the heel, the ball and the toes' tip above the sole; each
    with how far above the deck it is when the foot bears there."""
    m = fig.arm.matrix_world
    return [(m @ fig.bones[f"foot_{s}"].head, motion.HEEL_CLEAR),
            (m @ fig.bones[f"ball_{s}"].head, motion.TOE_CLEAR),
            (m @ fig.bones[f"ball_{s}"].tail, motion.TOE_CLEAR)]


def _lowest(fig, s):
    """The foot's lowest point's height over the deck, and which it is."""
    pts = _sole(fig, s)
    k = min(range(len(pts)), key=lambda i: pts[i][0].z - pts[i][1])
    return pts[k][0].z - pts[k][1], k


def _ring(clip):
    """The frames that differ: a loop's last is its first."""
    return clip.frames[:-1] if clip.loop else clip.frames


def _close(clip):
    if clip.loop:
        clip.frames[-1] = {"rot": dict(clip.frames[0]["rot"]), "pelvis": clip.frames[0]["pelvis"].copy()}


def _steady_seam(clip):
    """A loop begun where its bones turn most steadily, so its seam falls
    in the smooth of the motion, not on a foot coming down: the frame
    where the change of any bone's turning across it is least beyond what
    the changes either side account for (as the clips' gate judges a
    seam). Its contacts go round with it."""
    ring = clip.frames[:-1]
    n = len(ring)
    worst = np.zeros(n)
    for b in ring[0]["rot"]:
        v = [motion.log(ring[k]["rot"][b].inverted() @ ring[(k + 1) % n]["rot"][b]) for k in range(n)]
        for k in range(n):
            before = v[k - 2] - v[k - 3]
            across = v[k] - v[k - 1]
            after = v[(k + 1) % n] - v[k]
            worst[k] = max(worst[k], float(np.linalg.norm(across - (before + after) / 2)))
    k = int(np.argmin(worst))
    ring = ring[k:] + ring[:k]
    clip.frames = ring + [{"rot": dict(ring[0]["rot"]), "pelvis": ring[0]["pelvis"].copy()}]
    if clip.contacts:
        contacts = clip.contacts[:-1]
        contacts = contacts[k:] + contacts[:k]
        clip.contacts = contacts + [dict(contacts[0])]
    clip.notes["begun at frame"] = k


def _ground(fig, clip):
    """The body moved down (or up) so the soles are mostly on the deck:
    the median, over the frames, of the lower foot's lowest point."""
    lows = []
    for fr in _ring(clip):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        lows.append(min(_lowest(fig, s)[0] for s in ("l", "r")))
    g = float(np.median(lows))
    pb = fig.bones["pelvis"]
    for fr in _ring(clip):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        pb.location = _local_move(pb, Vector((0.0, 0.0, -g)))
        fig.update()
        fr["pelvis"] = pb.location.copy()
    _close(clip)
    clip.notes["grounded by"] = round(-g, 4)


def _lower(fig, clip, by):
    """The body moved down by this much, every frame."""
    pb = fig.bones["pelvis"]
    for fr in _ring(clip):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        pb.location = _local_move(pb, Vector((0.0, 0.0, -by)))
        fig.update()
        fr["pelvis"] = pb.location.copy()
    _close(clip)
    clip.notes["lowered"] = round(by, 4)


def _stoop(fig, clip, most):
    """The back's bend shared evenly among its three joints (the chest
    turned as the source has it), then bent forward, the neck and head
    back as far, by the share of a crouch the hips are down: as far as
    keeps the head's joint under most over the deck in every frame
    crouched."""
    rest = fig.arm.data.bones["pelvis"].head_local.z
    frames = _ring(clip)
    spine = ("spine_01", "spine_02", "spine_03")
    bones = fig.arm.data.bones
    rest_q = {b: bones[b].matrix_local.to_quaternion() for b in ("pelvis",) + spine}
    for fr in frames:
        fig.set_rotations(fr["rot"], fr["pelvis"])
        chest = fig.world_matrix("spine_03").to_quaternion()
        pelvis = fig.world_matrix("pelvis").to_quaternion()
        for b in spine:
            fig.bones[b].rotation_quaternion = Quaternion()
        fig.update()
        # The chest's turn on the hips, as one turn about one axis.
        carried = pelvis @ rest_q["pelvis"].inverted() @ rest_q["spine_03"]
        turn = chest @ carried.inverted()
        axis, angle = turn.to_axis_angle()
        for b in spine:
            pb = fig.bones[b]
            head = pb.matrix.to_translation()
            r = Matrix.Rotation(angle / 3, 4, axis)
            pb.matrix = Matrix.Translation(head) @ r @ Matrix.Translation(-head) @ pb.matrix
            fig.update()
        fr["rot"] = fig.rotations()
    base = [dict(fr["rot"]) for fr in frames]

    def bent(fr, rot, degrees):
        fig.set_rotations(rot, fr["pelvis"])
        down = min(max((rest - fig.world("pelvis").z) / (CROUCH * rest), 0.0), 1.0)
        d = degrees * down * down * (3 - 2 * down)
        fig.turn([("spine_01", "x", d / 3), ("spine_02", "x", d / 3), ("spine_03", "x", d / 3),
                  ("neck_01", "x", -d / 2), ("head", "x", -d / 2)])
        return down

    def over(degrees):
        worst = -math.inf
        for fr, rot in zip(frames, base):
            if bent(fr, rot, degrees) >= 1.0:
                worst = max(worst, fig.world("head").z - most)
        return worst

    degrees = 0.0
    while over(degrees) > 0:
        degrees += 0.5
        if degrees > STOOP_MOST:
            raise AssertionError(f"{clip.name}: the head stays {over(degrees):.3f} m over {most} m "
                                 f"with the back bent {STOOP_MOST}°")
    top = -math.inf
    for fr, rot in zip(frames, base):
        if bent(fr, rot, degrees) >= 1.0:
            top = max(top, fig.world("head").z)
        fig.derive()
        fr["rot"] = fig.rotations()
    _close(clip)
    clip.notes["back bent"] = degrees
    clip.notes["head over the deck"] = round(top, 4) if top > -math.inf else None


def _plant(fig, clip, speed):
    """Each foot, while it bears on the deck, held to it by IK: its lowest
    point on the deck and moving back (the figure's +y: it faces -y) at
    speed; let go again in the air. Records each frame's contacts (the
    ankles' targets while it bears fully), the speed the source walked
    at, and how far a foot's point on the deck slides (over the deck as it
    moves back at speed) while it bears, and how far off the deck it is."""
    frames = _ring(clip)
    n = len(frames)
    dt = 1.0 / clip.fps
    back = Vector((0.0, speed * dt, 0.0))
    sides = ("l", "r")
    loop = clip.loop

    def at(f):
        return f % n if loop else min(max(f, 0), n - 1)

    # Each foot's sole as the source moves it: its lowest point's height,
    # and its points (the heel, the ball, the toes) with how much each is
    # the one bearing (the lowest, softly, so a roll from heel to toe is
    # smooth).
    soles = {s: [] for s in sides}
    for fr in frames:
        fig.set_rotations(fr["rot"], fr["pelvis"])
        for s in sides:
            soles[s].append(_bearing(fig, s) + (fig.world(f"foot_{s}"),))
    walked = []
    moves = {}
    for s in sides:
        sole = soles[s]

        def moved(f, g):
            """The foot's bearing point's move from frame f to g, on the deck."""
            _, pts, share, _ = sole[f]
            m = sum(((sole[g][1][i] - pts[i]) * share[i] for i in range(len(pts))), Vector())
            m.z = 0.0
            return m

        # Low on the deck; and, walking, moving back as a foot that bears
        # does (one passing low in the air moves forward). Smoothed, so it
        # comes down and lifts off over a few frames.
        w = []
        for f in range(n):
            share = 1.0 - _smooth((sole[f][0] - PLANTED) / (FREE - PLANTED))
            if speed > 0:
                going = (moved(f, at(f + 1)) + moved(at(f - 1), f)).y / (2 * dt)
                share *= _smooth(going / (BACK * speed))
            w.append(share)
        w = _gauss(w, EASE, loop)
        bearing = [x > 1e-3 for x in w]
        # Gone through from where the foot leaves the deck (round a loop),
        # so each time it bears is whole.
        start = 0
        if loop:
            start = next((f for f in range(n) if not bearing[f] and bearing[(f - 1) % n]), 0)
        order = [(start + i) % n for i in range(n)]
        # The correction, gathered while the foot bears: the bearing
        # point's own move undone, and the walk's put in its place.
        c = [None] * n
        acc = Vector()
        for i, f in enumerate(order):
            if not bearing[f]:
                acc = Vector()
                continue
            c[f] = acc.copy()
            g = order[i + 1] if i + 1 < n else (order[0] if loop else None)
            if g is None or not bearing[g]:
                continue
            m = moved(f, g)
            if min(w[f], w[g]) > 0.99:
                walked.append(m.y / dt)
            acc = acc + (back - m) * min(w[f], w[g])
        # In the air, what was taken up is let go before the foot comes
        # down again.
        i = 0
        while i < n:
            if c[order[i]] is not None:
                i += 1
                continue
            j = i
            while j < n and c[order[j]] is None:
                j += 1
            before = order[i - 1] if i > 0 else (order[-1] if loop else None)
            gone = c[before] if before is not None and c[before] is not None else Vector()
            span = j - i + 1
            for k in range(i, j):
                c[order[k]] = gone * (1.0 - _smooth((k - i + 1) / span))
            i = j
        c = [Vector(v) for v in zip(*(_gauss([v[d] for v in c], EASE, loop) for d in range(3)))]
        moves[s] = (w, c)
    clip.contacts = []
    for f, fr in enumerate(frames):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        contacts = {}
        for s in sides:
            w, c = moves[s]
            low = soles[s][f][0]
            lift = -low * w[f] if low > 0 else -low
            target = soles[s][f][3] + c[f] + Vector((0.0, 0.0, lift))
            _leg(fig, s, target, fig.world(f"calf_{s}"), w[f])
            if w[f] >= 0.999:
                contacts[f"foot_{s}"] = target.copy()
        fig.derive()
        fr["rot"] = fig.rotations()
        clip.contacts.append(contacts)
    _close(clip)
    if loop:
        clip.contacts.append(dict(clip.contacts[0]))
    # The result, read back: each time a foot bears fully, how far its
    # bearing points have slid over the deck (as it moves back at speed)
    # since it came down, and how far off the deck it is.
    slide = off = 0.0
    for s in sides:
        w = moves[s][0]
        after = []
        for fr in frames:
            fig.set_rotations(fr["rot"], fr["pelvis"])
            after.append(_bearing(fig, s))
        start = next((f for f in range(n) if w[f] < 0.999), 0) if loop else 0
        acc = None
        for i in range(n + (1 if loop else 0)):
            f = (start + i) % n
            if w[f] < 0.999:
                acc = None
                continue
            off = max(off, abs(after[f][0]))
            if acc is None:
                acc = Vector()
            else:
                e = (start + i - 1) % n
                _, pts, share = after[e]
                m = sum(((after[f][1][k] - pts[k]) * share[k] for k in range(len(pts))), Vector()) - back
                m.z = 0.0
                acc = acc + m
                slide = max(slide, acc.length)
    clip.notes["speed"] = speed
    clip.notes["speed walked"] = round(float(np.mean(walked)), 4) if walked else 0.0
    clip.notes["slide"] = round(slide, 4)
    clip.notes["off the deck"] = round(off, 4)


def _bearing(fig, s):
    """A foot's lowest point's height over the deck; its points (the heel,
    the ball, the toes' tip, each as far over the deck as the sole under
    it); and how much each bears: the lowest most, softly (by SOFT)."""
    pts = _sole(fig, s)
    heights = [p.z - clear for p, clear in pts]
    low = min(heights)
    e = [math.exp(-(h - low) / SOFT) for h in heights]
    total = sum(e)
    return low, [p.copy() for p, _ in pts], [x / total for x in e]


def _gauss(values, sigma, loop):
    """A series through a Gaussian of sigma frames: round a loop, or held
    at its ends."""
    a = np.array(values, float)
    n = len(a)
    r = int(math.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    if loop:
        out = sum(wt * np.roll(a, -(i - r)) for i, wt in enumerate(k))
    else:
        pad = np.concatenate([np.repeat(a[:1], r), a, np.repeat(a[-1:], r)])
        out = sum(wt * pad[i:i + n] for i, wt in enumerate(k))
    return list(out)


def _clearance(fig, clip):
    """Nothing but the feet on the deck: how far clear of it the fingers'
    tips and the knees (their joints less a knee's thickness) are, and
    which is nearest."""
    clear, nearest = math.inf, None
    sides = ("l", "r")
    tips = [f"{d}_03_{s}" for d in motion.FINGERS for s in sides]
    for f, fr in enumerate(_ring(clip)):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        for name, z in [(b, fig.world(b, "tail").z) for b in tips] + \
                [(f"calf_{s}", fig.world(f"calf_{s}").z - KNEE) for s in sides]:
            if z < clear:
                clear, nearest = z, f"{name} at frame {f}"
    clip.notes["clear of the deck"] = round(clear, 4)
    clip.notes["nearest the deck"] = nearest


def _hands_up(fig, clip):
    """The elbows bent a little more, both alike through the clip, as far
    as keeps the fingers' tips HANDS clear of the deck: long arms hanging
    in a crouch."""
    frames = _ring(clip)
    tips = [f"{d}_03_{s}" for d in motion.FINGERS for s in ("l", "r")]
    base = [dict(fr["rot"]) for fr in frames]

    def lowest(degrees):
        low = math.inf
        for fr, rot in zip(frames, base):
            fig.set_rotations(rot, fr["pelvis"])
            if degrees:
                fig.turn([(f"lowerarm_{s}", "lx", degrees) for s in ("l", "r")])
            low = min([low] + [fig.world(b, "tail").z for b in tips])
        return low

    degrees = 0.0
    if lowest(0.0) < HANDS:
        # Which way the elbow bends the hand up: the forearm's own x.
        way = 1.0 if lowest(5.0) > lowest(-5.0) else -1.0
        while lowest(degrees) < HANDS:
            degrees += way
            if abs(degrees) > 30:
                raise AssertionError(f"{clip.name}: the fingers stay on the deck with the elbows bent 30° more")
        for fr, rot in zip(frames, base):
            fig.set_rotations(rot, fr["pelvis"])
            fig.turn([(f"lowerarm_{s}", "lx", degrees) for s in ("l", "r")])
            fig.derive()
            fr["rot"] = fig.rotations()
        _close(clip)
    clip.notes["elbows bent"] = abs(degrees)


def _smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def _leg(fig, s, target, knee, bears=1.0):
    """A leg's ankle to target, its knee in the plane it bent in (through
    the hip, the target and knee); the foot turned as it was in the world
    while it bears on the deck (bears 1), as it was on the shin in the air
    (0), and the toes as they were on the foot."""
    thigh, calf, foot, ball = (f"thigh_{s}", f"calf_{s}", f"foot_{s}", f"ball_{s}")
    world = fig.world_matrix(foot).to_quaternion()
    own = {b: fig.bones[b].rotation_quaternion.copy() for b in (foot, ball)}
    hip = fig.world(thigh)
    l1 = fig.arm.data.bones[thigh].length
    l2 = fig.arm.data.bones[calf].length
    d = Vector(target) - hip
    most = l1 + l2 - 1e-4
    if d.length > most:
        d = d.normalized() * most
    dn = d.normalized()
    toward = knee - hip
    toward = (toward - dn * toward.dot(dn)).normalized()
    a = (l1 * l1 - l2 * l2 + d.length_squared) / (2 * d.length)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    fig._aim(thigh, hip + dn * a + toward * h)
    fig._aim(calf, hip + d)
    for b, q in own.items():
        fig.bones[b].rotation_quaternion = q
    fig.update()
    if bears > 0:
        m = fig.world_matrix(foot)
        q = m.to_quaternion().slerp(world, bears)
        fig.bones[foot].matrix = fig.arm.matrix_world.inverted() @ Matrix.LocRotScale(m.to_translation(), q, None)
        fig.update()


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



# --- On the ship ----------------------------------------------------------

# The ship's places a retargeted clip is set at (stage.Ship's): leaning on
# her rail, facing outboard; sat on her hatch's forward edge, facing forward.
SHIP_RAIL = "ship-rail"
SHIP_HATCH = "ship-hatch"
# Leaning on the rail: the forearms' bones this far over the cap rail's top
# beyond the sleeve's own depth under them (the rail rises with her sheer
# along the forearms); each shoulder no higher over the
# forearms' line than this share of its upper arm (the back bent further if
# it would be), nor lower than this share; and how far the back may bend.
LEAN_CLEAR = 0.015
LEAN_HIGH = 0.97
LEAN_LOW = 0.25
LEAN_MOST = 35.0
# How much of the forearms' crossing before the chest is kept.
LEAN_CROSS = 0.7
# A hand is on the rail while its wrist is within this of where it rests on
# it, and off it past this more (raised to call out).
ON_RAIL = (0.03, 0.08)
# The bulwark's inner face this far out beyond the cap rail's inner edge
# (under its overhang), and the body kept this far off it; every this many
# frames looked at for it.
BULWARK_IN = 0.04
BULWARK_CLEAR = 0.05
# What of the body is kept off the bulwark: the hips, the back, the legs and
# the cloth on them (the arms reach over the rail, the head leans over it).
BULWARK_BODY = ("pelvis", "spine_01", "spine_02", "spine_03", "thigh", "thigh_corrector", "calf", "foot", "ball",
                "skirt")
SAMPLE = 6
# Sat on the hatch: the buttocks this far over its grating; the hatch's
# edge this far from the knees' joints, under the thighs.
SIT_CLEAR = 0.006
SIT_KNEE = 0.12


def _sleeve_depth(fig):
    """How far the sleeve stands out from the forearm's bone, at most, over
    both arms: the dressed vertices the forearm (or its twist) carries,
    their distance from its line, at rest."""
    fig.quiet(False)
    fig.reset()
    co = fig.dressed()
    owners = _owners(fig)
    most = 0.0
    for s in ("l", "r"):
        a, b = fig.world(f"lowerarm_{s}"), fig.world(f"hand_{s}")
        d = np.array(b - a)
        length = float(np.linalg.norm(d))
        d /= length
        pick = np.isin(owners, [f"lowerarm_{s}", f"lowerarm_twist_{s}", f"hand_{s}"])
        rel = co[pick] - np.array(a)
        t = rel @ d
        # Along the forearm and over the wrist, where a cuff flares.
        inside = (t > 0.15 * length) & (t < 1.1 * length)
        perp = rel[inside] - np.outer(t[inside], d)
        if len(perp):
            most = max(most, float(np.linalg.norm(perp, axis=1).max()))
    fig.quiet()
    return most


def _owners(fig):
    """Each vertex's bone, in dressed()'s order: the one weighing most on it."""
    out = []
    for o in fig.meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        out.extend(max(((g.weight, names.get(g.group, "")) for g in v.groups), default=(0, ""))[1]
                   for v in o.data.vertices)
    return np.array(out)


def _lean(fig, clip):
    """Leaning on the ship's rail (stage.Ship's `rail`): the rail, a line
    across the figure before it at the height of the cap rail's top over
    the deck the feet are on, the forearms' bones over it by the sleeve's
    depth; the back bent until each shoulder is within reach of it. Returns
    the rail's line: its height and its distance before the feet's middle
    (the figure faces -y), as the source's forearms rest."""
    ship = fig.stage.ship
    # The deck the feet stand on, a pace in from the rail, under its top.
    inboard = Vector((ship.rail.x - 0.45, ship.rail.y, ship.rail.z + 0.5))
    deck = ship.down(inboard.x, inboard.y, inboard.z)
    depth = _sleeve_depth(fig)
    height = ship.rail.z - deck + depth + LEAN_CLEAR
    frames = _ring(clip)
    spine = ("spine_01", "spine_02", "spine_03")
    bones = fig.arm.data.bones
    upper = {s: bones[f"upperarm_{s}"].length for s in ("l", "r")}
    base = [dict(fr["rot"]) for fr in frames]

    def bent(fr, rot, degrees):
        fig.set_rotations(rot, fr["pelvis"])
        if degrees:
            fig.turn([(b, "x", degrees / 3) for b in spine] + [("neck_01", "x", -degrees / 3),
                                                                ("head", "x", -degrees / 3)])

    def worst(degrees):
        hi, lo = -math.inf, math.inf
        for fr, rot in zip(frames, base):
            bent(fr, rot, degrees)
            for s in ("l", "r"):
                over = (fig.world(f"upperarm_{s}").z - height) / upper[s]
                hi, lo = max(hi, over), min(lo, over)
        return hi, lo

    degrees = 0.0
    hi, lo = worst(degrees)
    step = 0.5 if hi > LEAN_HIGH else -0.5 if lo < LEAN_LOW else 0.0
    while step and (hi > LEAN_HIGH if step > 0 else lo < LEAN_LOW):
        degrees += step
        if abs(degrees) > LEAN_MOST:
            raise AssertionError(f"{clip.name}: the shoulders stay {hi:.2f}–{lo:.2f} upper arms over the rail "
                                 f"with the back bent {degrees - step}° more")
        hi, lo = worst(degrees)
    # The rail before the feet, under the forearms' middles as the source
    # has them (their median over the clip).
    mids = []
    feet = []
    for fr, rot in zip(frames, base):
        bent(fr, rot, degrees)
        fig.derive()
        fr["rot"] = fig.rotations()
        for s in ("l", "r"):
            mids.append(((fig.world(f"lowerarm_{s}") + fig.world(f"hand_{s}")) / 2).y)
        feet.append(((fig.world("foot_l") + fig.world("foot_r")) / 2).y)
    _close(clip)
    clip.notes["back bent at the rail"] = degrees
    clip.notes["sleeve depth"] = round(depth, 4)
    clip.notes["rail over the deck"] = round(ship.rail.z - deck, 4)
    return {"height": height, "y": float(np.median(mids)), "feet": float(np.median(feet)),
            "deck": deck, "clear": depth + LEAN_CLEAR}


def _on_rail(fig, clip, rail):
    """The forearms laid on the rail's line: each elbow where its upper arm
    reaches the line's height nearest the source's elbow, the forearm level
    along the source's heading from it, by as much as the hand is on the
    rail (ON_RAIL: the source's wrist near where it rests). The wrists so
    placed are the clip's contacts; and how far each forearm's bone is off
    the line where it crosses it, and where along it, is recorded."""
    frames = _ring(clip)
    height = rail["height"]
    sides = ("l", "r")
    bones = fig.arm.data.bones
    l1 = {s: bones[f"upperarm_{s}"].length for s in sides}
    l2 = {s: bones[f"lowerarm_{s}"].length for s in sides}
    # Where each wrist rests on the rail, as the source has it: its median
    # height; above that it is lifted off.
    rest = {}
    for s in sides:
        zs = []
        for fr in frames:
            fig.set_rotations(fr["rot"], fr["pelvis"])
            zs.append(fig.world(f"hand_{s}").z)
        rest[s] = float(np.median(zs))
    off, worst_t = 0.0, (1.0, 0.0)
    for f, fr in enumerate(frames):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        contacts = clip.contacts[f] if f < len(clip.contacts) else {}
        for s in sides:
            sh = fig.world(f"upperarm_{s}")
            el = fig.world(f"lowerarm_{s}")
            wr = fig.world(f"hand_{s}")
            lift = wr.z - rest[s]
            w = 1.0 - _smooth((lift - ON_RAIL[0]) / (ON_RAIL[1] - ON_RAIL[0]))
            if w <= 0.0:
                continue
            drop = sh.z - height
            rho = math.sqrt(max(l1[s] ** 2 - drop ** 2, 1e-8))
            flat = Vector((el.x - sh.x, el.y - sh.y, 0.0))
            if flat.length < 1e-6:
                flat = Vector((0.0, -1.0, 0.0))
            e = Vector((sh.x, sh.y, height)) + flat.normalized() * rho
            heading = Vector((wr.x - el.x, wr.y - el.y, 0.0))
            # Less crossed before the chest than the source's, so a hand
            # keeps off a broad chest.
            heading.x *= LEAN_CROSS
            heading.normalize()
            wrist = e + heading * l2[s]
            e = el.lerp(e, w)
            wrist = wr.lerp(wrist, w)
            hand = fig.bones[f"hand_{s}"].rotation_quaternion.copy()
            fig._aim(f"upperarm_{s}", e)
            fig._aim(f"lowerarm_{s}", wrist)
            fig.bones[f"hand_{s}"].rotation_quaternion = hand
            fig.update()
            if w >= 0.999:
                contacts[f"hand_{s}"] = fig.world(f"hand_{s}").copy()
                a, b = fig.world(f"lowerarm_{s}"), fig.world(f"hand_{s}")
                if abs(b.y - a.y) > 1e-6:
                    t = (rail["y"] - a.y) / (b.y - a.y)
                    z = a.z + (b.z - a.z) * t
                    off = max(off, abs(z - height))
                    worst_t = (min(worst_t[0], t), max(worst_t[1], t))
        fig.derive()
        fr["rot"] = fig.rotations()
        if f < len(clip.contacts):
            clip.contacts[f] = contacts
    _close(clip)
    if clip.loop and clip.contacts:
        clip.contacts[-1] = dict(clip.contacts[0])
    clip.notes["forearms off the rail"] = round(off, 4)
    clip.notes["rail along the forearms"] = [round(worst_t[0], 3), round(worst_t[1], 3)]


def clip_of(fig):
    """The clip the figure is being set in."""
    return fig.clip


def _rail_place(fig, rail):
    """From the figure's space to the ship's, leaning on the starboard
    rail facing outboard: the rail's line before the feet at the rail's
    point (the cap's inner edge on its top), the deck under the feet."""
    ship = fig.stage.ship
    top = rail["height"] - rail["clear"]
    # The bulwark's inner face under the cap's overhang: the body (not its
    # arms or head, which reach and lean over the rail) kept BULWARK_CLEAR
    # off it, the rail
    # moved out from the figure as far as that takes.
    face = rail["y"] - BULWARK_IN
    fig.quiet(False)
    near = math.inf
    for fr in _ring(clip_of(fig))[::SAMPLE]:
        fig.set_rotations(fr["rot"], fr["pelvis"])
        fig.derive()
        co = fig.dressed()[fig.carried(BULWARK_BODY)]
        below = co[co[:, 2] < top]
        if len(below):
            near = min(near, float((below[:, 1] - face).min()))
    fig.quiet()
    out = max(0.0, BULWARK_CLEAR - near) if near < math.inf else 0.0
    rail["out"] = out
    contact = Vector((0.0, rail["y"] - out, top))
    return Matrix.Translation(ship.point(SHIP_RAIL)) @ Matrix.Rotation(math.radians(90.0), 4, "Z") @ \
        Matrix.Translation(-contact)


def _seat_height(fig):
    """The lowest of what the figure sits on (the body and its fitted
    clothes) under the hips, in its space."""
    pelvis = fig.bones["pelvis"].head
    co = fig.dressed(fig.sitting)
    near = np.hypot(co[:, 0] - pelvis.x, co[:, 1] - pelvis.y) < motion.SEAT_REACH
    below = near & (co[:, 2] < pelvis.z)
    return float(co[below, 2].min())


def _sit(fig, clip):
    """Sat on the ship's hatch: the body moved down or up, frame by frame
    (sampled, then eased), so the buttocks are on its grating, its height
    over the deck the feet are on."""
    ship = fig.stage.ship
    seat = ship.hatch.z - ship.down(ship.hatch.x + 0.15, ship.hatch.y + 0.3, ship.hatch.z) + SIT_CLEAR
    frames = _ring(clip)
    n = len(frames)
    every = 5
    picks = sorted(set(list(range(0, n, every)) + [n - 1]))
    fig.quiet(False)
    moves = []
    for f in picks:
        fr = frames[f]
        fig.set_rotations(fr["rot"], fr["pelvis"])
        fig.derive()
        moves.append(seat - _seat_height(fig))
    fig.quiet()
    move = np.interp(np.arange(n), picks, moves)
    move = _gauss(list(move), 2.0, clip.loop)
    pb = fig.bones["pelvis"]
    for fr, d in zip(frames, move):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        pb.location = _local_move(pb, Vector((0.0, 0.0, float(d))))
        fig.update()
        fr["pelvis"] = pb.location.copy()
    _close(clip)
    clip.notes["seat over the deck"] = round(seat - SIT_CLEAR, 4)
    clip.notes["seated by"] = [round(float(min(move)), 4), round(float(max(move)), 4)]
    clip.notes["seat"] = seat - SIT_CLEAR


def _hatch_place(fig, clip):
    """From the figure's space to the ship's, sat on the hatch's forward
    edge facing forward: the edge under the thighs SIT_KNEE from the knees'
    joints (their median), at the grating's height."""
    ship = fig.stage.ship
    ys = []
    for fr in _ring(clip):
        fig.set_rotations(fr["rot"], fr["pelvis"])
        ys.append(((fig.world("calf_l") + fig.world("calf_r")) / 2).y)
    edge = Vector((0.0, float(np.median(ys)) + SIT_KNEE, clip.notes["seat"]))
    return Matrix.Translation(ship.point(SHIP_HATCH)) @ Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation(-edge)


def _still(fig, clip, s):
    """An arm (s, its side) kept as the clip's first frame has it, on the
    body as it moves: a gesture of the source's left out (a hand raised to
    the brow, which a hat's brim is in the way of)."""
    first = clip.frames[0]["rot"]
    bones = [b for b in first if b.endswith("_" + s) and motion.kind(b) in motion.ARMS and motion.kind(b) != "clavicle"]
    for fr in clip.frames:
        fig.set_rotations(fr["rot"], fr["pelvis"])
        for b in bones:
            fig.bones[b].rotation_quaternion = first[b]
        fig.derive()
        fr["rot"] = fig.rotations()
    clip.notes["still"] = clip.notes.get("still", []) + [f"arm_{s}"]

