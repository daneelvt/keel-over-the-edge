// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A world's week of weather is made with the world, from its seed, for the
// epoch and end it is planned to begin and end at: by the next world's job,
// right after its terrain. A world that begins at another time, late after
// keel was down or by the owner's hand, has its week made again for its
// epoch as it opens, and a world stored before weeks were made has one made
// as it opens. Once a world has begun, its week is never made again: a
// restart reads the week it has, whatever build reads it.

// islandsOf is a world's islands as its week's showers form over them.
func islandsOf(b *worldgen.Bundle) []weather.Island {
	var out []weather.Island
	for _, is := range b.Islands {
		if is.Group >= 0 {
			continue
		}
		out = append(out, weather.Island{X: is.X, Y: is.Y, Area: is.Area, Across: is.Across})
	}
	return out
}

// endOf is a world's end as its week is made for it: its row's, or the
// schedule's from its epoch for a world with none.
func (p *process) endOf(row store.World) time.Time {
	if !row.EndsAt.IsZero() {
		return row.EndsAt
	}
	return p.cfg.Schedule.EndOf(row.Epoch)
}

// makeWeek makes a world's week for an epoch and an end and stores it,
// fenced by the lease.
func (p *process) makeWeek(ctx context.Context, id [16]byte, number int, b *worldgen.Bundle, epoch, ends time.Time) (*weather.Week, error) {
	start := time.Now()
	w := weather.Generate(p.wcfg, b.Seed, epoch.UnixMicro(), ends.UnixMicro(), islandsOf(b))
	took := time.Since(start)
	records, digest, err := w.Encode()
	if err != nil {
		return nil, err
	}
	if err := p.db.StoreWeather(ctx, id, p.lease, &store.Weather{
		Version: w.Version, Epoch: epoch, Ends: ends, Records: records, Digest: digest[:], GenerationMs: int(took.Milliseconds()),
	}); err != nil {
		return nil, fmt.Errorf("storing world %d's week: %w", number, err)
	}
	r := w.Report
	level := slog.LevelInfo
	if !r.Passed {
		level = slog.LevelWarn
	}
	p.log.Log(ctx, level, "the world's week is made and stored", "world", number, "epoch", epoch, "ends", ends, "draws", r.Draws,
		"passed", r.Passed, "failed", r.Failed, "spells", r.Spells, "fronts", r.Fronts, "storms", r.Storms, "systems", r.Systems,
		"bytes", len(records), "took", took.Round(time.Microsecond).String())
	return w, nil
}

