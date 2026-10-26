/*
Copyright © 2025 SUSE LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

		http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package shell contains a function to help with spawning commands in the
// Rancher Desktop VM.
package shell

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"golang.org/x/text/encoding/unicode"

	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/command"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/directories"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/paths"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/utils"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/wsl"
)

// Spawn a command that, when run, will be executed in the VM with the given
// arguments.
func SpawnCommand(ctx context.Context, args ...string) (*exec.Cmd, error) {
	if runtime.GOOS == "windows" {
		err := assertWSLIsRunning(ctx, wsl.DistributionName)
		if err != nil {
			return nil, err
		}
		args = append([]string{
			"--distribution", wsl.DistributionName,
			"--exec", "/usr/local/bin/wsl-exec",
		}, args...)
		return exec.CommandContext(ctx, "wsl", args...), nil
	}

	commandName, err := directories.GetSullaRuntimePath()
	if err != nil {
		return nil, err
	}
	if err := checkRuntimeIsRunning(ctx, commandName); err != nil {
		return nil, err
	}
	args = append([]string{"exec", "--"}, args...)
	return exec.CommandContext(ctx, commandName, args...), nil
}

// Set up the PATH environment variable.
func setupPathEnvVar(p *paths.Paths) error {
	if runtime.GOOS != "windows" {
		// This is only needed on Windows.
		return nil
	}
	msysDir := filepath.Join(utils.GetParentDir(p.Resources, 2), "msys")
	pathList := filepath.SplitList(os.Getenv("PATH"))
	if slices.Contains(pathList, msysDir) {
		return nil
	}
	pathList = append([]string{msysDir}, pathList...)
	return os.Setenv("PATH", strings.Join(pathList, string(os.PathListSeparator)))
}

func checkRuntimeIsRunning(ctx context.Context, commandName string) error {
	var stdout bytes.Buffer

	const desiredState = "Running"

	//nolint:gosec // The command name is auto-detected.
	cmd := exec.CommandContext(ctx, commandName, "status")
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		// The control socket is only there while the runtime is up.
		return command.NewVMStateError(ctx, desiredState, "")
	}
	if strings.Contains(stdout.String(), `"state":"docker-ready"`) {
		return nil
	}
	return command.NewVMStateError(ctx, desiredState, "Starting")
}

// Check that WSL is running the given distribution; if not, an error will be
// returned with a message suitable for printing to the user.
func assertWSLIsRunning(ctx context.Context, distroName string) error {
	// Ignore error messages; none are expected here
	rawOutput, err := exec.CommandContext(ctx, "wsl", "--list", "--verbose").CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to run 'wsl --list --verbose': %w", err)
	}
	decoder := unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()
	output, err := decoder.Bytes(rawOutput)
	if err != nil {
		return fmt.Errorf("failed to read WSL output ([% q]...); error: %w", rawOutput[:12], err)
	}
	actualState := ""
	for _, line := range regexp.MustCompile(`\r?\n`).Split(string(output), -1) {
		fields := regexp.MustCompile(`\s+`).Split(strings.TrimLeft(line, " \t"), -1)
		if fields[0] == "*" {
			fields = fields[1:]
		}
		if len(fields) >= 2 && fields[0] == distroName {
			actualState = fields[1]
			break
		}
	}
	const desiredState = "Running"
	if actualState == desiredState {
		return nil
	}

	return command.NewVMStateError(ctx, desiredState, actualState)
}
