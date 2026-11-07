// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"reflect"
	"strings"
	"testing"
)

type recordingTrimCommand struct {
	name   string
	args   []string
	output []byte
	err    error
}

func (command *recordingTrimCommand) CombinedOutput(_ context.Context, name string, args ...string) ([]byte, error) {
	command.name = name
	command.args = args
	return command.output, command.err
}

func TestDataTrimmerRunsFstrimAtIdlePriorityAndLogsBytes(t *testing.T) {
	// risk: storage reclamation silently stops and the host sparse disk fills.
	command := &recordingTrimCommand{output: []byte("/mnt/data: 26111647744 bytes trimmed\n")}
	var output bytes.Buffer
	trimmer := &dataTrimmer{command: command, logger: log.New(&output, "", 0)}

	trimmer.trim(context.Background())

	if command.name != "nice" {
		t.Fatalf("command = %q, want nice", command.name)
	}
	wantArgs := []string{"-n", "19", "ionice", "-c", "3", "fstrim", "-v", "/mnt/data"}
	if !reflect.DeepEqual(command.args, wantArgs) {
		t.Fatalf("arguments = %q, want %q", command.args, wantArgs)
	}
	if !strings.Contains(output.String(), "26111647744 bytes trimmed") {
		t.Fatalf("log = %q, want bytes trimmed", output.String())
	}
}

func TestDataTrimmerLogsFailureWithoutPanicking(t *testing.T) {
	// risk: discard failure disrupts boot services instead of remaining optional.
	command := &recordingTrimCommand{output: []byte("operation not supported"), err: errors.New("exit status 1")}
	var output bytes.Buffer
	trimmer := &dataTrimmer{command: command, logger: log.New(&output, "", 0)}

	trimmer.trim(context.Background())

	if !strings.Contains(output.String(), "data trim failed: exit status 1 output=operation not supported") {
		t.Fatalf("log = %q, want non-fatal failure detail", output.String())
	}
}
