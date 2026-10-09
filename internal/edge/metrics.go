// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"strconv"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The labels' values, resolved once so that counting allocates nothing.
const (
	upgradeOK = iota
	upgradeNoSession
	upgradeAI
	upgradeOrigin
	upgradeBad
	upgrades
)

var upgradeNames = [upgrades]string{"ok", "no_session", "ai_account", "origin", "bad_request"}

const (
	helloOK = iota
	helloProtocol
	helloCatalog
	helloLayout
	helloTimeout
	hellos
)

var helloNames = [hellos]string{"ok", "protocol", "catalog", "layout", "timeout"}

const (
	joinJoined = iota
	joinRejoined
	joinFull
	joinBusy
	joinTimeout
	joins
)

var joinNames = [joins]string{"joined", "rejoined", "full", "busy", "timeout"}

// The kinds of message counted, each way.
const (
	inHello = iota
	inInput
	inPing
	ins
)

var inNames = [ins]string{"hello", "input", "ping"}

const (
	outWelcome = iota
	outPong
	outSnapshot
	outs
)

var outNames = [outs]string{"welcome", "pong", "snapshot"}

// closeCodes are the codes counted by name; any other is "other", and a
// connection that ended without one "none".
var closeCodes = []websocket.StatusCode{
	websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusProtocolError,
	websocket.StatusUnsupportedData, websocket.StatusPolicyViolation, websocket.StatusMessageTooBig,
	websocket.StatusInternalError, websocket.StatusServiceRestart, websocket.StatusTryAgainLater,
	CloseReplaced, CloseVersion, CloseRemoved,
}

type metrics struct {
	connections prometheus.Gauge
	upgrade     [upgrades]prometheus.Counter
	hello       [hellos]prometheus.Counter
	join        [joins]prometheus.Counter
	closes      map[websocket.StatusCode]prometheus.Counter
	closeNone   prometheus.Counter
	closeOther  prometheus.Counter
	in          [ins]prometheus.Counter
	out         [outs]prometheus.Counter
	bytesIn     prometheus.Counter
	bytesOut    prometheus.Counter
	droppedRate prometheus.Counter
	replaced    prometheus.Counter
	encode      prometheus.Observer
	write       prometheus.Observer
	margin      prometheus.Observer
	rtt         prometheus.Observer
	frame       prometheus.Observer
}

func newMetrics(m *obs.Metrics) metrics {
	var x metrics
	x.connections = m.EdgeConnections
	for i, n := range upgradeNames {
		x.upgrade[i] = m.EdgeUpgrades.WithLabelValues(n)
	}
	for i, n := range helloNames {
		x.hello[i] = m.EdgeHellos.WithLabelValues(n)
	}
	for i, n := range joinNames {
		x.join[i] = m.EdgeJoins.WithLabelValues(n)
	}
	x.closes = map[websocket.StatusCode]prometheus.Counter{}
	for _, c := range closeCodes {
		x.closes[c] = m.EdgeCloses.WithLabelValues(strconv.Itoa(int(c)))
	}
	x.closeNone = m.EdgeCloses.WithLabelValues("none")
	x.closeOther = m.EdgeCloses.WithLabelValues("other")
	for i, n := range inNames {
		x.in[i] = m.EdgeMessages.WithLabelValues("in", n)
	}
	for i, n := range outNames {
		x.out[i] = m.EdgeMessages.WithLabelValues("out", n)
	}
	x.bytesIn = m.EdgeBytes.WithLabelValues("in")
	x.bytesOut = m.EdgeBytes.WithLabelValues("out")
	x.droppedRate = m.EdgeDropped.WithLabelValues("rate")
	x.replaced = m.EdgeDropped.WithLabelValues("snapshot_replaced")
	x.encode = m.EdgeEncodeDuration
	x.write = m.EdgeWriteDuration
	x.margin = m.EdgeInputMargin
	x.rtt = m.ClientRTT
	x.frame = m.ClientFrame
	return x
}

func (x *metrics) closed(code websocket.StatusCode) {
	switch c, ok := x.closes[code]; {
	case ok:
		c.Inc()
	case code < 0:
		x.closeNone.Inc()
	default:
		x.closeOther.Inc()
	}
}

// frameBytes is the size of a WebSocket frame of n bytes of payload
// (RFC 6455, 5.2): its header, the masking key a client's frames carry,
// and the payload.
func frameBytes(n int, masked bool) float64 {
	h := 2
	switch {
	case n > 0xffff:
		h += 8
	case n > 125:
		h += 2
	}
	if masked {
		h += 4
	}
	return float64(h + n)
}
