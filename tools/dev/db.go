// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// pgImage is PostgreSQL's official image, pinned by the digest of its
// multi-platform index (Renovate raises both).
const pgImage = "postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336"

// devDB is a PostgreSQL server in a container, for development: its data in
// a named volume, its password in an environment file in .dev. It is left
// running when tools/dev exits, so go test can use it.
type devDB struct {
	container string
	volume    string
	// port is where it listens, on loopback only. Not 5432, which a
	// PostgreSQL installed on the computer often has.
	port int
	// envFile holds the URLs, password included, for keel and for the tests.
	envFile string
}

var localDB = devDB{container: "keel-dev-db", volume: "keel-dev-db", port: 5433, envFile: filepath.Join(stateDir, "db.env")}

// dbURLs are a development database's URLs: the game's own database, and
// the server's maintenance database, from which the tests make databases of
// their own.
type dbURLs struct {
	App, Test string
}

// errNoRuntime is neither docker nor podman found.
var errNoRuntime = errors.New("the database runs in a container, and neither docker nor podman is installed: " +
	"install Docker Desktop or Podman, or set KEEL_DEV_DATABASE_URL to a PostgreSQL 18 of your own")

// findRuntime finds docker, or else podman, on the path.
func findRuntime(lookPath func(string) (string, error)) (string, error) {
	for _, name := range []string{"docker", "podman"} {
		if p, err := lookPath(name); err == nil {
			return p, nil
		}
	}
	return "", errNoRuntime
}

// devDatabase returns the development database, starting it if need be:
// KEEL_DEV_DATABASE_URL when set (nothing is started), or else the
// container.
func devDatabase(ctx context.Context, out io.Writer) (dbURLs, error) {
	if u := os.Getenv("KEEL_DEV_DATABASE_URL"); u != "" {
		return dbURLs{App: u, Test: os.Getenv("KEEL_TEST_DATABASE_URL")}, nil
	}
	rt, err := findRuntime(exec.LookPath)
	if err != nil {
		return dbURLs{}, err
	}
	return localDB.start(ctx, rt, out)
}

// start starts the container, or reuses it when it is running, and waits
// until PostgreSQL accepts connections.
func (d devDB) start(ctx context.Context, rt string, out io.Writer) (dbURLs, error) {
	if _, err := output(ctx, rt, "info", "--format", "{{.ServerVersion}}"); err != nil {
		return dbURLs{}, fmt.Errorf("%s is installed but not running: start it (Docker Desktop, or podman machine start)", filepath.Base(rt))
	}
	env, envErr := readEnvFile(d.envFile)
	state, err := output(ctx, rt, "container", "inspect", "--format", "{{.State.Running}}", d.container)
	exists := err == nil
	if !exists {
		_, verr := output(ctx, rt, "volume", "inspect", d.volume)
		exists = verr == nil
	}
	var password string
	switch {
	case exists && envErr != nil:
		return dbURLs{}, fmt.Errorf("the database's container or volume exists but %s is missing, so its password is lost: "+
			"go run ./tools/dev -db-reset, then start again", d.envFile)
	case exists:
		password = env["KEEL_DEV_DB_PASSWORD"]
	default:
		password = rand.Text()
		urls := d.urls(password)
		if err := writeEnvFile(d.envFile, password, urls); err != nil {
			return dbURLs{}, err
		}
	}
	switch {
	case state == "true":
	case err == nil:
		fmt.Fprintf(out, "dev: starting the database (%s)\n", d.container)
		if err := runIn(ctx, ".", out, rt, "start", d.container); err != nil {
			return dbURLs{}, err
		}
	default:
		fmt.Fprintf(out, "dev: starting the database in a new container, %s (PostgreSQL 18, on 127.0.0.1:%d)\n", d.container, d.port)
		if err := runIn(ctx, ".", out, rt, "run", "--detach", "--name", d.container,
			"--publish", fmt.Sprintf("127.0.0.1:%d:5432", d.port),
			"--volume", d.volume+":/var/lib/postgresql",
			"--env", "POSTGRES_USER=keel",
			"--env", "POSTGRES_PASSWORD="+password,
			"--env", "POSTGRES_DB=keel",
			pgImage); err != nil {
			return dbURLs{}, err
		}
	}
	if err := d.waitReady(ctx, rt); err != nil {
		return dbURLs{}, err
	}
	return d.urls(password), nil
}

