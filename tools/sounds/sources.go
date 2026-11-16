// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// The licences a recording may have. The sound is all rights reserved, so
// nothing that asks for credit, forbids selling or was made by an AI
// service: a CC0 original, or the owner's own recording (or the game's own,
// made from its generators), which is the art's own licence.
const (
	cc0   = "CC0-1.0"
	owned = "LicenseRef-All-Rights-Reserved"
)

var licences = []string{cc0, owned}

// artHeader is the first field of every numbers file, as every art JSON's.
const artHeader = "SPDX-License-Identifier: LicenseRef-All-Rights-Reserved. Art: all rights reserved, not covered by the AGPL. See art/README.md."

// The budgets: what a page fetches in either format, what it decodes to,
// and the masters kept in the repository, bytes.
const (
	fetchBudget   = 3 << 20
	decodedBudget = 40 << 20
	mastersBudget = 25 << 20
	// probeBudget is the format probe's: each of its files is fetched
	// before any recording.
	probeBudget = 1536
)

// The kinds of recording: a bed loops under the physics, a shot is played
// once, and the probe is decoded to choose the format.
const (
	kindBed   = "bed"
	kindShot  = "shot"
	kindProbe = "probe"
)

var kinds = []string{kindBed, kindShot, kindProbe}

// source is a master's row in SOURCES.md.
type source struct {
	Master   string // from art/sound
	Original string // its author, title and page
	Licence  string
	// OriginalSHA256 is the downloaded original's digest, or "—" for the
	// game's own.
	OriginalSHA256 string
	SHA256         string // the master's
}

// numbers is a recording's numbers' file, recorded/<name>.json: what it is
// and which voice plays it, which are written by hand, and what -encode
// measured of the files it built.
type numbers struct {
	Licence     string `json:"licence"`
	Description string `json:"description"`
	// Kind is a bed, a shot or the probe.
	Kind string `json:"kind"`
	// Voice is the page's voice that plays it ("" for none).
	Voice string `json:"voice"`
	// Gain is its level in the mix over its voice's own, dB.
	Gain float64 `json:"gain"`
	// Note is a shot's own pitch, Hz, where it is played at others' (one
	// fog signal's recording at each device's note); none where 0.
	Note float64 `json:"note,omitempty"`
	// Loop is the stretch of a shot, s, that loops to sound longer (a fog
	// signal's blast).
	Loop []float64 `json:"loop,omitempty"`
	// Master is the SHA-256 of the master the files were built from.
	Master   string  `json:"master"`
	Seconds  float64 `json:"seconds"`
	Channels int     `json:"channels"`
	// Loudness is the built WebM's integrated loudness, LUFS, and Peak its
	// true peak, dBTP.
	Loudness float64 `json:"loudness"`
	Peak     float64 `json:"peak"`
	Bytes    struct {
		WebM int64 `json:"webm"`
		M4A  int64 `json:"m4a"`
	} `json:"bytes"`
}

const numbersDescription = "A recording's numbers, read by the page alone. kind: a bed (a loop under the physics), a shot (played once) or the probe (decoded to choose the format). voice: which of the page's voices plays it (none where empty). gain: dB over that voice's own level. note: a shot's own pitch, Hz, where it is played at other pitches (one fog signal's recording at each device's note). loop: the stretch of a shot, s, looped to sound as long as it is meant to (a fog signal's blast). The rest is written by go run ./tools/sounds -encode: the SHA-256 of the master it was built from, its seconds and channels, the WebM's integrated loudness (LUFS) and true peak (dBTP), and each file's bytes."

var (
	tableRow = regexp.MustCompile(`^\|(.+)\|\s*$`)
	digest   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// name is a recording's name: its files are <name>.flac, .webm, .m4a
	// and .json.
	name = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
)

