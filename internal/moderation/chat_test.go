// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"slices"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/nyaruka/phonenumbers"
	"mvdan.cc/xurls/v2"
)

func TestCleanChat(t *testing.T) {
	for in, want := range map[string]string{
		"  Ready   about  ":         "Ready about",
		"Ready\nabout\tnow":         "Ready about now",
		"Ready\r\n\r\nabout":        "Ready about",
		"Ｈｅａｖｅ ｔｏ":                  "Heave to",
		"sh\u200bit":                "shit", // a zero-width space
		"sh\u200dit":                "shit", // a zero-width joiner between letters
		"s\u00adhit":                "shit", // a soft hyphen
		"\ufeffhello":               "hello",
		"abc\u202edef":              "abcdef", // a right-to-left override
		"\u2066abc\u2069 \u200fdef": "abc def",
		"a\u061cb\u200eb":           "abb",
		"\u3164\u3164":              "", // Hangul fillers
		"\u2800\u2800hi":            "hi",
		"e\u0301":                   "é",
		"e\u0301\u0302\u0303\u0304\u0305\u0306\u0307": "é\u0302\u0303\u0304\u0305", // marks kept to four
		"\u0301abc":                          "abc",
		"a \u0301b":                          "a b",
		"👩\u200d🚀 aboard":                    "👩\u200d🚀 aboard", // a joiner inside an emoji stays
		"❤\ufe0f":                            "❤\ufe0f",
		"1\ufe0f\u20e3":                      "1\ufe0f\u20e3",
		"a\ufe0fb":                           "ab",
		"\x00\x01ok\x7f":                     "ok",
		"ok\xff\xfe":                         "ok",
		"\ue000secret":                       "secret", // private use
		"line\u2028two\u2029three\u0085four": "line two three four",
	} {
		clean, _ := CheckChat(in)
		if clean != want {
			t.Errorf("CheckChat(%q) cleans to %q, want %q", in, clean, want)
		}
	}
}

func TestCheckChatLengths(t *testing.T) {
	for in, want := range map[string]ChatReason{
		"":                                  ChatEmpty,
		"   \n\t ":                          ChatEmpty,
		"\u200b\u200d\u2066":                ChatEmpty,
		strings.Repeat("a", MaxChat):        "",
		strings.Repeat("a", MaxChat+1):      ChatLong,
		strings.Repeat("é", MaxChat):        "",
		strings.Repeat("ab ", 70):           ChatLong,
		strings.Repeat("a\u200b", MaxChat):  "", // invisible characters are not counted
		strings.Repeat("a", maxChatBytes+1): ChatLong,
	} {
		clean, got := CheckChat(in)
		if got != want {
			t.Errorf("CheckChat(%.20q…) = %q, want %q", in, got, want)
		}
		if want == ChatLong && len(in) <= maxChatBytes && clean == "" {
			t.Errorf("CheckChat(%.20q…) refused as long returns no clean text", in)
		}
	}
}

