// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"bufio"
	"net/mail"
	"slices"
	"strconv"
	"strings"
)

// User is a GitHub account: its number, which outlives a rename, its
// name, and its type, "User" or "Bot" ("" when not known).
type User struct {
	ID    int64
	Login string
	Type  string
}

// Ident is a commit's author or committer as git recorded them, and the
// GitHub account GitHub linked to its e-mail, if any.
type Ident struct {
	Name, Email string
	User        *User
}

// Commit is one commit of a pull request.
type Commit struct {
	SHA       string
	Author    Ident
	Committer Ident
	Message   string
}

// Pull is what the check reads of a pull request.
type Pull struct {
	Repo    string // owner/name
	Number  int
	HeadSHA string
	Open    bool
	// Author is the account that opened it.
	Author User
	// Owner is the repository's owner, who signs nothing.
	Owner  User
	Labels []string
	// Commits are its commits, oldest first.
	Commits []Commit
}

// CheckedLabel is the label the owner puts on a pull request to pass, after
// asking, the authors the check cannot match to a GitHub account. Only the
// repository's collaborators can label.
const CheckedLabel = "agreement-checked"

// Bots are the bots passed without signing, by their accounts' numbers:
// they keep the dependencies and run the workflows, and write nothing a
// person did not ask for. A bot is passed only if its account is of the
// type Bot too, when GitHub says.
var Bots = map[int64]string{
	29139614: "renovate[bot]",
	49699333: "dependabot[bot]",
	41898282: "github-actions[bot]",
}

// AIAddresses are the addresses AI tools write in a commit's trailers, or
// as its author: such a trailer is the disclosure the agreement asks for,
// and the person who used the tool signs for what they submit. Lower case.
var AIAddresses = map[string]string{
	"noreply@anthropic.com":  "Claude",
	"cursoragent@cursor.com": "Cursor",
	"noreply@aider.chat":     "aider",
}

// AILogins are the GitHub accounts of AI tools, which they commit as or
// name in trailers by their no-reply addresses, passed as AIAddresses are.
// Lower case.
var AILogins = map[string]string{
	"copilot":                      "GitHub Copilot",
	"copilot-swe-agent[bot]":       "GitHub Copilot",
	"claude[bot]":                  "Claude",
	"cursor[bot]":                  "Cursor",
	"google-labs-jules[bot]":       "Jules",
	"chatgpt-codex-connector[bot]": "OpenAI Codex",
}

// webFlow is the account GitHub commits as when someone edits in its web
// editor or merges there: the committer, never the author, of such commits.
var webFlow = User{ID: 19864447, Login: "web-flow"}

// Need is who a pull request waits for.
type Need struct {
	// Users must have signed the current version: everyone found who is
	// not passed, by account, each once, in the order found.
	Users []User
	// Unknown are the authors the check cannot match to an account that
	// can sign: a commit e-mail GitHub links to no account, a co-author
	// trailer naming neither a GitHub no-reply address nor an AI tool, or a
	// bot not among Bots, each once. The owner's label passes them.
	Unknown []string
	// AI are the AI tools named, each once: passed, as disclosed.
	AI []string
}

