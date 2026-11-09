// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"mvdan.cc/xurls/v2"
)

// contact reports whether a line has a link, a bare domain, an email
// address, a phone number, a handle, or another app's name with a cue to
// find someone there.
func (f *chatForms) contact() bool {
	if phone(f.a) || phone(f.b) {
		return true
	}
	// Handles are read where @ is not yet a letter.
	if handle(f.a) || handle(f.ja) {
		return true
	}
	// The forms share most of their words: each stretch is read once.
	seen := &readOnce{chunks: map[string]bool{}, windows: map[string]bool{}}
	for _, s := range f.links {
		if link(s, seen) {
			return true
		}
	}
	for _, s := range f.all {
		if app(s, seen) {
			return true
		}
	}
	return false
}

// readOnce holds what a line's forms have had read already: the stretches
// between spaces xurls read, and the words around apps' names.
type readOnce struct{ chunks, windows map[string]bool }

// The ends of domains, from lists/tlds.txt.
type tldClass byte

const (
	tldPlain tldClass = iota + 1
	tldAlways
	tldWord
)

var tlds = sync.OnceValue(func() map[string]tldClass {
	m := map[string]tldClass{}
	classes := map[string]tldClass{"plain": tldPlain, "always": tldAlways, "word": tldWord}
	for _, line := range readList("tlds.txt") {
		name, class, _ := strings.Cut(line, " ")
		if classes[class] == 0 {
			panic("moderation: tlds.txt: " + line)
		}
		m[name] = classes[class]
	}
	return m
})

// tldsOf is an alternation of the ends of the classes given.
func tldsOf(classes ...tldClass) string {
	var names []string
	for name, c := range tlds() {
		if slices.Contains(classes, c) {
			names = append(names, regexp.QuoteMeta(name))
		}
	}
	slices.Sort(names)
	return "(?:" + strings.Join(names, "|") + ")"
}

// knownHosts are hosts that are a way to someone with no path, though
// their ends would pass: Telegram's, WhatsApp's and Messenger's.
var knownHosts = map[string]bool{"t.me": true, "wa.me": true, "m.me": true, "ig.me": true, "fb.me": true, "kik.me": true, "telegram.me": true}

type linkRules struct {
	// spaced is a domain written with spaces around its full stop, a space
	// after it before an always end ("example. com"), or a comma for it,
	// which xurls does not find.
	spaced *regexp.Regexp
	// www is the start of a web address, however its domain ends.
	www *regexp.Regexp
	// bracketed is a full stop or an at sign written in brackets, as
	// "(dot)" or "[at]".
	bracketedDot, bracketedAt *regexp.Regexp
	// spelled is a full stop spelled "dot", and slash a slash spelled;
	// dotEnd is a "dot" run into an end ("exampledotcom"). point is a full
	// stop spelled as a word of chat too ("point", "period"), read only
	// before an end of the always class.
	spelled, slash, dotEnd, point *regexp.Regexp
	// plain is a domain of a plain end, with or without spaces, and always
	// one of an always end.
	plain, always *regexp.Regexp
	// path is a domain with a path, its full stop or slash spaced
	// ("t . me / name"), whatever its end.
	path *regexp.Regexp
	// spacedDots are a full stop and the spaces around it, and hosts the
	// known hosts as words, found once the spaces are gone ("t . me").
	spacedDots, hosts *regexp.Regexp
	// email is an address's at sign.
	email *regexp.Regexp
}

