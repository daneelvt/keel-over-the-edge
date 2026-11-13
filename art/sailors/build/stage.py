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

A beach cat has a stage of its own (tables.yaml's `cat`): her model,
imported and set forward of the others, and a second of her lying on her
side (capsized to port), beside the first. Her `aboard` node gives, on her
starboard side, the hull's deck at its inner and outer edges at the helm's
and the crew's stations and the hiking strap there, the net, and the boom's
underside; her sailors sit on the hull facing inboard (the legs across the
net, the feet under the strap), sit out on its outer edge, lie out on the
wire from it, cross the net on it, and stand on her lower hull lying on her
side, hauling her up on the righting line over the upper one (Cat).

The cockpit runs between the side decks' inner edges (`edge` out from the
centreline). A figure is seated with its face inboard; a vertex is through the boat
when the line from its bone to it crosses the hull, and a bone is when the
line down the skeleton from above the boat to it does (thin shells have no
inside to test, so what is crossed is counted instead).
"""

import os
import re

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
        # The ship's, judged apart (Ship.tree): she stands far higher than
        # the rest, and her ropes are held.
        self.ship = Ship(root, spec["ship"]) if spec.get("ship") else None
        # The beach cat's, judged apart too (Cat.tree): her net gives, and
        # her straps and ropes are held.
        self.cat = Cat(root, spec["cat"]) if spec.get("cat") else None
        # The yacht's, judged apart too (Yacht.tree): her ropes are held,
        # her wheels measured apart.
        self.yacht = Yacht(root, spec["cruiser"]) if spec.get("cruiser") else None
        # The catamaran's, judged apart too (Bridgedeck.tree): her ropes and
        # rails are held, her wheel measured apart.
        self.bridge = Bridgedeck(root, spec["bridgedeck"]) if spec.get("bridgedeck") else None
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
        if self.ship is not None and name in Ship.POINTS:
            return self.ship.point(name, side)
        if self.cat is not None and name in Cat.POINTS:
            return self.cat.point(name, side)
        if self.yacht is not None and (name in Yacht.POINTS or name in self.yacht.grips):
            return self.yacht.point(name, side)
        if self.bridge is not None and name in self.bridge.places:
            return self.bridge.point(name, side)
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

    def show(self, shown, wheel=False, trapeze=False, rail=False, ship=False, cat=None, yacht=False, bridge=False):
        """Shows the dinghy's hull (shown), or the wheel's stage, or the
        trapeze's boat, or the rail's, or the ship, or the beach cat
        (cat: upright, or lying on her side, capsized), or the yacht, or the
        catamaran (bridge)."""
        for o in self.objects:
            o.hide_render = not shown or wheel or trapeze or rail or ship or bool(cat) or yacht or bridge or \
                o not in self.solid
        if self.bridge is not None:
            for o in self.bridge.objects:
                o.hide_render = not (shown and bridge) or o.type != "MESH" or o in self.bridge.planes or \
                    o in self.bridge.hidden
        if self.yacht is not None:
            for o in self.yacht.objects:
                o.hide_render = not (shown and yacht) or o.type != "MESH" or o in self.yacht.planes or \
                    o in self.yacht.hidden
        if self.cat is not None:
            for o in self.cat.objects:
                o.hide_render = not (shown and cat) or o.type != "MESH" or o in self.cat.planes or \
                    o in self.cat.hidden or \
                    (o in self.cat.lying) != (cat == "capsized")
        if self.ship is not None:
            for o in self.ship.objects:
                o.hide_render = not (shown and ship) or o.type != "MESH" or o in self.ship.planes
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


class Ship:
    """The ship's stage: the tall ship's model (spec `boat`), imported and
    moved by `at` in the stage's scene (x to starboard, y forward, z up),
    far forward of the rest. Its places, from her model's `company` node
    (the starboard side's; the port's the mirror): her quarterdeck's rail,
    the fore hatch's forward edge, the ladder at the quarterdeck's break, the
    main shrouds and their ratlines, the futtock and topmast shrouds, the
    main top, the main topsail yard's footrope and the main brace's lead and
    fall. Her hull (decks, bulwarks, rails, ladders, hatches, channels), her
    mainmast's spars and top and her main yards are solid (`tree`); the
    ropes a sailor holds or stands on (the shrouds, ratlines, footropes) are
    `ropes`, which only what holds them may meet; and the topsail yard a
    sailor lying on it holds, which its hands may meet (`unheld` is the rest).
    Where a seated sailor's cloth lies on the hatch is `hatch_plane`."""

    POINTS = ("ship-rail", "ship-hatch", "ladder-foot", "ladder-head", "shroud", "top", "aloft", "topmast-shroud",
              "yard-foot-in", "yard-foot-out", "yard", "brace-lead", "brace-fall", "brace", "haul-deck")
    # The parts of her model a sailor is judged against.
    SOLID = ("hull", "mainmast", "main-yards", "main-topsail-yard")
    # The ropes among them, by their material.
    ROPE = "rope"
    # Where a figure stands on the footrope, out along it from the yard's
    # middle (a share of its run), and how far apart its feet are.
    YARD_AT = 0.2
    YARD_FEET = 0.24
    # The shrouds a figure climbs between, fore and aft (the main's second
    # and third), and how high up the ratlines it is staged.
    SHROUDS = (1, 2)
    SHROUD_AT = 0.3
    # The hauler's place along the brace's fall, from its lead; the feet's
    # middle this far inboard of the fall.
    BRACE_AT = 1.6
    HAUL_BESIDE = 0.06
    # The fall as it is hauled, this far over the lead on her rail.
    BRACE_UP = 0.1
    # Where a figure stands in the top: this far out from her middle toward
    # her shrouds; and the topmast shroud it holds, this share of the way
    # up from the top's rim.
    TOP_OUT = 1.47
    TOPMAST_AT = 0.14

    def __init__(self, root, spec):
        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            o.name = "ship-" + o.name
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        c = bpy.data.objects["ship-company"]

        def blender(p):
            # The model's frame (x to starboard, y up, z aft) as the scene's.
            return Vector((p[0], -p[2], p[1])) + self.at

        def rows(v):
            return [list(x) for x in v]

        self.rail = blender(list(c["rail"]))
        self.hatch = blender(list(c["hatch"]["edge"]))
        self.hatch_half = float(c["hatch"]["half"])
        lad = c["ladder"]
        self.ladder = (blender(list(lad["foot"])), blender(list(lad["head"])), int(lad["steps"]))
        self.shrouds = [(blender(a), blender(b)) for a, b in rows(c["shrouds"])]
        r = c["ratlines"]
        self.ratlines = (float(r["from"]) + self.at.z, float(r["to"]) + self.at.z, float(r["every"]))
        self.futtocks = [(blender(a), blender(b)) for a, b in rows(c["futtocks"])]
        self.topmast = [(blender(a), blender(b)) for a, b in rows(c["topmast"])]
        t = c["top"]
        self.top = blender(list(t["floor"]))
        self.top_size = (float(t["half"]), float(t["fore"]), float(t["aft"]))
        y = c["yard"]
        node = bpy.data.objects["ship-" + y["node"]]
        self.yard_node = node
        self.yard_radius = float(y["radius"])
        # The footrope, in the yard's node's frame (as the model's), into the scene.
        self.footrope = [node.matrix_world @ Vector((p[0], -p[2], p[1])) for p in rows(y["footrope"])]
        self.yard_at = node.matrix_world.translation.copy()
        b = c["brace"]
        up = Vector((0.0, 0.0, self.BRACE_UP))
        self.brace = (blender(list(b["lead"])) + up, blender(list(b["fall"])) + up)
        objs = [bpy.data.objects["ship-" + n] for n in self.SOLID]
        # Her hull, decks and all: what cloth hanging to her deck is laid on.
        self.deck = objs[0]

        def rope(o, p):
            slots = o.material_slots
            return p.material_index < len(slots) and slots[p.material_index].name.split(".")[0] == self.ROPE

        self.tree = _tree(objs, lambda o, p: not rope(o, p))
        self.ropes = _tree(objs, rope)
        # Her hull and mast without the yard a figure on it holds: what its
        # hands may not meet there.
        self.unheld = _tree([o for o in objs if o is not node], lambda o, p: not rope(o, p))
        # The hatch's top, from its forward edge aft, as the cloth of a
        # figure sat on its edge is laid on it.
        me = bpy.data.meshes.new("ship-hatch-plane")
        h = self.hatch
        w = self.hatch_half
        me.from_pydata([(h.x - w, h.y - 2 * w, h.z), (h.x + w, h.y - 2 * w, h.z), (h.x + w, h.y, h.z),
                        (h.x - w, h.y, h.z)], [], [(0, 1, 2, 3)])
        self.hatch_plane = bpy.data.objects.new("ship-hatch-plane", me)
        bpy.context.scene.collection.objects.link(self.hatch_plane)
        self.hatch_plane.hide_render = True
        self.objects.append(self.hatch_plane)
        self.planes = [self.hatch_plane]
        # The brace's fall, drawn for the sheets (the model has no braces):
        # from its lead along the deck, past the hauler.
        lead, fall = self.brace
        end = lead + (fall - lead).normalized() * (self.BRACE_AT + 1.2)
        import bmesh

        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.014, radius2=0.014,
                              depth=(end - lead).length,
                              matrix=Matrix.Translation((lead + end) / 2) @
                              (end - lead).to_track_quat("Z", "Y").to_matrix().to_4x4())
        for side in (1, -1):
            me = bpy.data.meshes.new("ship-fall")
            bm.to_mesh(me)
            o = bpy.data.objects.new("ship-fall", me)
            bpy.context.scene.collection.objects.link(o)
            if side < 0:
                o.matrix_world = Matrix.Translation((self.at.x, 0, 0)) @ Matrix.Scale(-1, 4, (1, 0, 0)) @ \
                    Matrix.Translation((-self.at.x, 0, 0))
            o.hide_render = True
            self.objects.append(o)
        bm.free()

    def footrope_at(self, f, side=1):
        """The footrope's point a share f along its run from the yard's
        middle to its arm, on a side."""
        n = len(self.footrope) - 1
        x = min(max(f, 0.0), 1.0) * n
        i = min(int(x), n - 1)
        p = self.footrope[i].lerp(self.footrope[i + 1], x - i)
        return self._side(p, side)

    def _side(self, p, side):
        """A place on the starboard side, on a side: mirrored across her
        centreline for port."""
        return Vector((self.at.x + side * (p.x - self.at.x), p.y, p.z))

    def brace_along(self, side=1):
        """Along the brace's fall toward its lead, level: the way a hauler
        faces."""
        d = self.point("brace-lead", side) - self.point("brace-fall", side)
        d.z = 0.0
        return d.normalized()

    def shroud_line(self, side=1):
        """The line up the shrouds a figure climbs between: from their
        middle at the deadeyes to their middle under the top."""
        a, b = self.SHROUDS
        top = (self.shrouds[a][0] + self.shrouds[b][0]) / 2
        foot = (self.shrouds[a][1] + self.shrouds[b][1]) / 2
        return self._side(foot, side), self._side(top, side)

    def point(self, name, side=1):
        if name == "yard-foot-in" or name == "yard-foot-out":
            run = (self.footrope[-1] - self.footrope[0]).length
            d = self.YARD_FEET / 2 / run * (1 if name == "yard-foot-out" else -1)
            return self.footrope_at(self.YARD_AT + d, side)
        if name == "yard":
            # The yard over the footrope's point where the figure stands.
            p = self.footrope_at(self.YARD_AT, 1)
            return self._side(Vector((p.x, self.yard_at.y, self.yard_at.z)), side)
        if name == "shroud":
            foot, top = self.shroud_line(1)
            return self._side(foot.lerp(top, self.SHROUD_AT), side)
        if name == "topmast-shroud":
            a, b = self.topmast[1]
            return self._side(b.lerp(a, self.TOPMAST_AT), side)
        if name == "brace":
            lead, fall = self.brace
            return self._side(lead + (fall - lead).normalized() * self.BRACE_AT, side)
        if name == "haul-deck":
            # Under the hauler: beside the fall, inboard of it, on the deck.
            along = self.brace_along(side)
            across = Vector((-along.y, along.x, 0.0))
            if across.x * side > 0:
                across = -across
            p = self.point("brace", side) + across * self.HAUL_BESIDE
            return Vector((p.x, p.y, self.down(p.x, p.y, p.z)))
        if name == "aloft":
            return self.point("top", side) + Vector((side * self.TOP_OUT, 0.0, 0.0))
        p = {"ship-rail": self.rail, "ship-hatch": self.hatch, "ladder-foot": self.ladder[0],
             "ladder-head": self.ladder[1], "top": self.top, "brace-lead": self.brace[0],
             "brace-fall": self.brace[1]}[name]
        return self._side(p, side)

    def down(self, x, y, z):
        """The height of the first surface of the ship a ray straight down
        from (x, y, z) meets, or None."""
        hit = self.tree.ray_cast(Vector((x, y, z)), Vector((0, 0, -1)), 10.0)
        return None if hit[0] is None else hit[0].z


