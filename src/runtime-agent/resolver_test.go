// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import "testing"

func TestResolvConfUsable(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"empty", "", false},
		{"ipv6 loopback only", "nameserver ::1\n", false},
		{"ipv4 loopback only", "nameserver 127.0.0.1\nnameserver 127.0.0.53\n", false},
		{"unspecified", "nameserver 0.0.0.0\n", false},
		{"garbage address", "nameserver not-an-ip\n", false},
		{"comment only", "# nameserver 192.168.64.1\n", false},
		{"gateway", "nameserver 192.168.64.1\n", true},
		{"loopback then real", "nameserver ::1\nnameserver 100.64.0.2\n", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := resolvConfUsable(test.content); got != test.want {
				t.Fatalf("resolvConfUsable(%q) = %v, want %v", test.content, got, test.want)
			}
		})
	}
}

func TestDefaultGateway(t *testing.T) {
	if gw, ok := defaultGateway("default via 192.168.64.1 dev eth0\n"); !ok || gw != "192.168.64.1" {
		t.Fatalf("defaultGateway = (%q, %v)", gw, ok)
	}
	for _, bad := range []string{"", "default dev eth0\n", "default via nope dev eth0\n"} {
		if gw, ok := defaultGateway(bad); ok {
			t.Fatalf("defaultGateway(%q) = %q, want no gateway", bad, gw)
		}
	}
}
