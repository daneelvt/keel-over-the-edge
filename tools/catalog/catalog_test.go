// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// validBoats is one boat, with the real Jolly boat's physics values. Its
// model, testArt, is written by every fixture.
var validBoats = `boats:
  - id: test-boat
    name: Test boat
    description: A boat for tests
    capacity: 2
    stations:
      - { at: [0.55, 0.3, 0.4], pose: seated, facing: 270 }
      - { at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }
    lengthOverall: 3.5
    beam: 1.2
    lights: [tricolour]
    lookout: 2
    perch: [0, 0.4, -1.9]
    deck: [0.3, 0.1, -0.3]
    startSheet: [[110, 0.25]]
    controls:
      sheet: { name: Sheet, trim: Trim, ease: Ease }
      reef: [Full sail, One reef, Two reefs]
    fleet: sailor
    art:
      model: boats/test-boat/model.glb
      far: boats/test-boat/far.glb
      budget: { near: 15000, far: 1000 }
` + realPhysics()

const (
	testArt    = "art/boats/test-boat/model.glb"
	testFarArt = "art/boats/test-boat/far.glb"
)

// The sailors every fixture has unless it gives its own, and their art.
const (
	validSailors   = "sailors:\n  - id: test-sailor\n    name: Test sailor\n    habit: tests\n    hair: colours\n    versions:\n      - id: test-version\n        name: version\n        art:\n          model: sailors/test.deck.glb\n          far: sailors/test.far.glb\n          close: sailors/test.glb\n          clips: sailors/test.clips.glb\n          portrait: sailors/test.portrait.avif\n          portraitFallback: sailors/test.portrait.webp\n          portraitMask: sailors/test.portrait-mask.webp\n          ink: sailors/test.ink.webp\n" + validOptions + validMachine
	validBoatLooks = "boatLooks:\n  paints:\n    - {id: test-paint, name: paint, colour: \"#e9e2d0\"}\n  cloths:\n    - {id: test-cloth, name: cloth, colour: \"#efe7d2\", ink: \"#2b2622\"}\n  lettering: \"#c9a447\"\n  numbers: 9999\n"
	validOptions   = "sailorOptions:\n  skins:\n    - {id: test-skin, name: skin, colour: \"#cda385\"}\n  hairs:\n    - {id: test-hair, name: hair, colour: \"#654a37\"}\n  greys:\n    - {id: test-grey, name: grey, colour: \"#817b76\"}\n  colours:\n    - {id: test-colour, name: colour, colour: \"#9b2226\"}\n"
	validMachine   = "machine:\n  habit: tests\n  lamp: \"#ffb347\"\n  versions:\n    - id: test-machine\n      name: version\n      art:\n        model: sailors/m.deck.glb\n        far: sailors/m.far.glb\n        close: sailors/m.glb\n        clips: sailors/m.clips.glb\n        portrait: sailors/m.portrait.avif\n        portraitFallback: sailors/m.portrait.webp\n        portraitMask: sailors/m.portrait-mask.webp\n        ink: sailors/m.ink.webp\n  finishes:\n    - {id: test-finish, name: finish, colour: \"#808080\"}\n"
	sailorsPath    = "shared/catalog/sailors.yaml"
	weatherPath    = "shared/catalog/weather.yaml"
	skyPath        = "shared/catalog/sky.yaml"
	boatsPath      = "shared/catalog/boats.yaml"
	boatLooksPath  = "shared/catalog/boatlooks.yaml"
	encounterPath  = "shared/catalog/encounters.yaml"
	worldPath      = "shared/catalog/world.yaml"
	noticesPath    = "shared/catalog/notices.yaml"
	lifePath       = "shared/catalog/life.yaml"
)

// glb is a glTF binary holding only its JSON: nodes of the given names.
func glb(nodes ...string) string {
	var doc struct {
		Nodes []map[string]string `json:"nodes"`
	}
	for _, n := range nodes {
		doc.Nodes = append(doc.Nodes, map[string]string{"name": n})
	}
	body, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	for len(body)%4 != 0 {
		body = append(body, ' ')
	}
	out := binary.LittleEndian.AppendUint32(nil, glbMagic)
	out = binary.LittleEndian.AppendUint32(out, 2)
	out = binary.LittleEndian.AppendUint32(out, uint32(20+len(body)))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)))
	out = binary.LittleEndian.AppendUint32(out, glbJSON)
	return string(append(out, body...))
}