class Cat:
    """The beach cat's stage: her model (spec `boat`), imported and moved by
    `at` in the stage's scene (x to starboard, y forward, z up), clear of
    the rest; and a copy of her hull, mast and boom lying on her side,
    capsized to port (her port hull down), `capsized` from her. Her places,
    from her model's `aboard` node, on her starboard side (the port's the
    mirror): at the helm's station (`cat-`) and the crew's (`crew-`), the
    hull's deck at its inner edge (`-inner`), where a sailor sits facing
    inboard, and at its outer edge (`-outer`), where one sits out or stands
    on the wire, and the net under the hiking strap (`-strap`), where the
    feet go; the net's middle (`cat-net`), where a
    sailor crosses it; and, lying on her side, the top of her lower hull
    where a sailor stands to right her (`cat-stand`), and where the righting
    line leaves the upper hull's bottom for the hands (`cat-line`).

    Her hulls, decks, beams, pylons, side bars and fittings are solid
    (`tree`), and her net as a plane where it is laced (`net`, the middle's
    sag aside); her leather straps and her ropes (the righting line lying
    on the net, the lashings) are `ropes`, which only what holds them or
    stands on them may meet. Lying on her side, her hull, net and all, is
    `capsized_tree`. Where a seated sailor's cloth lies are the decks and
    the net (`planes`)."""

    POINTS = ("cat-inner", "cat-outer", "cat-strap", "crew-inner", "crew-outer", "crew-strap", "cat-net",
              "cat-stand", "cat-line")
    # The parts of her hull's mesh that give or are held, by material.
    NET = "net"
    HELD = ("leather", "rope")
    # Where a sailor stands to right her: on her lower hull's top (its
    # inner side, lying uppermost) at the crew's station, this far toward
    # its keel from the hull's middle; and where the line leaves her upper
    # hull, this far beyond its keel, toward the sailor.
    STAND_OUT = -0.05
    LINE_OUT = 0.06

    def __init__(self, root, spec):
        import math

        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            o.name = "cat-" + o.name
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        # Her sails and what flies from her rig, left out of the sheets: they
        # stand between the camera and her people.
        self.hidden = [o for o in self.objects if o.name in ("cat-sail", "cat-jib", "cat-telltales", "cat-pennant",
                                                             "cat-tricolour")]
        a = bpy.data.objects["cat-aboard"]

        def blender(p):
            # The model's frame (x to starboard, y up, z aft) as the scene's.
            return Vector((p[0], -p[2], p[1])) + self.at

        self.stations = {k: {n: blender(list(a[src][n])) for n in ("inner", "outer", "bar", "strap")}
                         for k, src in (("cat", "helm"), ("crew", "crew"))}
        n = a["net"]
        self.net_y = float(n["y"]) + self.at.z
        self.net_fore = -float(n["fore"]) + self.at.y
        self.net_aft = -float(n["aft"]) + self.at.y
        self.net_sag = float(n["sag"])
        self.boom = float(a["boom"]) + self.at.z
        hull = bpy.data.objects["cat-hull"]
        self.hull = hull

        def material(o, p):
            slots = o.material_slots
            return slots[p.material_index].name.split(".")[0] if p.material_index < len(slots) else ""

        self.tree = None
        # The net, as a plane where it is laced: from side bar to side bar,
        # beam to beam.
        half = min(st["bar"].x - self.at.x for st in self.stations.values())
        me = bpy.data.meshes.new("cat-net-plane")
        x0, x1 = self.at.x - half, self.at.x + half
        me.from_pydata([(x0, self.net_aft, self.net_y), (x1, self.net_aft, self.net_y), (x1, self.net_fore, self.net_y),
                        (x0, self.net_fore, self.net_y)], [], [(0, 1, 2, 3)])
        self.net = bpy.data.objects.new("cat-net-plane", me)
        bpy.context.scene.collection.objects.link(self.net)
        self.net.hide_render = True
        self.objects.append(self.net)
        self.planes = [self.net]
        self.tree = _tree([hull, self.net], lambda o, p: o is self.net or
                          material(o, p) not in (self.NET,) + self.HELD)
        self.ropes = _tree([hull], lambda o, p: material(o, p) in self.HELD)
        # Lying on her side: her hull, mast and boom turned about her
        # fore-and-aft axis till her mast lies to port, set beside her.
        self.lying_at = self.at + Vector(spec["capsized"])
        turn = Matrix.Translation(self.lying_at) @ Matrix.Rotation(math.radians(-90.0), 4, "Y") @ \
            Matrix.Translation(-self.at)
        self.turn = turn
        self.lying = []
        for name in ("cat-hull", "cat-mast", "cat-boom"):
            o = bpy.data.objects[name]
            c = o.copy()
            c.name = name + "-lying"
            bpy.context.scene.collection.objects.link(c)
            c.parent = None
            c.matrix_world = turn @ o.matrix_world
            c.hide_render = True
            self.lying.append(c)
            self.objects.append(c)
        bpy.context.view_layer.update()
        self.capsized_tree = _tree([self.lying[0]])
        # Where the sailor stands: on the lower hull's top over its middle
        # at the crew's station (a little toward its keel), as a ray down
        # finds it.
        # The starboard hull's keel, where it leaves the bottom (the model's
        # `board-root`): its centreline out from hers, and its depth.
        keel = bpy.data.objects["cat-board-root"].matrix_world.translation - self.at
        crew = self.stations["crew"]["inner"]
        mid = turn @ Vector((self.at.x - keel.x, crew.y, self.at.z))
        x = mid.x + self.STAND_OUT
        hit = self.capsized_tree.ray_cast(Vector((x, mid.y, mid.z + 0.6)), Vector((0, 0, -1)), 1.2)
        if hit[0] is None:
            raise AssertionError(f"{spec['boat']}: no lower hull under {x:.3f}, {mid.y:.3f} lying on her side")
        self.stand = hit[0].copy()
        # Where the line leaves the upper hull: past its keel at the
        # crew's station, toward the sailor.
        self.line = turn @ Vector((self.at.x + keel.x, crew.y, self.at.z + keel.z)) + \
            Vector((self.LINE_OUT, 0.0, 0.0))

    def _side(self, p, side):
        return Vector((self.at.x + side * (p.x - self.at.x), p.y, p.z))

    def point(self, name, side=1):
        if name == "cat-stand":
            return self.stand.copy()
        if name == "cat-line":
            return self.line.copy()
        if name == "cat-net":
            # The net's middle, on her centreline: a sailor on hands and
            # knees there is clear of both beams.
            return Vector((self.at.x, (self.net_fore + self.net_aft) / 2, self.net_y))
        station, _, which = name.partition("-")
        p = self.stations[station][which]
        if which == "strap":
            # On the net under the strap: where the feet go.
            p = Vector((p.x, p.y, self.net_y))
        return self._side(p, side)

    def down(self, x, y, z=None):
        """The height of the first surface of the cat (her decks, the net's
        plane) a ray straight down at (x, y) meets, or None."""
        top = (self.at.z + 3.0) if z is None else z
        hit = self.tree.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)), 6.0)
        return None if hit[0] is None else hit[0].z


