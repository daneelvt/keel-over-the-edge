// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memDB keeps no chat: no mutes, blocks, reports or statements. Chat's
// store is tested against the test database; its switches are on.

func (noAccounts) ChatSettings(context.Context) (bool, bool, []string, error) {
	return true, true, nil, nil
}
func (noAccounts) Ties(context.Context) ([]store.Tie, []store.Tie, error) { return nil, nil, nil }
func (noAccounts) Talker(context.Context, store.AccountID) (store.Talker, error) {
	return store.Talker{}, store.ErrNotFound
}
func (noAccounts) SetChat(context.Context, store.AccountID, bool) error { return store.ErrNotFound }
func (noAccounts) Mute(context.Context, store.AccountID, store.AccountID, bool) error {
	return errNoAccounts
}
func (noAccounts) Block(context.Context, store.AccountID, store.AccountID, bool) error {
	return errNoAccounts
}
func (noAccounts) TiesOf(context.Context, store.AccountID) ([]store.TieRow, error) { return nil, nil }
func (noAccounts) Statements(context.Context, store.AccountID) ([]store.Statement, error) {
	return nil, nil
}
func (noAccounts) ReadStatement(context.Context, store.AccountID, [16]byte) error { return nil }
func (noAccounts) AnswerStatement(context.Context, store.AccountID, [16]byte, string) error {
	return store.ErrNotFound
}
func (noAccounts) MakeYoungReport(context.Context, store.AccountID) error  { return nil }
func (noAccounts) DeleteReports(context.Context, time.Time) (int64, error) { return 0, nil }
func (noAccounts) EndFollows(context.Context) error                        { return nil }
func (noAccounts) MakeReport(context.Context, store.NewReport) (store.Made, error) {
	return store.Made{}, errNoAccounts
}
func (noAccounts) AddReportLines(context.Context, store.ReportID, []store.ReportLine) error {
	return nil
}
func (noAccounts) Report(context.Context, store.ReportID) (store.Report, error) {
	return store.Report{}, store.ErrNotFound
}
func (noAccounts) ReportQueue(context.Context, int) ([]store.QueueItem, error) { return nil, nil }
func (noAccounts) ReportCounts(context.Context) (int64, int64, time.Time, error) {
	return 0, 0, time.Time{}, nil
}
func (noAccounts) ActOnReport(context.Context, store.ReportAct) error { return store.ErrNotFound }
func (noAccounts) MakeNotice(context.Context, store.Notice) (store.ReportID, error) {
	return store.ReportID{}, errNoAccounts
}
func (noAccounts) SetChatSwitch(context.Context, bool, store.Action) error        { return nil }
func (noAccounts) SetShipmateMessages(context.Context, bool, store.Action) error  { return nil }
func (noAccounts) SetChatCountries(context.Context, []string, store.Action) error { return nil }
