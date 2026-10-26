// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Machine sailors: a player's AI accounts, each with a sailor of a machine
// look, made from the game with no passkey asked (a machine sailor does
// nothing until an AI app is approved for it, which asks), up to the
// account's cap. The account page lists them with their approved apps and
// connection tokens; revoking an app needs no passkey, since it only takes
// away, but a connection token, which hands the machine sailor out, and
// deleting one, which cannot be undone, do.

// Machines keeps machine sailors, their grants and connection tokens: the
// store.
type Machines interface {
	oauth.Machines
	CreateMachine(ctx context.Context, owner store.AccountID, m store.NewMachine, boat string) (store.AccountID, error)
	MachineCap(ctx context.Context, owner store.AccountID) (int, error)
	Fleet(ctx context.Context, owner store.AccountID) (map[string]int, error)
	RevokeOwnedGrant(ctx context.Context, owner store.AccountID, grant [16]byte) (store.AccountID, error)
	MakeConnection(ctx context.Context, owner, machine store.AccountID, hash [32]byte) ([16]byte, [][16]byte, error)
	RevokeConnection(ctx context.Context, owner, machine store.AccountID) ([][16]byte, error)
}

// machinesPage is GET /api/machines's answer.
type machinesPage struct {
	// MCP is the MCP address AI apps connect to.
	MCP string `json:"mcp"`
	// Cap is how many machine sailors the account may have.
	Cap      int                 `json:"cap"`
	Machines []oauth.MachineItem `json:"machines"`
	// Fleet is the account's boats: how many of each kind, by the
	// catalog's ids.
	Fleet map[string]int     `json:"fleet"`
	Looks oauth.MachineLooks `json:"looks"`
	// ConfirmedUntil is when the passkey last confirmed on this session
	// stops allowing what cannot be undone, ms; 0 for none.
	ConfirmedUntil int64 `json:"confirmedUntil"`
}

func (a *api) lifetime() time.Duration {
	if a.cfg.Lifetime == nil {
		return oauth.DefaultLifetime
	}
	return a.cfg.Lifetime.Get()
}

func (a *api) machinesOf(ctx context.Context, cur auth.Current) (machinesPage, error) {
	items, err := oauth.ListMachines(ctx, a.cfg.Machines, cur.ID, a.cfg.MachineLooks, a.lifetime(), time.Now(), a.cfg.AtSea)
	if err != nil {
		return machinesPage{}, err
	}
	limit, err := a.cfg.Machines.MachineCap(ctx, cur.ID)
	if err != nil {
		return machinesPage{}, err
	}
	fleet, err := a.cfg.Machines.Fleet(ctx, cur.ID)
	if err != nil {
		return machinesPage{}, err
	}
	p := machinesPage{MCP: a.cfg.MCP, Cap: limit, Machines: items, Fleet: fleet, Looks: a.cfg.MachineLooks}
	if cur.Confirmed(time.Now()) {
		p.ConfirmedUntil = ms(cur.ConfirmedUntil)
	}
	return p, nil
}