// realSky returns the real catalog's sky, which every fixture has unless
// it gives its own.
func realSky() string {
	data, err := os.ReadFile(filepath.Join("..", "..", skyPath))
	if err != nil {
		panic(err)
	}
	return string(data)
}

// realEncounters returns the real catalog's encounters, which every
// fixture has unless it gives its own.
func realEncounters() string {
	data, err := os.ReadFile(filepath.Join("..", "..", encounterPath))
	if err != nil {
		panic(err)
	}
	return string(data)
}

// realFile returns a file of the real repository.
func realFile(path string) string {
	data, err := os.ReadFile(filepath.Join("..", "..", path))
	if err != nil {
		panic(err)
	}
	return string(data)
}

// realBoats returns the real catalog's boats.
func realBoats() string {
	data, err := os.ReadFile(filepath.Join("..", "..", boatsPath))
	if err != nil {
		panic(err)
	}
	return string(data)
}

// realWeather returns the real catalog's weather, which every fixture has
// unless it gives its own.
func realWeather() string {
	data, err := os.ReadFile(filepath.Join("..", "..", weatherPath))
	if err != nil {
		panic(err)
	}
	return string(data)
}

// realPhysics returns the physics block of the real catalog's first boat.
func realPhysics() string {
	data, err := os.ReadFile(filepath.Join("..", "..", catalogDir, "boats.yaml"))
	if err != nil {
		panic(err)
	}
	s := string(data)
	start := strings.Index(s, "    physics:\n")
	if start < 0 {
		panic("shared/catalog/boats.yaml has no physics block")
	}
	s = s[start:]
	if end := strings.Index(s, "\n  - "); end >= 0 {
		s = s[:end+1]
	}
	return s
}

// fixture makes a repository root holding the real schema, the test boat's
// model and the given files, relative to that root.
func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	schema, err := os.ReadFile(filepath.Join("..", "..", schemaPath))
	if err != nil {
		t.Fatal(err)
	}
	files[schemaPath] = string(schema)
	if _, ok := files[testArt]; !ok {
		files[testArt] = glb("hull", "tricolour")
	}
	if _, ok := files[testFarArt]; !ok {
		files[testFarArt] = "glTF"
	}
	if _, ok := files[sailorsPath]; !ok {
		files[sailorsPath] = validSailors
		for _, who := range []string{"test", "m"} {
			for _, f := range []string{".deck.glb", ".far.glb", ".glb", ".clips.glb", ".portrait.avif", ".portrait.webp", ".portrait-mask.webp", ".ink.webp"} {
				files["art/sailors/"+who+f] = "art"
			}
		}
	}
	if _, ok := files[boatLooksPath]; !ok {
		files[boatLooksPath] = validBoatLooks
	}
	if _, ok := files[weatherPath]; !ok {
		files[weatherPath] = realWeather()
	}
	if _, ok := files[skyPath]; !ok {
		files[skyPath] = realSky()
	}
	if _, ok := files[encounterPath]; !ok {
		files[encounterPath] = realEncounters()
	}
	if _, ok := files[noticesPath]; !ok {
		files[noticesPath] = realFile(noticesPath)
	}
	if _, ok := files[worldPath]; !ok {
		files[worldPath] = realFile(worldPath)
	}
	if _, ok := files[lifePath]; !ok {
		files[lifePath] = realFile(lifePath)
	}
	// The real world's town kits.
	for _, kit := range []string{"wooded", "tropical", "rocky", "sandy", "volcanic"} {
		if p := "art/town/" + kit + ".glb"; files[p] == "" {
			files[p] = "glTF"
		}
	}
	// The real plants and the life's bodies.
	for _, p := range []string{"art/flora/plants.glb", "art/life/swimmers.glb"} {
		if files[p] == "" {
			files[p] = "glTF"
		}
	}
	for p, content := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// checkAll runs every check of the tool except generation.
func checkAll(root string) error {
	doc, err := readCatalog(root)
	if err != nil {
		return err
	}
	if err := validate(root, doc); err != nil {
		return err
	}
	if err := checkIDs(doc); err != nil {
		return err
	}
	if _, err := checkArt(root, doc); err != nil {
		return err
	}
	if err := checkLights(root, doc); err != nil {
		return err
	}
	if err := checkWorld(doc); err != nil {
		return err
	}
	if err := checkBoats(doc); err != nil {
		return err
	}
	return checkIDsNotInCode(root, ids(doc))
}

