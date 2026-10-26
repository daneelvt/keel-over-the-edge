// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"time"
)

// Refusals. Every call refused is a tool result marked an error, in the
// report's own words, which says what to do next and gives what the agent
// needs to do it, so it never has to call again to find out: an error in
// the protocol's own terms would reach the app, not the model. The door's
// refusals stay HTTP's, before any tool runs. Each kind is counted.

// refusalKind is a kind of refusal, as keel_agent_refusals_total counts
// it.
type refusalKind string

// The kinds of refusal.
const (
	refusedOrders     refusalKind = "orders"      // over the orders' budget
	refusedLooks      refusalKind = "looks"       // over the looks' budget
	refusedOrder      refusalKind = "order"       // an order out of its bounds, or not one of the ways to give it
	refusedArgs       refusalKind = "arguments"   // arguments that are not the tool's
	refusedPlace      refusalKind = "place"       // no charted place of that name
	refusedNotAtSea   refusalKind = "not_at_sea"  // the order needs the boat at sea, and it is not
	refusedQueued     refusalKind = "queued"      // the sea is full: the boat waits for a place
	refusedFull       refusalKind = "full"        // the sea and its queue are full
	refusedSuperseded refusalKind = "superseded"  // another wait of the machine sailor's took over
	refusedEnded      refusalKind = "world_ended" // the falls took the world
	refusedRestarting refusalKind = "restarting"  // keel restarts
	refusedNoWorld    refusalKind = "no_world"    // keel is between worlds
	refusedBusy       refusalKind = "busy"        // the simulation did not answer in time
	refusedFalling    refusalKind = "falling"     // over the falls: no orders until the boat starts again
	refusedStopped    refusalKind = "stopped"     // the machine sailor was stopped by the game's operator, or deleted
	refusedRevoked    refusalKind = "revoked"     // its grants were revoked by the game's operator
)

// refusalKinds lists every kind, for the metrics and the tests.
var refusalKinds = []refusalKind{refusedOrders, refusedLooks, refusedOrder, refusedArgs, refusedPlace, refusedNotAtSea, refusedQueued,
	refusedFull, refusedSuperseded, refusedEnded, refusedRestarting, refusedNoWorld, refusedBusy, refusedFalling, refusedStopped,
	refusedRevoked}

// refusal is a call refused: its kind and its words.
type refusal struct {
	kind  refusalKind
	words string
}

func (r *refusal) Error() string { return r.words }

// refuse is a refusal of kind k in words.
func refuse(k refusalKind, words string) *refusal { return &refusal{kind: k, words: words} }

// overBudget is a call over its budget: how long to wait, and the order
// the boat holds meanwhile.
func overBudget(b budget, l Limits, wait time.Duration, holds string) *refusal {
	ms := int(math.Ceil(float64(wait) / float64(time.Millisecond)))
	secs := fmt.Sprintf("%.1f s", float64(ms)/1000)
	if b == orders {
		words := fmt.Sprintf("Too many orders: the limit is %s a second, %d at once. Nothing was changed. Wait %s.",
			trimFloat(float64(l.Orders)), l.OrderBurst, secs)
		if holds != "" {
			words += " Your boat holds its last order (" + holds + ")."
		}
		return refuse(refusedOrders, words)
	}
	return refuse(refusedLooks, fmt.Sprintf("Too many looks: the limit is %s a second, %d at once. Wait %s, or use observe with wait to rest until something happens.",
		trimFloat(float64(l.Looks)), l.LookBurst, secs))
}

// queuedWords are a machine sailor's place in its queue.
func queuedWords(position int32) string {
	return fmt.Sprintf("The sea is full. You are %s in line for a machine sailor's place. Call observe with wait 25 to keep your place: "+
		"a waiting observe wakes as your boat is admitted.", ordinal(position))
}

// The words of the other refusals.
const (
	wordsNotAtSea   = "Not at sea: your boat is not in the water. Call observe to go to sea."
	wordsFull       = "The sea and its queue are full. Try again in a few minutes."
	wordsSuperseded = "This wait was superseded: another observe with wait was sent for this machine sailor. Only one waits at a time."
	wordsEnded      = "The falls took the world. The next world opens in a moment: call observe in a minute to sail it."
	wordsRestarting = "The game is restarting. Your boat sails on in its grace: call observe in a minute and you will find it."
	wordsNoWorld    = "No world is open just now: the game is starting or between worlds. Call observe in a minute."
	wordsBusy       = "The game is busy and did not answer in time. Nothing was changed. Try again in a moment."
	wordsFalling    = "Your boat is over the falls. It starts again at the start in a moment: call observe with wait 10."
)

// ordinal is n as an ordinal: "1st", "12th".
func ordinal(n int32) string {
	suffix := "th"
	switch {
	case n%100 >= 11 && n%100 <= 13:
	case n%10 == 1:
		suffix = "st"
	case n%10 == 2:
		suffix = "nd"
	case n%10 == 3:
		suffix = "rd"
	}
	return fmt.Sprintf("%d%s", n, suffix)
}

// leftWords are why the boat left the water, told at the next call.
func leftWords(why string, silence time.Duration) string {
	switch why {
	case leftSilent:
		return fmt.Sprintf("Your boat left the water after %s without a call and a minute's grace.", durationWords(silence))
	case leftGrace:
		return "Your boat left the water at the end of its grace, with no call from you."
	case leftFalls:
		return "The falls took the world, and your boat with it: this is a new world."
	case leftWorld:
		return "A new world began: your boat is in the water at the start."
	case leftUnknown:
		return "Your boat left the water."
	}
	return ""
}

// durationWords is a duration in plain words: "3 minutes", "90 seconds".
func durationWords(d time.Duration) string {
	if d%time.Minute == 0 {
		m := int(d / time.Minute)
		if m == 1 {
			return "a minute"
		}
		return fmt.Sprintf("%d minutes", m)
	}
	return fmt.Sprintf("%d seconds", int(d/time.Second))
}