// readSources reads SOURCES.md's table of recordings, by master.
func readSources(dir string) (map[string]source, []string, error) {
	f, err := os.Open(filepath.Join(dir, sourcesFile))
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	rows := map[string]source{}
	var problems []string
	var section string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "## ") {
			section = strings.TrimPrefix(line, "## ")
			continue
		}
		m := tableRow.FindStringSubmatch(line)
		if section != "Recordings" || m == nil {
			continue
		}
		cells := strings.Split(m[1], "|")
		for i := range cells {
			cells[i] = strings.Trim(strings.TrimSpace(cells[i]), "`")
		}
		if strings.HasPrefix(cells[0], "---") || !digest.MatchString(cells[len(cells)-1]) {
			continue // a header, a rule, or a row without a digest
		}
		if len(cells) != 5 {
			problems = append(problems, fmt.Sprintf("%s: the row for %s has %d cells, not 5", sourcesFile, cells[0], len(cells)))
			continue
		}
		s := source{Master: cells[0], Original: cells[1], Licence: cells[2], OriginalSHA256: cells[3], SHA256: cells[4]}
		switch {
		case !slices.Contains(licences, s.Licence):
			problems = append(problems, fmt.Sprintf("%s: %s is %s, but only %s may be recorded", sourcesFile, s.Master, s.Licence, strings.Join(licences, " or ")))
		case s.Licence == cc0 && (!strings.Contains(s.Original, "https://") || !digest.MatchString(s.OriginalSHA256)):
			problems = append(problems, fmt.Sprintf("%s: %s is another's: its row needs the original's page (https://…) and the SHA-256 of the file downloaded", sourcesFile, s.Master))
		case s.OriginalSHA256 != "—" && !digest.MatchString(s.OriginalSHA256):
			problems = append(problems, fmt.Sprintf("%s: %s's original's SHA-256 is %q: a digest, or — for the game's own", sourcesFile, s.Master, s.OriginalSHA256))
		}
		if _, twice := rows[s.Master]; twice {
			problems = append(problems, fmt.Sprintf("%s: %s is listed twice", sourcesFile, s.Master))
		}
		rows[s.Master] = s
	}
	return rows, problems, sc.Err()
}

// sizes are what the recordings come to, bytes.
type sizes struct {
	recordings          int
	webm, m4a           int64
	decoded, masters    int64
	probeWebM, probeM4A int64
}

// checkRecordings checks the recordings against SOURCES.md and the budgets:
// every master listed, by its digest and an allowed licence; every file
// under recorded/ a listed master's, which has all of its files, built from
// it as it is now; and the sizes.
func checkRecordings(dir string) (sizes, error) {
	var s sizes
	rows, problems, err := readSources(dir)
	if err != nil {
		return s, err
	}
	files := map[string]map[string]int64{} // by name, each file's size by its extension
	root := filepath.Join(dir, recordedDir)
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() == ".DS_Store" {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		ext := path.Ext(rel)
		base := strings.TrimSuffix(path.Base(rel), ext)
		inMasters := path.Dir(rel) == mastersDir
		ok := name.MatchString(base) &&
			((inMasters && ext == ".flac") || (path.Dir(rel) == recordedDir && (ext == ".webm" || ext == ".m4a" || ext == ".json")))
		if !ok {
			problems = append(problems, fmt.Sprintf("%s is not a recording's file: masters are %s/<name>.flac, and what is built from them %s/<name>.webm, .m4a and .json", rel, mastersDir, recordedDir))
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if files[base] == nil {
			files[base] = map[string]int64{}
		}
		files[base][ext] = info.Size()
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return s, err
	}

	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		got := files[n]
		master := mastersDir + "/" + n + ".flac"
		if _, ok := got[".flac"]; !ok {
			problems = append(problems, fmt.Sprintf("%s/%s.* has no master: %s", recordedDir, n, master))
			continue
		}
		s.recordings++
		s.masters += got[".flac"]
		row, listed := rows[master]
		sum, err := fileSHA256(filepath.Join(dir, master))
		if err != nil {
			return s, err
		}
		switch {
		case !listed:
			problems = append(problems, fmt.Sprintf("%s is not in %s: list it with its original and licence, and its SHA-256, %s; or remove it", master, sourcesFile, sum))
		case row.SHA256 != sum:
			problems = append(problems, fmt.Sprintf("%s has SHA-256 %s, but %s lists %s", master, sum, sourcesFile, row.SHA256))
		}
		info, err := flacInfo(filepath.Join(dir, master))
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", master, err))
			continue
		}
		if info.rate != rate {
			problems = append(problems, fmt.Sprintf("%s is at %d Hz, not %d", master, info.rate, rate))
		}
		var missing []string
		for _, ext := range []string{".json", ".webm", ".m4a"} {
			if _, ok := got[ext]; !ok {
				missing = append(missing, n+ext)
			}
		}
		if len(missing) > 0 {
			problems = append(problems, fmt.Sprintf("%s has no %s: write its numbers' file (kind and voice) and run go run ./tools/sounds -encode", master, strings.Join(missing, ", ")))
			continue
		}
		num, err := readNumbers(filepath.Join(dir, recordedDir, n+".json"))
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s/%s.json: %v", recordedDir, n, err))
			continue
		}
		problems = append(problems, num.problems(n, sum, info, got)...)
		if num.Kind == kindProbe {
			s.probeWebM, s.probeM4A = got[".webm"], got[".m4a"]
			if got[".webm"] > probeBudget || got[".m4a"] > probeBudget {
				problems = append(problems, fmt.Sprintf("the probe's files are %d and %d bytes: at most %d each", got[".webm"], got[".m4a"], probeBudget))
			}
		}
		s.webm += got[".webm"]
		s.m4a += got[".m4a"]
		s.decoded += info.samples * int64(info.channels) * 4 * rate / int64(max(info.rate, 1))
	}
	// A listed master that is not there.
	for m := range rows {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(m))); err != nil {
			problems = append(problems, fmt.Sprintf("%s lists %s, which cannot be read: %v", sourcesFile, m, err))
		}
	}
	if s.webm > fetchBudget || s.m4a > fetchBudget {
		problems = append(problems, fmt.Sprintf("the recordings are %d KB as WebM and %d KB as AAC: at most %d KB in either", s.webm>>10, s.m4a>>10, fetchBudget>>10))
	}
	if s.decoded > decodedBudget {
		problems = append(problems, fmt.Sprintf("the recordings decode to %.1f MB: at most %d MB", float64(s.decoded)/(1<<20), decodedBudget>>20))
	}
	if s.masters > mastersBudget {
		problems = append(problems, fmt.Sprintf("the masters are %.1f MB: at most %d MB", float64(s.masters)/(1<<20), mastersBudget>>20))
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return s, fmt.Errorf("the recordings:\n  %s", strings.Join(problems, "\n  "))
	}
	return s, nil
}

