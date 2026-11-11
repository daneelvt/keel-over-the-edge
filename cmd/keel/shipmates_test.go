// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memDB keeps no shipmates: nobody sailed together, no offers. Shipmates'
// store is tested against the test database.

func (noAccounts) AllShipmates(context.Context) ([]store.Tie, error) { return nil, nil }
func (noAccounts) SawTogether(context.Context, store.AccountID, store.AccountID, time.Time, uint64, bool) error {
	return nil
}
func (noAccounts) SailedWith(context.Context, store.AccountID, store.AccountID) (store.Sailed, error) {
	return store.Sailed{}, store.ErrNotFound
}
func (noAccounts) ShipmatesOf(context.Context, store.AccountID) ([]store.Mate, error) {
	return nil, nil
}
func (noAccounts) CountShipmates(context.Context, store.AccountID) (int, error) { return 0, nil }
func (noAccounts) OffersTo(context.Context, store.AccountID, time.Time) ([]store.Mate, error) {
	return nil, nil
}
func (noAccounts) CountOffersFrom(context.Context, store.AccountID, time.Time) (int, error) {
	return 0, nil
}
func (noAccounts) OfferOf(context.Context, store.AccountID, store.AccountID, time.Time) (store.Offer, error) {
	return store.Offer{}, store.ErrNotFound
}
func (noAccounts) MakeOffer(context.Context, store.AccountID, store.AccountID, bool, time.Time) error {
	return errNoAccounts
}
func (noAccounts) DeclineOffer(context.Context, store.AccountID, store.AccountID) error { return nil }
func (noAccounts) MakeShipmates(context.Context, store.AccountID, store.AccountID) (bool, error) {
	return false, errNoAccounts
}
func (noAccounts) EndShipmates(context.Context, store.AccountID, store.AccountID) (bool, error) {
	return false, nil
}
func (noAccounts) RecentCrew(context.Context, store.AccountID, time.Time, time.Time) ([]store.Mate, error) {
	return nil, nil
}
func (noAccounts) SetAppearOffline(context.Context, store.AccountID, bool) error {
	return store.ErrNotFound
}
func (noAccounts) DeleteSailedAndOffers(context.Context, time.Time) (int64, error) {
	return 0, nil
}
