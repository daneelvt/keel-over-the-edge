// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"maps"
	"math"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

const posesDir = "poses"

// poseLibrary is every file of poses/ together: the key poses, the clips
// made from them, and the clips retargeted from others'.
type poseLibrary struct {
	Poses    map[string]pose     `yaml:"poses" json:"poses"`
	Clips    map[string]clip     `yaml:"clips" json:"clips"`
	Retarget map[string]retarget `yaml:"retarget" json:"retarget"`
}

// pose is turns of bones, each [bone, axis, degrees] about the figure's
// own axes; where it sits in the boat; and its hands' and feet's targets.
type pose struct {
	From  string `yaml:"from" json:"from,omitempty"`
	Place string `yaml:"place" json:"place,omitempty"`
	// Shift moves the placed figure forward, inboard and up from its place.
	Shift []float64 `yaml:"shift" json:"shift,omitempty"`
	// Lie leans the placed figure back about its own left-right axis, in
	// degrees: a body lying out on the trapeze, its joints' turns its own.
	Lie  float64           `yaml:"lie" json:"lie,omitempty"`
	Turn [][]any           `yaml:"turn" json:"turn,omitempty"`
	IK   map[string]target `yaml:"ik" json:"ik,omitempty"`
}

// target is a place on the stage, or a bone of the figure's own, and an
// offset from it; and where the elbow or knee points, if not the usual
// (an offset from the chest).
type target struct {
	At     string    `yaml:"at" json:"at"`
	Bone   string    `yaml:"bone" json:"bone,omitempty"`
	Offset []float64 `yaml:"offset" json:"offset,omitempty"`
	Pole   []float64 `yaml:"pole" json:"pole,omitempty"`
	// Reach moves a stage target inboard until the limb is this share of
	// its length from its root.
	Reach float64 `yaml:"reach" json:"reach,omitempty"`
	// Planted puts the target where the pose's own turns put the limb's
	// end, on the stage's surface it names (a crouch's feet on the floor),
	// or anywhere (at free: a leg hanging over the side).
	Planted bool `yaml:"planted" json:"planted,omitempty"`
	// Grip turns a hand on its target so its fingers point along Aim and
	// its palm faces Palm (forward, inboard and up in the stage's frame):
	// a hand round a wheel's spoke.
	Grip *grip `yaml:"grip" json:"grip,omitempty"`
}

// grip is which way a hand's fingers point and its palm faces.
type grip struct {
	Aim  []float64 `yaml:"aim" json:"aim"`
	Palm []float64 `yaml:"palm" json:"palm"`
	// Weight is how far the hand is turned so, from its own turn: all
	// the way if not said.
	Weight float64 `yaml:"weight" json:"weight,omitempty"`
}

type clip struct {
	Loop bool `yaml:"loop" json:"loop,omitempty"`
	Idle bool `yaml:"idle" json:"idle,omitempty"`
	// Sides makes the clip on both side decks: as written, on the
	// starboard, and as its mirror image on the port, named with portSuffix.
	Sides bool `yaml:"sides" json:"sides,omitempty"`
	// Clear turns a leg at the hip, frame by frame, until it is clear of
	// the boat (climbing in over the side).
	Clear bool `yaml:"clear" json:"clear,omitempty"`
	// Strain names the kinds of joint (thigh, calf) the clip takes toward
	// the ends of their ranges, as the hike does; the motion gate gives
	// them more of it.
	Strain []string `yaml:"strain" json:"strain,omitempty"`
	// Hang turns the skirts' chains, by name (back, side, front), this
	// share of the way to hang straight down from the body (lying out on
	// the trapeze, sat on a rail); on the trapeze, the build's own shares
	// if not said.
	Hang map[string]float64 `yaml:"hang" json:"hang,omitempty"`
	// Group is the file it is written to beside the look's clips (ship:
	// <version>.ship.glb), if not the clips' own.
	Group string `yaml:"group" json:"group,omitempty"`
	Keys  []key  `yaml:"keys" json:"keys"`
}

// portSuffix names a clip's port side, made with Sides.
const portSuffix = "-port"

