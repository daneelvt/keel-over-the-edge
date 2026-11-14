// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/agreement"
)

// agreementFlags are keel admin agreements' flags.
type agreementFlags struct {
	name, note, reason, guardian, guardianEmail string
	version                                     int
	githubID                                    int64
	yes                                         bool
}

// agreements is keel admin agreements: the contributor agreement's
// signatures, through keel agreement's internal listener.
func (c *adminClient) agreements(ctx context.Context, pos []string, f agreementFlags, stdout, stderr io.Writer) error {
	if len(pos) == 0 {
		fmt.Fprintf(stderr, "keel admin agreements: list, export, add or void\n")
		return errUsage
	}
	switch pos[0] {
	case "list", "export":
		raw, err := c.do(ctx, http.MethodGet, "/agreements/api/signatures.json", nil, stderr)
		if err != nil {
			return err
		}
		var sigs []agreement.SignatureJSON
		if pos[0] == "export" {
			if err := json.Unmarshal(raw, &sigs); err != nil {
				return err
			}
			return writeSignaturesCSV(stdout, sigs)
		}
		return c.show(raw, &sigs, func() { writeSignatures(stdout, sigs) })
	case "add":
		req := agreement.AddRequest{GitHubID: f.githubID, Name: f.name, Version: f.version, Guardian: f.guardian,
			GuardianEmail: f.guardianEmail, Note: f.note, Check: !f.yes}
		if len(pos) > 1 {
			req.Login = pos[1]
		}
		if req.Login == "" {
			fmt.Fprintln(stderr, "keel admin agreements add: the signer's GitHub account's name is required")
			return errUsage
		}
		return c.agreementAction(ctx, "/agreements/api/add", req, stdout, stderr)
	case "void":
		if len(pos) < 2 {
			fmt.Fprintln(stderr, "keel admin agreements void: a signature's ID is required (agreements list shows them)")
			return errUsage
		}
		return c.agreementAction(ctx, "/agreements/api/void", agreement.VoidRequest{ID: pos[1], Reason: f.reason, Check: !f.yes}, stdout, stderr)
	}
	fmt.Fprintf(stderr, "keel admin agreements: unknown command %q: list, export, add or void\n", pos[0])
	return errUsage
}

func (c *adminClient) agreementAction(ctx context.Context, path string, req any, stdout, stderr io.Writer) error {
	raw, err := c.do(ctx, http.MethodPost, path, req, stderr)
	if err != nil {
		return err
	}
	var done agreement.Done
	return c.show(raw, &done, func() {
		fmt.Fprintln(stdout, done.Words)
		if !done.Done {
			fmt.Fprintln(stdout, "Nothing is done yet: run it again with -yes.")
		}
	})
}

func writeSignatures(w io.Writer, sigs []agreement.SignatureJSON) {
	if len(sigs) == 0 {
		fmt.Fprintln(w, "Nobody has signed yet.")
		return
	}
	for _, s := range sigs {
		state := ""
		if s.VoidedAt != "" {
			state = "  VOID " + s.VoidedAt + ": " + s.VoidReason
		}
		fmt.Fprintf(w, "%s  v%d  %s  %s (%d)  %q  %s%s\n", s.SignedAt, s.Version, s.How, s.Login, s.GitHubID, s.Name, s.ID, state)
		if s.Guardian != "" {
			fmt.Fprintf(w, "    with the consent of %s <%s>\n", s.Guardian, s.GuardianEmail)
		}
		if s.Note != "" {
			fmt.Fprintf(w, "    note: %s\n", s.Note)
		}
	}
}

// writeSignaturesCSV writes every signature as CSV, a header first.
func writeSignaturesCSV(w io.Writer, sigs []agreement.SignatureJSON) error {
	cw := csv.NewWriter(w)
	cw.Write([]string{"id", "github_id", "login", "name", "version", "text_sha256", "signed_at", "how",
		"guardian", "guardian_email", "note", "voided_at", "void_reason"})
	for _, s := range sigs {
		cw.Write([]string{s.ID, strconv.FormatInt(s.GitHubID, 10), s.Login, csvSafe(s.Name), strconv.Itoa(s.Version), s.TextSHA256,
			s.SignedAt, s.How, csvSafe(s.Guardian), s.GuardianEmail, csvSafe(s.Note), s.VoidedAt, csvSafe(s.VoidReason)})
	}
	cw.Flush()
	return cw.Error()
}

// csvSafe keeps a signer's own text from being read as a formula by a
// spreadsheet the export is opened in (OWASP, "CSV Injection").
func csvSafe(s string) string {
	if s != "" && (s[0] == '=' || s[0] == '+' || s[0] == '-' || s[0] == '@' || s[0] == '\t' || s[0] == '\r') {
		return "'" + s
	}
	return s
}
