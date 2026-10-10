// SPDX-License-Identifier: AGPL-3.0-only

// Command github keeps the repository's GitHub settings as code. The desired
// settings live in .github/settings/; this command compares them with the
// repository, or applies them. It calls the API through the owner's own gh
// login, so no token is stored anywhere.
//
//	go run ./tools/github -check   print every difference; fail if there is one
//	go run ./tools/github -apply   make the repository match
//
// The settings are the repository's own, its Actions settings, its
// deployment environments (who approves a job that uses one, and from
// which branches), and its rulesets.
//
// It runs from the repository root. Settings GitHub offers no API for are
// listed in docs/repository-settings.md and checked by hand.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	check := flag.Bool("check", false, "print every difference and fail if there is one")
	apply := flag.Bool("apply", false, "make the repository match the settings")
	repo := flag.String("repo", "daneelvt/keel-over-the-edge", "the repository, owner/name")
	dir := flag.String("dir", ".github/settings", "the folder of settings files")
	flag.Parse()
	if *check == *apply {
		fmt.Fprintln(os.Stderr, "github: give exactly one of -check or -apply")
		os.Exit(2)
	}

	s, err := loadSettings(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "github:", err)
		os.Exit(1)
	}
	t := &tool{api: ghAPI{}, repo: *repo, out: os.Stdout}
	if *check {
		drift, err := t.check(s)
		if err != nil {
			fmt.Fprintln(os.Stderr, "github:", err)
			os.Exit(1)
		}
		if len(drift) > 0 {
			for _, d := range drift {
				fmt.Println("drift:", d)
			}
			os.Exit(1)
		}
		fmt.Println("github: the repository matches", *dir)
		return
	}
	if err := t.apply(s); err != nil {
		fmt.Fprintln(os.Stderr, "github:", err)
		os.Exit(1)
	}
}