class Yacht:
    """The yacht's stage: her model (spec `boat`), imported and moved by
    `at` in the stage's scene (x to starboard, y forward, z up), clear of
    the rest. Her places, from her model's nodes, on her starboard side (the
    port's the mirror):

    - at her starboard wheel (the `wheel` node's child, `spread` out from
      her centreline): the stance aft of it on the cockpit's sole
      (`yacht-stance`, the `sailor` node moved out by the spread), its hub
      (`yacht-hub`) and the grips on its rim (`grips`: each an angle from
      the top, degrees, to starboard as the helm sees it, on the rim, so far
      in from its middle as is still within its wood);
    - the side deck outboard of the wheel, where the helm sits: its inner
      edge's top `helm-seat.aft` aft of the wheel (`yacht-helm-seat`), and
      `helm-seat.brace` forward of that (`yacht-helm-brace`), where the
      feet are braced, by her capstan;
    - the bench (the `bench` node): its front edge's top at the node's
      station (`yacht-bench`) and the sole before it (`yacht-bench-sole`);
    - the side deck's edge at her rail's station (`yacht-rail`, her `rail`
      node), and her two
      lifelines there, as they run between their stanchions
      (`yacht-lifeline-low`, `yacht-lifeline-up`, from the `lifelines`
      node), and the stanchion nearest (`yacht-stanchion`, its foot);
    - the sole on her centreline `cockpit.table` aft of her table
      (`yacht-sole`), where the cockpit is crossed between the table and
      the wheels, and the top of her coachroof on her centreline `roof.fore`
      aft of its fore end (`yacht-roof`), where it is crossed forward of the
      mast, and the side deck's top outboard of the coachroof's side there
      (`yacht-roof-step`);
    - the boom's underside at its lowest, amidships (`boom`).

    Her hull (with her decks, cockpit, benches, coachroof, sprayhood, table,
    binnacles, capstans, stanchions, pulpit and pushpit), mast and boom are
    solid (`tree`), but for her ropes (the lifelines, her rigging, the
    sheets and lazy jacks: `ropes`), which only what holds them may meet,
    and her wheels, whose wood is measured apart (`near`). Her sails are
    neither."""

    POINTS = ("yacht-stance", "yacht-hub", "yacht-helm-seat", "yacht-helm-brace", "yacht-bench", "yacht-bench-sole", "yacht-rail",
              "yacht-lifeline-low", "yacht-lifeline-up", "yacht-stanchion", "yacht-sole", "yacht-roof",
              "yacht-roof-step")
    ROPE = "rope"
    # What of her model is neither solid nor held: her sails and what flies
    # from her rig, and the wheels (measured apart).
    LEFT_OUT = ("sail", "jib", "telltales", "pennant")
    WHEELS = ("wheel-port", "wheel-starboard")
    # A wheel's rim and spokes as thick as her model's (their radii), and
    # its handles' reach beyond the rim.
    RIM = 0.024
    SPOKE = 0.017

    def __init__(self, root, spec):
        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            # Her nodes by their own names, whatever of the scene's they
            # met on import (the wheel's stage has a `wheel`).
            o.name = "yacht-" + re.sub(r"\.\d{3}$", "", o.name)
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        self.hidden = [o for o in self.objects if o.name in ["yacht-" + n for n in self.LEFT_OUT]]

        def node(name):
            return bpy.data.objects["yacht-" + name]

        def extras(name, key):
            return node(name)[key]

        w = extras("wheel", "wheel")
        self.spread = float(w["spread"])
        self.radius = float(w["radius"])
        self.spokes = int(w["spokes"])
        self.handles = float(w["handles"])
        hub = node("wheel").matrix_world.translation
        self.hub = Vector((hub.x + self.spread, hub.y, hub.z))
        st = node("sailor").matrix_world.translation
        self.stance = Vector((st.x + self.spread, st.y, st.z))
        # Each grip on the rim: its angle from the top, and how far in from
        # the rim's middle the hand holds it (within the rim's own wood).
        self.grips = {name: self.spoke(float(deg), self.radius - float(inside))
                      for name, (deg, inside) in spec["grips"].items()}

        def material(o, p):
            slots = o.material_slots
            return slots[p.material_index].name.split(".")[0] if p.material_index < len(slots) else ""

        meshes = [o for o in self.objects if o.type == "MESH" and o not in self.hidden]
        self.wheels = [o for o in meshes if o.name in ["yacht-" + n for n in self.WHEELS]]
        solid = [o for o in meshes if o not in self.wheels]
        self.hull = node("hull")
        self.tree = _tree(solid, lambda o, p: material(o, p) != self.ROPE)
        # Her decks, cockpit and coachroof, what a ray down finds them by.
        self.decks = _tree([self.hull], lambda o, p: material(o, p) != self.ROPE)
        self.ropes = _tree(solid, lambda o, p: material(o, p) == self.ROPE)
        # The bench, from its node: its front edge's top at its station.
        b = node("bench")
        bench = b["bench"]
        self.bench_z = b.matrix_world.translation.y
        self.bench = Vector((self.at.x + float(bench["inner"]), self.bench_z, self.at.z + float(bench["top"])))
        self.sole = self.at.z + float(bench["sole"])
        # The side deck outboard of the wheel: its inner edge's top, where a
        # ray down first meets the deck, not the sole, going out.
        y = self.hub.y - spec["helm-seat"]["aft"]
        self.helm_seat = self._edge_out(self.hub.x, y)
        # Forward of it along the side deck, where the helm's feet are
        # braced: the deck's top there, as far out.
        y += spec["helm-seat"]["brace"]
        self.helm_brace = self._edge_out(self.hub.x, y)
        # The deck's edge at the rail's station (her `rail` node).
        self.rail = node("rail").matrix_world.translation.copy()
        y = self.rail.y
        # The lifelines there, between the stanchions either side; and the
        # nearest stanchion's foot.
        ll = node("lifelines")["lifelines"]
        stations = [float(z) for z in ll["stanchions"]]
        inboard = float(ll["inboard"])
        z = self.at.y - y
        fore = max(s for s in stations if s <= z)
        aft = min(s for s in stations if s >= z)

        def foot(sz):
            yy = self.at.y - sz
            xx = self.at.x + 2.5
            while xx > self.at.x and self.down(xx, yy) is None:
                xx -= 0.002
            return Vector((xx - inboard, yy, self.down(xx - inboard, yy)))

        a, c = foot(fore), foot(aft)
        t = 0.0 if aft == fore else (z - fore) / (aft - fore)
        self.lifelines = [a.lerp(c, t) + Vector((0.0, 0.0, float(h))) for h in ll["heights"]]
        self.stanchion = min((a, c), key=lambda p: abs(p.y - y))
        # The cockpit's crossing: the sole on her centreline, aft of the
        # table's after end (the `table` node's).
        z = float(node("table")["table"]["aft"]) + spec["cockpit"]["table"]
        self.cross = Vector((self.at.x, self.at.y - z, self.sole))
        # The coachroof's crossing: its top on her centreline (on the
        # scuttle there, if any), and the side deck's top outboard of the
        # coachroof's side.
        z = float(node("coachroof")["coachroof"]["fore"]) + spec["roof"]["fore"]
        y = self.at.y - z
        self.roof = Vector((self.at.x, y, self.down(self.at.x, y)))
        x = self.at.x
        while self.down(x, y) > self.roof.z - 0.2:
            x += 0.002
        self.roof_step = Vector((x + 0.05, y, self.down(x + 0.05, y)))
        # The boom's underside, amidships: what a ray up from the coachroof
        # meets first.
        boom = node("boom")
        self.boom_tree = _tree([boom])
        hit = self.boom_tree.ray_cast(Vector((self.at.x, y, self.roof.z + 0.05)), Vector((0, 0, 1)), 5.0)
        self.boom = hit[0].z if hit[0] is not None else None
        # The bench's top, from its front edge to the cockpit's side, fore
        # and aft along it: what a seated figure's cloth is laid on there
        # (the rest of her decks by her hull itself).
        out = self._wall(self.bench.x, self.bench.y, self.bench.z + 0.05)
        self.planes = [self._plane("yacht-bench-plane", self.bench.x, out, self.at.y - float(bench["aft"]),
                                   self.at.y - float(bench["fore"]), self.bench.z)]
        # And the coachroof's scuttle where it is crossed, its top: a long
        # coat's skirts in a deep crouch are laid on it, not in it.
        self.planes.append(self._plane("yacht-roof-plane", self.at.x, self.at.x + 0.5, self.roof.y - 0.4,
                                       self.roof.y + 0.4, self.roof.z))
        self.objects += self.planes

    def _wall(self, x, y, z):
        """Going out from (x, y) at height z, where her side first stands."""
        hit = self.tree.ray_cast(Vector((x, y, z)), Vector((1, 0, 0)), 3.0)
        if hit[0] is None:
            raise AssertionError(f"{self.spec['boat']}: no side outboard of {x:.3f}, {y:.3f}")
        return hit[0].x

    def _edge_out(self, x, y, above=None):
        """Going out from (x, y), where a ray down first meets the deck: the
        side deck's inner edge, its top (above: higher than this)."""
        floor = self.sole + 0.1 if above is None else above
        while x < self.at.x + 2.5:
            h = self.down(x, y)
            if h is not None and h > floor and (above is None or h < above + 0.05):
                return Vector((x, y, h))
            x += 0.002
        raise AssertionError(f"{self.spec['boat']}: no side deck outboard of {x:.3f}, {y:.3f}")

    def _plane(self, name, x0, x1, y0, y1, z):
        me = bpy.data.meshes.new(name)
        verts = []
        for s in (1, -1):
            a, b = self.at.x + s * (x0 - self.at.x), self.at.x + s * (x1 - self.at.x)
            verts += [(a, y0, z), (b, y0, z), (b, y1, z), (a, y1, z)]
        me.from_pydata(verts, [], [(0, 1, 2, 3), (7, 6, 5, 4)])
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        o.hide_render = True
        return o

    def spoke(self, degrees, along, hub=None):
        """The point along the starboard wheel's spoke at this angle from
        the top, this far from the hub."""
        a = np.radians(degrees)
        return (hub or self.hub) + Vector((np.sin(a) * along, 0.0, np.cos(a) * along))

    def _side(self, p, side):
        return Vector((self.at.x + side * (p.x - self.at.x), p.y, p.z))

    def point(self, name, side=1):
        if name in self.grips:
            return self._side(self.grips[name], side)
        p = {"yacht-stance": self.stance, "yacht-hub": self.hub, "yacht-helm-seat": self.helm_seat,
             "yacht-helm-brace": self.helm_brace,
             "yacht-bench": self.bench, "yacht-bench-sole": Vector((self.bench.x, self.bench.y, self.sole)),
             "yacht-rail": self.rail, "yacht-lifeline-low": self.lifelines[0], "yacht-lifeline-up": self.lifelines[1],
             "yacht-stanchion": self.stanchion, "yacht-sole": self.cross, "yacht-roof": self.roof,
             "yacht-roof-step": self.roof_step}[name]
        return self._side(p, side)

    def down(self, x, y, z=None):
        """The height of the first surface of the yacht's hull (her decks,
        cockpit, coachroof and what stands on them, not her rig) a ray
        straight down at (x, y) meets (from z, or from above her), or None."""
        top = (self.at.z + 4.0) if z is None else z
        hit = self.decks.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)), 8.0)
        return None if hit[0] is None else hit[0].z

    def near(self, points, side, skip=None):
        """Which points are within a wheel's rim or a spoke's thickness of
        it (inside its wood), at the wheel on a side: the indices, those
        skipped left out."""
        hub = self._side(self.hub, side)
        p = np.asarray(points, float) - np.array(hub)
        r = np.hypot(p[:, 0], p[:, 2])
        hit = np.hypot(r - self.radius, p[:, 1]) < self.RIM
        a = np.arctan2(p[:, 0], p[:, 2])
        step = 2 * np.pi / self.spokes
        off = (a + step / 2) % step - step / 2
        across = np.abs(np.sin(off) * r)
        hit |= (across < self.SPOKE) & (np.abs(p[:, 1]) < self.SPOKE) & (r < self.radius + self.handles) & \
            (np.cos(off) > 0)
        if skip is not None:
            hit &= ~np.asarray(skip, bool)
        return np.flatnonzero(hit)


