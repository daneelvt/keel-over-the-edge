// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Passkeys are WebAuthn's ceremonies with the browser's passkey prompt, as
// go-webauthn runs them: making a passkey, for a new account or one more
// for an account; signing in with one, with no name typed (a discoverable
// credential); and confirming one of an account's own before what cannot be
// undone. Each ceremony is begun, its options sent to the browser and its
// state kept by the caller, and finished with the browser's answer and that
// state, once.
//
// The options follow WebAuthn Level 3 and web.dev's advice for passkeys: a
// discoverable credential required; user verification preferred, required
// to confirm; no attestation; the algorithms ES256, EdDSA and RS256; the
// credProps extension asked for, since browsers commonly return it and
// go-webauthn refuses an extension output it did not ask for.
type Passkeys struct {
	w *webauthn.WebAuthn
}

// PasskeyTimeout is how long the browser's prompt may stay open, and a
// ceremony's state is kept.
const PasskeyTimeout = 5 * time.Minute

// RelyingPartyName is the name a passkey manager may show beside the
// sailor's.
const RelyingPartyName = "Keel Over the Edge"

// UserHandleBytes is a user handle's length: the most WebAuthn allows,
// drawn at random, so it names an account and nothing else (Level 3,
// 14.6.1).
const UserHandleBytes = 64

// NewUserHandle draws a user handle for a new account.
func NewUserHandle() []byte {
	h := make([]byte, UserHandleBytes)
	_, _ = rand.Read(h) // never fails (crypto/rand)
	return h
}

// NewPasskeys configures the ceremonies for the relying party rpID, whose
// passkeys the origins may make and use: the play origin, and in the
// browser tests the servers beside it.
func NewPasskeys(rpID string, origins []string) (*Passkeys, error) {
	uv := protocol.VerificationPreferred
	w, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: RelyingPartyName,
		RPOrigins:     origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: protocol.ResidentKeyRequired(),
			UserVerification:   uv,
		},
		AttestationPreference: protocol.PreferNoAttestation,
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: PasskeyTimeout, TimeoutUVD: PasskeyTimeout},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: PasskeyTimeout, TimeoutUVD: PasskeyTimeout},
		},
	})
	if err != nil {
		return nil, err
	}
	return &Passkeys{w: w}, nil
}

// RPID is the relying party's ID.
func (p *Passkeys) RPID() string { return p.w.Config.RPID }

// User is an account as a ceremony sees it: the user handle its passkeys
// carry, the sailor's name, which passkey managers show, and its passkeys.
type User struct {
	Handle   []byte
	Name     string
	Passkeys []store.Passkey
}

func (u *User) WebAuthnID() []byte          { return u.Handle }
func (u *User) WebAuthnName() string        { return u.Name }
func (u *User) WebAuthnDisplayName() string { return u.Name }

func (u *User) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, len(u.Passkeys))
	for i := range u.Passkeys {
		out[i] = credentialOf(&u.Passkeys[i])
	}
	return out
}

// WebAuthnCredentialIDs are the credential IDs of the account's passkeys,
// for the Signal API's list of those accepted.
func (u *User) WebAuthnCredentialIDs() [][]byte {
	out := make([][]byte, len(u.Passkeys))
	for i := range u.Passkeys {
		out[i] = u.Passkeys[i].CredentialID
	}
	return out
}

func credentialOf(k *store.Passkey) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, len(k.Transports))
	for i, t := range k.Transports {
		transports[i] = protocol.AuthenticatorTransport(t)
	}
	return webauthn.Credential{
		ID: k.CredentialID, PublicKey: k.PublicKey, AttestationFormat: k.AttestationFormat, Transport: transports,
		Flags: webauthn.NewCredentialFlags(protocol.AuthenticatorFlags(k.Flags)),
		Authenticator: webauthn.Authenticator{
			AAGUID: k.AAGUID, SignCount: k.SignCount, CloneWarning: k.CloneWarning,
			Attachment: protocol.AuthenticatorAttachment(k.Attachment),
		},
	}
}

