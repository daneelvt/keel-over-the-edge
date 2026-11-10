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

A boat steered by a wheel has a stage of its own beside the dinghy
(tables.yaml's `wheel`): a flat deck, and the wheel standing before the
helmsman, made by the numbers the boat's model is built to. The helmsman
stands on the deck at the point its `sailor` node marks, between the feet,
facing forward: the hub ahead and above, its axle fore and aft, the spokes
round it and their handles beyond the rim. It is set in the stage's scene
well forward of the dinghy, clear of it; only its deck is solid (a hand on
a spoke grips it), and what of the figure is too near the wheel is
measured apart (Wheel.near). A clip placed at the wheel is placed from that
point, as the game places it from the boat's node.

A boat sailed from the trapeze has a stage of its own too (tables.yaml's
`trapeze`): its model, imported and set well forward of the dinghy and the
wheel. Its `trapeze` node says where the rack's edge is that the feet stand
on (at the helm's station, on the starboard side), where the hounds are
that the wires come down from, and where each ring hangs. The figure stands
on the rack's edge facing inboard, as it sits facing inboard on a side
deck, and lies back out over the water. A clip placed there is placed from
the rack's edge on its side, as the game places it from the model's node;
the model's hull, its racks and their net are solid as the dinghy's are.

A keelboat whose crew sit on the rail has a stage of its own as well
(tables.yaml's `rail`): her model, imported and set forward of the
others. Its `rail` node is the starboard deck's edge where the crew sit,
legs over the side, facing outboard; the topsides fall away below it. A
clip placed there is placed from the deck's edge on its side, as the game
places it from a station on the rail; her hull (with her deck and cuddy)
is solid, and the cloth a figure sits on is laid on her deck inboard of
the edge (Rail.plane), hanging free outboard of it.

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
        # The wheel's stage, if the tables give one: its deck is solid too.
        self.wheel = Wheel(spec["wheel"]) if spec.get("wheel") else None
        # The trapeze's, likewise: its hull is solid too.
        self.trapeze = Trapeze(root, spec["trapeze"]) if spec.get("trapeze") else None
        # The rail's, likewise: the keelboat's hull is solid too.
        self.rail = Rail(root, spec["rail"]) if spec.get("rail") else None
        self.tree = _tree(self.solid + ([self.wheel.deck] if self.wheel else []) +
                          (self.trapeze.solid if self.trapeze else []) + (self.rail.solid if self.rail else []))

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

    def wheel_point(self, name, side=1):
        """A place at the wheel (the deck at the helmsman's point, or a
        hand's grip on its spoke), on a side: as written (1), or mirrored
        across the centreline (-1)."""
        p = self.wheel.point(name)
        return Vector((side * (p.x - self.wheel.at.x) + self.wheel.at.x, p.y, p.z))

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
        if self.wheel is not None and name in self.wheel.points:
            return self.wheel_point(name, side)
        if self.trapeze is not None and name in Trapeze.POINTS:
            return self.trapeze.point(name, side)
        if self.rail is not None and name in Rail.POINTS:
            return self.rail.point(name, side)
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

    def show(self, shown, wheel=False, trapeze=False, rail=False):
        """Shows the dinghy's hull (shown), or the wheel's stage, or the
        trapeze's boat, or the rail's."""
        for o in self.objects:
            o.hide_render = not shown or wheel or trapeze or rail or o not in self.solid
        if self.wheel is not None:
            for o in self.wheel.objects:
                o.hide_render = not (shown and wheel)
        if self.trapeze is not None:
            for o in self.trapeze.objects:
                o.hide_render = not (shown and trapeze) or o.type != "MESH"
        if self.rail is not None:
            for o in self.rail.objects:
                o.hide_render = not (shown and rail) or o.type != "MESH" or o is self.rail.plane

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


class Wheel:
    """The wheel's stage, in the stage's scene (x to starboard, y forward,
    z up): the helmsman's point on the deck at `at`; the hub `hub.ahead`
    forward of it and `hub.up` above the deck, the axle fore and aft; the
    rim `radius` out, `spokes` spokes, the first straight up at rest, and
    their handles `handles` beyond the rim. The grips (`grips`) are where
    the hands hold the spokes: each a spoke's angle from the top, degrees,
    clockwise as the helmsman sees it (to starboard), and how far out
    along it from the hub."""

    # The rim's and the spokes' thickness, as radii: what a body keeps clear of.
    RIM = 0.025
    SPOKE = 0.018

    def __init__(self, spec):
        self.spec = spec
        self.at = Vector(spec["at"])
        self.hub = self.at + Vector((0.0, spec["hub"]["ahead"], spec["hub"]["up"]))
        self.radius = spec["radius"]
        self.spokes = spec["spokes"]
        self.handles = spec["handles"]
        self.points = {"deck": self.at.copy()}
        for name, (degrees, along) in spec["grips"].items():
            self.points[name] = self.spoke(degrees, along)
        self.objects = []
        self.deck = self._deck(spec["deck"])
        self.objects.append(self.deck)
        self.objects.append(self._wheel())
        for o in self.objects:
            o.hide_render = True

    def point(self, name):
        return self.points[name].copy()

    def spoke(self, degrees, along):
        """The point along a spoke at this angle from the top, this far
        from the hub."""
        a = np.radians(degrees)
        return self.hub + Vector((np.sin(a) * along, 0.0, np.cos(a) * along))

    def _deck(self, d):
        me = bpy.data.meshes.new("wheel-deck")
        w, l, t = d["width"] / 2, d["length"] / 2, d["thickness"]
        x, y, z = self.at
        verts = [(x + sx * w, y + sy * l, z - t * k) for k in (0, 1) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        me.from_pydata(verts, [], faces)
        me.update()
        o = bpy.data.objects.new("wheel-deck", me)
        bpy.context.scene.collection.objects.link(o)
        return o

    def _wheel(self):
        """The rim, the spokes out to their handles' ends and the hub, as
        one mesh: for the sheets."""
        import bmesh

        bm = bmesh.new()
        ring = 64
        sides = 8
        # The rim, a tube round the hub in the plane across the boat.
        rows = []
        for i in range(ring):
            a = 2 * np.pi * i / ring
            c = Vector((np.sin(a), 0.0, np.cos(a)))
            row = []
            for j in range(sides):
                b = 2 * np.pi * j / sides
                n = c * np.cos(b) + Vector((0.0, np.sin(b), 0.0))
                row.append(bm.verts.new(self.hub + c * self.radius + n * self.RIM))
            rows.append(row)
        for i in range(ring):
            for j in range(sides):
                a, b = rows[i], rows[(i + 1) % ring]
                bm.faces.new((a[j], b[j], b[(j + 1) % sides], a[(j + 1) % sides]))
        # The spokes, square bars from the hub out past the rim.
        for k in range(self.spokes):
            a = 2 * np.pi * k / self.spokes
            d = Vector((np.sin(a), 0.0, np.cos(a)))
            side = Vector((np.cos(a), 0.0, -np.sin(a))) * self.SPOKE
            fore = Vector((0.0, self.SPOKE, 0.0))
            ends = [self.hub + d * 0.06, self.hub + d * (self.radius + self.handles)]
            vs = [[bm.verts.new(e + sx * side + sy * fore) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
                  for e in ends]
            for j in range(4):
                bm.faces.new((vs[0][j], vs[1][j], vs[1][(j + 1) % 4], vs[0][(j + 1) % 4]))
            bm.faces.new(vs[1])
        # The hub, a drum on the axle.
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.07, radius2=0.07, depth=0.12,
                              matrix=Matrix.Translation(self.hub) @ Matrix.Rotation(np.pi / 2, 4, "X"))
        me = bpy.data.meshes.new("wheel")
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new("wheel", me)
        bpy.context.scene.collection.objects.link(o)
        return o

    def near(self, points, skip=None):
        """Which points are within the rim's or a spoke's thickness of it
        (inside the wheel's wood): the indices, those skipped left out."""
        p = np.asarray(points, float) - np.array(self.hub)
        # In the wheel's plane (x, z) and along the axle (y).
        r = np.hypot(p[:, 0], p[:, 2])
        rim = np.hypot(r - self.radius, p[:, 1]) < self.RIM
        hit = rim.copy()
        a = np.arctan2(p[:, 0], p[:, 2])
        step = 2 * np.pi / self.spokes
        off = (a + step / 2) % step - step / 2
        across = np.abs(np.sin(off) * r)
        spoke = (across < self.SPOKE) & (np.abs(p[:, 1]) < self.SPOKE) & (r < self.radius + self.handles) & \
            (np.cos(off) > 0)
        hit |= spoke
        if skip is not None:
            hit &= ~np.asarray(skip, bool)
        return np.flatnonzero(hit)


class Trapeze:
    """The trapeze's stage: a boat's model sailed from the trapeze (spec
    `boat`), imported and moved by `at` in the stage's scene (x to
    starboard, y forward, z up). Its places, from its model: the rack's
    edge (`rack`), the hounds, each side's ring, the tiller extension's
    hinge and length, and the mainsheet's block on the floor
    (`trapeze-sheet`); each on a side, mirrored across the centreline for
    port."""

    POINTS = ("rack", "hounds", "ring", "trapeze-hinge", "trapeze-sheet")

    def __init__(self, root, spec):
        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            o.name = "trapeze-" + o.name
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        node = bpy.data.objects["trapeze-trapeze"]

        def blender(p):
            # The model's frame (x to starboard, y up, z aft) as the scene's.
            return Vector((p[0], -p[2], p[1])) + self.at

        self.rack = blender(list(node["rackEdge"]))
        self.hounds = blender(list(node["hounds"]))
        self.ring = blender(list(node["rings"][0]))
        self.hinge = bpy.data.objects["trapeze-extension"].matrix_world.translation.copy()
        self.extension = (bpy.data.objects["trapeze-grip"].matrix_world.translation - self.hinge).length
        self.sheet = bpy.data.objects["trapeze-sheet"].matrix_world.translation.copy()
        self.solid = [bpy.data.objects["trapeze-hull"]]

    def point(self, name, side=1):
        p = {"rack": self.rack, "hounds": self.hounds, "ring": self.ring, "trapeze-hinge": self.hinge,
             "trapeze-sheet": self.sheet}[name]
        return Vector((side * p.x, p.y, p.z))


class Rail:
    """The rail's stage: a keelboat's model (spec `boat`), imported and
    moved by `at` in the stage's scene (x to starboard, y forward, z up).
    Its places, from its model: the starboard deck's edge where the crew
    sit (`rail`, its node), mirrored across the centreline for port. The
    cloth under a figure seated there is laid on `plane`, the deck's
    height at the edge, from the cuddy's side out to the edge and no
    further (`span` fore and aft of the station): outboard of it, the cloth
    hangs down the topsides."""

    POINTS = ("rail",)

    def __init__(self, root, spec):
        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            o.name = "rail-" + o.name
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        self.edge = bpy.data.objects["rail-rail"].matrix_world.translation.copy()
        self.solid = [bpy.data.objects["rail-hull"]]
        self.tree = _tree(self.solid)
        # Inboard from the edge, the side deck to the cuddy's side: where a
        # ray down first meets something more than a hand's breadth above
        # the edge.
        x = self.edge.x
        while x > 0.0:
            hit = self.tree.ray_cast(Vector((x, self.edge.y, self.edge.z + ABOVE)), Vector((0, 0, -1)), 2 * ABOVE)
            if hit[0] is None or hit[0].z > self.edge.z + 0.1:
                break
            x -= 0.005
        self.inner = x
        me = bpy.data.meshes.new("rail-plane")
        y0, y1 = self.edge.y - spec["span"], self.edge.y + spec["span"]
        z = self.edge.z
        verts = []
        for s in (1, -1):
            verts += [(s * self.inner, y0, z), (s * self.edge.x, y0, z), (s * self.edge.x, y1, z), (s * self.inner, y1, z)]
        me.from_pydata(verts, [], [(0, 1, 2, 3), (7, 6, 5, 4)])
        self.plane = bpy.data.objects.new("rail-plane", me)
        bpy.context.scene.collection.objects.link(self.plane)
        self.plane.hide_render = True
        self.objects.append(self.plane)

    def point(self, name, side=1):
        p = {"rail": self.edge}[name]
        return Vector((side * p.x, p.y, p.z))

    def down(self, x, y):
        """The height of the first surface of the keelboat a ray straight
        down at (x, y) meets, or None."""
        hit = self.tree.ray_cast(Vector((x, y, self.edge.z + ABOVE)), Vector((0, 0, -1)), 2 * ABOVE)
        return None if hit[0] is None else hit[0].z


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