// Who works out who must have signed for a pull request: whoever opened
// it; every commit's author and committer, as GitHub links them; and every
// person named in a Co-authored-by trailer. Passed without signing: the
// repository's owner, the bots of Bots, GitHub's web-flow as a committer,
// and AI tools by their addresses and accounts. With the label CheckedLabel, the
// unknown are passed too.
func Who(p Pull) Need {
	var n Need
	seen := map[int64]bool{}
	seenUnknown := map[string]bool{}
	seenAI := map[string]bool{}
	// Every account this pull request's commits link an e-mail to, for
	// trailers naming the same e-mail.
	linked := map[string]User{}
	for _, c := range p.Commits {
		for _, id := range []Ident{c.Author, c.Committer} {
			if id.User != nil && id.Email != "" {
				linked[strings.ToLower(id.Email)] = *id.User
			}
		}
	}
	addAI := func(tool string) {
		if !seenAI[tool] {
			seenAI[tool] = true
			n.AI = append(n.AI, tool)
		}
	}
	addUnknown := func(who string) {
		if !seenUnknown[strings.ToLower(who)] {
			seenUnknown[strings.ToLower(who)] = true
			n.Unknown = append(n.Unknown, who)
		}
	}
	addUser := func(u User) {
		if u.ID == 0 || seen[u.ID] {
			return
		}
		seen[u.ID] = true
		switch {
		case u.ID == p.Owner.ID || passedBot(u):
		case AILogins[strings.ToLower(u.Login)] != "":
			addAI(AILogins[strings.ToLower(u.Login)])
		case u.Type == "Bot" || strings.HasSuffix(u.Login, "[bot]"):
			// A bot cannot sign: the owner's label passes it, as an author
			// the check cannot place.
			addUnknown(u.Login)
		default:
			n.Users = append(n.Users, u)
		}
	}
	// ident places an author, committer or co-author.
	ident := func(name, email string, u *User) {
		if u != nil {
			addUser(*u)
			return
		}
		e := strings.ToLower(strings.TrimSpace(email))
		if tool, ok := AIAddresses[e]; ok {
			addAI(tool)
			return
		}
		if u, ok := noReply(e); ok {
			addUser(u)
			return
		}
		if u, ok := linked[e]; ok {
			addUser(u)
			return
		}
		addUnknown(formatIdent(name, email))
	}

	addUser(p.Author)
	for _, c := range p.Commits {
		ident(c.Author.Name, c.Author.Email, c.Author.User)
		if !isWebFlow(c.Committer) {
			ident(c.Committer.Name, c.Committer.Email, c.Committer.User)
		}
		for _, co := range CoAuthors(c.Message) {
			ident(co.Name, co.Address, nil)
		}
	}
	if slices.Contains(p.Labels, CheckedLabel) {
		n.Unknown = nil
	}
	return n
}

// passedBot reports whether an account is one of Bots, and of the type
// Bot when GitHub said its type.
func passedBot(u User) bool {
	if _, ok := Bots[u.ID]; !ok {
		return false
	}
	return u.Type == "" || u.Type == "Bot"
}

// isWebFlow reports whether a committer is GitHub's web editor: its
// account, or its address when GitHub left it unlinked.
func isWebFlow(id Ident) bool {
	if id.User != nil {
		return id.User.ID == webFlow.ID
	}
	return strings.EqualFold(id.Email, "noreply@github.com")
}

// noReply reads a GitHub no-reply address, ID+login@users.noreply.github.com,
// as the account it names. The older form without the number names a login
// alone, which can be renamed and taken by another; it is not read.
func noReply(email string) (User, bool) {
	local, ok := strings.CutSuffix(strings.ToLower(email), "@users.noreply.github.com")
	if !ok {
		return User{}, false
	}
	num, login, ok := strings.Cut(local, "+")
	if !ok || login == "" {
		return User{}, false
	}
	id, err := strconv.ParseInt(num, 10, 64)
	if err != nil || id <= 0 {
		return User{}, false
	}
	u := User{ID: id, Login: login}
	if strings.HasSuffix(login, "[bot]") {
		u.Type = "Bot"
	}
	return u, true
}

// CoAuthors are the people a commit message's Co-authored-by trailers name,
// read wherever such a line stands, as GitHub reads them.
func CoAuthors(message string) []*mail.Address {
	var out []*mail.Address
	sc := bufio.NewScanner(strings.NewReader(message))
	for sc.Scan() {
		key, value, ok := strings.Cut(strings.TrimSpace(sc.Text()), ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "co-authored-by") {
			continue
		}
		value = strings.TrimSpace(value)
		if a, err := mail.ParseAddress(value); err == nil {
			out = append(out, a)
			continue
		}
		// A name mail cannot parse, "J. Smith <j@example.com>": the address
		// between the angle brackets, the name before them.
		if i, j := strings.LastIndex(value, "<"), strings.LastIndex(value, ">"); i >= 0 && j > i {
			out = append(out, &mail.Address{Name: strings.TrimSpace(value[:i]), Address: strings.TrimSpace(value[i+1 : j])})
		}
	}
	return out
}

func formatIdent(name, email string) string {
	name, email = strings.TrimSpace(name), strings.TrimSpace(email)
	switch {
	case name == "":
		return "<" + email + ">"
	case email == "":
		return name
	}
	return name + " <" + email + ">"
}
