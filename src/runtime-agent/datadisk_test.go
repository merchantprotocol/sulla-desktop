// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"path/filepath"
	"testing"
)

func TestDataBinds(t *testing.T) {
	targets := map[string]string{}
	for _, bind := range dataBinds {
		if filepath.IsAbs(bind.source) || !filepath.IsAbs(bind.target) {
			t.Fatalf("bind %q on %q: source must be relative to the data disk and target absolute", bind.source, bind.target)
		}
		if _, dup := targets[bind.target]; dup {
			t.Fatalf("target %q bound twice", bind.target)
		}
		targets[bind.target] = bind.source
	}
	// pip (usr/pip.conf) and npm (builtin npmrc) install under /usr/local;
	// that must be the data disk or the installs vanish on reboot.
	if targets["/usr/local"] != "usr/local" {
		t.Fatalf("/usr/local is not bound from the data disk: %v", targets)
	}
}