// contacts are lines that must be refused as contact.
var contacts = []string{
	// Links and domains.
	"go to example.com",
	"https://example.org/x",
	"http://localhost:8080",
	"example.com/bob",
	"www.example.boats",
	"EXAMPLE.COM",
	"example.co.uk",
	"see discord.gg/abc",
	"t.me/sailor",
	"t.me",
	"wa.me/15551234567",
	"bit.ly/abc",
	"linktr.ee/bob",
	"mysite.ninja",
	"192.168.1.10",
	"[2001:db8::1]",
	"mailto:bob",
	"tel:5551234",
	"пример.рф",
	"xn--e1afmkfd.xn--p1ai",
	"example . com",
	"example .com",
	"example. com",
	"example ,com",
	"example,com",
	"example dot com",
	"example DOT com",
	"example (dot) com",
	"example[dot]com",
	"example {dot} net",
	"example(.)com",
	"example d0t c0m",
	"exampledotcom",
	"example dotcom",
	"e x a m p l e . c o m",
	"e x a m p l e dot c o m",
	"x . c o m",
	"w w w . e x a m p l e",
	"www dot example dot net",
	"ехаmple.соm", // Cyrillic е, х, а, с, о
	"ｅｘａｍｐｌｅ．ｃｏｍ", // fullwidth
	"example。com", // an ideographic full stop
	"example·com",
	"example․com",
	"exa\u200bmple.c\u200dom",
	"example.c\u202eom",
	"ex4mple.c0m",
	"g00gle.com",
	"examplecom.c o m",
	// Email addresses.
	"bob@example.com",
	"bob@example",
	"bob @ example . com",
	"bob(at)example(dot)com",
	"bob [at] example [dot] com",
	"bob at gmail dot com",
	"bob at example dot co dot uk",
	"bob at gmail",
	"email me at hotmail",
	"my gmail is coolkid",
	"ｂｏｂ＠ｅｘａｍｐｌｅ．ｃｏｍ",
	// Phone numbers.
	"555 123 4567",
	"5551234",
	"555-1234",
	"+1 (555) 123-4567",
	"+64 21 123 4567",
	"5-5-5-1-2-3-4",
	"5.5.5.1.2.3.4",
	"5 5 5 1 2 3 4",
	"five five five one two three four",
	"FIVE FIVE FIVE ONE TWO THREE FOUR",
	"fivefivefive onetwothreefour",
	"five-five-five-one-two-three-four",
	"5five5 one 2three4",
	"five oh five one two three four",
	"5o5 l234",
	"555 dash 123 dash 4567",
	"nine one one five five five one",
	"five double five one two three four",
	"f1ve f1ve f1ve 0ne tw0 three f0ur",
	"call 5551234x",
	"٥٥٥١٢٣٤", // Arabic-Indic digits
	"５５５１２３４",
	"5\u200b5\u200b5\u200b1\u200b2\u200b3\u200b4",
	"my number is 555 12 34 567",
	// Handles.
	"@coolkid",
	"find me @coolkid",
	"#coolkid",
	"u/coolkid",
	"r/sailing",
	"coolkid#1234",
	"＠coolkid",
	// Another app with a contact.
	"add me on snap",
	"add me on snapchat",
	"Add me on SnapChat!",
	"add me on snap chat",
	"add me snap",
	"addmeonsnap",
	"a d d m e o n s n a p",
	"add me on sn4p",
	"add me on 5nap",
	"add me on ѕnар", // Cyrillic ѕ, а, р
	"add me on s.n.a.p",
	"add me on snaaaap",
	"add me on s\u200bnap",
	"my snap is coolkid",
	"my snap: coolkid",
	"what's your snap?",
	"whats ur insta",
	"ur insta?",
	"dm me on insta",
	"DM me on IG",
	"i'm on ig",
	"follow me on twitch",
	"follow me on tik tok",
	"hit me up on discord",
	"join my discord",
	"join the discord",
	"my discord is coolkid",
	"discord: coolkid",
	"discord me",
	"got discord?",
	"do you have discord",
	"are you on whatsapp",
	"text me on whats app",
	"message me on telegram",
	"find me on roblox",
	"on snap",
	"snap me",
	"snap coolkid99",
	"add me on steam",
	"my steam id is coolkid",
	"steam id coolkid",
	"add me on line",
	"message me on signal",
	"add me on x",
	"my line id is coolkid",
	"kik me",
	"add me on fb",
	"subscribe to my youtube channel",
	"my email is coolkid",
	"email me",
	"add me on 𝓈𝓃𝒶𝓅", // mathematical script letters
	"add me on ⓢⓝⓐⓟ",
	"add me on 🅂🄽🄰🄿",
	"add me on 🇸 🇳 🇦 🇵", // regional indicators
	"add me on s\u0336n\u0336a\u0336p\u0336",
	"add_me_on_snap",
	"a-d-d m-e o-n s-n-a-p",
	"discord?",
	"wanna play roblox? add me",
	"do u have discord",
	"coolkid99 on snap",
	"discord gg abc",
	"example dawt com",
	"example period com",
	"exampleㆍcom",
	"t . me / coolkid",
	"t dot me slash coolkid",
	"discord . gg / abc",
	"https : // example . com",
	"h t t p s : / / e x a m p l e . c o m",
	"c o o l k i d @ g m a i l . c o m",
	"coolkid AT gmail DOT com",
	"555.123.4567",
	"(555) 123-4567",
	"my number is five five five, one two three, four five six seven",
	"5\ufe0f\u20e35\ufe0f\u20e35\ufe0f\u20e31\ufe0f\u20e32\ufe0f\u20e33\ufe0f\u20e34\ufe0f\u20e3", // keycaps
	"⑤⑤⑤①②③④",
	"𝟓𝟓𝟓𝟏𝟐𝟑𝟒",
	"5 5 5 l 2 3 4",
}

