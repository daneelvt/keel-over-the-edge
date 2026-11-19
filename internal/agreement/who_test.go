// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"reflect"
	"testing"
)

var (
	theOwner = User{ID: 1, Login: "skipper", Type: "User"}
	ann      = User{ID: 7, Login: "ann", Type: "User"}
	bob      = User{ID: 8, Login: "bob", Type: "User"}
	renov    = User{ID: 29139614, Login: "renovate[bot]", Type: "Bot"}
	dependa  = User{ID: 49699333, Login: "dependabot[bot]", Type: "Bot"}
	webflow  = User{ID: 19864447, Login: "web-flow", Type: "User"}
)

func by(u User, email string) Ident { return Ident{Name: u.Login, Email: email, User: &u} }

func commit(author, committer Ident, message string) Commit {
	return Commit{SHA: "c", Author: author, Committer: committer, Message: message}
}

func TestWho(t *testing.T) {
	annMail := "ann@example.com"
	for name, c := range map[string]struct {
		pull Pull
		want Need
	}{
		"the owner's own": {
			pull: Pull{Author: theOwner, Commits: []Commit{commit(by(theOwner, "o@example.com"), by(theOwner, "o@example.com"),
				"A change\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")}},
			want: Need{AI: []string{"Claude"}},
		},
		"an outsider": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}},
		},
		"committed in GitHub's web editor": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(webflow, "noreply@github.com"), "Fix")}},
			want: Need{Users: []User{ann}},
		},
		"web-flow unlinked": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), Ident{Name: "GitHub", Email: "noreply@github.com"}, "Fix")}},
			want: Need{Users: []User{ann}},
		},
		"another's commit, committed by the opener": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(bob, "b@example.com"), by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann, bob}},
		},
		"renovate": {
			pull: Pull{Author: renov, Commits: []Commit{commit(by(renov, "29139614+renovate[bot]@users.noreply.github.com"), by(webflow, ""), "Update")}},
		},
		"dependabot": {
			pull: Pull{Author: dependa, Commits: []Commit{commit(by(dependa, "x"), by(dependa, "x"), "Bump")}},
		},
		"a bot's number on a person's account": {
			pull: Pull{Author: User{ID: 29139614, Login: "renovate-fake", Type: "User"}},
			want: Need{Users: []User{{ID: 29139614, Login: "renovate-fake", Type: "User"}}},
		},
		"another bot": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(User{ID: 99, Login: "helper[bot]", Type: "Bot"}, "h"), by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}, Unknown: []string{"helper[bot]"}},
		},
		"a person's trailer by their no-reply address": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail),
				"Fix\n\nCo-authored-by: Bob <8+bob@users.noreply.github.com>")}},
			want: Need{Users: []User{ann, {ID: 8, Login: "bob"}}},
		},
		"a person's trailer by an e-mail linked in the pull request": {
			pull: Pull{Author: ann, Commits: []Commit{
				commit(by(bob, "bob@example.com"), by(bob, "bob@example.com"), "First"),
				commit(by(ann, annMail), by(ann, annMail), "Second\n\nCo-authored-by: Bob B. <BOB@example.com>"),
			}},
			want: Need{Users: []User{ann, bob}},
		},
		"a person's trailer by an e-mail nobody links": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail),
				"Fix\n\nCo-authored-by: Carol <carol@example.com>\nco-authored-by: Carol <Carol@example.com>")}},
			want: Need{Users: []User{ann}, Unknown: []string{"Carol <carol@example.com>"}},
		},
		"the label passes the unknown, not a person": {
			pull: Pull{Author: ann, Labels: []string{"bug", CheckedLabel}, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail),
				"Fix\n\nCo-authored-by: Carol <carol@example.com>")}},
			want: Need{Users: []User{ann}},
		},
		"an unlinked commit e-mail": {
			pull: Pull{Author: ann, Commits: []Commit{commit(Ident{Name: "ann", Email: "ann@laptop.local"}, by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}, Unknown: []string{"ann <ann@laptop.local>"}},
		},
		"an unlinked no-reply address": {
			pull: Pull{Author: ann, Commits: []Commit{commit(Ident{Name: "ann", Email: "7+ann@users.noreply.github.com"}, by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}},
		},
		"the old no-reply address names a login alone": {
			pull: Pull{Author: ann, Commits: []Commit{commit(Ident{Name: "ann", Email: "ann@users.noreply.github.com"}, by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}, Unknown: []string{"ann <ann@users.noreply.github.com>"}},
		},
		"an AI as the author": {
			pull: Pull{Author: ann, Commits: []Commit{commit(Ident{Name: "Claude", Email: "noreply@anthropic.com"}, by(ann, annMail), "Fix")}},
			want: Need{Users: []User{ann}, AI: []string{"Claude"}},
		},
		"an AI's account": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail),
				"Fix\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>")}},
			want: Need{Users: []User{ann}, AI: []string{"GitHub Copilot"}},
		},
		"the owner as a co-author": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail),
				"Fix\n\nCo-authored-by: Skipper <1+skipper@users.noreply.github.com>")}},
			want: Need{Users: []User{ann}},
		},
		"a trailer that is no address": {
			pull: Pull{Author: ann, Commits: []Commit{commit(by(ann, annMail), by(ann, annMail), "Fix\n\nCo-authored-by: the team")}},
			want: Need{Users: []User{ann}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			c.pull.Owner = theOwner
			if got := Who(c.pull); !reflect.DeepEqual(got, c.want) {
				t.Errorf("Who = %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestCoAuthors(t *testing.T) {
	got := CoAuthors("Subject\n\nbody line\n\nCo-authored-by: Ann Smith <ann@example.com>\nCO-AUTHORED-BY: J. Bloggs <j@example.com>\nSigned-off-by: X <x@example.com>\n")
	if len(got) != 2 || got[0].Address != "ann@example.com" || got[0].Name != "Ann Smith" || got[1].Address != "j@example.com" || got[1].Name != "J. Bloggs" {
		t.Errorf("CoAuthors = %v", got)
	}
}
