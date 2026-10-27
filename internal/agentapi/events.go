// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

// What happens to a machine sailor's boat is kept as events, in a ring of
// ringSize per helm, each with the world's tick it happened at. A report's
// seq is the tick of the latest event it tells: the tick goes on across
// keel's restarts, as a count kept in memory would not. The events of one
// tick are always told together, so "since" means after a tick. observe
// tells the events after the last answer it sent; since tells them again
// after a tick, as when an answer was lost on its way.

// ringSize is how many events a helm keeps.
const ringSize = 500

// evKind is what an event is.
type evKind uint8

// The kinds of event.
const (
	evCapsized evKind = iota + 1
	evRighted
	evAground
	evAfloat
	evBump
	evLip       // the boat came near the lip of the falls
	evOver      // it went over the falls
	evTaken     // the falls took the world, and the boat with it
	evCharted   // its lookout charted something
	evDiscovery // a great discovery charted near it
	evFalls     // the falls are coming: the world's end draws near
	evGale      // a gale warning is in force
	evNewWorld  // a new world began
	evRestart   // keel is about to restart
	evAdmitted  // the queue gave it a boat
	evLeft      // its boat left the water
	evTurned    // the autopilot finished a tack or a gybe
	evGybed     // the autopilot followed an accidental gybe
	evWorldEnded
	evStalled // the autopilot's tack or gybe stalled
)

// always are the events that end any wait: a sailor would notice them
// whatever they were watching for.
func (k evKind) always() bool {
	switch k {
	case evCapsized, evAground, evBump, evLip, evOver, evTaken, evRestart, evAdmitted, evLeft, evNewWorld, evWorldEnded, evFalls, evGale:
		return true
	}
	return false
}

// wake is the wake_on word an event answers to, or "" for one that only
// always wakes or never does.
func (k evKind) wake() string {
	switch k {
	case evTurned, evGybed, evStalled:
		return wakePilot
	case evCharted, evDiscovery:
		return wakeSighting
	case evAfloat, evRighted:
		return wakeBoat
	}
	return ""
}

// word is the word a wake says it woke for.
func (k evKind) word() string {
	switch k {
	case evCapsized:
		return "capsized"
	case evRighted:
		return "righted"
	case evAground:
		return "aground"
	case evAfloat:
		return "afloat"
	case evBump:
		return "bump"
	case evLip:
		return "the lip"
	case evOver:
		return "over the falls"
	case evTaken:
		return "the falls"
	case evCharted, evDiscovery:
		return "sighting"
	case evFalls:
		return "the falls coming"
	case evGale:
		return "gale warning"
	case evNewWorld:
		return "a new world"
	case evRestart:
		return "restart"
	case evAdmitted:
		return "admitted"
	case evLeft:
		return "left the water"
	case evTurned, evGybed, evStalled:
		return "pilot"
	case evWorldEnded:
		return "the world ended"
	}
	return "event"
}

// event is something that happened to a boat, in the report's words.
type event struct {
	Tick int64
	Kind evKind
	// Words are what the report says of it; Seconds a time it gives, as
	// the restart's.
	Words   string
	Seconds int64
}

// ring keeps a helm's latest events, oldest first.
type ring struct {
	ev    [ringSize]event
	start int
	n     int
	// dropped is the tick of the newest event let go to make room, 0 for
	// none.
	dropped int64
}

func (r *ring) add(e event) {
	if r.n == ringSize {
		r.dropped = r.ev[r.start].Tick
		r.start = (r.start + 1) % ringSize
		r.n--
	}
	r.ev[(r.start+r.n)%ringSize] = e
	r.n++
}

// last is the tick of the newest event, 0 for none.
func (r *ring) last() int64 {
	if r.n == 0 {
		return 0
	}
	return r.ev[(r.start+r.n-1)%ringSize].Tick
}

// after lists the events after tick, oldest first, and whether events
// after it were let go: those of the ticks to lost and before.
func (r *ring) after(tick int64) (out []event, lost int64) {
	for i := range r.n {
		if e := r.ev[(r.start+i)%ringSize]; e.Tick > tick {
			out = append(out, e)
		}
	}
	if r.dropped > tick {
		lost = r.dropped
	}
	return out, lost
}

// event adds an event to the helm's ring, and ends its wait if the event
// is one it waits for.
func (h *helm) event(e event) {
	h.mu.Lock()
	if e.Tick == 0 {
		e.Tick = h.ring.last()
	}
	h.ring.add(e)
	w := h.waiter
	h.mu.Unlock()
	if w != nil && (e.Kind.always() || w.on[e.Kind.wake()]) {
		w.wake(e.Kind.word())
	}
}

// wakeAll ends the helm's wait for kind, whatever it waits for.
func (h *helm) wakeAll(kind evKind) {
	h.mu.Lock()
	w := h.waiter
	h.mu.Unlock()
	if w != nil {
		w.wake(kind.word())
	}
}