// innocents are lines that must pass: sailors' talk, and the sea's words
// near a contact's or a listed word.
var innocents = []string{
	"St. Ives",
	"Port Royal",
	"e.g. the jib",
	"i.e. the main",
	"No.5",
	"3.5 knots",
	"10.30",
	"ok.so",
	"oh.no",
	"Mr. Smith",
	"a.m.",
	"9 a.m. at the dock",
	"fog signal",
	"the line squall",
	"the steam",
	"full steam ahead",
	"add more sail",
	"call the tack",
	"follow me round the point",
	"heading 270",
	"wind 15 knots gusting 22",
	"12:30",
	"2026",
	"we're 3.2 NM off",
	"lat 41.5 lon -70.2",
	"#1",
	"we're #1",
	"meet @ 5",
	"see you @5pm",
	"see you on the line",
	"see you on the start line",
	"my line is fouled",
	"snap shackle",
	"my snap shackle is stuck",
	"the halyard snapped",
	"ig we should tack",
	"the point. Me too",
	"a dot to starboard",
	"a dot on the chart",
	"Who re-rigged the jib?",
	"the pen is in the chart table",
	"heading 270, wind 15, gusting 22",
	"race at 12:30, start at 13:00",
	"on 2026-11-09 at 14:30",
	"the 3rd mark, then the 4th",
	"I play minecraft",
	"do you play roblox",
	"steam ahead",
	"the signal flags",
	"call me Ishmael",
	"text me later", // no app: nothing to find someone by
	"hard on the wind",
	"Ahoy! Is anyone aboard?",
	"we passed Bell End",
	"Is that a booby?",
	"close the seacocks",
	"the sextant",
	"The keel is fine, staff and everyone aboard",
	"oh, 270 then",
	"I'm at the dock",
	"meet at the bar",
	"the net is wet",
	"Ready. Uk sailors first",
	"10, 9, 8 go",
	"we're on 12, they're on 14",
	"👩\u200d🚀 aboard",
	"Arsenal won",
	"to the Sussex coast",
	"Scunthorpe",
	"the main sheet",
	"lee ho",
	"pass the line",
	"x marks the spot",
	"line up on the start",
	"thanks.Now tack",
	"ok.cool",
	"Hmm. Com'on",
	"I have a snap shackle",
	"oh snap",
	"cold snap coming",
	"I watched it on youtube",
	"we play minecraft sometimes",
	"the boat is called Discordia",
	"your signal is weak",
	"call me on channel 16",
	"find me a harbour",
	"hit me up when you're ready",
	"ig :)",
	"the race starts at 10:00, 10:30 and 11:00",
	"start in 5, 4, 3, 2, 1",
	"41°30'N 70°15'W",
	"from 1700 to 1800",
	"St.Ives",
	"H.M.S. Victory",
	"🏴\u200d☠\ufe0f pirates!",
	"🇳🇿 kiwi sailors",
	"Привет, как дела?",
	"日本語 大丈夫",
	"Kia ora e hoa",
	"¿Dónde está el puerto?",
}

func TestChatContact(t *testing.T) {
	for _, s := range contacts {
		if _, got := CheckChat(s); got != ChatContact {
			t.Errorf("CheckChat(%q) = %q, want contact", s, got)
		}
	}
}

func TestChatInnocent(t *testing.T) {
	// The names that must pass, said in chat, too.
	lines := slices.Concat(innocents, readLines(t, "innocent-chat.txt"), readLines(t, "innocent.txt"))
	for _, s := range lines {
		if _, got := CheckChat(s); got != "" {
			t.Errorf("CheckChat(%q) = %q, want it to pass", s, got)
		}
	}
}

func TestChatWords(t *testing.T) {
	for _, s := range []string{
		"shit",
		"Shit happens",
		"oh shiiit",
		"s h i t",
		"s.h.i.t",
		"sh it",
		"5h1t",
		"$hit",
		"sh\u200bit",
		"ѕhіt", // Cyrillic ѕ and і
		"ｓｈｉｔ",
		"what the fuck",
		"motherfuckers",
		"f u c k",
		"fuuuuck",
		"you twat",
		"shit123",
		"boooobs",
		"a$$",
		"🇸🇭🇮🇹",
	} {
		if _, got := CheckChat(s); got != ChatWords {
			t.Errorf("CheckChat(%q) = %q, want words", s, got)
		}
	}
}

