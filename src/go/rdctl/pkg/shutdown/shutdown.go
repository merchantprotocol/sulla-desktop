/*
Copyright © 2022 SUSE LLC

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

package shutdown

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/hashicorp/go-multierror"
	"github.com/sirupsen/logrus"

	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/directories"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/factoryreset"
	p "github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/paths"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/process"
)

type shutdownData struct {
	waitForShutdown bool
}

type InitiatingCommand string

const (
	Shutdown     InitiatingCommand = "shutdown"
	FactoryReset InitiatingCommand = "factory-reset"
	// When killing an application, the number of times to retry.
	appKillRetryCount = 15
	// When killing an application, time interval between retries.
	appKillWaitInterval = 2 * time.Second
)

var sullaRuntimePath string

func newShutdownData(waitForShutdown bool) *shutdownData {
	return &shutdownData{waitForShutdown: waitForShutdown}
}

// FinishShutdown - ensures that none of the Rancher Desktop related processes are around
// after a graceful shutdown command has been sent as part of either `rdctl shutdown` or
// `rdctl factory-reset`.
func FinishShutdown(ctx context.Context, waitForShutdown bool, initiatingCommand InitiatingCommand) error {
	s := newShutdownData(waitForShutdown)
	if runtime.GOOS == "windows" {
		return s.waitForAppToDieOrKillIt(ctx, factoryreset.CheckProcessWindows, factoryreset.KillRancherDesktop, false, "the app")
	}
	runtimePath, err := directories.GetSullaRuntimePath()
	if err != nil {
		logrus.Errorf("Ignoring error trying to get path to sulla-runtime: %s", err)
	} else {
		sullaRuntimePath = runtimePath
		switch initiatingCommand {
		case Shutdown, FactoryReset:
			// The runtime's data disk is user data; neither command deletes it.
			err = s.waitForAppToDieOrKillIt(ctx, checkSullaRuntime, stopSullaRuntime, false, "the Sulla runtime")
			if err != nil {
				logrus.Errorf("Ignoring error trying to stop the Sulla runtime: %s", err)
			}
		default:
			return fmt.Errorf("internal error: unknown shutdown initiating command of %q", initiatingCommand)
		}
	}
	appDir, err := directories.GetApplicationDirectory(ctx)
	if err != nil {
		return fmt.Errorf("failed to find application directory: %w", err)
	}
	mainExecutablePath, err := p.GetMainExecutable(ctx)
	if err != nil {
		return fmt.Errorf("failed to get Rancher Desktop executable: %w", err)
	}
	return s.waitForAppToDieOrKillIt(
		ctx,
		isExecutableRunningFunc(mainExecutablePath),
		terminateRancherDesktopFunc(appDir),
		false,
		"the app")
}

// Run the given check function to detect if an application has exited, every
// appKillWaitInterval for appKillRetryCount times.  After all the checks have
// expired, run killFunc to terminate the application forcefully.  If skipRetry
// is true, do not wait at all and just kill immediately.
func (s *shutdownData) waitForAppToDieOrKillIt(ctx context.Context, checkFunc func(context.Context) (bool, error), killFunc func(context.Context) error, skipRetry bool, description string) error {
	for iter := 0; s.waitForShutdown && iter < appKillRetryCount; iter++ {
		if iter > 0 {
			logrus.Debugf("checking %s showed it's still running; sleeping for %s\n", description, appKillWaitInterval)
			time.Sleep(appKillWaitInterval)
		}
		status, err := checkFunc(ctx)
		if err != nil {
			return fmt.Errorf("while checking %s, found error: %w", description, err)
		}
		if !status {
			logrus.Debugf("%s is no longer running\n", description)
			return nil
		}
		if skipRetry {
			break
		}
	}
	logrus.Debugf("About to force-kill %s\n", description)
	return killFunc(ctx)
}

func isExecutableRunningFunc(executablePath string) func(context.Context) (bool, error) {
	return func(ctx context.Context) (bool, error) {
		pid, err := process.FindPidOfProcess(executablePath)
		if err != nil {
			return false, err
		}
		return pid != 0, nil
	}
}

func terminateExecutableFunc(executablePath string) func(context.Context) error {
	return func(ctx context.Context) error {
		pid, err := process.FindPidOfProcess(executablePath)
		if err != nil || pid == 0 {
			return err
		}
		proc, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("failed to find process for pid %d: %w", pid, err)
		}
		// The pid might not exist even if we did not receive an error.
		err = proc.Signal(syscall.SIGTERM)
		if err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("failed to terminate process %d: %w", pid, err)
		}
		return nil
	}
}

// checkSullaRuntime reports whether the runtime's control socket answers with
// a state other than "stopped".
func checkSullaRuntime(ctx context.Context) (bool, error) {
	cmd := exec.CommandContext(ctx, sullaRuntimePath, "status")
	result, err := cmd.Output()
	if err != nil {
		// No control socket: the runtime is not running.
		return false, nil
	}
	return !strings.Contains(string(result), `"state":"stopped"`), nil
}

func runCommandIgnoreOutput(cmd *exec.Cmd) error {
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func stopSullaRuntime(ctx context.Context) error {
	return runCommandIgnoreOutput(exec.CommandContext(ctx, sullaRuntimePath, "stop"))
}

func terminateRancherDesktopFunc(appDir string) func(context.Context) error {
	return func(ctx context.Context) error {
		var errs *multierror.Error

		errs = multierror.Append(errs, (func() error {
			mainExe, err := p.GetMainExecutable(ctx)
			if err != nil {
				return err
			}
			pid, err := process.FindPidOfProcess(mainExe)
			if err != nil {
				return err
			}
			return process.KillProcessGroup(pid, false)
		})())

		errs = multierror.Append(errs, process.TerminateProcessInDirectory(appDir, true))

		return errs.ErrorOrNil()
	}
}
