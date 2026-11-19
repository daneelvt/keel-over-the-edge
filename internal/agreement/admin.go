// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

// The owner's routes, on the keeper's internal listener, which keel admin
// agreements calls from inside its pod: every signature, a signature
// entered by hand, a signature voided. They are guarded as the world
// page's are (owner.Guard).

// SignatureJSON is a signature as the owner's routes give it.
type SignatureJSON struct {
	ID            string `json:"id"`
	GitHubID      int64  `json:"github_id"`
	Login         string `json:"login"`
	Name          string `json:"name"`
	Version       int    `json:"version"`
	TextSHA256    string `json:"text_sha256"`
	SignedAt      string `json:"signed_at"`
	How           string `json:"how"`
	Guardian      string `json:"guardian,omitempty"`
	GuardianEmail string `json:"guardian_email,omitempty"`
	Note          string `json:"note,omitempty"`
	VoidedAt      string `json:"voided_at,omitempty"`
	VoidReason    string `json:"void_reason,omitempty"`
}

func signatureJSON(s store.Signature) SignatureJSON {
	j := SignatureJSON{
		ID: s.ID.String(), GitHubID: s.GitHubID, Login: s.Login, Name: s.Name, Version: s.Version,
		TextSHA256: s.TextSHA256, SignedAt: s.SignedAt.UTC().Format(time.RFC3339), How: s.How,
		Guardian: s.Guardian, GuardianEmail: s.GuardianEmail, Note: s.Note, VoidReason: s.VoidReason,
	}
	if !s.Voided.IsZero() {
		j.VoidedAt = s.Voided.UTC().Format(time.RFC3339)
	}
	return j
}

// AddRequest enters a signature by hand: a minor's, with their parent's
// or guardian's consent, or one made on paper.
type AddRequest struct {
	// Login is the signer's GitHub account, by name; GitHubID, if not 0,
	// by number instead.
	Login    string `json:"login"`
	GitHubID int64  `json:"github_id"`
	Name     string `json:"name"`
	// Version is the version agreed to; 0 is the current one.
	Version       int    `json:"version"`
	Guardian      string `json:"guardian"`
	GuardianEmail string `json:"guardian_email"`
	Note          string `json:"note"`
	// Check asks what would be done, and does nothing.
	Check bool `json:"check"`
}

// VoidRequest voids a signature.
type VoidRequest struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
	Check  bool   `json:"check"`
}

// Done is what an action did, or would do.
type Done struct {
	Done  bool   `json:"done"`
	Words string `json:"words"`
}

// Admin is the owner's routes.
type Admin struct {
	// GitHub finds an account by its name; nil when the App is not set up,
	// when a signature is entered by the account's number alone.
	GitHub  *GitHub
	Store   Store
	Checker *Checker
	Signed  func(how string)
}

