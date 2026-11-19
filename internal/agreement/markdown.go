// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"html"
	"html/template"
	"regexp"
	"strings"
)

// The agreement's and the privacy notice's Markdown, the little of it they
// use, as HTML: headings, paragraphs, lists, rules, bold, code, and bare
// web addresses as links. Their text is the repository's own, embedded;
// every character of it is escaped before any of it is marked up. A test
// renders every version, so one that uses more of Markdown fails it.

var (
	boldRE = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	codeRE = regexp.MustCompile("`([^`]+)`")
	urlRE  = regexp.MustCompile(`https://[^\s<>()"&]+[^\s<>()"&.,;:]`)
)

// inline marks up one block's text, already joined into a line.
func inline(s string) string {
	s = html.EscapeString(s)
	s = codeRE.ReplaceAllString(s, "<code>$1</code>")
	s = boldRE.ReplaceAllString(s, "<strong>$1</strong>")
	return urlRE.ReplaceAllStringFunc(s, func(u string) string {
		return `<a href="` + u + `">` + u + `</a>`
	})
}

// Markdown renders text as HTML.
func Markdown(text []byte) template.HTML {
	var b strings.Builder
	var para []string
	var items []string // the open list's items
	flush := func() {
		if len(para) > 0 {
			b.WriteString("<p>" + inline(strings.Join(para, " ")) + "</p>\n")
			para = nil
		}
		if len(items) > 0 {
			b.WriteString("<ul>\n")
			for _, it := range items {
				b.WriteString("<li>" + inline(it) + "</li>\n")
			}
			b.WriteString("</ul>\n")
			items = nil
		}
	}
	for line := range strings.SplitSeq(strings.ReplaceAll(string(text), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			flush()
		case trimmed == "---":
			flush()
			b.WriteString("<hr>\n")
		case strings.HasPrefix(line, "#"):
			flush()
			level := len(line) - len(strings.TrimLeft(line, "#"))
			if level > 4 {
				level = 4
			}
			tag := "h" + string(rune('0'+level))
			b.WriteString("<" + tag + ">" + inline(strings.TrimSpace(line[level:])) + "</" + tag + ">\n")
		case strings.HasPrefix(line, "- "):
			if len(para) > 0 {
				flush()
			}
			items = append(items, strings.TrimSpace(line[2:]))
		case len(items) > 0 && strings.HasPrefix(line, "  "):
			items[len(items)-1] += " " + trimmed
		default:
			if len(items) > 0 {
				flush()
			}
			para = append(para, trimmed)
		}
	}
	flush()
	// The repository's own text, every character escaped above.
	return template.HTML(b.String())
}