// passkeyOf is a credential just made or used as the store keeps it.
func passkeyOf(c *webauthn.Credential) (store.Passkey, error) {
	var key webauthncose.PublicKeyData
	if err := webauthncbor.Unmarshal(c.PublicKey, &key); err != nil {
		return store.Passkey{}, fmt.Errorf("the passkey's public key: %w", err)
	}
	transports := make([]string, len(c.Transport))
	for i, t := range c.Transport {
		transports[i] = string(t)
	}
	f := c.Flags
	return store.Passkey{
		CredentialID: c.ID, PublicKey: c.PublicKey, Algorithm: int32(key.Algorithm),
		SignCount: c.Authenticator.SignCount, CloneWarning: c.Authenticator.CloneWarning,
		Flags: byte(f.ProtocolValue()), BackupEligible: f.BackupEligible, BackupState: f.BackupState,
		AAGUID: c.Authenticator.AAGUID, Transports: transports, AttestationFormat: c.AttestationFormat,
		Attachment: string(c.Authenticator.Attachment),
	}, nil
}

// algorithms are the public keys' algorithms a passkey may have, the most
// preferred first: ES256, which every platform authenticator makes, then
// EdDSA and RS256 (Windows Hello's).
var algorithms = []protocol.CredentialParameter{
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgES256},
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgEdDSA},
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgRS256},
}

// Begun is a ceremony begun: the options for the browser, as JSON, and the
// ceremony's state, as JSON, to keep until it is finished.
type Begun struct {
	Options []byte
	State   []byte
	Expires time.Time
}

func begun(options any, s *webauthn.SessionData) (Begun, error) {
	o, err := json.Marshal(options)
	if err != nil {
		return Begun{}, err
	}
	st, err := json.Marshal(s)
	if err != nil {
		return Begun{}, err
	}
	return Begun{Options: o, State: st, Expires: s.Expires}, nil
}

func stateOf(state []byte) (webauthn.SessionData, error) {
	var s webauthn.SessionData
	err := json.Unmarshal(state, &s)
	return s, err
}

// BeginCreate begins making a passkey for u: a new account's, or one more
// for an account, whose passkeys the browser is told it holds already.
func (p *Passkeys) BeginCreate(u *User) (Begun, error) {
	opts := []webauthn.RegistrationOption{
		webauthn.WithCredentialParameters(algorithms),
		webauthn.WithExtensions(webauthn.WithExtensionCredProps()),
	}
	if len(u.Passkeys) > 0 {
		opts = append(opts, webauthn.WithExclusions(webauthn.Credentials(u.WebAuthnCredentials()).CredentialDescriptors()))
	}
	creation, s, err := p.w.BeginRegistration(u, opts...)
	if err != nil {
		return Begun{}, err
	}
	return begun(creation, s)
}

// ErrRefused is a browser's answer the ceremony does not accept: a
// signature that does not verify, another origin, a challenge not its
// own, or anything else WebAuthn's checks refuse. What go-webauthn found
// is wrapped in it, for the log.
var ErrRefused = errors.New("auth: the passkey was refused")

func refused(err error) error {
	var pe *protocol.Error
	if errors.As(err, &pe) {
		return fmt.Errorf("%w: %s (%s)", ErrRefused, pe.Details, pe.DevInfo)
	}
	return fmt.Errorf("%w: %v", ErrRefused, err)
}