// Handler serves the routes under /agreements/api/.
func (a *Admin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /agreements/api/signatures.json", a.list)
	mux.HandleFunc("POST /agreements/api/add", a.add)
	mux.HandleFunc("POST /agreements/api/void", a.void)
	return owner.Guard(mux, nil)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func (a *Admin) list(w http.ResponseWriter, r *http.Request) {
	sigs, err := a.Store.Signatures(r.Context())
	if err != nil {
		http.Error(w, "the signatures could not be read: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	out := make([]SignatureJSON, len(sigs))
	for i, s := range sigs {
		out[i] = signatureJSON(s)
	}
	writeJSON(w, out)
}

func (a *Admin) add(w http.ResponseWriter, r *http.Request) {
	var req AddRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "not an add request", http.StatusBadRequest)
		return
	}
	req.Name, req.Guardian, req.GuardianEmail, req.Note = strings.TrimSpace(req.Name), strings.TrimSpace(req.Guardian),
		strings.TrimSpace(req.GuardianEmail), strings.TrimSpace(req.Note)
	if req.Version == 0 {
		req.Version = legal.Current().Number
	}
	v, ok := legal.Get(req.Version)
	switch {
	case !ok:
		http.Error(w, fmt.Sprintf("there is no version %d", req.Version), http.StatusBadRequest)
		return
	case !validName(req.Name):
		http.Error(w, "the signer's full name (-name) is required", http.StatusBadRequest)
		return
	case req.Note == "":
		http.Error(w, "a note (-note) on how it was agreed to is required", http.StatusBadRequest)
		return
	case (req.Guardian == "") != (req.GuardianEmail == ""):
		http.Error(w, "a parent's or guardian's name and e-mail come together (-guardian and -guardian-email)", http.StatusBadRequest)
		return
	case req.Guardian != "" && !validName(req.Guardian):
		http.Error(w, "the parent's or guardian's name is not a name", http.StatusBadRequest)
		return
	}
	if req.GuardianEmail != "" {
		if _, err := mail.ParseAddress(req.GuardianEmail); err != nil {
			http.Error(w, "the parent's or guardian's e-mail is not an address", http.StatusBadRequest)
			return
		}
	}
	u := User{ID: req.GitHubID, Login: req.Login}
	if u.ID == 0 {
		if a.GitHub == nil || req.Login == "" {
			http.Error(w, "the signer's GitHub account is required, by name, or by number (-id) while the App is not set up", http.StatusBadRequest)
			return
		}
		found, err := a.GitHub.UserByLogin(r.Context(), req.Login)
		if err != nil {
			http.Error(w, "GitHub did not find "+req.Login+": "+err.Error(), http.StatusBadGateway)
			return
		}
		u = found
	}
	if u.Login == "" {
		http.Error(w, "the signer's GitHub account's name (the login) is required with its number", http.StatusBadRequest)
		return
	}
	verb := "Recorded that"
	if req.Check {
		verb = "Would record that"
	}
	words := fmt.Sprintf("%s %s (GitHub %s, number %d) signs version %d", verb, req.Name, u.Login, u.ID, v.Number)
	if req.Guardian != "" {
		words += fmt.Sprintf(", with the consent of %s <%s>", req.Guardian, req.GuardianEmail)
	}
	if req.Check {
		writeJSON(w, Done{Words: words + "."})
		return
	}
	made, err := a.Store.Sign(r.Context(), store.Signature{
		GitHubID: u.ID, Login: u.Login, Name: req.Name, Version: v.Number, TextSHA256: v.SHA256, How: store.SignedByOwner,
		Guardian: req.Guardian, GuardianEmail: req.GuardianEmail, Note: req.Note,
	})
	if err != nil {
		http.Error(w, "the signature was not recorded: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !made {
		writeJSON(w, Done{Done: true, Words: fmt.Sprintf("%s (number %d) has signed version %d already: nothing changed.", u.Login, u.ID, v.Number)})
		return
	}
	if a.Signed != nil {
		a.Signed(store.SignedByOwner)
	}
	if prs, err := a.Store.WaitingFor(r.Context(), u.ID); err == nil {
		a.Checker.Enqueue(prs...)
		if len(prs) > 0 {
			words += fmt.Sprintf("; %s checked again", count(len(prs), "pull request", "pull requests"))
		}
	}
	writeJSON(w, Done{Done: true, Words: words + "."})
}

func (a *Admin) void(w http.ResponseWriter, r *http.Request) {
	var req VoidRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "not a void request", http.StatusBadRequest)
		return
	}
	id, ok := store.ParseID(req.ID)
	if !ok {
		http.Error(w, fmt.Sprintf("%q is not a signature's ID", req.ID), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		http.Error(w, "a reason (-reason) is required", http.StatusBadRequest)
		return
	}
	var found *store.Signature
	sigs, err := a.Store.Signatures(r.Context())
	if err != nil {
		http.Error(w, "the signatures could not be read: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	for i := range sigs {
		if sigs[i].ID == id && sigs[i].Voided.IsZero() {
			found = &sigs[i]
		}
	}
	if found == nil {
		http.Error(w, "no standing signature has that ID", http.StatusNotFound)
		return
	}
	words := fmt.Sprintf("%s's signature of version %d, as %s, %s", found.Login, found.Version, found.Name, found.SignedAt.UTC().Format("2 January 2006"))
	if req.Check {
		writeJSON(w, Done{Words: "Would void " + words + ". It is kept, marked void, and no longer counts."})
		return
	}
	if _, err := a.Store.Void(r.Context(), id, strings.TrimSpace(req.Reason)); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "no standing signature has that ID", http.StatusNotFound)
			return
		}
		http.Error(w, "the signature was not voided: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, Done{Done: true, Words: "Voided " + words + "."})
}
