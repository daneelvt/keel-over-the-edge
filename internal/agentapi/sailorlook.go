// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	sailorlooks "github.com/daneelvt/keel-over-the-edge/internal/looks"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor's look: its version, its finish and its main colour,
// the catalog's choices. Its agent may change it as a player changes
// theirs, and only where a player may: at Port Royal, ashore before it
// sails (every voyage starts in Port Royal's roads), or at sea in Port
// Royal's harbour, where the change is seen at once.

// lookArgs are the choices boat's sailor_look changes, each by its name or
// its id, in any case; "" leaves it as it is.
type lookArgs struct {
	Version, Finish, Colour string
}

// changes reports whether any choice is given.
func (o *lookArgs) changes() bool { return o.Version != "" || o.Finish != "" || o.Colour != "" }

// choose is the choice of list a word names, by its name or its id.
func choose(list []sailorlooks.Choice, word string) (sailorlooks.Choice, bool) {
	w := fold(word)
	for _, c := range list {
		if w != "" && (w == fold(c.Name) || w == fold(c.ID)) {
			return c, true
		}
	}
	return sailorlooks.Choice{}, false
}

// nameOf is the name of the choice of list with id, "" for none.
func nameOf(list []sailorlooks.Choice, id string) string {
	for _, c := range list {
		if c.ID == id {
			return c.Name
		}
	}
	return ""
}

// series is the names of list's choices as prose: "a, b and c", or with
// "or".
func series(list []sailorlooks.Choice, conj string) string {
	names := make([]string, len(list))
	for i, c := range list {
		names[i] = c.Name
	}
	if len(names) < 2 {
		return strings.Join(names, "")
	}
	return strings.Join(names[:len(names)-1], ", ") + " " + conj + " " + names[len(names)-1]
}

// machineLook is a machine sailor's look as the game shows it: its own if
// it is made of the catalog's choices, else one drawn for it, the same
// every time, and always a machine's.
func machineLook(b *sailorlooks.Book, id store.AccountID, l store.Look) store.Look {
	if l.Look != store.MachineLook {
		l = store.Look{Look: store.MachineLook, Chosen: l.Chosen}
	}
	return b.Resolve(id, l)
}

// lookSentence is a machine sailor's look as it is told to its agent:
// "You are a machine sailor: male, brass, in sea green."
func lookSentence(m *sailorlooks.MachineChoices, l store.Look) string {
	return fmt.Sprintf("You are a machine sailor: %s, %s, in %s.",
		nameOf(m.Versions, l.Version), nameOf(m.Finishes, l.Finish), nameOf(m.Colours, l.Colour))
}

// lookLine is the helm's machine sailor's look in a sentence, as the
// handbook's start tells it; with no world open, only what it is.
func (c *Core) lookLine(h *helm) string {
	s := c.sea.Load()
	if s == nil || s.Looks == nil {
		return "You are a machine sailor."
	}
	m := s.Looks.Machines()
	h.mu.Lock()
	l := machineLook(s.Looks, h.account, h.sailor)
	h.mu.Unlock()
	return lookSentence(&m, l)
}

// The words of a change of look.
const (
	lookWhere     = "Your look changes only at Port Royal: before you sail, or in its harbour."
	lookInHarbour = "Your look is changed, here in Port Royal's harbour for all to see. "
	lookAshore    = "Your look is changed: you sail in it from Port Royal. "
)

// sailorLook answers boat's sailor_look: the machine sailor's look and
// what it may choose; or, given choices, the look changed, at Port Royal.
// The choices not given stay as they are.
func (c *Core) sailorLook(ctx context.Context, h *helm, o *lookArgs) (string, any, *refusal) {
	s := c.sea.Load()
	if s == nil {
		return "", nil, refuse(refusedNoWorld, wordsNoWorld)
	}
	b := s.Looks
	if b == nil {
		return "Not yet: sailors' looks come with a later update.", nil, nil
	}
	m := b.Machines()
	h.mu.Lock()
	l := machineLook(b, h.account, h.sailor)
	h.mu.Unlock()
	if !o.changes() {
		return fmt.Sprintf("%s You may choose your version (%s), finish (%s) and colour (%s): boat with action sailor_look and any of version, finish and colour. %s",
			lookSentence(&m, l), series(m.Versions, "or"), series(m.Finishes, "or"), series(m.Colours, "or"), lookWhere), nil, nil
	}
	for _, p := range []struct {
		word, what string
		list       []sailorlooks.Choice
		to         *string
	}{
		{o.Version, "version", m.Versions, &l.Version},
		{o.Finish, "finish", m.Finishes, &l.Finish},
		{o.Colour, "colour", m.Colours, &l.Colour},
	} {
		if p.word == "" {
			continue
		}
		ch, ok := choose(p.list, p.word)
		if !ok {
			return "", nil, refuse(refusedArgs, fmt.Sprintf("No %s called %q: a machine sailor's %s is %s. Nothing was changed.",
				p.what, p.word, p.what, series(p.list, "or")))
		}
		*p.to = ch.ID
	}
	l.Chosen = true
	if !b.Valid(l) {
		return "", nil, refuse(refusedArgs, "That look is not one a machine sailor may have. Nothing was changed.")
	}
	r, err := h.setLook(ctx, s, b.Code(l))
	switch {
	case err != nil:
		return "", nil, refuse(refusedBusy, wordsBusy)
	case r.Result == bus.Away:
		return "", nil, refuse(refusedPortRoyal, wordsPortRoyal)
	}
	if keep := c.cfg.SetLook; keep != nil {
		if err := keep(ctx, h.account, l); err != nil {
			c.cfg.Log.Warn("keeping a machine sailor's look", "account", h.account.String(), "err", err)
			return "", nil, refuse(refusedBusy, wordsBusy)
		}
	}
	h.mu.Lock()
	h.sailor = l
	h.mu.Unlock()
	if forget := c.cfg.Forget; forget != nil {
		// The token's grant carries the look: the next call reads it again.
		forget(h.account)
	}
	done := lookAshore
	if r.Result == bus.Done && r.Slot >= 0 {
		done = lookInHarbour
	}
	return done + lookSentence(&m, l), nil, nil
}

// setLook asks the simulation to change the look of the helm's boat, if
// it is in Port Royal's harbour, or of its place in the queue; and waits
// for its answer. Ashore, it answers NoBoat.
func (h *helm) setLook(ctx context.Context, s *Sea, code uint32) (bus.Reply, error) {
	reply := make(chan bus.Reply, 1)
	if err := send(ctx, s, bus.Command{Op: bus.SetLook, Account: bus.Account(h.account), Look: code, Reply: reply}); err != nil {
		return bus.Reply{}, err
	}
	t := time.NewTimer(joinWait)
	defer t.Stop()
	select {
	case r := <-reply:
		return r, nil
	case <-t.C:
		return bus.Reply{}, errBusy
	case <-ctx.Done():
		return bus.Reply{}, ctx.Err()
	}
}
