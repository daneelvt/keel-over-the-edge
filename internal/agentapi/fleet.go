// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/fleet"
	sailorlooks "github.com/daneelvt/keel-over-the-edge/internal/looks"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
)

// The fleet as a machine sailor's agent sails it: the boats of its owner's
// fleet, which it shares with its owner and the owner's other machine
// sailors; taking a free one, ashore or in port; and its own boat's look,
// changed there.

// fleetArgs are boat's arguments for the fleet: the boat taken, by its
// kind, name or number, and the look changed, each "" or nil to keep.
type fleetArgs struct {
	Boat         string
	Paint, Cloth string
	Number       *int
	Name         *string
}

// changes reports whether a look is given.
func (o *fleetArgs) changes() bool {
	return o.Paint != "" || o.Cloth != "" || o.Number != nil || o.Name != nil
}

// The words of the fleet.
const (
	fleetWhere = "Boats are taken and changed ashore, or at sea in port: in Port Royal's harbour or a port's, not at a fishing village."
	wordsPort  = "Only in port: sail into Port Royal's harbour or a port's (not a fishing village's) and ask again, or change it before you sail."
)

// boatNamed is a fleet's boat as its agent reads it: "Keelboat «Saltpeter»
// 311".
func (c *Core) boatNamed(s *Sea, b *fleet.Boat) string {
	return sailorlooks.Named(s.boat(uint16(b.Kind)).Name, b.Name, b.Number)
}

// boatState is whose a fleet's boat is, as its agent reads it.
func boatState(b *fleet.Boat, atSea bool) string {
	switch {
	case b.Yours && atSea:
		return "yours, in the water"
	case b.Yours:
		return "yours, ashore"
	case b.Taken() && b.Machine:
		return "at sea, sailed by machine sailor «" + b.SailorName + "»"
	case b.Taken():
		return "at sea, sailed by «" + b.SailorName + "»"
	}
	return "free"
}

// fleetList is the fleet as its agent reads it.
func (c *Core) fleetList(s *Sea, v *fleet.View) string {
	var b strings.Builder
	b.WriteString("Your owner's fleet, which you share with its sailors:")
	for i := range v.Boats {
		bt := &v.Boats[i]
		fmt.Fprintf(&b, "\n- %s, %s", c.boatNamed(s, bt), boatState(bt, v.AtSea))
		if bt.Yours || i == v.Yours {
			fmt.Fprintf(&b, " (%s)", s.Fleet.Looks().Words(sailorlooks.BoatLook{Paint: bt.Paint, Cloth: bt.Cloth}))
		}
		if i == v.Yours && !bt.Yours {
			b.WriteString(", the boat you take to sea")
		}
	}
	b.WriteString("\nTake a free boat with action take and boat (its kind, name or number); paint, number and name yours with action look. " + fleetWhere)
	return b.String()
}

// whichBoat is the boat of v a word names: by its sail number, its name,
// its kind and number ("keelboat 3"), or its kind, a free one or yours
// first; −1 for none.
func whichBoat(s *Sea, v *fleet.View, word string) int {
	w := fold(word)
	if w == "" {
		return v.Yours
	}
	best := -1
	for i := range v.Boats {
		b := &v.Boats[i]
		kind := fold(s.boat(uint16(b.Kind)).Name)
		num := strconv.Itoa(b.Number)
		switch {
		case w == num || w == kind+" "+num || b.Name != "" && w == fold(b.Name):
			return i
		case w == kind && (best < 0 || v.Boats[best].Taken() && !b.Taken() || b.Yours):
			best = i
		}
	}
	return best
}

// fleetRefusal is a change of the fleet refused, in words.
func fleetRefusal(err error, what string) *refusal {
	if ref, ok := errors.AsType[*moderation.Refusal](err); ok {
		words := map[moderation.Reason]string{
			moderation.Short:      "That name is too short: 2 letters at least, or empty for none.",
			moderation.Long:       "That name is too long: 20 letters at most.",
			moderation.Characters: "A name is letters and digits, with single spaces, hyphens, full stops or apostrophes between them.",
			moderation.Scripts:    "A name's letters are of one alphabet.",
			moderation.Words:      "That name is not allowed: choose another.",
		}[ref.Reason]
		return refuse(refusedArgs, words+" Nothing was changed.")
	}
	switch {
	case errors.Is(err, fleet.ErrPort):
		return refuse(refusedPort, wordsPort)
	case errors.Is(err, fleet.ErrTaken):
		return refuse(refusedArgs, "That boat is at sea with another of your owner's sailors: take a free one.")
	case errors.Is(err, fleet.ErrRoom):
		return refuse(refusedArgs, "No room here for "+what+": too near land, shoal water or another boat. Try the open water of the harbour.")
	case errors.Is(err, fleet.ErrNumber):
		return refuse(refusedArgs, "That sail number is another boat's of its kind: choose another. Nothing was changed.")
	case errors.Is(err, fleet.ErrLook):
		return refuse(refusedArgs, "No such paint or cloth, or a sail number out of 1 to 9999: boat with action look and nothing else lists them. Nothing was changed.")
	case errors.Is(err, fleet.ErrNoBoat):
		return refuse(refusedArgs, "No such boat in your owner's fleet: boat with action list lists them.")
	}
	return refuse(refusedBusy, wordsBusy)
}

