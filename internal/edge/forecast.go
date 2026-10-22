// SPDX-License-Identifier: AGPL-3.0-only

package edge

import "github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"

// The forecast goes to every connection, not only to those whose chart is
// open: its gale warning and the barometer need it at sea. After the
// Welcome a connection is sent the latest issue with what has been, the
// issue of ninety minutes before and the truth since, which the client
// keeps from then on; then each issue as it is made. It is the whole of
// the future a client is told.

// ForecastSource is the world's forecast as it stands: its latest issue,
// as the wire carries it, and what has been, for a client just come; nil
// before the first issue. The messages it returns never change.
type ForecastSource interface {
	Forecast() (latest *pb.Forecast, past *pb.ForecastPast)
}

// forecast sends the connection the latest issue if it has not been sent
// it, after the Welcome; with what has been the first time. It reports
// whether the connection is still good.
func (c *conn) forecast(src ForecastSource) bool {
	if src == nil || !c.welcomed {
		return true
	}
	m, past := src.Forecast()
	if m == nil || c.issued && m.GetIssue() == c.issue {
		return true
	}
	out := m
	if !c.issued && past != nil {
		out = &pb.Forecast{
			Issue: m.GetIssue(), Steps: m.GetSteps(), Step: m.GetStep(), Spells: m.GetSpells(), Shifts: m.GetShifts(),
			Systems: m.GetSystems(), Gale: m.GetGale(), Past: past,
		}
	}
	c.issued, c.issue = true, m.GetIssue()
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Forecast{Forecast: out}}, outForecast)
}
