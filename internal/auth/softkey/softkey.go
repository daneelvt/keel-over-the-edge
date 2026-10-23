// SPDX-License-Identifier: AGPL-3.0-only

// Package softkey is a software authenticator: a passkey held in memory,
// which answers the game's WebAuthn ceremonies as a browser and its
// authenticator would. Tests and tools make their sailors with it, through
// the same routes a player's browser uses; nothing in the server knows it
// from a phone.
//
// It makes ES256 (P-256) passkeys with the "none" attestation, as
// platform authenticators do when no attestation is asked for, and answers
// with the user present and verified (WebAuthn Level 3, 6.1: flags UP and
// UV). Its answers are the JSON a browser's PublicKeyCredential.toJSON()
// writes.
package softkey

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
)

// The authenticator data's flags (WebAuthn Level 3, 6.1).
const (
	flagUP = 0x01
	flagUV = 0x04
	flagBE = 0x08
	flagBS = 0x10
	flagAT = 0x40
)

// Key is a passkey.
type Key struct {
	// RPID is the relying party the passkey is for, and Origin the page's
	// origin it answers from.
	RPID   string `json:"rpId"`
	Origin string `json:"origin"`
	// CredentialID and UserHandle are the passkey's and its account's.
	CredentialID []byte `json:"credentialId"`
	UserHandle   []byte `json:"userHandle"`
	// Private is the private key, PKCS #8.
	Private []byte `json:"privateKey"`
	// SignCount is the count the next answer carries; kept at 0 it is a
	// passkey that syncs, which never counts.
	SignCount uint32 `json:"signCount"`
	// Synced makes the passkey backup eligible and backed up, as a synced
	// passkey's flags say.
	Synced bool `json:"synced,omitempty"`
}

var b64 = base64.RawURLEncoding

// creation is what of the browser's creation options a key needs.
type creation struct {
	PublicKey struct {
		RP        struct{ ID string } `json:"rp"`
		User      struct{ ID string } `json:"user"`
		Challenge string              `json:"challenge"`
	} `json:"publicKey"`
}

// Create makes a passkey for the creation options a server sent, as JSON,
// answering from origin. It returns the key and the browser's answer, the
// JSON the server's finish reads.
func Create(options []byte, origin string) (*Key, []byte, error) {
	var o creation
	if err := json.Unmarshal(options, &o); err != nil {
		return nil, nil, fmt.Errorf("softkey: the options: %w", err)
	}
	handle, err := b64.DecodeString(o.PublicKey.User.ID)
	if err != nil || len(handle) == 0 {
		return nil, nil, fmt.Errorf("softkey: the options' user handle %q", o.PublicKey.User.ID)
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, nil, err
	}
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	k := &Key{RPID: o.PublicKey.RP.ID, Origin: origin, CredentialID: id, UserHandle: handle, Private: der}
	answer, err := k.attest(o)
	if err != nil {
		return nil, nil, err
	}
	return k, answer, nil
}

// Another makes one more passkey for the same account, as another device
// would, from the options of adding a passkey: its user handle is the
// account's, and it answers from the same origin.
func (k *Key) Another(options []byte) (*Key, []byte, error) {
	return Create(options, k.Origin)
}

func (k *Key) private() (*ecdsa.PrivateKey, error) {
	p, err := x509.ParsePKCS8PrivateKey(k.Private)
	if err != nil {
		return nil, err
	}
	ec, ok := p.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("softkey: not an ECDSA key")
	}
	return ec, nil
}

func (k *Key) flags() byte {
	f := byte(flagUP | flagUV)
	if k.Synced {
		f |= flagBE | flagBS
	}
	return f
}

// authData is the authenticator data: the relying party's hash, the
// flags, the count, and what follows them.
func (k *Key) authData(flags byte, rest []byte) []byte {
	rp := sha256.Sum256([]byte(k.RPID))
	out := append(rp[:], flags)
	out = binary.BigEndian.AppendUint32(out, k.SignCount)
	return append(out, rest...)
}

