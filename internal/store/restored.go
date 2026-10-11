// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io/fs"
	"regexp"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// createTable finds the tables a migration makes, by name: each CREATE
// TABLE at the start of a line. A world's partitions are made by a
// function, not named, and are not among them.
var createTable = regexp.MustCompile(`(?m)^CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\b`)

// Tables are the tables this build's migrations make, sorted: what a
// database at Latest holds. Migrations only add, so none is ever dropped.
func Tables() []string {
	var names []string
	files, _ := fs.Glob(Migrations(), "*.sql")
	for _, f := range files {
		data, err := fs.ReadFile(Migrations(), f)
		if err != nil {
			panic(err) // the files are embedded
		}
		for _, m := range createTable.FindAllSubmatch(data, -1) {
			names = append(names, string(m[1]))
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// Restored is what a database restored from the backups holds, as the
// weekly restore test reads it.
type Restored struct {
	// Version is the newest migration it has had.
	Version int64
	// Missing are the tables of Tables it does not have.
	Missing []string
	// Rows is each table's row count, partitions included.
	Rows map[string]int64
	// Checkpoint and Event are when the newest checkpoint and the newest
	// event were written; zero when there is none.
	Checkpoint, Event time.Time
}

// RestoredDB is how to reach a restored database.
type RestoredDB struct {
	// URL is the database's. User and Password, if given, are used over
	// the URL's.
	URL            string
	User, Password string
	// RootCAs, if not nil, is the CA its server's certificate must be
	// signed by, for the host in URL: the connection is TLS, checked, and
	// nothing else.
	RootCAs *x509.CertPool
}

// ReadRestored connects to a restored database and reads it, writing
// nothing.
func ReadRestored(ctx context.Context, db RestoredDB) (Restored, error) {
	cc, err := pgx.ParseConfig(db.URL)
	if err != nil {
		return Restored{}, err
	}
	if db.User != "" {
		cc.User, cc.Password = db.User, db.Password
	}
	if db.RootCAs != nil {
		cc.TLSConfig = &tls.Config{RootCAs: db.RootCAs, ServerName: cc.Host, MinVersion: tls.VersionTLS12}
		cc.Fallbacks = nil
	}
	conn, err := pgx.ConnectConfig(ctx, cc)
	if err != nil {
		return Restored{}, err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	return readRestored(ctx, conn)
}

func readRestored(ctx context.Context, conn *pgx.Conn) (Restored, error) {
	r := Restored{Rows: map[string]int64{}}
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", versionTable).Scan(&exists); err != nil {
		return r, err
	}
	if exists {
		var v *int64
		if err := conn.QueryRow(ctx, "SELECT max(version_id) FROM "+versionTable).Scan(&v); err != nil {
			return r, err
		}
		if v != nil {
			r.Version = *v
		}
	}
	for _, t := range Tables() {
		if err := conn.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", t).Scan(&exists); err != nil {
			return r, err
		}
		if !exists {
			r.Missing = append(r.Missing, t)
			continue
		}
		var n int64
		// The name is one of Tables', from the embedded migrations.
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{t}.Sanitize()).Scan(&n); err != nil {
			return r, err
		}
		r.Rows[t] = n
	}
	for t, at := range map[string]*time.Time{"checkpoint": &r.Checkpoint, "event": &r.Event} {
		if _, ok := r.Rows[t]; !ok {
			continue
		}
		var newest *time.Time
		if err := conn.QueryRow(ctx, "SELECT max(written_at) FROM "+pgx.Identifier{t}.Sanitize()).Scan(&newest); err != nil {
			return r, err
		}
		if newest != nil {
			*at = *newest
		}
	}
	return r, nil
}
