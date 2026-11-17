// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The bodies a player's page sends, read as the handlers read them, with
// whatever a fuzzer makes of them. Each target needs no database, and its
// seeds are the tests' own bodies, so they run with every other test.

// jsonRequest is a POST of body as the page sends it.
func jsonRequest(path string, body []byte) (*httptest.ResponseRecorder, *http.Request) {
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return httptest.NewRecorder(), r
}

// sailorBody is a new sailor's body as the tests send it.
const sailorBody = `{"name":"Ann Bonny","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":1990,"month":1}}`

// FuzzBegin: POST /account/begin's body, read and checked in the order
// beginAccount checks it (the body, the month of birth, the look, the
// name's rules), never panics; a body read is answered by one of those
// checks; a month of birth accepted is one the database keeps as it is; a
// name accepted keeps to its length.
func FuzzBegin(f *testing.F) {
	for _, s := range []string{
		sailorBody,
		`{"name":"  Ann   Bonny ","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":1990,"month":1}}`,
		`{"name":"Ann","name":"Admin","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":1990,"month":1}}`,
		`{"name":"Ann","look":"pirate-king","born":{"year":1990,"month":1}}`,
		`{"name":"Pаypal","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":1990,"month":1}}`,
		`{"name":"Ann ⚓","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":2020,"month":13}}`,
		`{"name":"Mary Read","look":"rover","born":{"year":1990}}`,
		`{"name":"Mary Read","look":"rover","born":{"year":"1990","month":1.5}}`,
		`{"name":"Mary Read","look":"rover","born":null}`,
		`{}`, `[]`, `{"born":{"year":1990,"month":1,"day":2}}`,
	} {
		f.Add([]byte(s))
	}
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	f.Fuzz(func(t *testing.T, body []byte) {
		w, r := jsonRequest("/account/begin", body)
		var req sailorRequest
		if !readJSON(w, r, &req) {
			if w.Code != http.StatusBadRequest {
				t.Fatalf("a body not read answered %d", w.Code)
			}
			return
		}
		born, ok := bornFrom(req.Born, now)
		if !ok {
			return
		}
		if back, ok := aboard.BornOf(born.Code()); !ok || back != born || !born.Valid(now) {
			t.Fatalf("a month of birth accepted, %+v, is kept as %d", born, born.Code())
		}
		if aboard.BandOf(born, now) == aboard.Child {
			return
		}
		if l := req.look(); l.Look == store.MachineLook || !testBook.Valid(l) {
			return
		}
		name, err := moderation.CheckName(req.Name)
		if err != nil {
			if _, ok := errors.AsType[*moderation.Refusal](err); !ok {
				t.Fatalf("a name refused with no reason: %v", err)
			}
			return
		}
		if n := utf8.RuneCountInString(name.Display); n < moderation.MinLength || n > moderation.MaxLength || name.Key == "" {
			t.Fatalf("the name %q accepted, %d characters", name.Display, n)
		}
	})
}

// FuzzClientReport: POST /api/client-report's body never panics; a report
// accepted holds each field of its kind to its bounds, and its message,
// cut before anything quoted, holds no quotation.
func FuzzClientReport(f *testing.F) {
	for _, s := range []string{
		`{"build":"abc123","kind":"error","message":"Cannot read properties of undefined (reading 'Ann Bonny')","stack":"index-Bx1.js:12:345\nchart-9a.js:4:5"}`,
		`{"build":"abc123","kind":"startup","stages":{"shell":180,"cover":240,"start":1900,"tap":5200,"reveal":7400},"bytes":2400000,"visit":"first","tier":2}`,
		`{"build":"abc123","kind":"startup","stages":{"shell":20,"cover":60,"reveal":1500},"bytes":40000,"visit":"worker","tier":3}`,
		`{"build":"abc123","kind":"error",`,
		`{"build":"abc123","kind":"error","message":"x","name":"Ann Bonny"}`,
		`{"build":"abc123","kind":"chat","message":"x"}`,
		`{"build":"a b","kind":"error","message":"x"}`,
		`{"build":"abc123","kind":"error","message":"x","stack":"at Ann (index.js:1:2)"}`,
		`{"build":"abc123","kind":"startup","stages":{"lunch":1},"visit":"first"}`,
		`{"build":"abc123","kind":"startup","stages":{"shell":600001},"visit":"first"}`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		w, r := jsonRequest("/api/client-report", body)
		r.Body = http.MaxBytesReader(w, r.Body, ReportBodyLimit)
		var in clientReport
		if !readJSON(w, r, &in) || !in.valid() {
			return
		}
		if !buildPattern.MatchString(in.Build) {
			t.Fatalf("a report of build %q accepted", in.Build)
		}
		switch in.Kind {
		case "error":
			cut := cutQuoted(in.Message)
			if utf8.RuneCountInString(in.Message) > reportMessage || len(in.Stack) > reportStack ||
				strings.ContainsAny(cut, "\"'`“”‘’«»") || !strings.Contains(in.Message, cut) {
				t.Fatalf("an error accepted: %+v, logged as %q", in, cut)
			}
		case "startup":
			for _, ms := range in.Stages {
				if ms < 0 || ms > reportLongest {
					t.Fatalf("a stage of %d ms accepted", ms)
				}
			}
			if in.Bytes < 0 || in.Bytes > reportMostBytes || in.Message != "" || in.Stack != "" {
				t.Fatalf("a start-up accepted: %+v", in)
			}
		}
	})
}