func TestValidCatalog(t *testing.T) {
	root := fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats})
	if err := checkAll(root); err != nil {
		t.Fatal(err)
	}
}

func TestRejects(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "schema violation",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "capacity: 2", "capacity: 0", 1)},
			want:  "/boats/0/capacity",
		},
		{
			name:  "unknown field",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats + "    colour: red\n"},
			want:  "colour",
		},
		{
			name:  "a day of zero",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats, skyPath: strings.Replace(realSky(), "  day: 118", "  day: 0", 1)},
			want:  "/sky/day",
		},
		{
			name:  "a scale below 1",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats, skyPath: strings.Replace(realSky(), "  scale: 10", "  scale: 0.5", 1)},
			want:  "/sky/scale",
		},
		{
			name:  "a scale above 20",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats, skyPath: strings.Replace(realSky(), "  scale: 10", "  scale: 21", 1)},
			want:  "/sky/scale",
		},
		{
			name:  "a star outside the sphere",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats, skyPath: strings.Replace(realSky(), "declination: 74.15556", "declination: 94.15556", 1)},
			want:  "/sky/stars/1/declination",
		},
		{
			name:  "an unknown kind of light",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "lights: [tricolour]", "lights: [masthead]", 1)},
			want:  "/boats/0/lights/0",
		},
		{
			name: "a light without its node",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				testArt:                     glb("hull", "mast"),
			},
			want: `has no node "tricolour"`,
		},
		{
			name: "a model that is not a glTF binary",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				testArt:                     "glTF",
			},
			want: "not a glTF binary",
		},
		{
			name:  "a tricolour on a boat of 20 m",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "lengthOverall: 3.5", "lengthOverall: 20", 1)},
			want:  "a tricolour on a boat of 20 m",
		},
		{
			name: "lights that leave the stern dark",
			files: map[string]string{
				"shared/catalog/boats.yaml": strings.Replace(validBoats, "lights: [tricolour]", "lights: [port, starboard]", 1),
				testArt:                     glb("port", "starboard"),
			},
			want: "do not make the full circle once",
		},
		{
			name: "lights that cover the circle twice",
			files: map[string]string{
				"shared/catalog/boats.yaml": strings.Replace(validBoats, "lights: [tricolour]", "lights: [tricolour, stern]", 1),
				testArt:                     glb("tricolour", "stern"),
			},
			want: "do not make the full circle once",
		},
		{
			name:  "physics value missing",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        rudderTime:", "        rudderTimes:", 1)},
			want:  "/boats/0/physics/rates",
		},
		{
			name:  "physics value out of range",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        flattenMin: ", "        flattenMin: 2 #", 1)},
			want:  "/boats/0/physics/sailor/flattenMin",
		},
		{
			name:  "physics table of the wrong length",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        dragArea: [", "        dragArea: [0.1, ", 1)},
			want:  "/boats/0/physics/hull/dragArea",
		},
		{
			name:  "an autopilot with no gain",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        gain: ", "        gain: 0 #", 1)},
			want:  "/boats/0/physics/autopilot/gain",
		},
		{
			name:  "an autopilot with no damping",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        damping: ", "        damping: 0 #", 1)},
			want:  "/boats/0/physics/autopilot/damping",
		},
		{
			name:  "an autopilot let by the lee past a beam reach",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        byTheLee: ", "        byTheLee: 61 #", 1)},
			want:  "/boats/0/physics/autopilot/byTheLee",
		},
		{
			name:  "a gybe at more than the full helm",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        gybeHelm: ", "        gybeHelm: 1.2 #", 1)},
			want:  "/boats/0/physics/autopilot/gybeHelm",
		},
		{
			name:  "a tack at no helm",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        tackHelm: ", "        tackHelm: 0 #", 1)},
			want:  "/boats/0/physics/autopilot/tackHelm",
		},
		{
			name:  "a hull's value in waves missing",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        waterplaneArea:", "        waterplaneAreas:", 1)},
			want:  "/boats/0/physics/hull",
		},
		{
			name:  "a hull's value in waves out of range",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "        heaveDamping: ", "        heaveDamping: 3 #", 1)},
			want:  "/boats/0/physics/hull/heaveDamping",
		},
		{
			name: "no weather",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				weatherPath:                 "# none\n{}\n",
			},
			want: "weather",
		},
		{
			name: "sea value missing",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				weatherPath:                 strings.Replace(realWeather(), "    gamma:", "    gammas:", 1),
			},
			want: "/weather/sea",
		},
		{
			name: "sea value out of range",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				weatherPath:                 strings.Replace(realWeather(), "    cull: ", "    cull: 0.9 #", 1),
			},
			want: "/weather/sea/cull",
		},
		{
			name: "spreading not a whole number",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				weatherPath:                 strings.Replace(realWeather(), "    spreading: 5", "    spreading: 5.5", 1),
			},
			want: "/weather/sea/spreading",
		},
		{
			name:  "bad id",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "test-boat", "Test Boat", 1)},
			want:  "/boats/0/id",
		},
		{
			name: "duplicate id",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats + strings.Replace(
				strings.TrimPrefix(validBoats, "boats:\n"), "Test boat", "Another", 1)},
			want: `id "test-boat" is used more than once`,
		},
		{
			name: "list defined twice",
			files: map[string]string{
				"shared/catalog/a.yaml": validBoats,
				"shared/catalog/b.yaml": validBoats,
			},
			want: "already defined",
		},
		{
			name: "missing art",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"model: boats/test-boat/model.glb", "model: boats/missing.glb", 1)},
			want: "art/boats/missing.glb does not exist",
		},
		{
			name: "missing far model",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"far: boats/test-boat/far.glb", "far: boats/missing.far.glb", 1)},
			want: "art/boats/missing.far.glb does not exist",
		},
		{
			name: "no far model",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"      far: boats/test-boat/far.glb\n", "", 1)},
			want: "/boats/0/art: &{[far]}",
		},
		{
			name: "no art",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"    art:\n      model: boats/test-boat/model.glb\n      far: boats/test-boat/far.glb\n      budget: { near: 15000, far: 1000 }\n", "", 1)},
			want: "/boats/0: &{[art]}",
		},
		{
			name: "no sailors",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				sailorsPath:                 "sailors: []\n" + validOptions + validMachine,
			},
			want: "/sailors: ",
		},
		{
			name: "a station short",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"      - { at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }\n", "", 1)},
			want: "boats[0].stations: 1, not one for each of the 2 it carries",
		},
		{
			name: "a station outside the hull",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"at: [-0.3, 0.3, -0.5]", "at: [-0.7, 0.3, -0.5]", 1)},
			want: "boats[0].stations[1]: (-0.7, -0.5) is outside the hull",
		},
		{
			name: "a station under the water",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"at: [-0.3, 0.3, -0.5]", "at: [-0.3, -0.1, -0.5]", 1)},
			want: "boats[0].stations[1]: -0.1 m up is not on a deck",
		},
		{
			name: "two stations at one place",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"at: [-0.3, 0.3, -0.5]", "at: [0.3, 0.3, 0.3]", 1)},
			want: "boats[0].stations[1]: within 0.45 m of stations[0]",
		},
		{
			name: "a station on the rail away from the deck's edge",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"pose: standing", "pose: rail", 1)},
			want: "boats[0].stations[1]: on the rail 0.3 m out, but the deck's edge is",
		},
		{
			name: "a station to windward on another when the wind is on the other side",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"{ at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }", "{ at: [-0.55, 0.3, 0.1], pose: seated, facing: 90, windward: true }", 1)},
			want: "boats[0].stations[1]: within 0.45 m of stations[0] with the weather to starboard",
		},
		{
			name: "a station to leeward on another when the wind is on the other side",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"{ at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }", "{ at: [-0.55, 0.3, 0.1], pose: seated, facing: 90, lee: true }", 1)},
			want: "boats[0].stations[1]: within 0.45 m of stations[0] with the weather to port",
		},
		{
			name: "a station both to windward and to leeward",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"{ at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }", "{ at: [-0.3, 0.3, -0.5], pose: standing, facing: 0, windward: true, lee: true }", 1)},
			want: "boats[0].stations[1]: both to windward and to leeward",
		},
		{
			name: "a station aloft above the lookout's eye",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats,
				"{ at: [-0.3, 0.3, -0.5], pose: standing, facing: 0 }", "{ at: [0, 2.5, -0.5], pose: aloft, facing: 0 }", 1)},
			want: "boats[0].stations[1]: aloft 2.5 m up is not above the boom",
		},
		{
			name:  "a station's pose unknown",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "pose: standing", "pose: kneeling", 1)},
			want:  "/boats/0/stations/1/pose",
		},
		{
			name: "id in code",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				"internal/x/x.go":           "package x\n\nvar special = \"test-boat\"\n",
			},
			want: `internal/x/x.go: "test-boat"`,
		},
		{
			name: "id in client code",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				"client/src/x.ts":           "export const special = 'test-boat';\n",
			},
			want: `client/src/x.ts: 'test-boat'`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkAll(fixture(t, tc.files))
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestSeparateLights(t *testing.T) {
	root := fixture(t, map[string]string{
		"shared/catalog/boats.yaml": strings.Replace(strings.Replace(validBoats, "lights: [tricolour]", "lights: [stern, port, starboard]", 1), "lengthOverall: 3.5", "lengthOverall: 24", 1),
		testArt:                     glb("hull", "port", "starboard", "stern"),
	})
	if err := checkAll(root); err != nil {
		t.Fatal(err)
	}
}

