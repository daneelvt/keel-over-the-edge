// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// A race's calendar entry: an iCalendar file (RFC 5545) of one event, its
// start and expected end, its name, what it is and its link, with a
// reminder ten minutes before. The game sends nothing to a phone that is
// closed: the entry is the reminder.

// icsTime is t as iCalendar's UTC form.
func icsTime(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

// icsText escapes a text value (RFC 5545 3.3.11).
func icsText(s string) string {
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`)
	return r.Replace(s)
}

// fold writes a content line folded at 75 octets (RFC 5545 3.1), each
// line ending CRLF.
func fold(b *strings.Builder, line string) {
	most := 75 // a folded line's leading space counts
	for len(line) > most {
		cut := most
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		b.WriteString(line[:cut])
		b.WriteString("\r\n ")
		line = line[cut:]
		most = 74
	}
	b.WriteString(line)
	b.WriteString("\r\n")
}

// Calendar is a race's calendar file: uid unique to it, its start and
// expected minutes, its name, what it is and its link; made at now.
func Calendar(uid string, start time.Time, minutes int, name, what, link string, now time.Time) []byte {
	if minutes <= 0 {
		minutes = ShortMinutes
	}
	var b strings.Builder
	for _, l := range []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Keel Over the Edge//Races//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		"UID:" + icsText(uid),
		"DTSTAMP:" + icsTime(now),
		"DTSTART:" + icsTime(start),
		"DTEND:" + icsTime(start.Add(time.Duration(minutes)*time.Minute)),
		"SUMMARY:" + icsText(name),
		"DESCRIPTION:" + icsText(fmt.Sprintf("%s. Enter or watch: %s", what, link)),
		"URL:" + link,
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"TRIGGER:-PT10M",
		"DESCRIPTION:" + icsText(name+" starts in 10 minutes"),
		"END:VALARM",
		"END:VEVENT",
		"END:VCALENDAR",
	} {
		fold(&b, l)
	}
	return []byte(b.String())
}