// fuzzPasskeys are the passkeys' ceremonies as the tests' server runs
// them.
func fuzzPasskeys(f *testing.F) *auth.Passkeys {
	f.Helper()
	p, err := auth.NewPasskeys(testRPID, []string{testOrigin})
	if err != nil {
		f.Fatal(err)
	}
	return p
}

// FuzzPasskeyMade: POST /account/finish's body, the browser's answer to
// the passkey's creation, read by keel and checked by go-webauthn against
// a ceremony begun, never panics; a passkey made from it holds its
// credential and public key.
func FuzzPasskeyMade(f *testing.F) {
	p := fuzzPasskeys(f)
	u := &auth.User{Handle: auth.NewUserHandle(), Name: "Ann Bonny"}
	b, err := p.BeginCreate(u)
	if err != nil {
		f.Fatal(err)
	}
	_, made, err := softkey.Create(b.Options, testOrigin)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(made)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"id":"","rawId":"","type":"public-key","response":{"clientDataJSON":"","attestationObject":""}}`))
	f.Fuzz(func(t *testing.T, body []byte) {
		w, r := jsonRequest("/account/finish", body)
		got, ok := answer(w, r)
		if !ok {
			t.Fatalf("a body not read: %d", w.Code)
		}
		key, err := p.FinishCreate(u, b.State, got)
		if err == nil && (len(key.CredentialID) == 0 || len(key.PublicKey) == 0) {
			t.Fatalf("a passkey made with nothing in it: %+v", key)
		}
	})
}

// FuzzPasskeyUsed: POST /signin/finish's body, the browser's answer to a
// sign-in, read by keel and checked by go-webauthn, never panics; it
// signs in only the account whose passkey it names, and is otherwise
// refused, or a passkey no account has.
func FuzzPasskeyUsed(f *testing.F) {
	p := fuzzPasskeys(f)
	ann := &auth.User{Handle: auth.NewUserHandle(), Name: "Ann Bonny"}
	b, err := p.BeginCreate(ann)
	if err != nil {
		f.Fatal(err)
	}
	key, made, err := softkey.Create(b.Options, testOrigin)
	if err != nil {
		f.Fatal(err)
	}
	pk, err := p.FinishCreate(ann, b.State, made)
	if err != nil {
		f.Fatal(err)
	}
	ann.Passkeys = []store.Passkey{pk}
	in, err := p.BeginSignIn(false)
	if err != nil {
		f.Fatal(err)
	}
	used, err := key.Get(in.Options)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(used)
	f.Add(made)
	f.Add([]byte(`{"id":"","rawId":"","type":"public-key","response":{"clientDataJSON":"","authenticatorData":"","signature":"","userHandle":""}}`))
	find := func(handle []byte) (*auth.User, error) {
		if !bytes.Equal(handle, ann.Handle) {
			return nil, store.ErrNotFound
		}
		// A copy each time, as the store reads one: a sign-in counts on it.
		u := *ann
		u.Passkeys = append([]store.Passkey(nil), ann.Passkeys...)
		return &u, nil
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		w, r := jsonRequest("/signin/finish", body)
		got, ok := answer(w, r)
		if !ok {
			t.Fatalf("a body not read: %d", w.Code)
		}
		u, usedKey, err := p.FinishSignIn(in.State, got, find)
		var unknown *auth.UnknownPasskey
		switch {
		case err == nil:
			if u == nil || !bytes.Equal(u.Handle, ann.Handle) || !bytes.Equal(usedKey.CredentialID, pk.CredentialID) {
				t.Fatalf("signed in as %+v with %x", u, usedKey.CredentialID)
			}
		case errors.As(err, &unknown), errors.Is(err, auth.ErrRefused):
		default:
			t.Fatalf("an answer refused but not as refused: %v", err)
		}
	})
}