var rules = sync.OnceValue(func() linkRules {
	plain, always := tldsOf(tldPlain, tldAlways), tldsOf(tldAlways)
	// An end ends a word, and not before an apostrophe ("Com'on").
	const ending = `(?:[^\pL\pN'’]|$)`
	var hosts []string
	for h := range knownHosts {
		hosts = append(hosts, regexp.QuoteMeta(h))
	}
	slices.Sort(hosts)
	return linkRules{
		spaced: regexp.MustCompile(`[\pL\pN] \. ?` + plain + ending + `|[\pL\pN]\. ` + always + ending + `|[\pL\pN] ?, ?` + always + ending),
		www:    regexp.MustCompile(`(?:^|[^\pL\pN])www ?(?:\.|dot\b)`),

		bracketedDot: regexp.MustCompile(` ?[(\[{<] ?(?:dot|\.) ?[)\]}>] ?`),
		bracketedAt:  regexp.MustCompile(` ?[(\[{<] ?(?:at|@) ?[)\]}>] ?`),
		spelled:      regexp.MustCompile(` ?\b(?:dot|dawt|dott)\b ?`),
		slash:        regexp.MustCompile(` ?\bslash\b ?`),
		dotEnd:       regexp.MustCompile(` ?dot(` + always + `)\b`),
		point:        regexp.MustCompile(` ?\b(?:point|period|punto|punkt)\b ?`),
		plain:        regexp.MustCompile(`[\pL\pN] ?\. ?` + plain + ending),
		always:       regexp.MustCompile(`[\pL\pN]\.` + always + ending),
		path:         regexp.MustCompile(`[\pL\pN](?: \. ?|\.)\pL{2,} ?/ ?[\pL\pN]`),
		spacedDots:   regexp.MustCompile(` ?\. ?`),
		hosts:        regexp.MustCompile(`(?:^|[^\pL\pN.])(?:` + strings.Join(hosts, "|") + `)(?:[^\pL\pN]|$)`),
		email:        regexp.MustCompile(`[\pL\pN]@[\pL\pN]`),
	}
})

// link reports whether s, a folded form, has a link, a domain or an email
// address.
func link(s string, seen *readOnce) bool {
	r := rules()
	if glued(s, seen) || strings.Contains(s, "www") && r.www.MatchString(s) {
		return true
	}
	if strings.ContainsAny(s, ".,") && r.spaced.MatchString(s) {
		return true
	}
	if strings.Contains(s, ".") && r.path.MatchString(s) {
		return true
	}
	if (strings.Contains(s, " .") || strings.Contains(s, ". ")) && r.hosts.MatchString(r.spacedDots.ReplaceAllString(s, ".")) {
		return true
	}
	// Brackets around a full stop or an at sign are only ever there to
	// hide them.
	if strings.ContainsAny(s, "([{<") {
		t := r.bracketedAt.ReplaceAllString(r.bracketedDot.ReplaceAllString(s, "."), "@")
		if t != s && (glued(t, seen) || r.email.MatchString(t) || r.plain.MatchString(t)) {
			return true
		}
	}
	// "dot" spelled out reads as a full stop before a plain end, or with a
	// path: "example dot com" and "t dot me slash name" are refused, "a dot
	// to starboard" is not.
	if strings.Contains(s, "dot") || strings.Contains(s, "dawt") {
		t := r.slash.ReplaceAllString(r.dotEnd.ReplaceAllString(r.spelled.ReplaceAllString(s, "."), ".$1"), "/")
		if t != s && (r.plain.MatchString(t) || r.path.MatchString(t) || r.hosts.MatchString(t)) {
			return true
		}
	}
	if strings.Contains(s, "point") || strings.Contains(s, "period") || strings.Contains(s, "punt") || strings.Contains(s, "punkt") {
		if t := r.point.ReplaceAllString(s, "."); t != s && r.always.MatchString(t) {
			return true
		}
	}
	return false
}

// glued reports whether s has a URL or domain written whole that xurls'
// relaxed matcher finds, and that is refused: one with a scheme, a path, a
// port, an at sign or "www.", an IP address, a host of three parts or more,
// or a domain whose end is not a word of chat.
//
// A URL has no space, and a full stop, a colon or an at sign with a letter
// or digit after it; the matcher, slow on a whole line, reads only the
// stretches between spaces that have one.
func glued(s string, seen *readOnce) bool {
	for chunk := range strings.SplitSeq(s, " ") {
		if seen.chunks[chunk] || !mayLink(chunk) {
			continue
		}
		seen.chunks[chunk] = true
		for _, m := range xurls.Relaxed().FindAllString(chunk, -1) {
			if strings.ContainsAny(m, "@/:") || strings.HasPrefix(m, "www.") {
				return true
			}
			labels := strings.Split(strings.TrimSuffix(m, "."), ".")
			if len(labels) != 2 || knownHosts[m] || tlds()[labels[1]] != tldWord {
				return true
			}
		}
	}
	return false
}

// mayLink reports whether a stretch with no space may hold a URL.
func mayLink(chunk string) bool {
	for i := 0; i < len(chunk); i++ {
		if c := chunk[i]; c == '.' || c == ':' || c == '@' {
			next, _ := utf8.DecodeRuneInString(chunk[i+1:])
			if alnum(next) || c == ':' && next == '/' {
				return true
			}
		}
	}
	return false
}

