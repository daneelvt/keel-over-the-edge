// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memDB keeps no machine sailors, grants or AI apps' sign-ins: the game's
// tests of them run against the test database.

func (noAccounts) Machines(context.Context, store.AccountID) ([]store.Machine, error) {
	return nil, nil
}
func (noAccounts) Grants(context.Context, store.AccountID, time.Time) ([]store.Grant, error) {
	return nil, nil
}
func (noAccounts) TokenGrant(context.Context, [32]byte) (store.TokenGrant, error) {
	return store.TokenGrant{}, store.ErrNotFound
}
func (noAccounts) Client(context.Context, string) (store.Client, error) {
	return store.Client{}, store.ErrNotFound
}
func (noAccounts) ClientUsed(context.Context, string) error             { return nil }
func (noAccounts) RegisterClient(context.Context, store.Client) error   { return errNoAccounts }
func (noAccounts) SaveRequest(context.Context, store.AuthRequest) error { return errNoAccounts }
func (noAccounts) Request(context.Context, [32]byte) (store.AuthRequest, error) {
	return store.AuthRequest{}, store.ErrNotFound
}
func (noAccounts) ConfirmRequest(context.Context, [32]byte, store.AccountID, [16]byte, time.Time) error {
	return store.ErrNotFound
}
func (noAccounts) TakeRequest(context.Context, [32]byte) (store.AuthRequest, error) {
	return store.AuthRequest{}, store.ErrNotFound
}
func (noAccounts) AccountHeld(context.Context, store.AccountID) (bool, error) { return false, nil }
func (noAccounts) MachineCap(context.Context, store.AccountID) (int, error) {
	return 0, store.ErrNotFound
}
func (noAccounts) Approve(context.Context, store.Approval) (store.Approved, error) {
	return store.Approved{}, store.ErrNotFound
}
func (noAccounts) UseCode(context.Context, [32]byte) (store.CodeGrant, error) {
	return store.CodeGrant{}, store.ErrNotFound
}
func (noAccounts) IssuePair(context.Context, [16]byte, store.Pair) error { return errNoAccounts }
func (noAccounts) Refresh(context.Context, store.Refresh) (store.Refreshed, error) {
	return store.Refreshed{}, store.ErrNotFound
}
func (noAccounts) RevokeToken(context.Context, [32]byte, string) (store.Revoked, error) {
	return store.Revoked{}, store.ErrNotFound
}
func (noAccounts) CreateMachine(context.Context, store.AccountID, store.NewMachine, string) (store.AccountID, error) {
	return store.AccountID{}, errNoAccounts
}
func (noAccounts) DeleteMachine(context.Context, store.AccountID, store.AccountID) error {
	return store.ErrNotFound
}
func (noAccounts) Fleet(context.Context, store.AccountID) (map[string]int, error) { return nil, nil }
func (noAccounts) RevokeOwnedGrant(context.Context, store.AccountID, [16]byte) (store.AccountID, error) {
	return store.AccountID{}, store.ErrNotFound
}
func (noAccounts) MakeConnection(context.Context, store.AccountID, store.AccountID, [32]byte) ([16]byte, [][16]byte, error) {
	return [16]byte{}, nil, store.ErrNoMachine
}
func (noAccounts) RevokeConnection(context.Context, store.AccountID, store.AccountID) ([][16]byte, error) {
	return nil, store.ErrNoMachine
}
func (noAccounts) GrantUsed(context.Context, [16]byte, time.Time) error { return nil }
func (noAccounts) GrantLifetime(context.Context) (time.Duration, error) {
	return oauth.DefaultLifetime, nil
}
func (noAccounts) MachineCounts(context.Context, time.Duration) (store.MachineCounts, error) {
	return store.MachineCounts{}, nil
}
func (noAccounts) DeleteOAuthLeftovers(context.Context, time.Time, time.Duration) (store.OAuthCleanup, error) {
	return store.OAuthCleanup{}, nil
}
func (noAccounts) GrantsEndedBy(context.Context, time.Duration) (int64, error) { return 0, nil }
func (noAccounts) SetGrantLifetime(context.Context, time.Duration) error       { return nil }
func (noAccounts) SetMachineCap(context.Context, store.AccountID, int) error {
	return store.ErrNotFound
}