// machines answers GET /api/machines, behind auth.Required: the account's
// machine sailors, as the start screen and the account page show them.
func (a *api) machines(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	p, err := a.machinesOf(r.Context(), cur)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "session")
		return
	}
	if err != nil {
		a.unavailable(w, r, "listing machine sailors", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// machineRequest is POST /api/machines's body: a machine sailor's name and
// look.
type machineRequest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Finish  string `json:"finish"`
	Colour  string `json:"colour"`
}

// makeMachine answers POST /api/machines, behind auth.Required: a machine
// sailor made, its name by every sailor's rules, in the one namespace they
// share, and a boat added to the fleet for it.
//
//	201 {"machines", …}      the page, the new one last
//	400 {"error":"look"}     a look not of the catalog's choices
//	409 {"error":"cap"}      the account has as many as it may
//	422 {"error": reason}    the name is refused: short, long, characters, scripts, words or taken
func (a *api) makeMachine(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req machineRequest
	if !readJSON(w, r, &req) {
		return
	}
	m, reason := oauth.CheckMachine(a.cfg.MachineLooks, req.Name, req.Version, req.Finish, req.Colour)
	switch reason {
	case "":
	case "look":
		writeError(w, http.StatusBadRequest, "look")
		return
	default:
		a.refuse(w, reason)
		return
	}
	id, err := a.cfg.Machines.CreateMachine(r.Context(), cur.ID, m, a.cfg.Boat)
	switch {
	case errors.Is(err, store.ErrCap):
		writeError(w, http.StatusConflict, "cap")
		return
	case errors.Is(err, store.ErrNameTaken):
		a.refuse(w, "taken")
		return
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "session")
		return
	case err != nil:
		a.unavailable(w, r, "making a machine sailor", err)
		return
	}
	a.cfg.Metrics.MachinesCreated.WithLabelValues("game").Inc()
	a.cfg.Log.Info("a machine sailor made", "request_id", obs.RequestID(r.Context()), "account", cur.ID.String(), "machine", id.String())
	p, err := a.machinesOf(r.Context(), cur)
	if err != nil {
		a.unavailable(w, r, "listing machine sailors", err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// machineDelete is POST /api/machines/delete's body: the machine sailor,
// and its name typed again.
type machineDelete struct {
	Machine string `json:"machine"`
	Name    string `json:"name"`
}

// deleteMachine answers POST /api/machines/delete, behind auth.Required
// and a passkey confirmed: the machine sailor goes, with its approved apps
// and connection token, its name free; its boat stays in the fleet, and
// what it charted reads "a former sailor".
//
//	200 the page
//	403 {"error":"confirm"}    no passkey confirmed lately
//	404 {"error":"not-found"}  no such machine sailor of the account
//	422 {"error":"name"}       the name typed is not the machine sailor's
func (a *api) deleteMachine(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req machineDelete
	if !readJSON(w, r, &req) {
		return
	}
	if !confirmed(w, cur) {
		return
	}
	id, ok := store.ParseID(req.Machine)
	if !ok {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	list, err := a.cfg.Machines.Machines(r.Context(), cur.ID)
	if err != nil {
		a.unavailable(w, r, "listing machine sailors", err)
		return
	}
	name := ""
	for _, m := range list {
		if m.ID == id {
			name = m.Name
		}
	}
	if name == "" {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	if moderation.Key(req.Name) != moderation.Key(name) {
		writeError(w, http.StatusUnprocessableEntity, "name")
		return
	}
	if err := a.cfg.Deletions.DeleteMachineByPlayer(r.Context(), cur.ID, id); errors.Is(err, accounts.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not-found")
		return
	} else if err != nil {
		a.unavailable(w, r, "deleting a machine sailor", err)
		return
	}
	a.cfg.Log.Info("a machine sailor deleted", "request_id", obs.RequestID(r.Context()), "account", cur.ID.String(), "machine", id.String())
	a.writeMachines(w, r, cur)
}

func (a *api) writeMachines(w http.ResponseWriter, r *http.Request, cur auth.Current) {
	p, err := a.machinesOf(r.Context(), cur)
	if err != nil {
		a.unavailable(w, r, "listing machine sailors", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// grantRequest is POST /api/machines/revoke's body.
type grantRequest struct {
	Grant string `json:"grant"`
}

// revokeApp answers POST /api/machines/revoke, behind auth.Required: an
// approved app's grant ends now, and its next call is refused.
//
//	200 the page
//	404 {"error":"not-found"}  no such grant of the account's machine sailors
func (a *api) revokeApp(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req grantRequest
	if !readJSON(w, r, &req) {
		return
	}
	id, ok := store.ParseID(req.Grant)
	if !ok {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	if _, err := a.cfg.Machines.RevokeOwnedGrant(r.Context(), cur.ID, id); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not-found")
		return
	} else if err != nil {
		a.unavailable(w, r, "revoking a grant", err)
		return
	}
	if a.cfg.Grants != nil {
		a.cfg.Grants.ForgetGrants(id)
	}
	a.cfg.Log.Info("a grant revoked", "request_id", obs.RequestID(r.Context()), "account", cur.ID.String(), "grant", id.String())
	a.writeMachines(w, r, cur)
}

// machineRef is the body of the token's routes: the machine sailor.
type machineRef struct {
	Machine string `json:"machine"`
}

// makeToken answers POST /api/machines/token, behind auth.Required and a
// passkey confirmed: a new connection token for the machine sailor, shown
// once, in place of any it had, which is refused from now on.
//
//	201 {"token", "ends"}      the token, and when it ends, ms
//	403 {"error":"confirm"}    no passkey confirmed lately
//	404 {"error":"not-found"}  no such machine sailor of the account
//	409 {"error":"stopped"}    the machine sailor is stopped by the game's operator
func (a *api) makeToken(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req machineRef
	if !readJSON(w, r, &req) {
		return
	}
	if !confirmed(w, cur) {
		return
	}
	id, ok := store.ParseID(req.Machine)
	if !ok {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	var replaced [][16]byte
	token, err := auth.Issue(a.cfg.Log, "connection token", func() auth.Drawn {
		t, h := oauth.NewToken(oauth.KindConnection)
		return auth.Drawn{Token: t, Hash: h}
	}, func(d auth.Drawn) error {
		var err error
		_, replaced, err = a.cfg.Machines.MakeConnection(r.Context(), cur.ID, id, d.Hash)
		return err
	})
	if errors.Is(err, store.ErrNoMachine) {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	if errors.Is(err, store.ErrStopped) {
		writeError(w, http.StatusConflict, "stopped")
		return
	}
	if err != nil {
		a.unavailable(w, r, "making a connection token", err)
		return
	}
	if a.cfg.Grants != nil && len(replaced) > 0 {
		a.cfg.Grants.ForgetGrants(replaced...)
	}
	a.cfg.Log.Info("a connection token made", "request_id", obs.RequestID(r.Context()), "account", cur.ID.String(), "machine", id.String(),
		"replaced", len(replaced))
	writeJSON(w, http.StatusCreated, map[string]any{"token": token.Token, "ends": time.Now().Add(a.lifetime()).UnixMilli()})
}

// revokeToken answers POST /api/machines/token/revoke, behind
// auth.Required: the machine sailor's connection token ends now.
//
//	200 the page
//	404 {"error":"not-found"}  no such machine sailor of the account
func (a *api) revokeToken(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req machineRef
	if !readJSON(w, r, &req) {
		return
	}
	id, ok := store.ParseID(req.Machine)
	if !ok {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	revoked, err := a.cfg.Machines.RevokeConnection(r.Context(), cur.ID, id)
	if errors.Is(err, store.ErrNoMachine) {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	if err != nil {
		a.unavailable(w, r, "revoking a connection token", err)
		return
	}
	if a.cfg.Grants != nil && len(revoked) > 0 {
		a.cfg.Grants.ForgetGrants(revoked...)
	}
	a.writeMachines(w, r, cur)
}
