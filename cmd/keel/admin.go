// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// keel admin is the world page's Accounts tab from the command line: a
// client of the page's own routes on the internal listener, never of the
// database. One keel process holds the world, its connections and its
// caches; a second process writing the database would leave a stopped
// boat at sea and every cache a while behind. In the cluster it runs in
// keel's own pod, whose image has no shell or curl:
//
//	kubectl -n keel exec deploy/keel -c keel -- /keel admin search ann
//
// or from the owner's computer through a forward of the internal listener.

const adminUsage = `usage: keel admin [-addr host:port] [-json] <command> [arguments]

  search [TEXT] [-sort active-new|active-old|made|machines] [-page N]
                       find accounts by a sailor's name or part of it, an
                       account's ID, or a token; TEXT - reads it from the
                       standard input, so a token stays out of the shell's
                       history; no TEXT lists every account
  show ID              an account's card
  stop ID -reason TEXT [-yes]
                       stop an account: it cannot sign in or sail; a human's
                       machine sailors stop with it
  start ID [-reason TEXT]
                       start a stopped account again
  revoke ID -reason TEXT [-yes]
                       revoke an AI account's tokens, or a human's machine
                       sailors'
  delete ID -name NAME -reason TEXT [-yes]
                       delete an account, its sailor's name typed again
  flag ID on|off       the owner's flag
  priority ID on|off   a priority account never waits for a boat
  cap ID N             how many machine sailors a human may have
  lifetime DURATION [-yes]
                       how long an AI app's approval lasts: 90d, 12h, 30m
  actions [ID]         the record of the owner's actions

Without -yes, stop, revoke, delete and lifetime say what they would do,
and do nothing.

  -addr  keel's internal listener (default KEEL_INTERNAL_ADDR, or
         127.0.0.1:9090)
  -json  the answers as keel gives them
`

// adminTimeout bounds one request to keel.
const adminTimeout = 30 * time.Second

// adminClient talks to the internal listener.
type adminClient struct {
	base   string
	http   *http.Client
	json   bool
	stdout io.Writer
}

// errAdmin is an answer keel refused, already told.
var errAdmin = errors.New("refused")

// adminAddr is the internal listener's address to dial: an address that
// listens on every interface is reached on the loopback.
func adminAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}

// do sends one request: the body as JSON, the Host the guard allows, and
// the command named as its source. It answers the body, or tells the
// refusal on stderr and returns errAdmin.
func (c *adminClient) do(ctx context.Context, method, path string, body any, stderr io.Writer) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Host = "localhost"
	req.Header.Set(owner.SourceHeader, store.SourceCommand)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("keel's internal listener: %w", err)
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		fmt.Fprintf(stderr, "keel admin: %s\n", strings.TrimSpace(string(out)))
		return nil, errAdmin
	}
	return out, nil
}

// show writes an answer: as keel gave it with -json, or as text.
func (c *adminClient) show(raw []byte, v any, text func()) error {
	if c.json {
		var buf bytes.Buffer
		if err := json.Indent(&buf, raw, "", "  "); err != nil {
			return err
		}
		buf.WriteByte('\n')
		_, err := c.stdout.Write(buf.Bytes())
		return err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return err
	}
	text()
	return nil
}

