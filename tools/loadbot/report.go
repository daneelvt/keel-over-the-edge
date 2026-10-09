// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ServerReport is what the server's metrics say of a run: their changes
// between before and after it.
type ServerReport struct {
	Read bool
	// The tick's and the encoders' 99th percentiles and means, seconds.
	TickP99, TickMean     float64
	EncodeP99, EncodeMean float64
	FramesAllocated       float64
	BytesOut              float64 // a second, WebSocket frames
	Boats, Connections    float64 // at the end
	Encoders              float64
}

// metrics are a scrape's samples: each series, its name and labels as the
// text format writes them, and its value.
type metrics map[string]float64

// scrape reads Prometheus's text format from url.
func scrape(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return string(b), err
}

func parse(text string) metrics {
	m := metrics{}
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		i := strings.LastIndexByte(line, ' ')
		if i < 0 {
			continue
		}
		if v, err := strconv.ParseFloat(line[i+1:], 64); err == nil {
			m[line[:i]] = v
		}
	}
	return m
}

// quantile is the q-quantile of a histogram's observations between two
// scrapes, from its cumulative buckets, at the upper bound of the bucket
// it falls in; and their mean.
func quantile(before, after metrics, name string, q float64) (value, mean float64) {
	type bucket struct{ le, n float64 }
	var bs []bucket
	prefix := name + "_bucket{le=\""
	for k, v := range after {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		le, err := strconv.ParseFloat(strings.TrimSuffix(k[len(prefix):], "\"}"), 64)
		if err != nil {
			continue
		}
		bs = append(bs, bucket{le, v - before[k]})
	}
	sort.Slice(bs, func(i, j int) bool { return bs[i].le < bs[j].le })
	count := after[name+"_count"] - before[name+"_count"]
	if count <= 0 || len(bs) == 0 {
		return 0, 0
	}
	mean = (after[name+"_sum"] - before[name+"_sum"]) / count
	for _, b := range bs {
		if b.n >= q*count {
			return b.le, mean
		}
	}
	return math.Inf(1), mean
}

func serverReport(beforeText, afterText string, seconds float64) ServerReport {
	before, after := parse(beforeText), parse(afterText)
	r := ServerReport{Read: len(after) > 0}
	r.TickP99, r.TickMean = quantile(before, after, "keel_sim_tick_duration_seconds", 0.99)
	r.EncodeP99, r.EncodeMean = quantile(before, after, "keel_edge_encode_duration_seconds", 0.99)
	r.FramesAllocated = after["keel_sim_frames_allocated_total"] - before["keel_sim_frames_allocated_total"]
	out := `keel_edge_bytes_total{direction="out"}`
	r.BytesOut = (after[out] - before[out]) / seconds
	r.Boats = after["keel_sim_boats"]
	r.Connections = after["keel_edge_connections"]
	r.Encoders = after["keel_edge_encoders"]
	return r
}

// print writes the report: the players' totals and spread, each player's
// line when they are few, and the server's.
func (r *Report) print(w io.Writer, cfg Config) {
	secs := cfg.Sail.Seconds() + cfg.Ramp.Seconds()/2
	if secs <= 0 {
		secs = r.Seconds
	}
	lag := "no lag"
	if cfg.Lag != nil {
		lag = cfg.Lag.String()
	}
	fmt.Fprintf(w, "loadbot: %d players (%d guests made), %s, %.0f s each on average\n", len(r.Players), r.Made, lag, secs)
	var in, out, inMsgs, outMsgs, others []float64
	var snaps, corr, over, resyncs, dropped, errs int
	closes := map[int]int{}
	for _, p := range r.Players {
		s := p.Stats
		in = append(in, float64(s.FramesIn)/secs)
		out = append(out, float64(s.FramesOut)/secs)
		inMsgs = append(inMsgs, float64(s.MessagesIn)/secs)
		outMsgs = append(outMsgs, float64(s.MessagesOut)/secs)
		if s.Views > 0 {
			others = append(others, float64(s.Others)/float64(s.Views))
		}
		snaps += s.Snapshots
		corr += s.Corrections
		over += s.Over
		resyncs += s.Resyncs
		dropped += s.Dropped
		errs += p.Errors
		for c, n := range p.Closes {
			closes[c] += n
		}
		if len(r.Players) <= 20 {
			fmt.Fprintf(w, "  %-12s %6.0f B/s in, %4.0f B/s out, %4.1f messages/s in, %4.1f out, %5d snapshots, %4.1f others in view, %d corrections, %d resyncs, %d closes\n",
				p.Name, float64(s.FramesIn)/secs, float64(s.FramesOut)/secs, float64(s.MessagesIn)/secs, float64(s.MessagesOut)/secs,
				s.Snapshots, ratio(s.Others, s.Views), s.Corrections, s.Resyncs, p.Errors)
		}
	}
	fmt.Fprintf(w, "  bytes a player a second, WebSocket frames: in %s; out %s\n", spread(in), spread(out))
	fmt.Fprintf(w, "  messages a player a second: in %s; out %s\n", spread(inMsgs), spread(outMsgs))
	fmt.Fprintf(w, "  others in view: %s\n", spread(others))
	fmt.Fprintf(w, "  %d snapshots, %d corrections (%d over the snap thresholds), %d dropped for want of their base, %d resyncs\n", snaps, corr, over, dropped, resyncs)
	codes := slices.Sorted(func(yield func(int) bool) {
		for c := range closes {
			if !yield(c) {
				return
			}
		}
	})
	if len(codes) > 0 {
		var parts []string
		for _, c := range codes {
			parts = append(parts, fmt.Sprintf("%d×%d", closes[c], c))
		}
		fmt.Fprintf(w, "  connections ended early: %s\n", strings.Join(parts, ", "))
	}
	if s := r.Server; s.Read {
		fmt.Fprintf(w, "server: %.0f boats, %.0f connections, %.0f encoders; tick p99 ≤ %.1f ms (mean %.2f ms); encoding a frame p99 ≤ %.2f ms (mean %.3f ms) an encoder; %.0f frames allocated; %.0f B/s out in all\n",
			s.Boats, s.Connections, s.Encoders, s.TickP99*1000, s.TickMean*1000, s.EncodeP99*1000, s.EncodeMean*1000, s.FramesAllocated, s.BytesOut)
	}
}

func ratio(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return float64(a) / float64(b)
}

// spread is a list of numbers' mean, median and extremes.
func spread(v []float64) string {
	if len(v) == 0 {
		return "none"
	}
	s := slices.Sorted(slices.Values(v))
	sum := 0.0
	for _, x := range s {
		sum += x
	}
	return fmt.Sprintf("mean %.1f, median %.1f, least %.1f, most %.1f", sum/float64(len(s)), s[len(s)/2], s[0], s[len(s)-1])
}
