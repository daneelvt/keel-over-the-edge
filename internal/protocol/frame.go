// SPDX-License-Identifier: AGPL-3.0-only

// Package protocol is the game connection's wire format: the kind byte that
// begins every message, the Protocol Buffers envelopes generated into pb,
// and the packed own-boat snapshot. shared/protocol describes both; go run
// ./tools/protocol generates pb and the protocol version from it.
package protocol

import (
	"errors"

	"google.golang.org/protobuf/proto"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A message's first byte is its kind.
const (
	// KindMessage is a Protocol Buffers envelope: pb.ClientMessage from a
	// client, pb.ServerMessage from the server.
	KindMessage byte = 1
	// KindSnapshot is the packed own-boat snapshot.
	KindSnapshot byte = 2
)

// Errors from decoding.
var (
	ErrEmpty = errors.New("protocol: an empty message")
	ErrKind  = errors.New("protocol: a message of an unknown kind")
	ErrBody  = errors.New("protocol: a message with no body")
)

// AppendServer appends m as a message of KindMessage to dst.
func AppendServer(dst []byte, m *pb.ServerMessage) ([]byte, error) {
	return proto.MarshalOptions{}.MarshalAppend(append(dst, KindMessage), m)
}

// AppendClient appends m as a message of KindMessage to dst.
func AppendClient(dst []byte, m *pb.ClientMessage) ([]byte, error) {
	return proto.MarshalOptions{}.MarshalAppend(append(dst, KindMessage), m)
}

// DecodeClient decodes a client's message into m. A message of any kind
// but KindMessage is ErrKind; one that holds none of the messages a client
// sends is ErrBody.
func DecodeClient(data []byte, m *pb.ClientMessage) error {
	if len(data) == 0 {
		return ErrEmpty
	}
	if data[0] != KindMessage {
		return ErrKind
	}
	if err := proto.Unmarshal(data[1:], m); err != nil {
		return err
	}
	if m.GetBody() == nil {
		return ErrBody
	}
	return nil
}

// DecodeServer decodes a server's message of KindMessage into m. A
// snapshot is read with ReadSnapshot instead.
func DecodeServer(data []byte, m *pb.ServerMessage) error {
	if len(data) == 0 {
		return ErrEmpty
	}
	if data[0] != KindMessage {
		return ErrKind
	}
	if err := proto.Unmarshal(data[1:], m); err != nil {
		return err
	}
	if m.GetBody() == nil {
		return ErrBody
	}
	return nil
}
