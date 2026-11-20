// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// The annotations a release's manifests carry besides Flux's own, signed
// with them: which checks the build passed before it was released, and
// the versions the game compares with its checkpoint when it starts.
const (
	gateAnnotation     = "com.keelovertheedge.gate"
	catalogAnnotation  = "com.keelovertheedge.catalog"
	snapshotAnnotation = "com.keelovertheedge.snapshot"
	layoutAnnotation   = "com.keelovertheedge.layout"
)

// The gates a build passes before it is released: every check, or the
// short form a pull request labelled hotfix runs, with the full suite
// running in the same release run beside the build.
const (
	gateFull   = "full"
	gateHotfix = "hotfix"
)

// worldVersions are what the game's checkpoint is checked against when
// keel starts: a checkpoint written by a build whose catalog, snapshot
// format or physics layout differs is not restored, and the world starts
// empty.
type worldVersions struct {
	catalog, snapshot, layout string
}

// currentVersions are this commit's, read from the very constants the
// checkpoint is compared with.
func currentVersions() worldVersions {
	return worldVersions{
		catalog:  catalog.Version,
		snapshot: strconv.FormatUint(sim.SnapshotVersion, 10),
		layout:   strconv.FormatUint(uint64(physics.LayoutVersion), 10),
	}
}

// versionsOf reads a release's versions from its annotations. ok is false
// for a release made before they were recorded.
func versionsOf(annotations map[string]string) (v worldVersions, ok bool) {
	v = worldVersions{annotations[catalogAnnotation], annotations[snapshotAnnotation], annotations[layoutAnnotation]}
	return v, v.catalog != "" && v.snapshot != "" && v.layout != ""
}

// changes names what differs from v to w, as "the catalog (a → b)".
func (v worldVersions) changes(w worldVersions) []string {
	var c []string
	for _, f := range []struct{ name, a, b string }{
		{"the catalog", v.catalog, w.catalog},
		{"the snapshot format", v.snapshot, w.snapshot},
		{"the physics layout", v.layout, w.layout},
	} {
		if f.a != f.b {
			c = append(c, fmt.Sprintf("%s (`%s` → `%s`)", f.name, f.a, f.b))
		}
	}
	return c
}

// annotations are the release's own annotations for a build that passed
// gate, as key=value, one for each --annotations of flux push artifact.
func annotations(gate string) ([]string, error) {
	if gate != gateFull && gate != gateHotfix {
		return nil, fmt.Errorf("%q is not a gate: %s or %s", gate, gateFull, gateHotfix)
	}
	v := currentVersions()
	return []string{
		gateAnnotation + "=" + gate,
		catalogAnnotation + "=" + v.catalog,
		snapshotAnnotation + "=" + v.snapshot,
		layoutAnnotation + "=" + v.layout,
	}, nil
}

// worldLine is the line a promote's summary opens with: whether the world
// starts empty when production moves from now to next.
func worldLine(now, next release, following bool) string {
	if !following {
		return "**The world starts empty**: production follows no release yet."
	}
	a, okNow := versionsOf(now.annotations)
	b, okNext := versionsOf(next.annotations)
	switch {
	case !okNext:
		return fmt.Sprintf("**Whether the world starts empty is unknown**: build `%s` was released before the versions were recorded.", next.build)
	case !okNow:
		return fmt.Sprintf("**Whether the world starts empty is unknown**: build `%s`, which production follows, was released before the versions were recorded.", now.build)
	}
	if c := a.changes(b); len(c) > 0 {
		return "**This promote starts the world empty**: changed, " + strings.Join(c, ", ") + "."
	}
	return "**The world carries on**: the catalog, the snapshot format and the physics layout are those production runs now."
}
