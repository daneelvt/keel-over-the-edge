// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Machine sailors as the approval page and the game's account page list
// them: each with its look, whether it is at sea, its approved apps and
// its connection token, each with when it ends.

// LookOption is one choice of a machine sailor's look: its id, its name
// in words, and its colour (sRGB, #rrggbb) where it has one.
type LookOption struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Colour string `json:"colour,omitempty"`
}

// MachineLooks are the choices of a machine sailor's look, the catalog's.
type MachineLooks struct {
	Versions []LookOption `json:"versions"`
	Finishes []LookOption `json:"finishes"`
	Colours  []LookOption `json:"colours"`
}

func find(opts []LookOption, id string) (LookOption, bool) {
	for _, o := range opts {
		if o.ID == id {
			return o, true
		}
	}
	return LookOption{}, false
}

// Valid reports whether a look is made of the catalog's choices.
func (l MachineLooks) Valid(version, finish, colour string) bool {
	_, v := find(l.Versions, version)
	_, f := find(l.Finishes, finish)
	_, c := find(l.Colours, colour)
	return v && f && c
}

// Look is a machine sailor's look: its choices' ids, its words ("Brass ·
// female · deep red") and its main colour.
type Look struct {
	Version string `json:"version"`
	Finish  string `json:"finish"`
	Colour  string `json:"colour"`
	Words   string `json:"words"`
	SRGB    string `json:"srgb"`
}

// LookOf is a machine sailor's look as the pages show it.
func (l MachineLooks) LookOf(version, finish, colour string) Look {
	v, _ := find(l.Versions, version)
	f, _ := find(l.Finishes, finish)
	c, _ := find(l.Colours, colour)
	return Look{Version: version, Finish: finish, Colour: colour, Words: f.Name + " · " + v.Name + " · " + c.Name, SRGB: c.Colour}
}

// AppItem is an approved app as the pages list it. Times are ms of the
// Unix epoch, 0 for never.
type AppItem struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ReturnHost string `json:"returnHost"`
	Loopback   bool   `json:"loopback,omitempty"`
	Approved   int64  `json:"approved"`
	LastUsed   int64  `json:"lastUsed"`
	Ends       int64  `json:"ends"`
	// Ended is the app's approval ended: revoked, replaced or past its
	// lifetime; EndedHow says which ("revoked", "replaced", "lifetime").
	Ended    bool   `json:"ended,omitempty"`
	EndedHow string `json:"endedHow,omitempty"`
}

// TokenItem is a machine sailor's connection token as the account page
// lists it.
type TokenItem struct {
	ID       string `json:"id"`
	Made     int64  `json:"made"`
	LastUsed int64  `json:"lastUsed"`
	Ends     int64  `json:"ends"`
	Ended    bool   `json:"ended,omitempty"`
}

// MachineItem is a machine sailor as the pages list it. Stopped is when
// the game's operator stopped it on its own, ms; 0 if not.
type MachineItem struct {
	ID      string     `json:"id"`
	Name    string     `json:"name"`
	Look    Look       `json:"look"`
	AtSea   bool       `json:"atSea"`
	Stopped int64      `json:"stopped"`
	Apps    []AppItem  `json:"apps"`
	Token   *TokenItem `json:"token"`
}

// Machines are what the lists of an account's machine sailors are made
// from: the store.
type Machines interface {
	Machines(ctx context.Context, owner store.AccountID) ([]store.Machine, error)
	Grants(ctx context.Context, owner store.AccountID, since time.Time) ([]store.Grant, error)
}

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// ListMachines lists an account's machine sailors with their apps and
// connection tokens: those live, and those ended within the time the job
// keeps them.
func ListMachines(ctx context.Context, st Machines, owner store.AccountID, looks MachineLooks, lifetime time.Duration,
	now time.Time, atSea func(store.AccountID) bool) ([]MachineItem, error) {
	ms0, err := st.Machines(ctx, owner)
	if err != nil {
		return nil, err
	}
	grants, err := st.Grants(ctx, owner, now.Add(-store.EndedGrantKeep))
	if err != nil {
		return nil, err
	}
	out := make([]MachineItem, len(ms0))
	index := map[store.AccountID]int{}
	for i, m := range ms0 {
		out[i] = MachineItem{
			ID: m.ID.String(), Name: m.Name, Look: looks.LookOf(m.Version, m.Finish, m.Colour), Apps: []AppItem{},
			AtSea: atSea != nil && atSea(m.ID), Stopped: ms(m.Stopped),
		}
		index[m.ID] = i
	}
	for _, g := range grants {
		i, ok := index[g.Machine]
		if !ok {
			continue
		}
		ends := g.Approved.Add(lifetime)
		how := ""
		switch {
		case !g.Revoked.IsZero() && g.RevokedWhy == store.RevokedReplaced:
			how = "replaced"
		case !g.Revoked.IsZero():
			how = "revoked"
		case !now.Before(ends):
			how = "lifetime"
		}
		if !g.Revoked.IsZero() && g.Revoked.Before(ends) {
			ends = g.Revoked
		}
		if now.Sub(ends) > store.EndedGrantKeep {
			continue
		}
		id := store.AccountID(g.ID).String()
		if g.Kind == store.GrantConnection {
			// Only the newest connection token is listed: the others it
			// replaced.
			if how == "replaced" {
				continue
			}
			out[i].Token = &TokenItem{ID: id, Made: ms(g.Approved), LastUsed: ms(g.LastUsed), Ends: ms(ends), Ended: how != ""}
			continue
		}
		if how == "replaced" {
			continue
		}
		host, loop := returnHost(g.RedirectURI)
		out[i].Apps = append(out[i].Apps, AppItem{
			ID: id, Name: g.ClientName, ReturnHost: host, Loopback: loop, Approved: ms(g.Approved), LastUsed: ms(g.LastUsed),
			Ends: ms(ends), Ended: how != "", EndedHow: how,
		})
	}
	return out, nil
}
