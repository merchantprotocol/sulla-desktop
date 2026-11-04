// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import "testing"

func TestFilesystemProbeNormalizesBlkidOutput(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   string
	}{
		{name: "util-linux value", output: "ext4\n", want: "ext4"},
		{name: "BusyBox double quoted", output: `/dev/vdb: UUID="disk-id" TYPE="ext4"`, want: "ext4"},
		{name: "BusyBox single quoted", output: `/dev/vdb: UUID='disk-id' TYPE='ext4'`, want: "ext4"},
		{name: "BusyBox unquoted", output: `/dev/vdb: UUID=disk-id TYPE=ext4`, want: "ext4"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := newFilesystemProbe(func(string, ...string) ([]byte, error) {
				return []byte(test.output), nil
			})
			got, found, err := probe.probe("/dev/vdb")
			if err != nil || !found || got != test.want {
				t.Fatalf("probe() = (%q, %v, %v), want (%q, true, nil)", got, found, err, test.want)
			}
		})
	}
}
