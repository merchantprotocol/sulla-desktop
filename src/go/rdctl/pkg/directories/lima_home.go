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

package directories

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// SetupLimaHome verifies the canonical Lima-home directory exists and exports
// it as LIMA_HOME for any limactl child processes. Callers must pass the
// canonical path (paths.Lima) — never re-derive `appHome/lima`, since the
// macOS appHome is too long for UNIX_PATH_MAX socket limits with longer
// usernames. paths.Lima is the SSOT — see pkg/paths/paths_darwin.go.
func SetupLimaHome(limaHome string) error {
	stat, err := os.Stat(limaHome)
	if err != nil {
		return fmt.Errorf("can't find the lima-home directory at %q: %w", limaHome, err)
	}
	if !stat.Mode().IsDir() {
		return fmt.Errorf("path %q exists but isn't a directory", limaHome)
	}
	return os.Setenv("LIMA_HOME", limaHome)
}

func GetLimactlPath() (string, error) {
	execPath, err := os.Executable()
	if err != nil {
		return "", err
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return "", err
	}
	result := filepath.Join(filepath.Dir(filepath.Dir(execPath)), "lima", "bin", "limactl")
	if runtime.GOOS == "windows" {
		result += ".exe"
	}
	return result, nil
}