class Bridgedeck:
    """The cruising catamaran's stage: her model (spec `boat`), imported and
    moved by `at` in the stage's scene (x to starboard, y forward, z up),
    clear of the rest. Her places, from her model's nodes:

    - at her wheel (the `wheel` node, off her centreline): the helm's
      stance aft of it (`bridge-stance`, the `sailor` node), its hub
      (`bridge-hub`) and the grips on its rim (`grips`: each an angle from
      the top, degrees, to starboard as the helm sees it, so far in from the
      rim's middle as is still within its wood); the settle's front edge
      behind the stance, at the wheel (`bridge-wheel-seat`), and the
      platform under it (`bridge-wheel-floor`);
    - her seats (the `seats` node), each a family of places: the front
      edge's top where its clips are made (`bridge-helm`, the settle beside
      the helm; `bridge-table`, the L-shaped bench round the table;
      `bridge-beam`, the aft crossbeam's bench; `bridge-lounger`), the
      floor before it (`-floor`) and the top of its back (`-back`); and the
      table's edge nearest the table's seat (`bridge-table-top`);
    - her helm's ladder: its foot on the sole (`bridge-stairs`, facing up
      it), its landing (`bridge-landing`, facing down it, aft), each
      tread's middle from the lowest
      (`bridge-tread-1`...), and its rail over each (`bridge-rail-1`...,
      `bridge-rail-0` over the sole at its foot, the last over the landing);
    - the sole where her cockpit is walked (`bridge-sole`);
    - the boom's underside at its lowest, amidships (`boom`).

    Each place belongs to a family whose own place it is placed from, and
    the way a figure there faces (`facing`): its port side's mirror (a clip
    made with its -port) is the same place seen in a mirror stood along that
    way through it, the figure its own mirror image (`point`, side -1). Her
    seats, her helm's station and her ladder are hers alone: a mirror of
    one across her is no place of hers.

    Her hulls, bridgedeck, saloon, roof and its posts, helm's platform,
    settle, console and capstans, ladder, cockpit's seats and table, beams,
    mast and boom are solid (`tree`), but for her ropes and her bronze
    rails (`ropes`), which only what holds them may meet, and her wheel,
    whose wood is measured apart (`near`). Her sails are neither."""

    # What of her model only a hand may hold.
    HELD = ("rope", "bronze")
    # What of her model is neither solid nor held: her sails and what flies
    # from her rig; her wheel (measured apart).
    LEFT_OUT = ("sail", "jib", "telltales", "pennant")
    WHEEL = "wheel"
    # A wheel's rim and spokes as thick as her model's (their radii).
    RIM = 0.024
    SPOKE = 0.017
    SEATS = ("helm", "table", "beam", "lounger")

    def __init__(self, root, spec):
        self.spec = spec
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(root, "art", spec["boat"]))
        self.objects = [o for o in bpy.data.objects if o not in before]
        self.at = Vector(spec["at"])
        for o in self.objects:
            o.name = "bridge-" + re.sub(r"\.\d{3}$", "", o.name)
            o.hide_render = True
            if o.parent is None:
                o.location = o.location + self.at
        bpy.context.view_layer.update()
        self.hidden = [o for o in self.objects if o.name in ["bridge-" + n for n in self.LEFT_OUT]]

        def node(name):
            return bpy.data.objects["bridge-" + name]

        def blender(p):
            # The model's frame (x to starboard, y up, z aft) as the scene's.
            return Vector((float(p[0]), -float(p[2]), float(p[1]))) + self.at

        seats = node("seats")["seats"]
        w = node("wheel")["wheel"]
        self.radius = float(w["radius"])
        self.spokes = int(w["spokes"])
        self.handles = float(w["handles"])
        self.hub = node("wheel").matrix_world.translation.copy()
        self.stance = node("sailor").matrix_world.translation.copy()
        self.grips = {name: self.spoke(float(deg), self.radius - float(inside))
                      for name, (deg, inside) in spec["grips"].items()}
        # The places, each with its family's place and facing (degrees from
        # ahead toward starboard).
        self.places = {}
        self.family = {}

        def put(name, p, family):
            self.places[name] = p
            self.family[name] = family

        self.facings = {"bridge-stance": 0.0}
        put("bridge-stance", self.stance.copy(), "bridge-stance")
        put("bridge-hub", self.hub.copy(), "bridge-stance")
        for name, p in self.grips.items():
            put(name, p, "bridge-stance")
        helm = seats["helm"]
        edge = blender(list(helm["at"]))
        put("bridge-wheel-seat", Vector((self.stance.x, edge.y, edge.z)), "bridge-stance")
        put("bridge-wheel-floor", Vector((self.stance.x, edge.y, self.at.z + float(helm["floor"]))), "bridge-stance")
        self.seats = {}
        for key in self.SEATS:
            s = seats[key]
            name = "bridge-" + key
            at = blender(list(s["at"]))
            f = float(s["facing"])
            ahead = self.ahead(f)
            floor = self.at.z + float(s["floor"])
            self.facings[name] = f
            put(name, at, name)
            put(name + "-floor", Vector((at.x, at.y, floor)), name)
            put(name + "-back", at - ahead * float(s["back"]) + Vector((0.0, 0.0, floor + float(s["backTop"]) - at.z)),
                name)
            self.seats[key] = {"at": at, "facing": f, "floor": floor, "back": float(s["back"]),
                               "along": [float(x) for x in s["along"]]}
        top = [float(x) for x in seats["table"]["top"]]
        # The table's edge nearest its seat, across from the seat's place.
        t = self.places["bridge-table"]
        put("bridge-table-top", Vector((self.at.x + top[1], t.y, self.at.z + top[4])), "bridge-table")
        st = seats["stairs"]
        foot = blender(list(st["foot"]))
        head = blender(list(st["head"]))
        self.stairs = {"foot": foot, "head": head, "rise": float(st["rise"]), "run": float(st["run"]),
                       "treads": int(st["treads"]), "from": float(st["from"]), "to": float(st["to"])}
        # Climbed facing forward from its foot, and come down facing aft
        # from its head.
        self.facings["bridge-stairs"] = 0.0
        self.facings["bridge-landing"] = 180.0
        put("bridge-stairs", foot, "bridge-stairs")
        put("bridge-landing", head, "bridge-landing")
        sides = [float(x) for x in st["sides"]]
        mid = self.at.x + (sides[0] + sides[1]) / 2
        rail = [float(x) for x in st["rail"]]
        n = self.stairs["treads"]
        sole = self.at.z + float(st["foot"][1])
        for k in range(n + 2):
            # The k-th step from the sole (0, the sole at the foot; n + 1, the
            # landing): its middle (the model's z along her), and the rail
            # over it, rising from the ladder's foot to its head and level
            # beyond.
            if k == 0:
                mz, z = self.stairs["from"] + 0.1, sole
            elif k <= n:
                # Tread k from the foot is the model's (n - k)th from the top.
                mz = self.stairs["to"] + self.stairs["run"] * (n - k + 0.5)
                z = head.z - self.stairs["rise"] * (n + 1 - k)
            else:
                mz, z = self.stairs["to"] - 0.15, head.z
            y = self.at.y - mz
            if 0 < k <= n:
                put(f"bridge-tread-{k}", Vector((mid, y, z)), "bridge-stairs")
            t = min(max((self.stairs["from"] - mz) / (self.stairs["from"] - self.stairs["to"]), 0.0), 1.0)
            # (Over the landing, its own rail, inboard of its edge.)
            x = rail[2] if mz < self.stairs["to"] else rail[0]
            put(f"bridge-rail-{k}", Vector((self.at.x + x, y, sole + rail[1] + t * (head.z - sole))), "bridge-stairs")
        self.facings["bridge-sole"] = 0.0
        put("bridge-sole", blender(list(seats["walk"])), "bridge-sole")
        # The ladder's mirror is about its middle.
        self.mirror_x = {"bridge-stairs": mid, "bridge-landing": mid}

        def material(o, p):
            slots = o.material_slots
            return slots[p.material_index].name.split(".")[0] if p.material_index < len(slots) else ""

        meshes = [o for o in self.objects if o.type == "MESH" and o not in self.hidden]
        self.wheels = [o for o in meshes if o.name == "bridge-" + self.WHEEL]
        solid = [o for o in meshes if o not in self.wheels]
        self.hull = node("hull")
        self.tree = _tree(solid, lambda o, p: material(o, p) not in self.HELD)
        # Her decks, platform, seats and table: what a ray down finds them by.
        self.decks = _tree([self.hull], lambda o, p: material(o, p) not in self.HELD)
        self.ropes = _tree(solid, lambda o, p: material(o, p) in self.HELD)
        # The boom's underside, amidships: what a ray up from the roof meets
        # first.
        boom = node("boom")
        self.boom_tree = _tree([boom])
        y = boom.matrix_world.translation.y - 1.5
        hit = self.boom_tree.ray_cast(Vector((self.at.x, y, self.at.z + 3.6)), Vector((0, 0, 1)), 5.0)
        self.boom = hit[0].z if hit[0] is not None else None
        # Each seat's top, from its front edge back to its back, from end to
        # end: what a seated figure's cloth is laid on there (`planes`).
        self.planes = [self._plane(key) for key in self.SEATS]
        # And her floors: the cloth hanging from a seated figure to the sole
        # is laid on it.
        for key, height in (("sole", float(st["foot"][1])), ("platform", float(seats["platform"]))):
            x0, x1, z0, z1 = (float(v) for v in seats["floors"][key])
            me = bpy.data.meshes.new(f"bridge-{key}-plane")
            z = self.at.z + height
            me.from_pydata([(self.at.x + x0, self.at.y - z0, z), (self.at.x + x1, self.at.y - z0, z),
                            (self.at.x + x1, self.at.y - z1, z), (self.at.x + x0, self.at.y - z1, z)], [],
                           [(0, 1, 2, 3), (3, 2, 1, 0)])
            o = bpy.data.objects.new(f"bridge-{key}-plane", me)
            bpy.context.scene.collection.objects.link(o)
            o.hide_render = True
            self.planes.append(o)
        # And her ladder's treads, each its top: the cloth of one climbing it
        # meets them, and lies on them as on a seat.
        self.treads = []
        for k in range(1, n + 1):
            t = self.places[f"bridge-tread-{k}"]
            half = self.stairs["run"] / 2 + 0.01
            me = bpy.data.meshes.new(f"bridge-tread-plane-{k}")
            me.from_pydata([(self.at.x + sides[0], t.y - half, t.z), (self.at.x + sides[1], t.y - half, t.z),
                            (self.at.x + sides[1], t.y + half, t.z), (self.at.x + sides[0], t.y + half, t.z)], [],
                           [(0, 1, 2, 3), (3, 2, 1, 0)])
            o = bpy.data.objects.new(f"bridge-tread-plane-{k}", me)
            bpy.context.scene.collection.objects.link(o)
            o.hide_render = True
            self.treads.append(o)
        self.planes += self.treads
        self.objects += self.planes

    @staticmethod
    def ahead(facing):
        """The way a figure faces at this facing (degrees from ahead toward
        starboard), in the scene."""
        a = np.radians(facing)
        return Vector((float(np.sin(a)), float(np.cos(a)), 0.0))

    def frame(self, family, side=1):
        """A place's frame in the scene (the figure's ahead, its left, up),
        for a family's places; on side -1, its mirror (left the other way)."""
        f = self.facings[family]
        a = self.ahead(f)
        left = Vector((-a.y, a.x, 0.0)) * side
        return Matrix((a, left, (0.0, 0.0, 1.0))).transposed()

    def facing(self, family):
        """The figure's turn to face as a family's places face: it faces -y
        in its own axes."""
        return Matrix.Rotation(np.pi - np.radians(self.facings[family]), 4, "Z")

    def _plane(self, key):
        s = self.seats[key]
        a = self.ahead(s["facing"])
        at = s["at"]
        lo, hi = sorted(s["along"])
        # Its ends along its front edge: the model's x for a seat facing fore
        # or aft, its z (aft, the scene's -y) for one facing athwartships.
        if abs(a.y) > 0.5:
            ends = [Vector((self.at.x + e, at.y, at.z)) for e in (lo, hi)]
        else:
            ends = [Vector((at.x, self.at.y - e, at.z)) for e in (lo, hi)]
        # (A hair over the slats' top.)
        ends = [e + Vector((0.0, 0.0, 0.002)) for e in ends]
        verts = [tuple(e) for e in ends] + [tuple(e - a * s["back"]) for e in ends]
        me = bpy.data.meshes.new(f"bridge-{key}-plane")
        me.from_pydata(verts, [], [(0, 1, 3, 2), (2, 3, 1, 0)])
        o = bpy.data.objects.new(f"bridge-{key}-plane", me)
        bpy.context.scene.collection.objects.link(o)
        o.hide_render = True
        return o

    def spoke(self, degrees, along):
        """The point along the wheel's spoke at this angle from the top, this
        far from the hub."""
        a = np.radians(degrees)
        return self.hub + Vector((np.sin(a) * along, 0.0, np.cos(a) * along))

    def point(self, name, side=1):
        """A place, on a side: as it is (1), or (-1) its mirror in its
        family's mirror, stood along the way the family's place faces."""
        p = self.places[name].copy()
        if side > 0:
            return p
        fam = self.family[name]
        if fam in self.mirror_x:
            return Vector((2 * self.mirror_x[fam] - p.x, p.y, p.z))
        a = self.ahead(self.facings[fam])
        left = Vector((-a.y, a.x, 0.0))
        d = (p - self.places[fam]).dot(left)
        return p - left * (2 * d)

    def down(self, x, y, z=None):
        """The height of the first surface of her hull (her decks, platform,
        seats and table, not her rig) a ray straight down at (x, y) meets,
        from z (or from under her roof), or None."""
        top = (self.at.z + 3.25) if z is None else z
        hit = self.decks.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)), 8.0)
        return None if hit[0] is None else hit[0].z

    def near(self, points, skip=None):
        """Which points are within the wheel's rim or a spoke's thickness of
        it (inside its wood): the indices, those skipped left out."""
        p = np.asarray(points, float) - np.array(self.hub)
        r = np.hypot(p[:, 0], p[:, 2])
        hit = np.hypot(r - self.radius, p[:, 1]) < self.RIM
        a = np.arctan2(p[:, 0], p[:, 2])
        step = 2 * np.pi / self.spokes
        off = (a + step / 2) % step - step / 2
        across = np.abs(np.sin(off) * r)
        hit |= (across < self.SPOKE) & (np.abs(p[:, 1]) < self.SPOKE) & (r < self.radius + self.handles) & \
            (np.cos(off) > 0)
        if skip is not None:
            hit &= ~np.asarray(skip, bool)
        return np.flatnonzero(hit)


def _tree(objs, keep=None):
    """One BVH tree of the objects as they stand, in boat space: of those
    faces keep (an object and a face) keeps, if given."""
    dg = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        base = len(verts)
        verts.extend(o.matrix_world @ v.co for v in me.vertices)
        polys.extend([base + i for i in p.vertices] for p in me.polygons if keep is None or keep(o, p))
        e.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)