func TestIDsAllowedInTestsAndGeneratedFiles(t *testing.T) {
	root := fixture(t, map[string]string{
		"shared/catalog/boats.yaml":        validBoats,
		"internal/x/x_test.go":             "package x\n\nvar b = \"test-boat\"\n",
		"internal/x/types.gen.go":          "package x\n\nvar b = \"test-boat\"\n",
		"client/src/x.test.ts":             "const b = 'test-boat';\n",
		"internal/x/testdata/fixture.go":   "package x\n\nvar b = \"test-boat\"\n",
		"client/node_modules/pkg/index.ts": "const b = 'test-boat';\n",
	})
	if err := checkAll(root); err != nil {
		t.Fatal(err)
	}
}

func TestArtPresentAndUnreferenced(t *testing.T) {
	root := fixture(t, map[string]string{
		"shared/catalog/boats.yaml": validBoats,
		"art/boats/orphan.png":      "png",
		"art/README.md":             "readme",
		"art/boats/test/build.ts":   "// the model's script",
		"art/sound/wind.json":       "{}",
	})
	doc, err := readCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	warnings, err := checkArt(root, doc)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "art/boats/orphan.png") {
		t.Fatalf("warnings = %q, want one about the orphan", warnings)
	}
}

func TestCanonicalJSONIgnoresFileOrderAndLayout(t *testing.T) {
	a := fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats})
	reordered := `boats:
  - lengthOverall: 3.50
    art: {model: boats/test-boat/model.glb, far: boats/test-boat/far.glb, budget: {far: 1000, near: 15000}}
    fleet: sailor
    controls: {reef: [Full sail, One reef, Two reefs], sheet: {trim: Trim, name: Sheet, ease: Ease}}
    beam: 1.20
    capacity: 2
    stations: [{facing: 270, pose: seated, at: [0.55, 0.30, 0.4]}, {pose: standing, at: [-0.3, 0.3, -0.5], facing: 0}]
    description: A boat for tests
    name: Test boat
    lights:
      - tricolour
    lookout: 2.0
    perch: [0, 0.4, -1.9]
    deck: [0.3, 0.1, -0.3]
    startSheet: [[110, 0.25]]
    id: test-boat
` + realPhysics()
	b := fixture(t, map[string]string{"shared/catalog/boats.yaml": reordered})
	encode := func(root string) string {
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	if encode(a) != encode(b) {
		t.Fatalf("canonical JSON differs:\n%s\n%s", encode(a), encode(b))
	}
}