// parseMixed parses flags that may come before, between or after the
// positional arguments, which it returns.
func parseMixed(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

// parseLifetime reads a lifetime: a Go duration, or whole days, 90d.
func parseLifetime(s string) (time.Duration, error) {
	if d, ok := strings.CutSuffix(s, "d"); ok {
		n, err := strconv.Atoi(d)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("not a number of days: %q", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("not a duration: %q (90d, 12h or 30m)", s)
	}
	return d, nil
}

func admin(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) error {
	return adminWith(ctx, args, getenv, stdin, stdout, stderr, http.DefaultClient)
}

// adminWith is admin with the HTTP client given, for tests.
func adminWith(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer, hc *http.Client) error {
	top := flag.NewFlagSet("admin", flag.ContinueOnError)
	top.SetOutput(stderr)
	top.Usage = func() { io.WriteString(stderr, adminUsage) }
	defaultAddr := getenv("KEEL_INTERNAL_ADDR")
	if defaultAddr == "" {
		defaultAddr = config.DefaultInternalAddr
	}
	addr := top.String("addr", defaultAddr, "")
	asJSON := top.Bool("json", false, "")
	if err := top.Parse(args); err != nil {
		return errUsage
	}
	if top.NArg() == 0 {
		top.Usage()
		return errUsage
	}
	verb, rest := top.Arg(0), top.Args()[1:]
	fs := flag.NewFlagSet("admin "+verb, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = top.Usage
	fs.StringVar(addr, "addr", *addr, "")
	fs.BoolVar(asJSON, "json", *asJSON, "")
	reason := fs.String("reason", "", "")
	name := fs.String("name", "", "")
	yes := fs.Bool("yes", false, "")
	sort := fs.String("sort", "", "")
	page := fs.Int("page", 0, "")
	pos, err := parseMixed(fs, rest)
	if err != nil {
		return errUsage
	}
	c := &adminClient{base: "http://" + adminAddr(*addr), http: hc, json: *asJSON, stdout: stdout}
	id := func() (string, error) {
		if len(pos) < 1 {
			fmt.Fprintf(stderr, "keel admin %s: an account's ID is required\n", verb)
			return "", errUsage
		}
		if _, ok := store.ParseID(pos[0]); !ok {
			fmt.Fprintf(stderr, "keel admin %s: %q is not an account's ID\n", verb, pos[0])
			return "", errUsage
		}
		return pos[0], nil
	}
	onOff := func() (bool, error) {
		if len(pos) != 2 || (pos[1] != "on" && pos[1] != "off") {
			fmt.Fprintf(stderr, "keel admin %s: ID on|off\n", verb)
			return false, errUsage
		}
		return pos[1] == "on", nil
	}
	switch verb {
	case "search":
		text := strings.Join(pos, " ")
		if text == "-" {
			line, err := bufio.NewReader(stdin).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			text = strings.TrimSpace(line)
		}
		return c.search(ctx, owner.SearchRequest{Text: text, Sort: *sort, Page: *page}, stderr)
	case "show":
		a, err := id()
		if err != nil {
			return err
		}
		raw, err := c.do(ctx, http.MethodGet, "/owner/api/account.json?id="+url.QueryEscape(a), nil, stderr)
		if err != nil {
			return err
		}
		var card accounts.Card
		return c.show(raw, &card, func() { writeCard(stdout, &card, "") })
	case "stop", "start", "revoke", "delete":
		a, err := id()
		if err != nil {
			return err
		}
		req := owner.ActionRequest{Account: a, Reason: *reason, Name: *name, Check: !*yes && verb != "start"}
		raw, err := c.do(ctx, http.MethodPost, "/owner/api/accounts/"+verb, req, stderr)
		if err != nil {
			return err
		}
		var done accounts.Done
		return c.show(raw, &done, func() {
			if done.Done {
				fmt.Fprintf(stdout, "Done: %s\n", done.Words)
				return
			}
			fmt.Fprintf(stdout, "%s\nNothing is done yet: run it again with -yes.\n", done.Words)
		})
	case "flag", "priority":
		a, err := id()
		if err != nil {
			return err
		}
		on, err := onOff()
		if err != nil {
			return err
		}
		raw, err := c.do(ctx, http.MethodPost, "/owner/api/"+verb, owner.FlagRequest{Account: a, On: on}, stderr)
		if err != nil {
			return err
		}
		var out struct {
			On        bool `json:"on"`
			Connected bool `json:"connected"`
		}
		return c.show(raw, &out, func() { fmt.Fprintf(stdout, "%s %s.\n", verb, map[bool]string{true: "on", false: "off"}[out.On]) })
	case "cap":
		a, err := id()
		if err != nil {
			return err
		}
		n := -1
		if len(pos) == 2 {
			n, err = strconv.Atoi(pos[1])
		}
		if len(pos) != 2 || err != nil {
			fmt.Fprintln(stderr, "keel admin cap: ID N, the machine sailors allowed")
			return errUsage
		}
		raw, err := c.do(ctx, http.MethodPost, "/owner/api/machines", owner.MachinesRequest{Account: a, Cap: n}, stderr)
		if err != nil {
			return err
		}
		var out owner.MachinesRequest
		return c.show(raw, &out, func() { fmt.Fprintf(stdout, "%s allowed.\n", count(out.Cap, "machine sailor")) })
	case "lifetime":
		if len(pos) != 1 {
			fmt.Fprintln(stderr, "keel admin lifetime: DURATION, as 90d, 12h or 30m")
			return errUsage
		}
		d, err := parseLifetime(pos[0])
		if err != nil {
			fmt.Fprintln(stderr, "keel admin lifetime:", err)
			return errUsage
		}
		raw, err := c.do(ctx, http.MethodPost, "/owner/api/lifetime", owner.LifetimeRequest{Seconds: int64(d / time.Second), Check: !*yes}, stderr)
		if err != nil {
			return err
		}
		var out struct {
			Ends int64 `json:"ends"`
			Set  bool  `json:"set"`
		}
		return c.show(raw, &out, func() {
			if out.Set {
				fmt.Fprintf(stdout, "Done: the lifetime is %s; %d grants ended at once.\n", d, out.Ends)
				return
			}
			fmt.Fprintf(stdout, "A lifetime of %s ends %d live grants at once.\nNothing is done yet: run it again with -yes.\n", d, out.Ends)
		})
	case "actions":
		path := "/owner/api/actions.json"
		if len(pos) > 0 {
			a, err := id()
			if err != nil {
				return err
			}
			path += "?account=" + url.QueryEscape(a)
		}
		raw, err := c.do(ctx, http.MethodGet, path, nil, stderr)
		if err != nil {
			return err
		}
		var out struct {
			Actions []accounts.ActionCard `json:"actions"`
		}
		return c.show(raw, &out, func() {
			for _, a := range out.Actions {
				writeAction(stdout, &a)
			}
		})
	}
	fmt.Fprintf(stderr, "keel admin: unknown command %q\n\n%s", verb, adminUsage)
	return errUsage
}

func (c *adminClient) search(ctx context.Context, req owner.SearchRequest, stderr io.Writer) error {
	raw, err := c.do(ctx, http.MethodPost, "/owner/api/accounts/search", req, stderr)
	if err != nil {
		return err
	}
	var res accounts.Result
	return c.show(raw, &res, func() {
		w := c.stdout
		if res.Note != "" {
			fmt.Fprintln(w, res.Note)
		}
		fmt.Fprintf(w, "%d found; page %d of %d.\n", res.Total, res.Page+1, max(1, res.Pages))
		for _, r := range res.Accounts {
			fmt.Fprintf(w, "%s  %-20s  made %s  %-12s%s\n", r.ID, r.Name, date(r.Made), r.LastActive,
				marks(r.Matched, r.Tools, r.Priority, r.Stopped, r.Queued))
			for _, m := range r.Machines {
				fmt.Fprintf(w, "  %s  %-18s  made %s  %-12s%s\n", m.ID, m.Name, date(m.Made), m.LastActive,
					marks(m.Matched, false, m.Priority, m.Stopped, m.Queued))
			}
		}
	})
}

// marks are a row's flags, in words.
func marks(matched, tools, priority, stopped, queued bool) string {
	var out []string
	for _, m := range []struct {
		on   bool
		word string
	}{{matched, "found"}, {tools, "owner's flag"}, {priority, "priority"}, {stopped, "STOPPED"}, {queued, "waiting"}} {
		if m.on {
			out = append(out, m.word)
		}
	}
	if len(out) == 0 {
		return ""
	}
	return "  [" + strings.Join(out, ", ") + "]"
}

// count is a number and its noun: "1 passkey", "2 passkeys".
func count(n int, one string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + one + "s"
}

// date is a time of the answers, ms, as a date in UTC; "never" for none.
func date(ms int64) string {
	if ms == 0 {
		return "never     "
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

// stamp is a time of the answers, ms, to the minute in UTC.
func stamp(ms int64) string {
	if ms == 0 {
		return "never"
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04 UTC")
}

func writeAction(w io.Writer, a *accounts.ActionCard) {
	who := a.Name
	if a.Account != "" {
		who += " (" + a.Account + ")"
	}
	fmt.Fprintf(w, "%s  %-10s %s  %q  by the %s from %s\n", stamp(a.At), a.Action, who, a.Detail, a.Source, a.From)
}

// writeCard writes an account's card as text, a machine sailor's within
// its human's indented.
func writeCard(w io.Writer, c *accounts.Card, indent string) {
	p := func(format string, args ...any) { fmt.Fprintf(w, indent+format+"\n", args...) }
	kind := "human"
	if c.Kind == store.AI {
		kind = "machine sailor"
	}
	p("%s, %s, %s", c.Name, kind, c.ID)
	p("  made %s; last active %s", stamp(c.Made), c.LastActive)
	if c.Owner != nil {
		p("  its human: %s, %s", c.Owner.Name, c.Owner.ID)
	}
	if c.LookWords != "" {
		p("  looks: %s", c.LookWords)
	}
	if s := c.Stopped; s != nil {
		if s.ByOwner {
			p("  STOPPED with its human, %s", stamp(s.At))
		} else {
			p("  STOPPED %s: %q", stamp(s.At), s.Reason)
		}
	}
	if c.Own {
		p("  one of your own accounts")
	}
	p("  owner's flag %v, priority %v", c.Tools, c.Priority)
	switch {
	case c.Sea != nil:
		p("  at sea: boat %d at %.0f m east, %.0f m north; connected %v, grace %.0f s", c.Sea.Boat, c.Sea.East, c.Sea.North, c.Sea.Connected, c.Sea.Grace)
	case c.Queue != nil:
		p("  waiting for a boat, %d in line", c.Queue.Position)
	}
	if c.Kind == store.Human {
		p("  %s:", count(len(c.Passkeys), "passkey"))
		for _, k := range c.Passkeys {
			warn := ""
			if k.CloneWarning {
				warn = ", a clone warning"
			}
			p("    %s, made %s, last used %s, synced %v%s", k.MadeOn, stamp(k.Made), stamp(k.LastUsed), k.Synced, warn)
		}
		if c.RecoveryMade != 0 {
			p("  recovery code made %s", stamp(c.RecoveryMade))
		} else {
			p("  no recovery code")
		}
		if s := c.Sessions; s != nil {
			p("  %s, the latest seen %s", count(int(s.Count), "session"), stamp(s.Latest))
		}
		p("  fleet %v; %s allowed", c.Fleet, count(c.Cap, "machine sailor"))
	}
	for _, a := range c.Apps {
		state := "ends " + stamp(a.Ends)
		if a.Ended {
			state = "ended (" + a.EndedHow + ")"
		}
		p("  app %s, returning to %s: approved %s, last used %s, %s", a.Name, a.ReturnHost, stamp(a.Approved), stamp(a.LastUsed), state)
	}
	if t := c.Token; t != nil {
		state := "ends " + stamp(t.Ends)
		if t.Ended {
			state = "ended"
		}
		p("  connection token made %s, last used %s, %s", stamp(t.Made), stamp(t.LastUsed), state)
	}
	for i := range c.Machines {
		writeCard(w, &c.Machines[i], indent+"    ")
	}
	if len(c.Actions) > 0 {
		p("  the record:")
		for i := range c.Actions {
			fmt.Fprint(w, indent+"    ")
			writeAction(w, &c.Actions[i])
		}
	}
}
