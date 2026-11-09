// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// SailSettings are the owner's switches for sailing together as the
// database keeps them, each written with its entry in the record: the
// store.
type SailSettings interface {
	SetLinkLifetime(ctx context.Context, d time.Duration, a store.Action) error
	SetLinks(ctx context.Context, on bool, a store.Action) (int64, error)
	SetBoarding(ctx context.Context, on bool, a store.Action) error
	CountLiveSailLinks(ctx context.Context, lifetime time.Duration) (int64, error)
	SailLinksEndedBy(ctx context.Context, now, d time.Duration) (int64, error)
}

// ChatSettings are the owner's switches for chat as the database keeps
// them, each written with its entry in the record.
type ChatSettings interface {
	SetChatSwitch(ctx context.Context, on bool, a store.Action) error
	SetShipmateMessages(ctx context.Context, on bool, a store.Action) error
	SetSpectatorChat(ctx context.Context, on bool, a store.Action) error
	SetChatCountries(ctx context.Context, countries []string, a store.Action) error
}

// SettingsJSON is settings.json: how long a link lasts, s, and whether
// links and boarding are on for everyone; and whether chat, shipmates'
// messages and spectators' reading of machine sailors' chat are, and the
// countries where chat is off.
type SettingsJSON struct {
	LinkLifetime     int64    `json:"linkLifetime"`
	Links            bool     `json:"links"`
	Boarding         bool     `json:"boarding"`
	Chat             bool     `json:"chat"`
	ShipmateMessages bool     `json:"shipmateMessages"`
	SpectatorChat    bool     `json:"spectatorChat"`
	ChatCountries    []string `json:"chatCountries"`
}

// SettingsRequest changes any of the switches; with Check, it only says
// what it would do.
type SettingsRequest struct {
	LinkLifetime *int64 `json:"linkLifetime,omitempty"`
	Links        *bool  `json:"links,omitempty"`
	Boarding     *bool  `json:"boarding,omitempty"`
	// Chat, ShipmateMessages, SpectatorChat and ChatCountries are chat's
	// switches.
	Chat             *bool     `json:"chat,omitempty"`
	ShipmateMessages *bool     `json:"shipmateMessages,omitempty"`
	SpectatorChat    *bool     `json:"spectatorChat,omitempty"`
	ChatCountries    *[]string `json:"chatCountries,omitempty"`
	Check            bool      `json:"check,omitempty"`
}

// SettingsAnswer is what a change did, or checked would do: the switches
// after it, its words, and how many working links it ends.
type SettingsAnswer struct {
	Settings SettingsJSON `json:"settings"`
	Words    string       `json:"words"`
	Ended    int64        `json:"ended"`
}

func settingsOf(s *aboard.Switches) SettingsJSON {
	c := s.ChatCountries()
	if c == nil {
		c = []string{}
	}
	return SettingsJSON{LinkLifetime: int64(s.Lifetime() / time.Second), Links: s.Links(), Boarding: s.Boarding(),
		Chat: s.Chat(), ShipmateMessages: s.ShipmateMessages(), SpectatorChat: s.SpectatorChat(), ChatCountries: c}
}

