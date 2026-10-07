// SPDX-License-Identifier: AGPL-3.0-only

// Command catalog validates the catalog of kinds and generates the server's
// and the client's copies of it.
//
//	go run ./tools/catalog          validate and write the generated files
//	go run ./tools/catalog -check   validate and fail if a generated file is out of date
//
// It runs from the repository root.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	check := flag.Bool("check", false, "write nothing; fail if a generated file would change")
	flag.Parse()

	if err := run(".", *check, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "catalog:", err)
		os.Exit(1)
	}
}