func TestWriteOrCheck(t *testing.T) {
	root := t.TempDir()
	files := map[string][]byte{"out/a.json": []byte("{}\n")}
	if err := writeOrCheck(root, files, true); err == nil {
		t.Fatal("check passed with the file missing")
	}
	if err := writeOrCheck(root, files, false); err != nil {
		t.Fatal(err)
	}
	if err := writeOrCheck(root, files, true); err != nil {
		t.Fatalf("check failed after writing: %v", err)
	}
}

func TestParamsMatchTheSchema(t *testing.T) {
	fields, err := physicsFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkParams(fields); err != nil {
		t.Fatal(err)
	}
	swapped := append([]physicsField{fields[1], fields[0]}, fields[2:]...)
	if err := checkParams(swapped); err == nil || !strings.Contains(err.Error(), "field 0") {
		t.Errorf("two fields swapped: %v", err)
	}
	if err := checkParams(fields[1:]); err == nil {
		t.Error("a field missing from the schema was accepted")
	}
	longer := append([]physicsField{}, fields...)
	for i := range longer {
		if longer[i].length > 0 {
			longer[i].length++
			break
		}
	}
	if err := checkParams(longer); err == nil || !strings.Contains(err.Error(), "values)") {
		t.Errorf("an array of another length: %v", err)
	}

	sea, err := seaFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkSeaParams(sea); err != nil {
		t.Fatal(err)
	}
	if err := checkSeaParams(sea[1:]); err == nil || !strings.Contains(err.Error(), "SeaParams") {
		t.Errorf("a sea value missing from the schema: %v", err)
	}

	sky, err := skyFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkSkyParams(sky); err != nil {
		t.Fatal(err)
	}
	if err := checkSkyParams(append([]physicsField{sky[1], sky[0]}, sky[2:]...)); err == nil || !strings.Contains(err.Error(), "field 0") {
		t.Errorf("two of the sky's numbers swapped: %v", err)
	}
}

