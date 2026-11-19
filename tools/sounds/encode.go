// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// What a master is normalised to: a bed's integrated loudness, LUFS, and a
// shot's true peak, dBTP, half a decibel under the most a file may peak at
// (peakMost), which Opus's encoding overshoots by up to about that.
const (
	bedLoudness = -23.0
	shotPeak    = -1.5
	peakMost    = -1.0
)

// bitrate is the encoders' bitrate for a file of so many channels: a point
// source is mono, a bed stereo.
func bitrate(channels int) string {
	if channels == 1 {
		return "48k"
	}
	return "64k"
}

// bitexact asks ffmpeg for the same bytes from the same input: no
// encoder's version or random identifiers in the files.
var bitexact = []string{"-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"}

// encodeAll builds the files of every master whose are missing or stale,
// or of all of them.
func encodeAll(ctx context.Context, dir string, all bool, out io.Writer) error {
	masters, err := filepath.Glob(filepath.Join(dir, mastersDir, "*.flac"))
	if err != nil {
		return err
	}
	slices.Sort(masters)
	var stubs []string
	for _, m := range masters {
		base := strings.TrimSuffix(filepath.Base(m), ".flac")
		jsonPath := filepath.Join(dir, recordedDir, base+".json")
		num, err := readNumbers(jsonPath)
		if os.IsNotExist(err) {
			num = &numbers{Licence: artHeader, Description: numbersDescription}
			if err := writeNumbers(jsonPath, num); err != nil {
				return err
			}
			stubs = append(stubs, filepath.ToSlash(filepath.Join(recordedDir, base+".json")))
			continue
		}
		if err != nil {
			return fmt.Errorf("%s: %w", jsonPath, err)
		}
		if !slices.Contains(kinds, num.Kind) {
			stubs = append(stubs, filepath.ToSlash(filepath.Join(recordedDir, base+".json")))
			continue
		}
		sum, err := fileSHA256(m)
		if err != nil {
			return err
		}
		webm := filepath.Join(dir, recordedDir, base+".webm")
		m4a := filepath.Join(dir, recordedDir, base+".m4a")
		if !all && num.Master == sum && exists(webm) && exists(m4a) {
			continue
		}
		fmt.Fprintf(out, "sounds: encoding %s\n", base)
		if err := encodeOne(ctx, m, webm, m4a, num); err != nil {
			return fmt.Errorf("%s: %w", base, err)
		}
		info, err := flacInfo(m)
		if err != nil {
			return err
		}
		num.Master = sum
		num.Seconds = info.seconds()
		num.Channels = info.channels
		num.Description = numbersDescription
		if num.Bytes.WebM, err = sizeOf(webm); err != nil {
			return err
		}
		if num.Bytes.M4A, err = sizeOf(m4a); err != nil {
			return err
		}
		if err := writeNumbers(jsonPath, num); err != nil {
			return err
		}
		fmt.Fprintf(out, "sounds: %s: %.1f LUFS, %.1f dBTP, %d and %d bytes\n", base, num.Loudness, num.Peak, num.Bytes.WebM, num.Bytes.M4A)
	}
	if len(stubs) > 0 {
		return fmt.Errorf("say what each of these is, its kind (%s) and its voice, then encode again:\n  %s", strings.Join(kinds, ", "), strings.Join(stubs, "\n  "))
	}
	return nil
}

// encodeOne writes a master's WebM and AAC files, normalised by its kind,
// and puts what the WebM measures into num.
func encodeOne(ctx context.Context, master, webm, m4a string, num *numbers) error {
	info, err := flacInfo(master)
	if err != nil {
		return err
	}
	loudness, peak, err := measure(ctx, master)
	if err != nil {
		return err
	}
	var gain float64
	if num.Kind == kindBed {
		if math.IsInf(loudness, -1) {
			return fmt.Errorf("the master is silent")
		}
		gain = bedLoudness - loudness
		if peak+gain > shotPeak {
			return fmt.Errorf("at %.0f LUFS its true peak would be %.1f dBTP, over %.1f: tame its peaks in the master", bedLoudness, peak+gain, shotPeak)
		}
	} else {
		gain = shotPeak - peak
	}
	filter := fmt.Sprintf("volume=%.2fdB", gain)
	rate := bitrate(info.channels)
	for _, args := range [][]string{
		{"-c:a", "libopus", "-b:a", rate, "-vbr", "on", "-application", "audio", "-f", "webm", webm},
		{"-c:a", "aac", "-b:a", rate, "-movflags", "+faststart", "-f", "mp4", m4a},
	} {
		argv := append([]string{"-y", "-loglevel", "error", "-i", master, "-af", filter, "-ar", strconv.Itoa(48000)}, bitexact...)
		argv = append(argv, args...)
		if err := ffmpeg(ctx, nil, argv...); err != nil {
			return err
		}
	}
	num.Loudness, num.Peak, err = measure(ctx, webm)
	num.Loudness = round1(num.Loudness)
	num.Peak = round1(num.Peak)
	return err
}