// FinishCreate checks the browser's answer to BeginCreate for u, with the
// ceremony's state, and returns the passkey made.
func (p *Passkeys) FinishCreate(u *User, state, answer []byte) (store.Passkey, error) {
	s, err := stateOf(state)
	if err != nil {
		return store.Passkey{}, err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(answer)
	if err != nil {
		return store.Passkey{}, refused(err)
	}
	c, err := p.w.CreateCredential(u, s, parsed)
	if err != nil {
		return store.Passkey{}, refused(err)
	}
	return passkeyOf(c)
}

// BeginSignIn begins a sign-in with any of the relying party's passkeys
// the browser holds: on the browser's own prompt, or, conditional, offered
// as the name field is touched (autofill).
func (p *Passkeys) BeginSignIn(conditional bool) (Begun, error) {
	mediation := protocol.MediationDefault
	if conditional {
		mediation = protocol.MediationConditional
	}
	assertion, s, err := p.w.BeginDiscoverableMediatedLogin(mediation)
	if err != nil {
		return Begun{}, err
	}
	return begun(assertion, s)
}

// UnknownPasskey is a sign-in with a passkey no account has: one of an
// account deleted, or removed from one. The browser can be told to forget
// it (the Signal API's signalUnknownCredential).
type UnknownPasskey struct {
	CredentialID []byte
}

func (e *UnknownPasskey) Error() string { return "auth: a passkey no account has" }

// FinishSignIn checks the browser's answer to BeginSignIn, with the
// ceremony's state: find gives the account a user handle names, or
// store.ErrNotFound. It returns the account and the passkey used, updated
// as the store must write it back: its count, clone warning, flags and
// backup state. An *UnknownPasskey is a passkey no account has.
func (p *Passkeys) FinishSignIn(state, answer []byte, find func(handle []byte) (*User, error)) (*User, store.Passkey, error) {
	s, err := stateOf(state)
	if err != nil {
		return nil, store.Passkey{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(answer)
	if err != nil {
		return nil, store.Passkey{}, refused(err)
	}
	unknown := &UnknownPasskey{CredentialID: parsed.RawID}
	var found *User
	var lookup error
	handler := func(rawID, handle []byte) (webauthn.User, error) {
		found, lookup = find(handle)
		if lookup != nil {
			return nil, lookup
		}
		for i := range found.Passkeys {
			if bytes.Equal(found.Passkeys[i].CredentialID, rawID) {
				return found, nil
			}
		}
		lookup = store.ErrNotFound
		return nil, lookup
	}
	_, c, err := p.w.ValidatePasskeyLogin(handler, s, parsed)
	switch {
	case errors.Is(lookup, store.ErrNotFound):
		return nil, store.Passkey{}, unknown
	case lookup != nil:
		return nil, store.Passkey{}, lookup
	case err != nil:
		return nil, store.Passkey{}, refused(err)
	}
	used, err := passkeyOf(c)
	return found, used, err
}

// BeginApprove asks for whichever of the relying party's passkeys the
// browser holds, with the player verified by the device, to approve an AI
// app: on the browser's own prompt, never autofill, and with no account
// named, since the page an app opens has no game session to name one.
func (p *Passkeys) BeginApprove() (Begun, error) {
	assertion, s, err := p.w.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return Begun{}, err
	}
	return begun(assertion, s)
}

// ErrUnverified is an approval whose passkey did not verify the player:
// the authenticator data's UV flag was not set.
var ErrUnverified = fmt.Errorf("%w: the player was not verified", ErrRefused)

// FinishApprove checks the browser's answer to BeginApprove, as
// FinishSignIn does, and refuses one whose player was not verified,
// whatever the browser was asked.
func (p *Passkeys) FinishApprove(state, answer []byte, find func(handle []byte) (*User, error)) (*User, store.Passkey, error) {
	u, key, err := p.FinishSignIn(state, answer, find)
	if err != nil {
		return u, key, err
	}
	if protocol.AuthenticatorFlags(key.Flags)&protocol.FlagUserVerified == 0 {
		return nil, store.Passkey{}, ErrUnverified
	}
	return u, key, nil
}

// BeginConfirm asks for one of u's own passkeys, with the player verified
// by the device (its face, fingerprint or PIN), before something that
// cannot be undone (OWASP ASVS 5.0, 7.5.1).
func (p *Passkeys) BeginConfirm(u *User) (Begun, error) {
	assertion, s, err := p.w.BeginLogin(u, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return Begun{}, err
	}
	return begun(assertion, s)
}

// FinishConfirm checks the browser's answer to BeginConfirm for u, and
// returns the passkey used, updated as FinishSignIn's is.
func (p *Passkeys) FinishConfirm(u *User, state, answer []byte) (store.Passkey, error) {
	s, err := stateOf(state)
	if err != nil {
		return store.Passkey{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(answer)
	if err != nil {
		return store.Passkey{}, refused(err)
	}
	c, err := p.w.ValidateLogin(u, s, parsed)
	if err != nil {
		return store.Passkey{}, refused(err)
	}
	return passkeyOf(c)
}

// Accepted is the Signal API's list of the passkeys an account accepts,
// for signalAllAcceptedCredentials: a passkey manager may hide or remove
// the account's others.
func (p *Passkeys) Accepted(u *User) *protocol.SignalAllAcceptedCredentials {
	return protocol.NewSignalAllAcceptedCredentials(p.RPID(), u)
}
