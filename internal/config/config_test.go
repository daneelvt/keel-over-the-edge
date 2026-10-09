// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"log/slog"
	"strings"
	"testing"
)

const dbURL = "postgres://keel:secret@127.0.0.1:5432/keel"

// env serves vars, with a database URL unless vars sets one, even "".
func env(vars map[string]string) func(string) string {
	return func(k string) string {
		if v, ok := vars[k]; ok {
			return v
		}
		if k == "KEEL_DATABASE_URL" {
			return dbURL
		}
		return ""
	}
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
	want := Config{
		PlayAddr: "127.0.0.1:8080", PlayOrigin: "https://192.168.1.20:5173",
		AgentsAddr: "127.0.0.1:8081", InternalAddr: "127.0.0.1:9090", LogLevel: slog.LevelInfo, DatabaseURL: dbURL,
		BoatLimit: DefaultBoatLimit, Bell: DefaultBell,
	}
	if c != want {
		t.Errorf("defaults %+v, want %+v", c, want)
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

	c, err = Load(env(map[string]string{
		"KEEL_PLAY_ORIGIN":   "https://play.keelovertheedge.com",
		"KEEL_PLAY_ADDR":     ":8080",
		"KEEL_AGENTS_ADDR":   ":8081",
		"KEEL_INTERNAL_ADDR": "0.0.0.0:9090",
		"KEEL_LOG_LEVEL":     "debug",
		"KEEL_TRACE_DIR":     "/tmp/traces",
		"KEEL_REPLAY_DIR":    "/tmp/replays",
		"KEEL_CLIENT_DIR":    "/srv/keel/client",
		"KEEL_DEV_SAILORS":   "1000",
		"KEEL_BOAT_LIMIT":    "2",
		"KEEL_BELL":          "0",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want = Config{
		PlayAddr: ":8080", PlayOrigin: "https://play.keelovertheedge.com", AgentsAddr: ":8081", InternalAddr: "0.0.0.0:9090",
		LogLevel: slog.LevelDebug, TraceDir: "/tmp/traces", ReplayDir: "/tmp/replays", ClientDir: "/srv/keel/client", DevSailors: 1000, DatabaseURL: dbURL,
		BoatLimit: 2, Bell: 0,
	}
	if c != want {
		t.Errorf("got %+v, want %+v", c, want)
	}
	for _, origin := range []string{"http://localhost:5181", "http://127.0.0.1:8080", "http://[::1]:5181", "http://127.0.0.2"} {
		if _, err := Load(env(map[string]string{"KEEL_PLAY_ORIGIN": origin})); err != nil {
			t.Errorf("%s: %v", origin, err)
		}
	}
	for _, u := range []string{"postgresql://h/db", "host=db user=keel dbname=keel", "postgres:///keel?host=/tmp"} {
		if _, err := Load(env(map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DATABASE_URL": u})); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	if s := c.String(); strings.Contains(s, "secret") || !strings.Contains(s, "not shown") {
		t.Errorf("String() = %s", s)
	}
	for in, level := range map[string]slog.Level{"DEBUG": slog.LevelDebug, "info": slog.LevelInfo, "Warn": slog.LevelWarn, "error": slog.LevelError} {
		if got, err := ParseLevel(in); err != nil || got != level {
			t.Errorf("%s: %v, %v", in, got, err)
		}
	}
}

func TestLoadRejects(t *testing.T) {
	cases := map[string]struct {
		vars map[string]string
		want []string
	}{
		"origin missing":   {map[string]string{}, []string{"KEEL_PLAY_ORIGIN: required"}},
		"origin http":      {map[string]string{"KEEL_PLAY_ORIGIN": "http://example.com"}, []string{"not https"}},
		"origin http lan":  {map[string]string{"KEEL_PLAY_ORIGIN": "http://192.168.1.20:5173"}, []string{"not https"}},
		"origin http host": {map[string]string{"KEEL_PLAY_ORIGIN": "http://localhost.example.com"}, []string{"not https"}},
		"database missing": {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DATABASE_URL": ""}, []string{"KEEL_DATABASE_URL: required"}},
		"database mysql":   {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DATABASE_URL": "mysql://u:secret@h/db"}, []string{"not postgres"}},
		"database word":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DATABASE_URL": "keel"}, []string{"KEEL_DATABASE_URL"}},
		"origin with path": {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com/play"}, []string{"not an origin"}},
		"origin slash":     {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com/"}, []string{"not an origin"}},
		"origin user":      {map[string]string{"KEEL_PLAY_ORIGIN": "https://a@example.com"}, []string{"user information"}},
		"addr no port":     {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_PLAY_ADDR": "localhost"}, []string{"KEEL_PLAY_ADDR"}},
		"addr bad port":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_PLAY_ADDR": ":99999"}, []string{"KEEL_PLAY_ADDR"}},
		"both wrong": {
			map[string]string{"KEEL_PLAY_ADDR": "x", "KEEL_PLAY_ORIGIN": "ftp://x"},
			[]string{"KEEL_PLAY_ADDR", "KEEL_PLAY_ORIGIN"},
		},
		"agents addr bad":     {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_AGENTS_ADDR": "8081"}, []string{"KEEL_AGENTS_ADDR"}},
		"internal addr bad":   {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_INTERNAL_ADDR": "x:y"}, []string{"KEEL_INTERNAL_ADDR"}},
		"same as play":        {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_AGENTS_ADDR": "127.0.0.1:8080"}, []string{"KEEL_AGENTS_ADDR: \"127.0.0.1:8080\" is KEEL_PLAY_ADDR's"}},
		"wildcard overlaps":   {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_INTERNAL_ADDR": "0.0.0.0:8081"}, []string{"KEEL_INTERNAL_ADDR", "KEEL_AGENTS_ADDR's address"}},
		"log level":           {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_LOG_LEVEL": "loud"}, []string{"KEEL_LOG_LEVEL"}},
		"bell not a duration": {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BELL": "3"}, []string{"KEEL_BELL"}},
		"bell too long":       {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BELL": "11s"}, []string{"from 0s to 10s"}},
		"bell negative":       {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BELL": "-1s"}, []string{"KEEL_BELL"}},
		"sailors not number":  {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DEV_SAILORS": "many"}, []string{"KEEL_DEV_SAILORS"}},
		"sailors negative":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DEV_SAILORS": "-1"}, []string{"KEEL_DEV_SAILORS"}},
		"too many sailors":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_DEV_SAILORS": "4097"}, []string{"from 0 to 4096"}},
		"no boats":            {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BOAT_LIMIT": "0"}, []string{"KEEL_BOAT_LIMIT", "from 1 to 4096"}},
		"too many boats":      {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BOAT_LIMIT": "4097"}, []string{"KEEL_BOAT_LIMIT"}},
		"boats not number":    {map[string]string{"KEEL_PLAY_ORIGIN": "https://example.com", "KEEL_BOAT_LIMIT": "lots"}, []string{"KEEL_BOAT_LIMIT"}},
		"everything wrong": {
			map[string]string{
				"KEEL_PLAY_ADDR": "x", "KEEL_AGENTS_ADDR": "y", "KEEL_INTERNAL_ADDR": "z",
				"KEEL_LOG_LEVEL": "loud", "KEEL_DEV_SAILORS": "lots",
			},
			[]string{"KEEL_PLAY_ADDR", "KEEL_AGENTS_ADDR", "KEEL_INTERNAL_ADDR", "KEEL_PLAY_ORIGIN", "KEEL_LOG_LEVEL", "KEEL_DEV_SAILORS"},
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
			if strings.Contains(err.Error(), "secret") {
				t.Errorf("error %q shows the password", err)
			}
		})
	}
}