func (k *Key) clientData(kind, challenge string) []byte {
	cd, _ := json.Marshal(map[string]any{"type": kind, "challenge": challenge, "origin": k.Origin, "crossOrigin": false})
	return cd
}

func (k *Key) attest(o creation) ([]byte, error) {
	priv, err := k.private()
	if err != nil {
		return nil, err
	}
	x, y := make([]byte, 32), make([]byte, 32)
	priv.X.FillBytes(x)
	priv.Y.FillBytes(y)
	// The public key as COSE writes it (RFC 9053): an EC2 key, ES256, on
	// P-256.
	cose, err := webauthncbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	if err != nil {
		return nil, err
	}
	var att bytes.Buffer
	att.Write(make([]byte, 16)) // the AAGUID: none
	_ = binary.Write(&att, binary.BigEndian, uint16(len(k.CredentialID)))
	att.Write(k.CredentialID)
	att.Write(cose)
	auth := k.authData(k.flags()|flagAT, att.Bytes())
	obj, err := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": auth})
	if err != nil {
		return nil, err
	}
	spki, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return nil, err
	}
	id := b64.EncodeToString(k.CredentialID)
	return json.Marshal(map[string]any{
		"id": id, "rawId": id, "type": "public-key", "authenticatorAttachment": "platform",
		"response": map[string]any{
			"clientDataJSON":     b64.EncodeToString(k.clientData("webauthn.create", o.PublicKey.Challenge)),
			"attestationObject":  b64.EncodeToString(obj),
			"authenticatorData":  b64.EncodeToString(auth),
			"publicKey":          b64.EncodeToString(spki),
			"publicKeyAlgorithm": -7,
			"transports":         []string{"internal", "hybrid"},
		},
		"clientExtensionResults": map[string]any{"credProps": map[string]any{"rk": true}},
	})
}

// request is what of the browser's request options a key needs.
type request struct {
	PublicKey struct {
		RPID      string `json:"rpId"`
		Challenge string `json:"challenge"`
		Allow     []struct {
			ID string `json:"id"`
		} `json:"allowCredentials"`
	} `json:"publicKey"`
}

// ErrNotAllowed is a request whose options allow other passkeys than this
// one, or are for another relying party: a browser would offer this one
// nothing to answer with.
var ErrNotAllowed = errors.New("softkey: the request does not allow this passkey")

// Get answers the request options a server sent, as JSON, signing in or
// confirming with the key. It returns the browser's answer, the JSON the
// server's finish reads, and counts up when the key counts.
func (k *Key) Get(options []byte) ([]byte, error) {
	var o request
	if err := json.Unmarshal(options, &o); err != nil {
		return nil, fmt.Errorf("softkey: the options: %w", err)
	}
	if o.PublicKey.RPID != k.RPID {
		return nil, ErrNotAllowed
	}
	if len(o.PublicKey.Allow) > 0 {
		allowed := false
		for _, a := range o.PublicKey.Allow {
			allowed = allowed || a.ID == b64.EncodeToString(k.CredentialID)
		}
		if !allowed {
			return nil, ErrNotAllowed
		}
	}
	priv, err := k.private()
	if err != nil {
		return nil, err
	}
	if k.SignCount > 0 {
		k.SignCount++
	}
	auth := k.authData(k.flags(), nil)
	cd := k.clientData("webauthn.get", o.PublicKey.Challenge)
	h := sha256.Sum256(cd)
	signed := sha256.Sum256(append(append([]byte{}, auth...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, priv, signed[:])
	if err != nil {
		return nil, err
	}
	id := b64.EncodeToString(k.CredentialID)
	return json.Marshal(map[string]any{
		"id": id, "rawId": id, "type": "public-key", "authenticatorAttachment": "platform",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cd),
			"authenticatorData": b64.EncodeToString(auth),
			"signature":         b64.EncodeToString(sig),
			"userHandle":        b64.EncodeToString(k.UserHandle),
		},
		"clientExtensionResults": map[string]any{},
	})
}
