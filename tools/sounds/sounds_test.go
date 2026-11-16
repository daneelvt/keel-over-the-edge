// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeFLAC is the start of a FLAC file: its stream information for samples
// at sampleRate, and a little after it.
func fakeFLAC(sampleRate, channels int, samples int64) string {
	var b bytes.Buffer
	b.WriteString("fLaC")
	b.Write([]byte{0x80, 0, 0, 34}) // the last block, stream information, 34 bytes
	si := make([]byte, 34)
	v := uint64(sampleRate)<<44 | uint64(channels-1)<<41 | uint64(15)<<36 | uint64(samples)
	binary.BigEndian.PutUint64(si[10:18], v)
	b.Write(si)
	b.WriteString("frames")
	return b.String()
}

func digestOf(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// recording is one recording's files in a test's tree.
type recording struct {
	name, licence, original, originalSHA string
	master                               string
	num                                  numbers
	webm, m4a                            int64
	unlisted                             bool
	// listed is the master's digest SOURCES.md lists, where not its own.
	listed string
}

// tree writes SOURCES.md and the recordings' files into a new folder.
func tree(t *testing.T, rs []recording, extra map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, mastersDir), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := "# Sources\n\n## Recordings\n\n| Master | Original | Licence | Original's SHA-256 | SHA-256 |\n| --- | --- | --- | --- | --- |\n"
	write := func(rel string, data []byte) {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(rel)), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range rs {
		master := mastersDir + "/" + r.name + ".flac"
		if r.master != "" {
			write(master, []byte(r.master))
		}
		listed := digestOf(r.master)
		if r.listed != "" {
			listed = r.listed
		}
		if !r.unlisted {
			doc += "| `" + master + "` | " + r.original + " | " + r.licence + " | " + r.originalSHA + " | " + listed + " |\n"
		}
		if r.webm >= 0 {
			write(recordedDir+"/"+r.name+".webm", make([]byte, r.webm))
		}
		if r.m4a >= 0 {
			write(recordedDir+"/"+r.name+".m4a", make([]byte, r.m4a))
		}
		n := r.num
		if err := writeNumbers(filepath.Join(dir, recordedDir, r.name+".json"), &n); err != nil {
			t.Fatal(err)
		}
	}
	for rel, data := range extra {
		write(rel, []byte(data))
	}
	write(sourcesFile, []byte(doc))
	return dir
}

// good is a CC0 bed, as -encode leaves it.
func good() recording {
	master := fakeFLAC(rate, 2, 30*rate)
	r := recording{
		name: "sea-moderate", licence: cc0, master: master, webm: 2000, m4a: 2100,
		original:    "someone, \"Waves\", https://example.org/waves",
		originalSHA: digestOf("the original"),
	}
	r.num = numbers{Licence: artHeader, Kind: kindBed, Voice: "sea.moderate", Master: digestOf(master),
		Seconds: 30, Channels: 2, Loudness: -23, Peak: -8}
	r.num.Bytes.WebM, r.num.Bytes.M4A = r.webm, r.m4a
	return r
}