// TestPhoneExamples checks every example number phonenumbers has, for
// every region and kind, is refused as it is written there: nationally when
// it has seven digits or more, and always internationally.
func TestPhoneExamples(t *testing.T) {
	short := 0
	for region := range phonenumbers.GetSupportedRegions() {
		for _, kind := range []phonenumbers.PhoneNumberType{
			phonenumbers.FIXED_LINE, phonenumbers.MOBILE, phonenumbers.TOLL_FREE, phonenumbers.VOIP,
			phonenumbers.PERSONAL_NUMBER, phonenumbers.UAN, phonenumbers.PAGER, phonenumbers.VOICEMAIL,
		} {
			n := phonenumbers.GetExampleNumberForType(region, kind)
			if n == nil {
				continue
			}
			for _, format := range []phonenumbers.PhoneNumberFormat{phonenumbers.NATIONAL, phonenumbers.INTERNATIONAL, phonenumbers.E164} {
				written := phonenumbers.Format(n, format)
				if digits := strings.Count(strings.Map(keepDigits, written), ""); digits-1 < 7 {
					short++
					continue
				}
				if _, got := CheckChat("call me on " + written); got != ChatContact {
					t.Errorf("%s's %v, %q, passes", region, kind, written)
				}
			}
		}
	}
	t.Logf("%d national forms of fewer than seven digits", short)
}

func keepDigits(r rune) rune {
	if unicode.IsDigit(r) {
		return r
	}
	return -1
}

// TestChatListsWellFormed checks each app is a lowercase name, as the
// filter folds them, and each end is one xurls knows.
func TestChatListsWellFormed(t *testing.T) {
	for _, line := range readLines(t, "apps.txt") {
		name, _, _ := strings.Cut(line, " ")
		if name == "" || strings.Trim(name, "abcdefghijklmnopqrstuvwxyz0123456789") != "" || apps().names[name] == 0 {
			t.Errorf("apps.txt: %q is not a lowercase name and its tier", line)
		}
	}
	known := map[string]bool{}
	for _, tld := range append(xurls.TLDs, xurls.PseudoTLDs...) {
		known[tld] = true
	}
	for _, line := range readLines(t, "tlds.txt") {
		name, _, _ := strings.Cut(line, " ")
		if !known[name] || tlds()[name] == 0 {
			t.Errorf("tlds.txt: %q is not an end xurls knows and its class", line)
		}
	}
}

// FuzzCheckChat runs any line through the whole check: it never panics, a
// line's clean form is valid UTF-8, one line with no control, format or
// direction character, at most MaxChat code points when it passes, and its
// own clean form.
func FuzzCheckChat(f *testing.F) {
	for _, s := range append(append(contacts, innocents...), "a\u0301\u0302\u0303\u0304\u0305", "👩\u200d🚀", "\xff\xfe", "Ⓐ\ufe0f\u0301", "\u0301\u200d", "1\ufe0f\u20e3", "0\ufe0f\u20e3\ufe2c\ufe0f\u20e3") {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		clean, refused := CheckChat(s)
		if !utf8.ValidString(clean) {
			t.Fatalf("%q cleans to invalid UTF-8 %q", s, clean)
		}
		for _, r := range clean {
			if r == '\n' || r == '\r' || unicode.In(r, unicode.Cc, unicode.Co, unicode.Bidi_Control) ||
				unicode.Is(unicode.Cf, r) && r != '\u200d' {
				t.Fatalf("%q cleans to %q, with %U", s, clean, r)
			}
		}
		if refused == "" && utf8.RuneCountInString(clean) > MaxChat {
			t.Fatalf("%q passes at %d code points", s, utf8.RuneCountInString(clean))
		}
		if refused == ChatLong && len(s) > maxChatBytes {
			return
		}
		again, refusedAgain := CheckChat(clean)
		if again != clean || refusedAgain != refused {
			t.Fatalf("%q cleans to %q (%q), which cleans to %q (%q)", s, clean, refused, again, refusedAgain)
		}
	})
}

func BenchmarkCheckChat(b *testing.B) {
	for name, line := range map[string]string{
		// A line of about 100 characters, as most are.
		"typical": "Ready about! Wind's backing to 250, 15 knots gusting 22. Ease the main and watch the line squall.",
		// 200 characters that pass every check and make every form: a
		// look-alike, a fullwidth letter, single letters, a repeat, digits
		// for letters, full stops, brackets, "dot", an app's name, digits.
		"worst": strings.Repeat("ѕ ｈ i i i p 3.5 ok.so c0w (x) dot steam 12 34 56 ", 4),
	} {
		b.Run(name, func(b *testing.B) {
			if clean, refused := CheckChat(line); refused != "" || utf8.RuneCountInString(clean) > MaxChat {
				b.Fatalf("%q is refused: %q", line, refused)
			}
			b.ReportAllocs()
			for b.Loop() {
				CheckChat(line)
			}
		})
	}
}