var handles = regexp.MustCompile(
	// @name, #name: an at sign or a hash on a letter ("@5" and "#1" pass).
	`[@#][\pL_]` +
		// u/name, r/name.
		`|(?:^|[^\pL\pN])[ur]/[\pL\pN_-]{2,}` +
		// name#1234, a Discord tag.
		`|[\pL\pN_.]{2,}#[0-9]{4}\b`)

// handle reports whether s, a folded form, has a handle.
func handle(s string) bool { return strings.ContainsAny(s, "@#/") && handles.MatchString(s) }

// phone reports whether s, a folded form, has seven digits or more in a
// run, however they are spaced, punctuated or spelled: "555 123 4567",
// "5-5-5-1-2-3-4", "five five five one two three four", "fivefivefive",
// with "oh" or "o" for zero. A word that is no digit's ends a run, as do a
// time ("12:30") and a date ("2026-11-09").
func phone(s string) bool {
	if !digitRun(s) {
		return false
	}
	// Times and dates are looked for only in a line with a run.
	return digitRun(timesAndDates.ReplaceAllString(s, " time "))
}

// digitRun reports whether s has seven digits in a run, times and dates
// counted as digits.
func digitRun(s string) bool {
	count := 0
	for _, word := range strings.FieldsFunc(s, func(r rune) bool { return !alnum(r) }) {
		parts := digitParts(word)
		for i, p := range parts {
			switch n := digitsIn(p, i > 0 && isDigits(parts[i-1]) || i+1 < len(parts) && isDigits(parts[i+1])); {
			case n > 0:
				count += n
			case n < 0:
				count = 0
			}
			if count >= 7 {
				return true
			}
		}
	}
	return false
}

var timesAndDates = regexp.MustCompile(
	`\b(?:[01]?[0-9]|2[0-3])[:h][0-5][0-9]\b` +
		`|\b[0-9]{4}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12][0-9]|3[01])\b` +
		`|\b(?:0?[1-9]|[12][0-9]|3[01])/(?:0?[1-9]|[12][0-9]|3[01])/(?:[0-9]{4}|[0-9]{2})\b` +
		`|\b(?:0?[1-9]|[12][0-9]|3[01])[.-](?:0?[1-9]|1[0-2])[.-][0-9]{4}\b`)

// digitParts splits a word into its runs of digits and of letters.
func digitParts(word string) []string {
	var parts []string
	start := 0
	for i, r := range word {
		if i > 0 {
			prev, _ := utf8.DecodeLastRuneInString(word[:i])
			if unicode.IsDigit(prev) != unicode.IsDigit(r) {
				parts = append(parts, word[start:i])
				start = i
			}
		}
	}
	return append(parts, word[start:])
}

func isDigits(s string) bool {
	return s != "" && strings.IndexFunc(s, func(r rune) bool { return !unicode.IsDigit(r) }) < 0
}

// digitWords are digits spelled, and the words that count them twice and
// three times.
var digitWords = map[string]int{
	"zero": 1, "oh": 1, "nought": 1, "one": 1, "two": 1, "three": 1, "four": 1, "five": 1,
	"six": 1, "seven": 1, "eight": 1, "nine": 1, "double": 1, "triple": 2,
}

// digitFillers are words that may stand between a number's digits.
var digitFillers = map[string]bool{"dash": true, "hyphen": true, "dot": true, "point": true, "space": true, "comma": true, "plus": true, "minus": true, "slash": true}

// digitsIn counts the digits a part of a word stands for, 0 for a word
// between digits, or -1 for a word that ends a run. A part of o, l and i
// beside digits is digits written as letters ("5o5", "l234").
func digitsIn(part string, besideDigits bool) int {
	switch {
	case isDigits(part):
		return utf8.RuneCountInString(part)
	case part == "o" || part == "l":
		return 1
	case digitFillers[part]:
		return 0
	case besideDigits && strings.Trim(part, "oli") == "":
		return len(part)
	}
	// Digits spelled and run together: "fivefivefive", "fiveohfive". No
	// digit's word is the start of another, so the first that fits is the
	// one.
	n := 0
	for part != "" {
		found := false
		for w, count := range digitWords {
			if strings.HasPrefix(part, w) {
				part, n, found = part[len(w):], n+count, true
				break
			}
		}
		if !found {
			return -1
		}
	}
	return n
}

// The apps' names, from lists/apps.txt, and how much it takes to refuse
// each.
type appTier byte

