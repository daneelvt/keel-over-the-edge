// SPDX-License-Identifier: AGPL-3.0-only

// Package legal holds the contributor agreement's versions and the privacy
// notice beside it, as the files in this directory, embedded into keel. The
// signing page serves exactly these bytes, and a signature records the
// SHA-256 of the version signed, so what was signed can always be shown.
//
// A version, once anyone has signed it, is never edited: a change is a new
// file, agreement-N.md, and a new number. SUMS holds each version's SHA-256,
// and a test fails when one changes.
package legal

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed agreement-*.md privacy.md
var files embed.FS

// Version is one version of the contributor agreement.
type Version struct {
	// Number is the version's number, from 1.
	Number int
	// Text is the version's text, Markdown, as served and downloaded.
	Text []byte
	// SHA256 is the text's SHA-256, lowercase hex: what a signature records.
	SHA256 string
}

// Name is the agreement's name, with its version.
func (v Version) Name() string {
	return "Keel Over the Edge Contributor Agreement, version " + strconv.Itoa(v.Number)
}

var versions = load()

func load() []Version {
	names, err := fs.Glob(files, "agreement-*.md")
	if err != nil || len(names) == 0 {
		panic("legal: no agreement embedded")
	}
	vs := make([]Version, len(names))
	for _, name := range names {
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "agreement-"), ".md"))
		if err != nil || n < 1 || n > len(names) {
			panic("legal: an agreement's name is not agreement-N.md, numbered from 1 without a gap: " + name)
		}
		text, err := files.ReadFile(name)
		if err != nil {
			panic(err)
		}
		sum := sha256.Sum256(text)
		vs[n-1] = Version{Number: n, Text: text, SHA256: hex.EncodeToString(sum[:])}
	}
	return vs
}

// Current is the newest version: the one a contributor must have signed.
func Current() Version { return versions[len(versions)-1] }

// Get is version n, if there is one.
func Get(n int) (Version, bool) {
	if n < 1 || n > len(versions) {
		return Version{}, false
	}
	return versions[n-1], true
}

// Versions is every version, oldest first.
func Versions() []Version { return append([]Version(nil), versions...) }

// Privacy is the privacy notice beside the agreement, Markdown.
func Privacy() []byte {
	b, err := files.ReadFile("privacy.md")
	if err != nil {
		panic(fmt.Sprintf("legal: %v", err)) // embedded
	}
	return b
}