func TestPhysicsGenerated(t *testing.T) {
	fields, err := physicsFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	sea, err := seaFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	sky, err := skyFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	wind, err := windFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	regime, err := regimeFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	encounters, err := encounterFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	clouds, err := cloudFields(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	g, err := goPhysics(fields, sea, sky, wind, regime, clouds, encounters)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"p.Displacement = b.Physics.Hull.Displacement", "copy(p.DragArea[:], b.Physics.Hull.DragArea)",
		"p.WaveForce = b.Physics.Hull.WaveForce", "p.WaveYaw = b.Physics.Hull.WaveYaw", "p.Shortest = float64(c.Weather.Sea.Shortest)", "p.Spreading = float64(c.Weather.Sea.Spreading)",
		"p.Day = float64(c.Sky.Day)", "p.MoonAtEpoch = float64(c.Sky.MoonAtEpoch)",
		"p.SpeedCentre = float64(c.Weather.Disk.SpeedCentre)", "copy(p.AcrossTurn[:], c.Weather.Disk.AcrossTurn)",
		"p.WaveSamples = float64(c.Weather.WaveWind.WaveSamples)", "copy(p.Speed[:], r.Speed)", "p.Drift = float64(r.Drift)",
		"copy(p.Outline[:], b.Physics.Hull.Outline)", "p.CloseHauled = b.Physics.Rig.CloseHauled",
		"p.Restitution = float64(c.Encounters.Contact.Restitution)", "copy(p.Deflection[:], c.Encounters.Shadow.Deflection)",
		"p.HeadToWind = float64(c.Encounters.Articles.HeadToWind)",
		"p.Cirrus = float64(c.Weather.Clouds.Cirrus)", "copy(p.FrontCirrus[:], c.Weather.Clouds.FrontCirrus)"} {
		if !strings.Contains(string(g), want) {
			t.Errorf("physics.gen.go lacks %q", want)
		}
	}
	ts := string(tsParams(fields, sea, sky, wind, regime, clouds, encounters))
	for _, want := range []string{"params[f.displacement] = p.hull.displacement;", "params.set(p.hull.dragArea, f.dragArea);",
		"export function writeSeaParams(", "params[f.fetchCap] = s.fetchCap;",
		"export function writeSkyParams(", "params[0] = s.day;", "params[4] = s.epoch;",
		"export function writeWeatherParams(", "params[f.speedCentre] = w.disk.speedCentre;", "params.set(w.disk.acrossTurn, f.acrossTurn);",
		"export function writeRegime(", "record.set(r.speed, f.speed);", "record[f.gustFactor] = r.gustFactor;",
		"export function writeEncounterParams(", "params[f.restitution] = e.contact.restitution;", "params.set(e.shadow.deflection, f.deflection);",
		"export function writeCloudParams(", "params[f.lattice] = c.lattice;", "params.set(c.frontRain, f.frontRain);"} {
		if !strings.Contains(ts, want) {
			t.Errorf("params.gen.ts lacks %q", want)
		}
	}
}

