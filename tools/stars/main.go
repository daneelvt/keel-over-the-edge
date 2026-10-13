// SPDX-License-Identifier: AGPL-3.0-only

// Command stars writes the table of stars the client draws, from the
// Bright Star Catalogue kept beside it as published, and checks the game's
// named stars against that catalogue.
//
//	go run ./tools/stars          write client/src/sky/stars.bin
//	go run ./tools/stars -check   write nothing; fail if the table is out of date
//
// It runs from the repository root.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	check := flag.Bool("check", false, "write nothing; fail if the table would change")
	flag.Parse()

	if err := run(".", *check, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "stars:", err)
		os.Exit(1)
	}
}