// key is a pose held in a clip, and how the ramp into it goes.
type key struct {
	Pose       string    `yaml:"pose" json:"pose"`
	Hold       float64   `yaml:"hold" json:"hold"`
	Ramp       float64   `yaml:"ramp" json:"ramp,omitempty"`
	Anticipate float64   `yaml:"anticipate" json:"anticipate,omitempty"`
	Arc        []float64 `yaml:"arc" json:"arc,omitempty"`
	Lead       string    `yaml:"lead" json:"lead,omitempty"`
	// Step lifts the feet this far at the middle of the ramp, clear of
	// the floor between their places.
	Step float64 `yaml:"step" json:"step,omitempty"`
	// Side is the side deck the key is on, if not the clip's: port, the
	// other (a tack's cross ends there).
	Side string `yaml:"side" json:"side,omitempty"`
}

// retarget is a clip of someone else's, from a vendored file, and the
// feet it stands on.
type retarget struct {
	File string   `yaml:"file" json:"file"`
	Loop bool     `yaml:"loop" json:"loop,omitempty"`
	Idle bool     `yaml:"idle" json:"idle,omitempty"`
	Lock []string `yaml:"lock" json:"lock,omitempty"`
	// Deck sets it on a flat deck: the soles on it, and each foot that
	// bears on it held there by IK.
	Deck bool `yaml:"deck" json:"deck,omitempty"`
	// Speed is how fast it walks over the deck, m/s: a foot that bears on
	// it moves back at this speed.
	Speed float64 `yaml:"speed" json:"speed,omitempty"`
	// Head keeps the head's joint under this height over the deck while
	// the hips are down in a crouch, by bending the back.
	Head float64 `yaml:"head" json:"head,omitempty"`
	// Strain names the joints it takes toward the ends of their ranges
	// (a deep crouch's knees), as a clip's Strain does.
	Strain []string `yaml:"strain" json:"strain,omitempty"`
	// Seconds plays it over this long, slowed or quickened from its own.
	Seconds float64 `yaml:"seconds" json:"seconds,omitempty"`
	// Group is the file it is written to beside the look's clips (rail:
	// <version>.rail.glb), if not the clips' own.
	Group string `yaml:"group" json:"group,omitempty"`
	// Stage is the ship's place it is set at (on a deck): leaning on her
	// rail (ship-rail), sat on her hatch (ship-hatch).
	Stage string `yaml:"stage" json:"stage,omitempty"`
	// Still keeps the arm of each hand named as the clip's first frame has
	// it: a gesture of the source's left out.
	Still []string `yaml:"still" json:"still,omitempty"`
	// Clear sets, leaning on the ship's rail, how far the forearms' sleeves
	// are kept over its top, if not the build's own.
	Clear float64 `yaml:"clear" json:"clear,omitempty"`
	// Way is which way it walks over the deck at its speed: forward, or to
	// its left or right, facing forward (crossing a beach cat's net).
	Way string `yaml:"way" json:"way,omitempty"`
	// Crawl holds its hands and knees on the deck while they bear, as its
	// feet.
	Crawl bool `yaml:"crawl" json:"crawl,omitempty"`
	// Smooth is over how many frames (a Gaussian's sigma) its keys are
	// smoothed, if not the build's own: a source's hitches eased.
	Smooth float64 `yaml:"smooth" json:"smooth,omitempty"`
}

var (
	places = []string{"", "seat", "gunwale", "cockpit", "outside", "wheel", "trapeze", "rail", "brace", "top", "yard",
		"cat-seat", "crew-seat", "cat-out", "cat-wire", "crew-wire", "cat-stand"}
	// groups are the files a clip may be written to apart from the
	// look's clips.
	groups = []string{"", "rail", "ship", "aloft", "cat"}
	// shipStages are the ship's places a retargeted clip may be set at,
	// and the beach cat's: her net, crossing it.
	shipStages = []string{"", "ship-rail", "ship-hatch", "cat-net"}
	// ways are the ways a retargeted clip may walk over its deck.
	ways = []string{"", "forward", "left", "right"}
	// catPoints are the beach cat's places a target may be at.
	catPoints = []string{"cat-inner", "cat-outer", "cat-strap", "crew-inner", "crew-outer", "crew-strap", "cat-net",
		"cat-stand", "cat-line"}
	// shipPoints are the ship's places a target may be at.
	shipPoints = []string{"ship-rail", "ship-hatch", "ladder-foot", "ladder-head", "shroud", "top", "aloft",
		"topmast-shroud", "yard-foot-in", "yard-foot-out", "yard", "brace-lead", "brace-fall", "brace", "haul-deck"}
	effectors = []string{"hand_l", "hand_r", "foot_l", "foot_r"}
	stageAt   = []string{"seat", "gunwale", "floor", "strap", "free"}
	keySides  = []string{"", "port", "starboard"}
	leads     = []string{"", "hips", "head"}
	// turnAxes are the figure's axes, and lx a bone's own x axis (a
	// finger's curl toward the palm).
	turnAxes   = []string{"x", "y", "z", "lx"}
	maxDegrees = 180.0
)

