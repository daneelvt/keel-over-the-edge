// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"net"
	"strings"
	"sync"
	"testing"
)

func TestPrintAddressesShowsBothSteps(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	printAddresses(&mu, &out, "https://192.168.1.20:5173", []net.IP{net.ParseIP("192.168.1.20")})
	text := out.String()
	setup := strings.Index(text, "1. Once per phone, trust this computer: http://192.168.1.20:5174/")
	game := strings.Index(text, "2. The game: https://192.168.1.20:5173")
	if setup < 0 || game < setup {
		t.Fatalf("output:\n%s", text)
	}
}