func TestCheck(t *testing.T) {
	probe := fakeFLAC(rate, 1, rate/20)
	p := recording{name: "probe", licence: owned, original: "the game's own", originalSHA: "—", master: probe, webm: 900, m4a: 1100}
	p.num = numbers{Licence: artHeader, Kind: kindProbe, Master: digestOf(probe), Seconds: 0.05, Channels: 1, Loudness: math.Inf(-1)}
	p.num.Loudness = -70
	p.num.Bytes.WebM, p.num.Bytes.M4A = p.webm, p.m4a
	s, err := checkRecordings(tree(t, []recording{good(), p}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if s.recordings != 2 || s.webm != 2900 || s.m4a != 3200 || s.decoded != (30*rate*2+rate/20)*4 {
		t.Errorf("sizes %+v", s)
	}
}

func TestCheckRefuses(t *testing.T) {
	for what, c := range map[string]struct {
		change func(*recording)
		extra  map[string]string
		want   string
	}{
		"a master not listed":       {func(r *recording) { r.unlisted = true }, nil, "is not in SOURCES.md"},
		"a master changed":          {func(r *recording) { r.listed = digestOf("before"); r.num.Master = r.listed }, nil, "has SHA-256"},
		"a licence asking credit":   {func(r *recording) { r.licence = "CC-BY-4.0" }, nil, "only CC0-1.0 or"},
		"another's without a page":  {func(r *recording) { r.original = "someone" }, nil, "needs the original's page"},
		"another's without its sum": {func(r *recording) { r.originalSHA = "—" }, nil, "needs the original's page"},
		"a stray file": {func(*recording) {}, map[string]string{recordedDir + "/sea.mp3": "x"},
			"not a recording's file"},
		"a built file without a master": {func(*recording) {}, map[string]string{recordedDir + "/gulls.webm": "x"},
			"has no master"},
		"a master without its files": {func(r *recording) { r.webm = -1 }, nil, "has no sea-moderate.webm"},
		"files built from another master": {func(r *recording) { r.num.Master = digestOf("before") }, nil,
			"were not built from the master as it is"},
		"files of other sizes": {func(r *recording) { r.num.Bytes.M4A = 7 }, nil, "were not built from the master"},
		"a master not at 48 kHz": {func(r *recording) {
			r.master = fakeFLAC(44100, 2, 30*44100)
			r.num.Master = digestOf(r.master)
		}, nil, "is at 44100 Hz"},
		"a bed not normalised":  {func(r *recording) { r.num.Loudness = -18 }, nil, "not −23"},
		"a peak over −1 dBTP":   {func(r *recording) { r.num.Peak = -0.4 }, nil, "over -1"},
		"an unknown kind":       {func(r *recording) { r.num.Kind = "music" }, nil, "kind is \"music\""},
		"numbers not the art's": {func(r *recording) { r.num.Licence = "CC0" }, nil, "licence is not the art's"},
		"over the fetch budget": {func(r *recording) { r.webm = fetchBudget + 1; r.num.Bytes.WebM = r.webm }, nil, "at most 3072 KB"},
		"over the decoded budget": {func(r *recording) {
			r.master = fakeFLAC(rate, 2, 120*rate)
			r.num.Master, r.num.Seconds = digestOf(r.master), 120
		}, nil, "decode to 43.9 MB"},
	} {
		t.Run(what, func(t *testing.T) {
			r := good()
			c.change(&r)
			_, err := checkRecordings(tree(t, []recording{r}, c.extra))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("%v, want %q", err, c.want)
			}
		})
	}
}

// A listed master that is not there.
func TestCheckListedMissing(t *testing.T) {
	r := good()
	dir := tree(t, []recording{r}, nil)
	if err := os.Remove(filepath.Join(dir, mastersDir, r.name+".flac")); err != nil {
		t.Fatal(err)
	}
	if _, err := checkRecordings(dir); err == nil || !strings.Contains(err.Error(), "cannot be read") {
		t.Fatal(err)
	}
}

// TestRepositorySounds: the repository's recordings are listed, built and
// within their budgets.
func TestRepositorySounds(t *testing.T) {
	if _, err := checkRecordings(filepath.Join("..", "..", soundDir)); err != nil {
		t.Fatal(err)
	}
}

// TestEncode: the game's own masters, made and encoded with ffmpeg,
// normalised and within their budgets, and the same bytes when encoded
// again.
func TestEncode(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	dir := t.TempDir()
	ctx := t.Context()
	if err := generateOwn(ctx, dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	err := encodeAll(ctx, dir, false, &log)
	if err != nil {
		t.Fatal(err)
	}
	// SOURCES.md from what -generate printed.
	var rows bytes.Buffer
	if err := generateOwn(ctx, dir, &rows); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sourcesFile), []byte("## Recordings\n\n"+rows.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := encodeAll(ctx, dir, false, &log); err != nil {
		t.Fatal(err)
	}
	s, err := checkRecordings(dir)
	if err != nil {
		t.Fatalf("%v\n%s", err, log.String())
	}
	bed, err := readNumbers(filepath.Join(dir, recordedDir, "test-sea.json"))
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(bed.Loudness-bedLoudness) > 0.5 || bed.Peak > peakMost || bed.Channels != 1 || bed.Seconds != 2 {
		t.Errorf("the bed: %+v", bed)
	}
	if s.probeWebM > probeBudget || s.probeM4A > probeBudget || s.probeWebM == 0 {
		t.Errorf("the probe: %d and %d bytes", s.probeWebM, s.probeM4A)
	}
	before, err := os.ReadFile(filepath.Join(dir, recordedDir, "test-sea.webm"))
	if err != nil {
		t.Fatal(err)
	}
	if err := encodeAll(ctx, dir, true, io.Discard); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(dir, recordedDir, "test-sea.webm"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("encoded twice, the bytes differ")
	}
}

// A master with no numbers' file gets one to fill in, and is not encoded.
func TestEncodeAsksForNumbers(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, mastersDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, mastersDir, "gulls.flac"), []byte(fakeFLAC(rate, 1, rate)), 0o644); err != nil {
		t.Fatal(err)
	}
	err := encodeAll(t.Context(), dir, false, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "recorded/gulls.json") {
		t.Fatal(err)
	}
	n, err := readNumbers(filepath.Join(dir, recordedDir, "gulls.json"))
	if err != nil || n.Licence != artHeader || n.Kind != "" {
		t.Fatalf("%+v, %v", n, err)
	}
}