// storedWeek is a world's week as stored, if it has one made for its
// epoch: nil if it has none, or one made for another epoch.
func (p *process) storedWeek(ctx context.Context, row store.World) (*weather.Week, *store.Weather, error) {
	sw, err := p.db.LoadWeather(ctx, row.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	w, err := weather.Decode(sw.Records, sw.Digest)
	if err != nil {
		return nil, nil, err
	}
	return w, sw, nil
}

// weekFor is the timeline of a world about to open: its week as stored if
// it was made for the world's epoch, or made now for its epoch and end,
// and stored.
func (p *process) weekFor(ctx context.Context, rw *readyWorld) (*weather.Timeline, error) {
	row := rw.row
	// The week read as the world was loaded, if it was made for when the
	// world begins.
	if tl := rw.timeline; tl != nil && tl.Week() != nil && tl.Week().Epoch == row.Epoch.UnixMicro() {
		return tl, nil
	}
	w, sw, err := p.storedWeek(ctx, row)
	if err != nil {
		return nil, err
	}
	switch {
	case w != nil && sw.Epoch.Equal(row.Epoch):
		if w.Version != weather.Version {
			p.log.Info("the world's week was made by another version of the generator: it is sailed as it was made", "world", row.Number, "version", w.Version)
		}
	case w != nil:
		p.log.Info("the world begins at another time than its week was made for: its week is made again", "world", row.Number,
			"planned", sw.Epoch, "epoch", row.Epoch)
		w = nil
	default:
		p.log.Info("the world has no week of weather: one is made now", "world", row.Number)
	}
	if w == nil {
		if w, err = p.makeWeek(ctx, row.ID, row.Number, rw.bundle, row.Epoch, p.endOf(row)); err != nil {
			return nil, err
		}
	}
	return weather.New(p.wcfg, w)
}

// shownWeek is a world's timeline for the world page before it opens: its
// week as stored, made for when it is planned to begin, or nil.
func (p *process) shownWeek(ctx context.Context, row store.World) *weather.Timeline {
	w, _, err := p.storedWeek(ctx, row)
	if err != nil || w == nil {
		if err != nil {
			p.log.Warn("the next world's week cannot be read", "world", row.Number, "err", err)
		}
		return nil
	}
	tl, err := weather.New(p.wcfg, w)
	if err != nil {
		return nil
	}
	return tl
}

// weatherMain prints a world's week of weather: its spells, fronts and
// systems, and the checks it passed; or writes it, as stored, to a file.
//
//	keel weather -seed 1 -epoch 2026-10-18T22:00:00Z [-ends …] [-world FILE] [-out FILE] [-report]
func weatherMain(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("weather", flag.ContinueOnError)
	fs.SetOutput(stderr)
	seed := fs.String("seed", "1", "the world's seed")
	epochText := fs.String("epoch", time.UnixMicro(weather.SampleEpoch).UTC().Format(time.RFC3339), "the world's epoch, RFC 3339")
	endsText := fs.String("ends", "", "the world's end, RFC 3339; a week after its epoch if not given")
	worldFile := fs.String("world", "", "a world bundle (keel worldgen -out) whose islands the showers form over")
	out := fs.String("out", "", "write the week, as stored, to this file")
	report := fs.Bool("report", false, "print the report alone")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	s, err := strconv.ParseUint(*seed, 10, 64)
	if err != nil {
		return fmt.Errorf("weather: -seed: %w", err)
	}
	epoch, err := time.Parse(time.RFC3339, *epochText)
	if err != nil {
		return fmt.Errorf("weather: -epoch: %w", err)
	}
	ends := epoch.Add(7 * 24 * time.Hour)
	if *endsText != "" {
		if ends, err = time.Parse(time.RFC3339, *endsText); err != nil {
			return fmt.Errorf("weather: -ends: %w", err)
		}
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	cfg, err := weather.ConfigOf(cat)
	if err != nil {
		return err
	}
	var islands []weather.Island
	if *worldFile != "" {
		b, err := readWorldFile(*worldFile)
		if err != nil {
			return err
		}
		islands = islandsOf(b)
	}
	start := time.Now()
	w := weather.Generate(cfg, s, epoch.UnixMicro(), ends.UnixMicro(), islands)
	took := time.Since(start)
	records, digest, err := w.Encode()
	if err != nil {
		return err
	}
	if *out != "" {
		if err := os.WriteFile(*out, records, 0o644); err != nil {
			return err
		}
	}
	r := w.Report
	fmt.Fprintf(stdout, "seed %d, %s to %s: made in %v, %d draws, passed %v %v; %d bytes, digest %x\n", s, epoch.Format(time.RFC3339),
		ends.Format(time.RFC3339), took.Round(time.Microsecond), r.Draws, r.Passed, r.Failed, len(records), digest)
	fmt.Fprintf(stdout, "%d spells, %d fronts, %d storms, %d systems, %d not born, at most %d at once\n", r.Spells, r.Fronts, r.Storms, r.Systems, r.Refused, r.Most)
	for i, sh := range r.Shares {
		fmt.Fprintf(stdout, "  %-10s %5.1f%%  (the catalog's %2.0f%%)\n", cat.Weather.Regimes[i].ID, 100*sh, 100*cat.Weather.Regimes[i].Share)
	}
	if *report {
		return nil
	}
	hour := func(tick float64) string {
		at := epoch.Add(time.Duration(tick / physics.StepsPerSecond * float64(time.Second)))
		return at.UTC().Format("Mon 15:04")
	}
	fmt.Fprintln(stdout, "\nspells:")
	for _, sp := range w.Spells {
		front := ""
		if sp.Front != 0 {
			front = fmt.Sprintf(" a front toward %03.0f°, crossing %.1f h, trough %.1f hPa", sp.Toward*360/physics.TurnSteps, sp.Change/3600/physics.StepsPerSecond, sp.Trough/100)
		}
		fmt.Fprintf(stdout, "  %s  %-10s from %03.0f° %4.1f kn  %6.1f hPa%s\n", hour(sp.Begin), cat.Weather.Regimes[int(sp.Regime)].ID,
			sp.From*360/physics.TurnSteps, sp.Speed*physics.SeaSpeedStep*3600/1852, sp.Pressure/100, front)
	}
	fmt.Fprintln(stdout, "\nsystems:")
	for _, sy := range w.Systems {
		x, y := physics.SystemTrack(&sy.SystemRecord, sy.Born)
		fmt.Fprintf(stdout, "  %s–%s  slot %2d  %-9s born at %5.2f NM %03.0f°, size %.2f NM\n", hour(sy.Born), hour(sy.Gone), sy.Slot,
			cat.Weather.Systems[int(sy.Kind)].ID, math.Hypot(x, y)/1852, math.Mod(math.Atan2(x, y)*180/math.Pi+360, 360), sy.Size/1852)
	}
	return nil
}

// weekDigest is the digest of a week as stored.
func weekDigest(w *weather.Week) [32]byte {
	if w == nil {
		return [32]byte{}
	}
	_, d, err := w.Encode()
	if err != nil {
		return [32]byte{}
	}
	return d
}

// systemKindNames are the catalog's kinds of weather system, by their ids.
func systemKindNames(c *catalog.Catalog) []string {
	out := make([]string, len(c.Weather.Systems))
	for i, k := range c.Weather.Systems {
		out[i] = string(k.ID)
	}
	return out
}