// problems are what is wrong with a recording's numbers, against its
// master (digest sum, as info has it) and its files' sizes.
func (n *numbers) problems(base, sum string, info flac, got map[string]int64) []string {
	var p []string
	file := recordedDir + "/" + base + ".json"
	if n.Licence != artHeader {
		p = append(p, fmt.Sprintf("%s: its licence is not the art's: %q", file, artHeader))
	}
	if !slices.Contains(kinds, n.Kind) {
		p = append(p, fmt.Sprintf("%s: kind is %q, not %s", file, n.Kind, strings.Join(kinds, ", ")))
	}
	if n.Master != sum || n.Bytes.WebM != got[".webm"] || n.Bytes.M4A != got[".m4a"] ||
		n.Channels != info.channels || math.Abs(n.Seconds-info.seconds()) > 0.001 {
		p = append(p, fmt.Sprintf("%s: its files were not built from the master as it is: run go run ./tools/sounds -encode", file))
	}
	if n.Kind == kindBed && math.Abs(n.Loudness+23) > 1 {
		p = append(p, fmt.Sprintf("%s: a bed at %.1f LUFS, not −23", file, n.Loudness))
	}
	if n.Kind != kindProbe && n.Peak > peakMost {
		p = append(p, fmt.Sprintf("%s: its true peak is %.1f dBTP, over %.0f", file, n.Peak, peakMost))
	}
	return p
}

func readNumbers(p string) (*numbers, error) {
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var n numbers
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&n); err != nil {
		return nil, err
	}
	return &n, nil
}

// flac is what a FLAC's stream information says of it.
type flac struct {
	rate, channels, bits int
	samples              int64
}

func (f flac) seconds() float64 {
	if f.rate == 0 {
		return 0
	}
	return math.Round(float64(f.samples)/float64(f.rate)*1000) / 1000
}

// flacInfo reads a FLAC's stream information, its first metadata block.
func flacInfo(p string) (flac, error) {
	f, err := os.Open(p)
	if err != nil {
		return flac{}, err
	}
	defer f.Close()
	var head [4 + 4 + 34]byte
	if _, err := io.ReadFull(f, head[:]); err != nil || string(head[:4]) != "fLaC" || head[4]&0x7f != 0 {
		return flac{}, fmt.Errorf("not a FLAC file")
	}
	si := head[8:]
	// 16 bits each of the least and most block size, 24 each of the least
	// and most frame size; then 20 bits of the rate, 3 of the channels
	// less one, 5 of the bits a sample less one and 36 of the samples.
	v := binary.BigEndian.Uint64(si[10:18])
	return flac{
		rate:     int(v >> 44),
		channels: int((v>>41)&0x7) + 1,
		bits:     int((v>>36)&0x1f) + 1,
		samples:  int64(v & 0xfffffffff),
	}, nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