// readPoses reads every file of the pose library and checks it against
// the skeleton, the stage's places and the inputs.
func readPoses(dir string, t tables, sources map[string]source) (poseLibrary, error) {
	lib := poseLibrary{Poses: map[string]pose{}, Clips: map[string]clip{}, Retarget: map[string]retarget{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return lib, err
	}
	sort.Strings(files)
	for _, f := range files {
		var part poseLibrary
		if err := decodeStrict(f, &part); err != nil {
			return lib, err
		}
		for _, merge := range []struct {
			names []string
			add   func(string)
		}{
			{slices.Collect(maps.Keys(part.Poses)), func(n string) { lib.Poses[n] = part.Poses[n] }},
			{slices.Collect(maps.Keys(part.Clips)), func(n string) { lib.Clips[n] = part.Clips[n] }},
			{slices.Collect(maps.Keys(part.Retarget)), func(n string) { lib.Retarget[n] = part.Retarget[n] }},
		} {
			for _, n := range merge.names {
				if _, ok := lib.Poses[n]; ok {
					return lib, fmt.Errorf("%s: %s is named twice in the pose library", f, n)
				}
				if _, ok := lib.Clips[n]; ok {
					return lib, fmt.Errorf("%s: %s is named twice in the pose library", f, n)
				}
				if _, ok := lib.Retarget[n]; ok {
					return lib, fmt.Errorf("%s: %s is named twice in the pose library", f, n)
				}
				merge.add(n)
			}
		}
	}
	return lib, lib.check(t, sources)
}

func (lib poseLibrary) check(t tables, sources map[string]source) error {
	bones, err := skeletonOf(t)
	if err != nil {
		return err
	}
	points := map[string]bool{}
	if st, ok := t.Tables["stage"].(map[string]any); ok {
		if ps, ok := st["points"].(map[string]any); ok {
			for p := range ps {
				points[p] = true
			}
		}
		// On the trapeze: the rack's edge the feet stand on, the hounds,
		// the ring, the extension's hinge and the mainsheet's block.
		if _, ok := st["trapeze"].(map[string]any); ok {
			for _, p := range []string{"rack", "hounds", "ring", "trapeze-hinge", "trapeze-sheet"} {
				points[p] = true
			}
		}
		// On the rail: the deck's edge the crew sit on.
		if _, ok := st["rail"].(map[string]any); ok {
			points["rail"] = true
		}
		// On the ship: her company's places.
		if _, ok := st["ship"].(map[string]any); ok {
			for _, p := range shipPoints {
				points[p] = true
			}
		}
		// On the beach cat: her hull's edges, the strap, the net, and
		// where she is righted from.
		if _, ok := st["cat"].(map[string]any); ok {
			for _, p := range catPoints {
				points[p] = true
			}
		}
		// At the wheel: the deck the helmsman stands on, and the grips.
		if w, ok := st["wheel"].(map[string]any); ok {
			points["deck"] = true
			if gs, ok := w["grips"].(map[string]any); ok {
				for g := range gs {
					points[g] = true
				}
			}
		}
	}
	for _, s := range stageAt {
		points[s] = true
	}
	for name, p := range lib.Poses {
		if err := p.check(bones, points, lib.Poses); err != nil {
			return fmt.Errorf("the pose %s: %w", name, err)
		}
		if err := lib.chain(name, nil); err != nil {
			return err
		}
	}
	for name, c := range lib.Clips {
		if len(c.Keys) == 0 {
			return fmt.Errorf("the clip %s has no keys", name)
		}
		if _, ok := lib.Clips[name+portSuffix]; ok && c.Sides {
			return fmt.Errorf("the clip %s is made on both sides, but %s is a clip of its own", name, name+portSuffix)
		}
		if !slices.Contains(groups, c.Group) {
			return fmt.Errorf("the clip %s: no file %q beside the clips", name, c.Group)
		}
		for i, k := range c.Keys {
			if _, ok := lib.Poses[k.Pose]; !ok {
				return fmt.Errorf("the clip %s's key %d: no pose %q", name, i, k.Pose)
			}
			switch {
			case k.Hold < 0 || k.Ramp < 0:
				return fmt.Errorf("the clip %s's key %d: a hold or ramp less than nothing", name, i)
			case k.Anticipate < 0 || k.Anticipate > 0.5:
				return fmt.Errorf("the clip %s's key %d: anticipation %v is not 0 to 0.5 of the move", name, i, k.Anticipate)
			case k.Arc != nil && len(k.Arc) != 2:
				return fmt.Errorf("the clip %s's key %d: an arc is [out, up]", name, i)
			case !slices.Contains(leads, k.Lead):
				return fmt.Errorf("the clip %s's key %d: lead %q is neither hips nor head", name, i, k.Lead)
			case k.Step < 0 || k.Step > 0.6:
				return fmt.Errorf("the clip %s's key %d: a step of %v m is not 0 to 0.6", name, i, k.Step)
			case !slices.Contains(keySides, k.Side):
				return fmt.Errorf("the clip %s's key %d: side %q is neither port nor starboard", name, i, k.Side)
			}
		}
	}
	for name, r := range lib.Retarget {
		if _, ok := sources[r.File]; !ok {
			return fmt.Errorf("the retarget %s: %s is not in %s", name, r.File, sourcesFile)
		}
		for _, e := range r.Lock {
			if !strings.HasPrefix(e, "foot_") || !slices.Contains(effectors, e) {
				return fmt.Errorf("the retarget %s: only feet are locked, not %q", name, e)
			}
		}
		for _, e := range r.Still {
			if !strings.HasPrefix(e, "hand_") || !slices.Contains(effectors, e) {
				return fmt.Errorf("the retarget %s: only arms are kept still, by their hands, not %q", name, e)
			}
		}
		switch {
		case !slices.Contains(groups, r.Group):
			return fmt.Errorf("the retarget %s: no file %q beside the clips", name, r.Group)
		case !slices.Contains(shipStages, r.Stage):
			return fmt.Errorf("the retarget %s: no place %q on the ship", name, r.Stage)
		case r.Clear < 0 || r.Clear > 0.1 || r.Clear > 0 && r.Stage != "ship-rail":
			return fmt.Errorf("the retarget %s: a clearance over the rail is 0 to 0.1 m, and only on it", name)
		case r.Stage != "" && !r.Deck:
			return fmt.Errorf("the retarget %s: set on the ship's %s, it is on a deck", name, r.Stage)
		case (r.Speed != 0 || r.Head != 0) && !r.Deck:
			return fmt.Errorf("the retarget %s: a speed or a head's height is over a deck, and it has none", name)
		case r.Deck && len(r.Lock) > 0:
			return fmt.Errorf("the retarget %s: its feet are on the deck, not locked", name)
		case r.Speed < 0 || r.Speed > 2:
			return fmt.Errorf("the retarget %s: a speed of %v m/s is not 0 to 2", name, r.Speed)
		case r.Seconds < 0 || r.Seconds > 60:
			return fmt.Errorf("the retarget %s: %v seconds is not 0 to 60", name, r.Seconds)
		case !slices.Contains(ways, r.Way) || r.Way != "" && r.Speed == 0:
			return fmt.Errorf("the retarget %s: it walks forward, left or right, not %q, and at a speed", name, r.Way)
		case r.Smooth < 0 || r.Smooth > 10:
			return fmt.Errorf("the retarget %s: smoothed over %v frames, not 0 to 10", name, r.Smooth)
		case r.Crawl && !r.Deck:
			return fmt.Errorf("the retarget %s: crawling, it is on a deck", name)
		case r.Head < 0 || r.Head > 2:
			return fmt.Errorf("the retarget %s: a head %v m over the deck is not 0 to 2", name, r.Head)
		}
	}
	return nil
}

func (p pose) check(bones []string, points map[string]bool, all map[string]pose) error {
	if p.From != "" {
		if _, ok := all[p.From]; !ok {
			return fmt.Errorf("it comes from %q, which is no pose", p.From)
		}
	}
	if !slices.Contains(places, p.Place) {
		return fmt.Errorf("its place %q is none of %s", p.Place, strings.Join(places[1:], ", "))
	}
	if p.Shift != nil && len(p.Shift) != 3 {
		return fmt.Errorf("its shift %v is not [forward, inboard, up]", p.Shift)
	}
	for _, tr := range p.Turn {
		if len(tr) != 3 {
			return fmt.Errorf("the turn %v is not [bone, axis, degrees]", tr)
		}
		bone, _ := tr[0].(string)
		axis, _ := tr[1].(string)
		deg, ok := number(tr[2])
		switch {
		case !slices.Contains(bones, bone):
			return fmt.Errorf("the turn %v: no bone %q", tr, tr[0])
		case !slices.Contains(turnAxes, axis):
			return fmt.Errorf("the turn %v: the axis is x, y, z or lx", tr)
		case !ok || math.Abs(deg) > maxDegrees:
			return fmt.Errorf("the turn %v: the degrees are a number within ±%v", tr, maxDegrees)
		}
	}
	for e, tg := range p.IK {
		switch {
		case !slices.Contains(effectors, e):
			return fmt.Errorf("IK on %q: only %s", e, strings.Join(effectors, ", "))
		case tg.At == "bone" && !slices.Contains(bones, tg.Bone):
			return fmt.Errorf("IK on %s: at the bone %q, which the skeleton has not", e, tg.Bone)
		case tg.At != "bone" && !points[tg.At]:
			return fmt.Errorf("IK on %s: at %q, which is no place on the stage", e, tg.At)
		case tg.Offset != nil && len(tg.Offset) != 3, tg.Pole != nil && len(tg.Pole) != 3:
			return fmt.Errorf("IK on %s: an offset or a pole is three numbers", e)
		case tg.Reach < 0 || tg.Reach > 1 || tg.Reach > 0 && tg.At == "bone":
			return fmt.Errorf("IK on %s: a reach is a share of a limb, on a stage target", e)
		case tg.Grip != nil && (!strings.HasPrefix(e, "hand") || len(tg.Grip.Aim) != 3 || len(tg.Grip.Palm) != 3):
			return fmt.Errorf("IK on %s: a grip is a hand's, its aim and palm three numbers each", e)
		}
	}
	return nil
}

// chain fails if a pose comes, through others, from itself.
func (lib poseLibrary) chain(name string, seen []string) error {
	if slices.Contains(seen, name) {
		return fmt.Errorf("the pose %s comes from itself", name)
	}
	if from := lib.Poses[name].From; from != "" {
		return lib.chain(from, append(seen, name))
	}
	return nil
}

// skeletonOf is tables.yaml's skeleton: every bone, in the files' order.
func skeletonOf(t tables) ([]string, error) {
	raw, ok := t.Tables["skeleton"].([]any)
	if !ok || len(raw) == 0 {
		return nil, fmt.Errorf("%s has no skeleton", tablesFile)
	}
	out := make([]string, 0, len(raw))
	for _, b := range raw {
		s, ok := b.(string)
		if !ok || slices.Contains(out, s) {
			return nil, fmt.Errorf("%s's skeleton: %v is not a bone's name, or is there twice", tablesFile, b)
		}
		out = append(out, s)
	}
	return out, nil
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

// checkClips fails unless every clip a look names is in the library.
func checkClips(l look, lib poseLibrary) error {
	for _, c := range l.Clips {
		_, made := lib.Clips[c]
		_, other := lib.Retarget[c]
		if !made && !other {
			return fmt.Errorf("%s names the clip %q, which the pose library has not", l.ID, c)
		}
	}
	return nil
}