// waitReady waits until the server in the container accepts connections
// over TCP. While the image initialises a new database it runs a server on
// a socket alone, which pg_isready over TCP does not mistake for ready.
func (d devDB) waitReady(ctx context.Context, rt string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for {
		if _, err := output(ctx, rt, "exec", d.container, "pg_isready", "--quiet", "--host", "127.0.0.1", "--username", "keel", "--dbname", "keel"); err == nil {
			// The published port, which can lag behind the container.
			c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(d.port)), time.Second)
			if err == nil {
				c.Close()
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the database in %s did not start: %s logs %s", d.container, filepath.Base(rt), d.container)
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func (d devDB) urls(password string) dbURLs {
	u := func(database string) string {
		return (&url.URL{
			Scheme: "postgres", User: url.UserPassword("keel", password),
			Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(d.port)), Path: "/" + database,
			RawQuery: "sslmode=disable",
		}).String()
	}
	return dbURLs{App: u("keel"), Test: u("postgres")}
}

// reset removes the container and its volume, and the environment file.
func (d devDB) reset(ctx context.Context, rt string, out io.Writer) error {
	if _, err := output(ctx, rt, "container", "inspect", d.container); err == nil {
		if err := runIn(ctx, ".", out, rt, "rm", "--force", "--volumes", d.container); err != nil {
			return err
		}
	}
	if _, err := output(ctx, rt, "volume", "inspect", d.volume); err == nil {
		if err := runIn(ctx, ".", out, rt, "volume", "rm", d.volume); err != nil {
			return err
		}
	}
	if err := os.Remove(d.envFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// writeEnvFile writes the password and the URLs, readable by this user
// alone. The tests read KEEL_TEST_DATABASE_URL from it.
func writeEnvFile(path, password string, u dbURLs) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body := "# The development database, in a container (go run ./tools/dev -db).\n" +
		"KEEL_DEV_DB_PASSWORD=" + password + "\n" +
		"KEEL_DATABASE_URL=" + u.App + "\n" +
		"KEEL_TEST_DATABASE_URL=" + u.Test + "\n"
	return os.WriteFile(path, []byte(body), 0o600)
}

// readEnvFile reads KEY=value lines, skipping blank lines and comments.
func readEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	env := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			env[k] = v
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if env["KEEL_DEV_DB_PASSWORD"] == "" {
		return nil, fmt.Errorf("%s has no password", path)
	}
	return env, nil
}

// runDB starts the database alone and prints how to reach it.
func runDB(ctx context.Context, out io.Writer) error {
	u, err := devDatabase(ctx, out)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "dev: the database is up, and left running.\n\n")
	fmt.Fprintf(out, "  the game's database   psql %q\n", u.App)
	if u.Test != "" {
		fmt.Fprintf(out, "  for go test           KEEL_TEST_DATABASE_URL=%q\n", u.Test)
		fmt.Fprintf(out, "                        (go test reads it from %s by itself)\n", localDB.envFile)
	}
	if os.Getenv("KEEL_DEV_DATABASE_URL") == "" {
		fmt.Fprintf(out, "  stop it               docker stop %s (or podman)\n", localDB.container)
		fmt.Fprintf(out, "  remove it, and its data  go run ./tools/dev -db-reset\n")
	}
	return nil
}

// runDBReset removes the development database and its data.
func runDBReset(ctx context.Context, out io.Writer) error {
	rt, err := findRuntime(exec.LookPath)
	if err != nil {
		return err
	}
	if err := localDB.reset(ctx, rt, out); err != nil {
		return err
	}
	fmt.Fprintln(out, "dev: the database's container, volume and password are removed")
	return nil
}
