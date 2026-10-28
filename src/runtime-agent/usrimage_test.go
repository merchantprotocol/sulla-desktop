// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import "testing"

func TestUsrDiskName(t *testing.T) {
	for cmdline, want := range map[string]string{
		"console=hvc0 sulla.data=vda sulla.usr=vdb sulla.time=1": "vdb",
		"sulla.usr=vdc": "vdc",
	} {
		if got, err := usrDiskName(cmdline); err != nil || got != want {
			t.Fatalf("%q: got %q, %v; want %q", cmdline, got, err, want)
		}
	}
	for _, cmdline := range []string{
		"console=hvc0 sulla.data=vda",
		"sulla.usr=sda",
		"sulla.usr=vdb1",
		"sulla.usr=../vdb",
		"sulla.usrx=vdb",
	} {
		if got, err := usrDiskName(cmdline); err == nil {
			t.Fatalf("%q: accepted %q", cmdline, got)
		}
	}
}