const (
	appAny appTier = iota + 1
	appNamed
	appOn
	appMail
)

// appMarks stand for an app's name among the words app's rules read.
var appMarks = map[appTier]string{appAny: "\x01", appNamed: "\x02", appOn: "\x03", appMail: "\x04"}

type appList struct {
	names   map[string]appTier
	longest int // the longest name, in bytes
	// cues are the rules, over a line's words with each app's name
	// replaced by its mark.
	cues *regexp.Regexp
	// cueWords are the words the rules name: a name with none of them
	// near it, nor a word with a digit after it, has no cue.
	cueWords map[string]bool
	// joined finds the plainest cues and names with nothing between
	// them, in a line's letters run together ("addmeonsnapchat").
	joined *regexp.Regexp
	// anyNames are the names the joined rules look for.
	anyNames []string
}

var apps = sync.OnceValue(func() appList {
	l := appList{names: map[string]appTier{}}
	tiers := map[string]appTier{"any": appAny, "named": appNamed, "on": appOn, "mail": appMail}
	var anyNames []string
	for _, line := range readList("apps.txt") {
		name, tier, _ := strings.Cut(line, " ")
		if tiers[tier] == 0 {
			panic("moderation: apps.txt: " + line)
		}
		l.names[name] = tiers[tier]
		l.longest = max(l.longest, len(name))
		if tiers[tier] == appAny && len(name) > 3 {
			anyNames = append(anyNames, name)
		}
	}
	// The rules read a line's words, an app's name replaced by its mark.
	const (
		any   = `[\x01\x04]`     // a name that is no word, or a mail service's
		named = `[\x01\x02\x04]` // and the short forms
		on    = `[\x01-\x04]`    // and the words
		// Verbs of getting in touch, and of finding someone somewhere.
		messages = `add|addme|dm|dms|pm|msg|message|messages|text|txt|contact|friend|hmu|inbox|ping`
		message  = `(?:` + messages + `)`
		find     = `(?:` + messages + `|call|ring|find|follow|reach|catch|meet|see|talk|chat|speak|join|sub|subscribe|hit (?:me|us) up|holla|hop|jump|go|come)`
		object   = `(?: (?:me|us|u|you|ya|him|her|them))?(?: up)?`
		where    = `(?: (?:on|at|in|via|over|thru|through|with|to))`
		owners   = `my|our|ur|your|yur|yer|his|her|their`
		whose    = `(?:` + owners + `)`
		// What may follow a name given as a contact, and a name someone
		// has.
		afters = `me|pls|plz|please|:|=|name|names|id|handle|username|user|usr|tag|code|acc|account|addy|server|link|friend|friends|add|dm|dms|gc|group|gg|invite`
		after  = `(?:` + afters + `)`
		is     = `(?:` + afters + `|is|isnt|number|num|channel|page|profile|\?)`
		end    = `(?: |$)`
	)
	cues := `(?:^| )(?:` +
		// add me on snap, join the discord, see you on insta
		find + object + where + `?(?: (?:the|a|` + owners + `))? ` + any +
		// add me on steam, dm me steam
		`|` + find + object + ` (?:on|via|over|thru|through|to)(?: ` + whose + `)? ` + named +
		`|` + message + ` (?:me|us) ` + named +
		// add me on line, message me via signal
		`|` + message + `(?: (?:me|us))? (?:on|via) ` + on +
		// are you on steam, i'm on ig
		`|(?:im|i am|are you|r u|ru|r you|are u|u|you|ya|were|we are|is he|is she|hes|shes|theyre|be|get|got) on (?:my |the )?` + named +
		// on snap; got insta?, have discord: the name last, or a cue after it
		`|on(?: (?:the|a|` + owners + `))? ` + any +
		`|(?:got|have|has|use|using|get|download|downloaded|install|installed)(?: (?:the|a|` + owners + `))? ` + any + `(?: ` + is + `(?: |$)|$)` +
		// my snap is, your discord?, whats your insta
		`|(?:` + owners + `|whats (?:your|ur)|what is (?:your|ur)|wats ur|wat is ur) ` + named + `(?: ` + is + end + `|$)` +
		// my line id
		`|` + whose + ` ` + on + ` (?:id|name|username|handle|tag|account|acc)` + end +
		// email me at gmail, name @ gmail
		`|(?:at|@) \x04` +
		`)` +
		// snap me, steam id, discord: name
		`|` + named + ` ` + after + end +
		// snap coolkid99
		`|` + any + ` \pL+\pN[\pL\pN]*` + end +
		// discord?, alone
		`|^` + any + ` \?$` +
		// roblox? add me
		`|` + any + `(?: [^ ]+){0,2} (?:add|dm|pm|msg|message|text|txt|friend|follow|hmu) (?:me|us)` + end
	l.cues = regexp.MustCompile(cues)
	l.cueWords = map[string]bool{":": true, "=": true, "?": true, "@": true}
	// The words between the rules' brackets and bars, not their escapes,
	// but those no rule needs: each needs a verb, "on", "at", an owner or
	// a word after the name as well.
	for _, m := range regexp.MustCompile(`(?:^|[ (|:])([a-z]+)`).FindAllStringSubmatch(cues, -1) {
		l.cueWords[m[1]] = true
	}
	for _, w := range []string{"the", "a", "up", "i", "u", "you", "ya", "him", "them", "is", "are", "am", "be", "he", "she", "we"} {
		delete(l.cueWords, w)
	}
	slices.Sort(anyNames)
	l.anyNames = anyNames
	names := strings.Join(anyNames, "|")
	l.joined = regexp.MustCompile(`(?:add|dm|pm|msg|message|text|follow|hmu|hitmeup|find|friend|contact)(?:me|us)(?:on|at|via)?(?:my|the)?(?:` +
		names + `)|(?:my|ur|your)(?:` + names + `)(?:is|name|id|handle|username)`)
	return l
})

