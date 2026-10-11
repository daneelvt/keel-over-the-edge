// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// serviceAccountDir is where Kubernetes mounts a pod's service account:
// its token, the cluster's CA and the pod's namespace (Kubernetes'
// documentation, "Accessing the Kubernetes API from a Pod").
const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// kube is a client of the Kubernetes API as a pod reaches it: over HTTPS to
// the address Kubernetes puts in every pod's environment, its certificate
// checked against the cluster's CA, as the pod's service account. JSON in,
// JSON out; no client library.
type kube struct {
	base      string
	http      *http.Client
	tokenFile string
	// Namespace is the pod's own.
	Namespace string
}

// inCluster makes the client from what Kubernetes gives a pod: the API
// server's address in KUBERNETES_SERVICE_HOST and _PORT, and the service
// account's files under dir.
func inCluster(getenv func(string) string, dir string) (*kube, error) {
	host, port := getenv("KUBERNETES_SERVICE_HOST"), getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not in a Kubernetes pod: KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are not set")
	}
	ca, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("the cluster's CA: %w", err)
	}
	ns, err := os.ReadFile(filepath.Join(dir, "namespace"))
	if err != nil {
		return nil, fmt.Errorf("the pod's namespace: %w", err)
	}
	return newKube("https://"+net.JoinHostPort(host, port), ca, filepath.Join(dir, "token"), strings.TrimSpace(string(ns)))
}

// newKube makes a client of the API server at base, whose certificate ca
// signed, with the token in tokenFile.
func newKube(base string, ca []byte, tokenFile, namespace string) (*kube, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the cluster's CA holds no certificate")
	}
	return &kube{
		base: base,
		http: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		},
		tokenFile: tokenFile,
		Namespace: namespace,
	}, nil
}

// apiError is the API server's answer to a request it refused.
type apiError struct {
	Code    int
	Message string
}

func (e *apiError) Error() string { return fmt.Sprintf("the Kubernetes API answered %d: %s", e.Code, e.Message) }

// notFound is whether err is the API server's 404.
func notFound(err error) bool {
	var a *apiError
	return errors.As(err, &a) && a.Code == http.StatusNotFound
}

// do sends a request to path, with in as its JSON body if not nil, and
// reads the JSON answer into out if not nil.
func (k *kube) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, k.base+path, body)
	if err != nil {
		return err
	}
	// Read each time: the kubelet replaces a projected token before it
	// expires.
	token, err := os.ReadFile(k.tokenFile)
	if err != nil {
		return fmt.Errorf("the service account's token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := k.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode/100 != 2 {
		// A Status object, whose message says why.
		var st struct{ Message string }
		if json.Unmarshal(data, &st) != nil || st.Message == "" {
			st.Message = strings.TrimSpace(string(data[:min(len(data), 200)]))
		}
		return &apiError{Code: res.StatusCode, Message: st.Message}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}