// TestEncounters checks the outline and the encounters' numbers: what the
// schema rejects, and what checkEncounters does.
func TestEncounters(t *testing.T) {
	boats := realBoats()
	outline := "outline: [0.528, 0.592, 0.646, 0.682, 0.695, 0.685, 0.651, 0.590, 0.492, 0.342, 0]"
	if !strings.Contains(boats, outline) {
		t.Fatal("the test's outline is not the catalog's")
	}
	cases := []struct {
		name       string
		boats, enc string
		want       string
	}{
		{name: "the real catalog"},
		{name: "not convex", boats: strings.Replace(boats, outline, "outline: [0.528, 0.592, 0.646, 0.682, 0.695, 0.685, 0.651, 0.40, 0.492, 0.342, 0]", 1), want: "not convex"},
		{name: "a blunt stem", boats: strings.Replace(boats, outline, "outline: [0.528, 0.592, 0.646, 0.682, 0.695, 0.685, 0.651, 0.590, 0.492, 0.342, 0.1]", 1), want: "not convex"},
		{name: "ten stations", boats: strings.Replace(boats, outline, "outline: [0.528, 0.592, 0.646, 0.682, 0.695, 0.685, 0.651, 0.590, 0.492, 0]", 1), want: "/boats/0/physics/hull/outline"},
		{name: "wider than the beam", boats: strings.Replace(strings.Replace(boats, "beam: 1.39", "beam: 1.2", 1), "at: [0.69, 0.31, 0.35]", "at: [0.59, 0.31, 0.35]", 1), want: "wider than half the beam"},
		{name: "longer than the boat", boats: strings.Replace(boats, "stem: 2.25", "stem: 2.5", 1), want: "not the length overall"},
		{name: "close-hauled at 20°", boats: strings.Replace(boats, "closeHauled: 40", "closeHauled: 20", 1), want: "/boats/0/physics/rig/closeHauled"},
		{name: "close-hauled at 81°", boats: strings.Replace(boats, "closeHauled: 40", "closeHauled: 81", 1), want: "/boats/0/physics/rig/closeHauled"},
		{name: "a restitution above 1", enc: strings.Replace(realEncounters(), "restitution: 0.3", "restitution: 1.2", 1), want: "/encounters/contact/restitution"},
		{name: "a restitution below 0", enc: strings.Replace(realEncounters(), "restitution: 0.3", "restitution: -0.1", 1), want: "/encounters/contact/restitution"},
		{name: "two hulls with a pointed bow", boats: strings.Replace(boats, "1.115, 1.07, 1.0]", "1.115, 1.07, 0]", 1), want: "not convex with a flat bow"},
		{name: "two hulls and one rudder", boats: strings.Replace(boats, "rudderCount: 2", "rudderCount: 1", 1), want: "two hulls need two rudders"},
		{name: "one hull and two rudders", boats: strings.Replace(boats, "        rudderCount: 1\n", "        rudderCount: 2\n", 1), want: "one hull has one rudder"},
		{name: "a righting lever's step of 7°", boats: strings.Replace(boats, "rightingLeverStep: 5", "rightingLeverStep: 7", 1), want: "not a whole number"},
		{name: "the bows buried past the pitchpole", boats: strings.Replace(boats, "pitchpoleAngle: 25", "pitchpoleAngle: 4", 1), want: "before the pitchpole"},
		{name: "a taper past the reach", enc: strings.Replace(realEncounters(), "taper: 8", "taper: 12", 1), want: "taper"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			files := map[string]string{boatsPath: boats}
			if c.boats != "" {
				files[boatsPath] = c.boats
			}
			if c.enc != "" {
				files[encounterPath] = c.enc
			}
			// The real boat's art, so that only the encounters can fail.
			files["art/boats/jolly-boat.glb"] = glb("hull", "tricolour")
			files["art/boats/jolly-boat.far.glb"] = "glTF"
			files["art/boats/keelboat.glb"] = glb("hull", "tricolour")
			files["art/boats/keelboat.far.glb"] = "glTF"
			files["art/boats/tall-ship.glb"] = glb("hull", "port", "starboard", "stern")
			files["art/boats/tall-ship.far.glb"] = "glTF"
			files["art/boats/skiff.glb"] = glb("hull", "tricolour")
			files["art/boats/skiff.far.glb"] = "glTF"
			files["art/boats/beach-cat.glb"] = glb("hull", "tricolour")
			files["art/boats/beach-cat.far.glb"] = "glTF"
			root := fixture(t, files)
			err := checkAll(root)
			if err == nil {
				doc, rerr := readCatalog(root)
				if rerr != nil {
					t.Fatal(rerr)
				}
				err = checkEncounters(doc)
			}
			switch {
			case c.want == "" && err != nil:
				t.Fatal(err)
			case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
				t.Fatalf("got %v, want an error with %q", err, c.want)
			}
		})
	}
}