// settings serves settings.json, the switches in force.
func (o *Owner) settings(w http.ResponseWriter, _ *http.Request) {
	if o.cfg.Switches == nil {
		http.Error(w, "sailing together is not running", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, settingsOf(o.cfg.Switches))
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

// workingLinks is "1 working link", "2 working links".
func workingLinks(n int64) string {
	if n == 1 {
		return "1 working link"
	}
	return fmt.Sprintf("%d working links", n)
}

// setSettings changes the owner's switches for sailing together: the
// database first, each with its entry in the record, then the switches in
// memory every knock and link reads, so a change works at once. Links off
// ends every live link for good; a shorter lifetime stops the links older
// than it at once, and ends nothing in the database, so a longer one
// again never lengthens a link beyond its own expiry. The answer counts
// the working links it stops.
//
//	POST /owner/api/settings {"linkLifetime": 3600, "links": false, "boarding": false, "check": true}
func (o *Owner) setSettings(w http.ResponseWriter, r *http.Request) {
	var req SettingsRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Switches == nil || o.cfg.Sail == nil {
		o.refuse(w, "settings", http.StatusServiceUnavailable, "sailing together is not running")
		return
	}
	chatAsked := req.Chat != nil || req.ShipmateMessages != nil || req.SpectatorChat != nil || req.ChatCountries != nil
	if req.LinkLifetime == nil && req.Links == nil && req.Boarding == nil && !chatAsked {
		o.refuse(w, "settings", http.StatusBadRequest, "nothing to change: give linkLifetime, links, boarding, chat, shipmateMessages, spectatorChat or chatCountries")
		return
	}
	if chatAsked && o.cfg.ChatSettings == nil {
		o.refuse(w, "settings", http.StatusServiceUnavailable, "chat is not running")
		return
	}
	var countries []string
	if req.ChatCountries != nil {
		var ok bool
		if countries, ok = aboard.Countries(*req.ChatCountries); !ok {
			o.refuse(w, "settings", http.StatusBadRequest, "chatCountries: two letters each, as ISO 3166 has them (BR, AU)")
			return
		}
	}
	sw := o.cfg.Switches
	was, life := sw.Lifetime(), sw.Lifetime()
	if req.LinkLifetime != nil {
		life = time.Duration(*req.LinkLifetime) * time.Second
		if life < aboard.MinLifetime || life > aboard.MaxLifetime {
			o.refuse(w, "settings", http.StatusBadRequest, "lifetime: a link lasts from 5 minutes to 7 days (300 to 604800 s)")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	var ended int64
	var err error
	switch {
	case req.Links != nil && !*req.Links && sw.Links():
		ended, err = o.cfg.Sail.CountLiveSailLinks(ctx, min(was, life))
	case life < was && sw.Links():
		ended, err = o.cfg.Sail.SailLinksEndedBy(ctx, was, life)
	}
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	after := settingsOf(sw)
	var words []string
	if req.LinkLifetime != nil {
		after.LinkLifetime = *req.LinkLifetime
		words = append(words, fmt.Sprintf("a link lasts %s", life))
	}
	if req.Links != nil {
		after.Links = *req.Links
		words = append(words, "links "+onOff(*req.Links)+" for everyone")
	}
	if req.Boarding != nil {
		after.Boarding = *req.Boarding
		words = append(words, "boarding "+onOff(*req.Boarding)+" for everyone")
	}
	if req.Chat != nil {
		after.Chat = *req.Chat
		words = append(words, "chat "+onOff(*req.Chat)+" for everyone")
	}
	if req.ShipmateMessages != nil {
		after.ShipmateMessages = *req.ShipmateMessages
		words = append(words, "shipmates' messages "+onOff(*req.ShipmateMessages)+" for everyone")
	}
	if req.SpectatorChat != nil {
		after.SpectatorChat = *req.SpectatorChat
		words = append(words, "spectators reading machine sailors' chat "+onOff(*req.SpectatorChat)+" for everyone")
	}
	if req.ChatCountries != nil {
		after.ChatCountries = append([]string{}, countries...)
		if len(countries) == 0 {
			words = append(words, "chat off in no country")
		} else {
			words = append(words, "chat off in "+strings.Join(countries, ", "))
		}
	}
	said := strings.Join(words, "; ")
	if req.Check {
		writeJSON(w, SettingsAnswer{Settings: after, Ended: ended, Words: "Would set: " + said + "." + linksWords(req, "stops", ended)})
		return
	}
	a := store.Action{Source: sourceOf(r), From: r.RemoteAddr}
	if req.LinkLifetime != nil {
		a.Detail = life.String()
		if err := o.cfg.Sail.SetLinkLifetime(ctx, life, a); err != nil {
			http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		sw.SetLifetime(life)
		o.count(store.ActionLinkLifetime)
		o.cfg.Log.Info("owner: the link lifetime set", "action", store.ActionLinkLifetime, "was", was.String(), "now", life.String(), "from", r.RemoteAddr)
	}
	if req.Links != nil {
		a.Detail = onOff(*req.Links)
		n, err := o.cfg.Sail.SetLinks(ctx, *req.Links, a)
		if err != nil {
			http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		sw.SetLinks(*req.Links)
		o.count(store.ActionLinks)
		o.cfg.Log.Info("owner: links switched", "action", store.ActionLinks, "on", *req.Links, "ended", n, "from", r.RemoteAddr)
	}
	if req.Boarding != nil {
		a.Detail = onOff(*req.Boarding)
		if err := o.cfg.Sail.SetBoarding(ctx, *req.Boarding, a); err != nil {
			http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		sw.SetBoarding(*req.Boarding)
		o.count(store.ActionBoarding)
		o.cfg.Log.Info("owner: boarding switched", "action", store.ActionBoarding, "on", *req.Boarding, "from", r.RemoteAddr)
	}
	if chatAsked {
		cs := o.cfg.ChatSettings
		if req.Chat != nil {
			a.Detail = onOff(*req.Chat)
			if err := cs.SetChatSwitch(ctx, *req.Chat, a); err != nil {
				http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			sw.SetChat(*req.Chat)
			o.count(store.ActionChat)
			o.cfg.Log.Info("owner: chat switched", "action", store.ActionChat, "on", *req.Chat, "from", r.RemoteAddr)
		}
		if req.ShipmateMessages != nil {
			a.Detail = onOff(*req.ShipmateMessages)
			if err := cs.SetShipmateMessages(ctx, *req.ShipmateMessages, a); err != nil {
				http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			sw.SetShipmateMessages(*req.ShipmateMessages)
			o.count(store.ActionShipmateMessages)
			o.cfg.Log.Info("owner: shipmates' messages switched", "action", store.ActionShipmateMessages, "on", *req.ShipmateMessages, "from", r.RemoteAddr)
		}
		if req.SpectatorChat != nil {
			a.Detail = onOff(*req.SpectatorChat)
			if err := cs.SetSpectatorChat(ctx, *req.SpectatorChat, a); err != nil {
				http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			sw.SetSpectatorChat(*req.SpectatorChat)
			o.count(store.ActionSpectatorChat)
			o.cfg.Log.Info("owner: spectators' reading of machine sailors' chat switched", "action", store.ActionSpectatorChat, "on", *req.SpectatorChat, "from", r.RemoteAddr)
		}
		if req.ChatCountries != nil {
			a.Detail = strings.Join(countries, ",")
			if err := cs.SetChatCountries(ctx, countries, a); err != nil {
				http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			sw.SetChatCountries(countries)
			o.count(store.ActionChatCountries)
			o.cfg.Log.Info("owner: chat's countries set", "action", store.ActionChatCountries, "countries", a.Detail, "from", r.RemoteAddr)
		}
		// Every connection is told how chat stands for it now: the next
		// line is refused already, the switches being read for each.
		if o.cfg.ChatChanged != nil {
			o.cfg.ChatChanged()
		}
	}
	writeJSON(w, SettingsAnswer{Settings: settingsOf(sw), Ended: ended, Words: "Done: " + said + "." + linksWords(req, "stopped", ended)})
}

// linksWords are a change's words for the links it stops, for a change
// that touches links: " It stops 2 working links at once."
func linksWords(req SettingsRequest, verb string, ended int64) string {
	if req.LinkLifetime == nil && req.Links == nil && req.Boarding == nil {
		return ""
	}
	return fmt.Sprintf(" It %s %s at once.", verb, workingLinks(ended))
}