// app reports whether s, a folded form, has another app's name with a cue
// to find someone there.
func app(s string, seen *readOnce) bool {
	l := apps()
	words := appWords(s)
	var marks []int // where the names are in words
	for i := 0; i < len(words); i++ {
		if tier, n := l.nameAt(words[i:]); tier != 0 {
			words = slices.Replace(words, i, i+n, appMarks[tier])
			marks = append(marks, i)
		}
	}
	// The rules read the words around each name: a cue is at most eight
	// words before it ("hit me up on my") and four after ("? add me").
	for _, i := range marks {
		around := words[max(0, i-8):min(len(words), i+5)]
		tagged := (words[i] == appMarks[appAny] || words[i] == appMarks[appMail]) && i+1 < len(words) && strings.ContainsFunc(words[i+1], unicode.IsDigit)
		if !tagged && !slices.ContainsFunc(around, func(w string) bool { return l.cueWords[w] }) {
			continue
		}
		window := strings.Join(around, " ")
		if seen.windows[window] {
			continue
		}
		seen.windows[window] = true
		if l.cues.MatchString(window) {
			return true
		}
	}
	letters := strings.Map(func(r rune) rune {
		if r < utf8.RuneSelf && unicode.IsLetter(r) {
			return r
		}
		return -1
	}, s)
	if seen.windows[letters] {
		return false
	}
	seen.windows[letters] = true
	for _, name := range l.anyNames {
		if strings.Contains(letters, name) {
			return l.joined.MatchString(letters)
		}
	}
	return false
}

// nameAt is the app named by the longest run of up to three words at the
// start of words ("snap chat" is snapchat), and how many words it takes.
func (l appList) nameAt(words []string) (appTier, int) {
	for n := min(3, len(words)); n > 1; n-- {
		size := 0
		for _, w := range words[:n] {
			size += len(w)
		}
		if size > l.longest {
			continue
		}
		if tier := l.names[strings.Join(words[:n], "")]; tier != 0 {
			return tier, n
		}
	}
	if len(words) > 0 && l.names[words[0]] != 0 {
		return l.names[words[0]], 1
	}
	return 0, 0
}

// appWords are the words of s for app's rules, an apostrophe inside a word
// dropped ("i'm" is im), and the marks of punctuation they read: a colon
// (but a smiley's), an equals sign, a question mark and an at sign.
func appWords(s string) []string {
	var words []string
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			words = append(words, word.String())
			word.Reset()
		}
	}
	for i, r := range s {
		switch {
		case alnum(r):
			word.WriteRune(r)
		case (r == '\'' || r == '’') && word.Len() > 0:
		case r == ':':
			flush()
			if next, _ := utf8.DecodeRuneInString(s[i+1:]); !strings.ContainsRune(")(dp3/\\|*o", next) {
				words = append(words, ":")
			}
		case r == '=' || r == '?' || r == '@':
			flush()
			words = append(words, string(r))
		default:
			flush()
		}
	}
	flush()
	return words
}
