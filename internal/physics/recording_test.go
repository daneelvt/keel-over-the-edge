// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"path/filepath"
	"reflect"
	"testing"
)

// Sails recorded in the client's sandbox (testdata/recordings/*.json): each
// is a scenario of the golden tests' format whose end is the state the
// sandbox reached. Replayed here, natively, each must reach the same state
// bit for bit: the boat sailed in the browser is the boat the server sails.
// client/src/sandbox/sandbox.test.ts records sandbox-sail.json and checks it
// is still what the sandbox records.

type recordingFile struct {
	Params    map[string]any     `json:"params"`
	Scenarios []recordedScenario `json:"scenarios"`
}

type recordedScenario struct {
	scenario
	End map[string]string `json:"end"`
}

func TestRecordings(t *testing.T) {
	paths, err := filepath.Glob("testdata/recordings/*.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no recordings in testdata/recordings")
	}
	for _, p := range paths {
		var f recordingFile
		readJSON(t, p, &f)
		for _, sc := range f.Scenarios {
			t.Run(filepath.Base(p)+"/"+sc.Name, func(t *testing.T) {
				g, err := runScenario(f.Params, sc.scenario)
				if err != nil {
					t.Fatal(err)
				}
				if len(g.Checkpoints) == 0 {
					t.Fatal("no steps")
				}
				got := g.Checkpoints[len(g.Checkpoints)-1]
				if got.Step != sc.Steps {
					t.Fatalf("the last checkpoint is at step %d, not %d", got.Step, sc.Steps)
				}
				if !reflect.DeepEqual(got.State, sc.End) {
					t.Errorf("after %d steps:\n got  %v\n want %v", sc.Steps, got.State, sc.End)
				}
			})
		}
	}
}
