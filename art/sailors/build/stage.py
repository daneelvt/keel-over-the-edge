# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The boat a sailor is judged and moved in: the game's own dinghy.

Read from its model (art/boats), as the game draws it: the hull's mesh,
which holds the hull, the side decks, the cockpit and its floor, and the
`sailor` node, the station the game seats the sailor at. In Blender's axes
once imported: x to starboard, y forward, z up, the waterline at z 0.

The places a sailor's hands and feet go are found from the model (the seat
on the side deck, the gunwale, the cockpit's floor, the hiking strap's node
`strap`) or taken from tables.yaml's `stage` as offsets from the seat (where
the hands hold the tiller extension and the mainsheet). They are kept in seat
space: forward, inboard and up from the seat, so the same pose sits on either
side. The aft hand holds the tiller extension, hinged at the tiller's end (its
node `extension`, its far end `grip`), anywhere along it: a hand's place on
the tiller is brought within the extension's length of the hinge, as the game
swings the extension to the hand. The mainsheet comes up from its block on
the floor to the hand, wherever it is.

The cockpit runs between the side decks' inner edges (`edge` out from the
centreline). A figure is seated with its face inboard; a vertex is through the boat
when the line from its bone to it crosses the hull, and a bone is when the
line down the skeleton from above the boat to it does (thin shells have no
inside to test, so what is crossed is counted instead).
"""

import os

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# The parts of the model a sailor may not pass through.
SOLID = ("hull",)

# How high above the deck a ray starts that looks down for it.
ABOVE = 3.0


class Stage:
    def __init__(self, root, spec):
        self.spec = spec
        path = os.path.join(root, "art", spec["boat"])
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        self.objects = [o for o in bpy.data.objects if o not in before]
        for o in self.objects:
            o.name = "boat-" + o.name
            o.hide_render = True
        bpy.context.view_layer.update()
        node = bpy.data.objects["boat-sailor"]
        self.station = float(node.matrix_world.translation.y)
        self.seat_height = float(node.matrix_world.translation.z)
        self.solid = [bpy.data.objects["boat-" + n] for n in SOLID]
        self.tree = _tree(self.solid)

        # The side deck under the hips, and the gunwale: the outermost
        # point of the hull at the seat's station, looking down.
        out = spec["seat"]["out"]
        top = self.down(out, self.station)
        if top is None:
            raise AssertionError(f"{spec['boat']}: no side deck {out} m out at the sailor's station")
        self.seat = Vector((out, self.station, top))
        xs = np.arange(out, 2.0, 0.005)
        hits = [x for x in xs if self.down(x, self.station) is not None]
        self.gunwale = Vector((hits[-1], self.station, self.down(hits[-1], self.station)))
        # The side deck's inner edge: inboard of the seat, where the deck
        # drops away to the cockpit.
        x = out
        while x > 0 and (self.down(x, self.station) or 0.0) > top - 0.1:
            x -= 0.005
        self.edge = x
        # The cockpit's floor: what a ray down inboard of the seat meets
        # first, where the feet go.
        fx = out - spec["floor"]["in"]
        floor = self.down(fx, self.station)
        if floor is None or floor > top - 0.1:
            raise AssertionError(f"{spec['boat']}: no cockpit floor {spec['floor']['in']} m inboard of the seat")
        self.floor = Vector((fx, self.station, floor))
        # The tiller extension, hinged at the tiller's end on the centreline
        # (the rudder amidships): the aft hand holds it anywhere along it.
        self.hinge = bpy.data.objects["boat-extension"].matrix_world.translation.copy()
        self.extension = (bpy.data.objects["boat-grip"].matrix_world.translation - self.hinge).length
        # The hiking strap, on the floor at the seat's station.
        self.strap = bpy.data.objects["boat-strap"].matrix_world.translation.copy()
        # The seat's plane, as the game lifts cloth to it: at the side deck's
        # height, over each side deck and out beyond the gunwale, for the
        # skirts' lift to find from below; not over the cockpit, where a
        # sailor crouched on the floor has cloth below it.
        me = bpy.data.meshes.new("seat-plane")
        y0, y1 = self.station - 1.5, self.station + 1.5
        far = self.gunwale.x + 0.25
        verts = []
        for s in (1, -1):
            verts += [(s * self.edge, y0, top), (s * far, y0, top), (s * far, y1, top), (s * self.edge, y1, top)]
        me.from_pydata(verts, [], [(0, 1, 2, 3), (7, 6, 5, 4)])
        self.plane = bpy.data.objects.new("seat-plane", me)
        bpy.context.scene.collection.objects.link(self.plane)
        self.plane.hide_render = True
        self.objects.append(self.plane)

    def down(self, x, y):
        """The height of the first surface a ray straight down at (x, y)
        meets, or None."""
        hit = self.tree.ray_cast(Vector((x, y, ABOVE)), Vector((0, 0, -1)), 2 * ABOVE)
        return None if hit[0] is None else hit[0].z

    def frame(self, side=1):
        """Seat space to boat space on a side (1 starboard, -1 port): x
        forward, y inboard, z up from the seat on that side."""
        seat = Vector((side * self.seat.x, self.seat.y, self.seat.z))
        return Matrix(((0, -side, 0, seat.x), (1, 0, 0, seat.y), (0, 0, 1, seat.z), (0, 0, 0, 1)))

    def point(self, name, side=1):
        """A named place in boat space: the seat, the gunwale, the floor,
        the strap, or one of the stage's offsets from the seat; a place on
        the tiller (tiller, tiller-hiking) brought onto the extension, within
        its length of its hinge, as the game swings it to the hand."""
        if name == "seat":
            return self.frame(side) @ Vector((0, 0, 0))
        if name == "gunwale":
            return Vector((side * self.gunwale.x, self.gunwale.y, self.gunwale.z))
        if name == "floor":
            return Vector((side * self.floor.x, self.floor.y, self.floor.z))
        if name == "strap":
            return self.strap.copy()
        fwd, inb, up = self.spec["points"][name]
        p = self.frame(side) @ Vector((fwd, inb, up))
        if name.startswith("tiller"):
            d = p - self.hinge
            if d.length > self.extension:
                p = self.hinge + d.normalized() * self.extension
        return p

    def facing(self, side=1):
        """The figure's turn to face inboard on a side: it faces -y in its
        own axes, x to its left."""
        return Matrix.Rotation(np.radians(-90.0 * side), 4, "Z")

    def show(self, shown):
        for o in self.objects:
            o.hide_render = not shown or o not in self.solid

    def under(self, p):
        """Whether a point is under a top of the boat: straight up, the
        first surface it meets faces up (it is seen from below)."""
        hit = self.tree.ray_cast(Vector(p), Vector((0, 0, 1)), 2.0)
        return hit[0] is not None and hit[1].z > 0

    def crossings(self, a, b):
        """How many of the segments a[i] → b[i] cross the boat."""
        return len(self.crossed(a, b))

    def crossed(self, a, b):
        """Which of the segments a[i] → b[i] cross the boat."""
        out = []
        for i, (p, q) in enumerate(zip(a, b)):
            d = Vector(q) - Vector(p)
            length = d.length
            if length < 1e-6:
                continue
            hit = self.tree.ray_cast(Vector(p), d / length, length)
            if hit[0] is not None:
                out.append(i)
        return out


    def keep_out(self, anchors, points, clear=0.002):
        """The points, each moved back toward its anchor to clear short of
        the boat where the line from one to the other crosses it: for a
        rigid figure posed for this seat."""
        out = np.array(points, float)
        for i, (p, q) in enumerate(zip(anchors, points)):
            d = Vector(q) - Vector(p)
            length = d.length
            if length < 1e-6:
                continue
            hit = self.tree.ray_cast(Vector(p), d / length, length)
            if hit[0] is not None:
                out[i] = np.array(hit[0] - d / length * clear)
        return out


def _tree(objs):
    """One BVH tree of the objects as they stand, in boat space."""
    dg = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        base = len(verts)
        verts.extend(o.matrix_world @ v.co for v in me.vertices)
        polys.extend([base + i for i in p.vertices] for p in me.polygons)
        e.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)