// takeBoat answers boat's take: the boat named is the machine sailor's,
// ashore its boat to sea, at sea in port swapped for its boat where it
// lies; then it is at sea in it.
func (c *Core) takeBoat(ctx context.Context, h *helm, s *Sea, which string) (string, any, *refusal) {
	if s.Fleet == nil {
		return c.toSea(ctx, h, s, nil)
	}
	v, err := s.Fleet.Of(ctx, h.account)
	if err != nil {
		return "", nil, refuse(refusedBusy, wordsBusy)
	}
	i := whichBoat(s, &v, which)
	if i < 0 {
		return "", nil, refuse(refusedArgs, fmt.Sprintf("No boat called %q in your owner's fleet.\n%s", which, c.fleetList(s, &v)))
	}
	b := v.Boats[i]
	var lines []string
	if !b.Yours {
		if _, err := s.Fleet.Take(ctx, h.account, b.ID); err != nil {
			return "", nil, fleetRefusal(err, "a "+strings.ToLower(s.boat(uint16(b.Kind)).Name))
		}
		if v.AtSea {
			lines = append(lines, "Swapped where you lay: you are at rest in "+c.boatNamed(s, &b)+", your sheet eased.")
		} else {
			lines = append(lines, "Your boat is "+c.boatNamed(s, &b)+".")
		}
	}
	if !b.Yours {
		return c.toSea(ctx, h, s, lines)
	}
	return c.toSea(ctx, h, s, nil, "Already at sea in "+c.boatNamed(s, &b)+".")
}

// toSea takes the helm's boat to sea, if it is not, after lines; already at
// sea, it says so in the words given.
func (c *Core) toSea(ctx context.Context, h *helm, s *Sea, lines []string, already ...string) (string, any, *refusal) {
	_, f, jr, err := h.atSea(ctx)
	if r := atSeaRefusal(err, jr); r != nil {
		return "", nil, r
	}
	defer f.Release()
	if jr.queued {
		return strings.Join(append(lines, queuedWords(jr.position)), "\n"), nil, nil
	}
	lines = append(lines, c.noticesOf(s, jr)...)
	if !jr.joined {
		if len(already) == 0 {
			already = []string{"Already at sea."}
		}
		if len(lines) == 0 {
			lines = append(lines, already...)
		}
	}
	return strings.Join(lines, "\n"), nil, nil
}

// boatLook answers boat's look: the machine sailor's boat's look and what
// it may choose; or, given choices, the look changed, ashore or in port.
func (c *Core) boatLook(ctx context.Context, h *helm, s *Sea, o *fleetArgs) (string, any, *refusal) {
	v, err := s.Fleet.Of(ctx, h.account)
	if err != nil {
		return "", nil, refuse(refusedBusy, wordsBusy)
	}
	if v.Yours < 0 {
		return "", nil, refuse(refusedArgs, "No boat of your owner's fleet is free for you now.\n"+c.fleetList(s, &v))
	}
	b := v.Boats[v.Yours]
	bl := s.Fleet.Looks()
	if !o.changes() {
		return fmt.Sprintf("Your boat: %s, %s. Paints: %s. Cloths: %s. A sail number from 1 to %d no other boat of its kind has; "+
			"a name of 2 to 20 letters, or none. Change them with action look and paint, cloth, number or name; the rest stay. %s",
			c.boatNamed(s, &b), bl.Words(sailorlooks.BoatLook{Paint: b.Paint, Cloth: b.Cloth}), series(bl.Paints(), "or"),
			series(bl.Cloths(), "or"), bl.MaxNumber(), fleetWhere), nil, nil
	}
	ch := fleet.Change{Number: o.Number, Name: o.Name}
	for _, p := range []struct {
		word, what string
		list       []sailorlooks.Choice
		to         **string
	}{
		{o.Paint, "paint", bl.Paints(), &ch.Paint},
		{o.Cloth, "cloth", bl.Cloths(), &ch.Cloth},
	} {
		if p.word == "" {
			continue
		}
		choice, ok := choose(p.list, p.word)
		if !ok {
			return "", nil, refuse(refusedArgs, fmt.Sprintf("No %s called %q: a boat's %s is %s. Nothing was changed.", p.what, p.word, p.what, series(p.list, "or")))
		}
		*p.to = &choice.ID
	}
	nv, err := s.Fleet.SetLook(ctx, h.account, b.ID, ch)
	if err != nil {
		return "", nil, fleetRefusal(err, "it")
	}
	nb := nv.Boats[nv.Yours]
	where := "ashore: you sail in it next"
	if nv.AtSea {
		where = "here in port for all to see"
	}
	return fmt.Sprintf("Your boat is changed, %s: %s, %s.", where, c.boatNamed(s, &nb), bl.Words(sailorlooks.BoatLook{Paint: nb.Paint, Cloth: nb.Cloth})), nil, nil
}
