// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestLoadValid(t *testing.T) {
	c, err := Load(env(map[string]string{
		"KEEL_PLAY_ORIGIN": "https://192.168.1.20:5173",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PlayAddr != "127.0.0.1:8080" {
		t.Errorf("PlayAddr = %q, want the default", c.PlayAddr)
	}
	if c.PlayOrigin != "https://192.168.1.20:5173" {
		t.Errorf("PlayOrigin = %q", c.PlayOrigin)
	}

	c, err = Load(env(map[string]string{
		"KEEL_PLAY_ADDR":   ":9000",
		"KEEL_PLAY_ORIGIN": "https://play.keelovertheedge.com",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PlayAddr != ":9000" {
		t.Errorf("PlayAddr = %q", c.PlayAddr)
	}
}

func TestLoadRejects(t *testing.T) {
	cases := map[string]struct {
		vars map[string]string
		want []string
	}{
		"origin missing":   {map[string]string{}, []string{"KEEL_PLAY_ORIGIN: required"}},
		"origin http":      {map[string]string{"KEEL_PLAY_ORIGIN": "http://example.com"}, []string{"not https"}},
		"origin with path": {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com/play"}, []string{"not an origin"}},
		"origin slash":     {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com/"}, []string{"not an origin"}},
		"origin user":      {map[string]string{"KEEL_PLAY_ORIGIN": "https://a@example.com"}, []string{"user information"}},
		"addr no port":     {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_PLAY_ADDR": "localhost"}, []string{"KEEL_PLAY_ADDR"}},
		"addr bad port":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_PLAY_ADDR": ":99999"}, []string{"KEEL_PLAY_ADDR"}},
		"both wrong": {
			map[string]string{"KEEL_PLAY_ADDR": "x", "KEEL_PLAY_ORIGIN": "ftp://x"},
			[]string{"KEEL_PLAY_ADDR", "KEEL_PLAY_ORIGIN"},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(env(tc.vars))
			if err == nil {
				t.Fatal("accepted")
			}
			for _, w := range tc.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q does not mention %q", err, w)
				}
			}
		})
	}
}