var (
	integratedLine = regexp.MustCompile(`I:\s+(-?[0-9.]+|-inf) LUFS`)
	peakLine       = regexp.MustCompile(`Peak:\s+(-?[0-9.]+|-inf) dBFS`)
)

// measure is a file's integrated loudness, LUFS, and true peak, dBTP, by
// ffmpeg's ebur128 filter.
func measure(ctx context.Context, file string) (loudness, peak float64, err error) {
	var log bytes.Buffer
	if err := ffmpeg(ctx, &log, "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"); err != nil {
		return 0, 0, err
	}
	text := log.String()
	// The summary is last.
	if i := strings.LastIndex(text, "Summary:"); i >= 0 {
		text = text[i:]
	}
	parse := func(re *regexp.Regexp, what string) (float64, error) {
		m := re.FindStringSubmatch(text)
		if m == nil {
			return 0, fmt.Errorf("ffmpeg's ebur128 gave no %s for %s", what, file)
		}
		if m[1] == "-inf" {
			return math.Inf(-1), nil
		}
		return strconv.ParseFloat(m[1], 64)
	}
	if loudness, err = parse(integratedLine, "loudness"); err != nil {
		return 0, 0, err
	}
	peak, err = parse(peakLine, "true peak")
	return loudness, peak, err
}

// ffmpeg runs ffmpeg, its log into log (else shown on failure).
func ffmpeg(ctx context.Context, log *bytes.Buffer, args ...string) error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("ffmpeg is needed (with libopus): %w", err)
	}
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stderr = &stderr
	if log != nil {
		cmd.Stderr = log
	}
	if err := cmd.Run(); err != nil {
		if log != nil {
			stderr = *log
		}
		return fmt.Errorf("ffmpeg %s: %w\n%s", strings.Join(args, " "), err, stderr.String())
	}
	return nil
}

// generateOwn makes the game's own masters, from ffmpeg's generators, and
// their numbers' files: the format probe, a twentieth of a second of a
// tone, and the test recording, two seconds of brown noise swelling as a
// sea does, which the tests load and which no voice plays.
func generateOwn(ctx context.Context, dir string, out io.Writer) error {
	own := []struct {
		name, source, kind string
		lavfi              string
	}{
		{"probe", "The game's own: a tone from ffmpeg's sine generator, to choose the format by decoding", kindProbe,
			"sine=frequency=440:sample_rate=48000:duration=0.05"},
		{"test-sea", "The game's own: brown noise from ffmpeg's generator, swelling, for the tests", kindBed,
			"anoisesrc=color=brown:amplitude=0.25:sample_rate=48000:duration=2:seed=7,volume='0.6+0.4*sin(PI*t)':eval=frame,lowpass=f=900"},
	}
	if err := os.MkdirAll(filepath.Join(dir, mastersDir), 0o755); err != nil {
		return err
	}
	fmt.Fprintln(out, "| Master | Original | Licence | Original's SHA-256 | SHA-256 |")
	fmt.Fprintln(out, "| --- | --- | --- | --- | --- |")
	for _, o := range own {
		master := filepath.Join(dir, mastersDir, o.name+".flac")
		argv := append([]string{"-y", "-loglevel", "error", "-f", "lavfi", "-i", o.lavfi, "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", "-compression_level", "12"}, bitexact...)
		if err := ffmpeg(ctx, nil, append(argv, master)...); err != nil {
			return err
		}
		jsonPath := filepath.Join(dir, recordedDir, o.name+".json")
		num, err := readNumbers(jsonPath)
		if err != nil {
			num = &numbers{Licence: artHeader, Description: numbersDescription}
		}
		num.Kind = o.kind
		if err := writeNumbers(jsonPath, num); err != nil {
			return err
		}
		sum, err := fileSHA256(master)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "| `%s/%s.flac` | %s | %s | — | %s |\n", mastersDir, o.name, o.source, owned, sum)
	}
	return nil
}

func writeNumbers(p string, n *numbers) error {
	raw, err := json.MarshalIndent(n, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(raw, '\n'), 0o644)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sizeOf(p string) (int64, error) {
	info, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
