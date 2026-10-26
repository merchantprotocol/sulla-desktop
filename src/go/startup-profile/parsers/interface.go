package parsers

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/rancher-sandbox/rancher-desktop/src/go/startup-profile/model"
)

// A Parser is a function that processes some kind of log file and emits events
// into the provided channel.
type Parser func(context.Context) ([]*model.Event, error)

const appName = "rancher-desktop"

// logsDirectory returns the application logs directory, matching
// pkg/rancher-desktop/utils/paths.ts. RD_LOGS_DIR overrides it.
func logsDirectory() (string, error) {
	if dir := os.Getenv("RD_LOGS_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Logs", appName), nil
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(localAppData, appName, "logs"), nil
	default:
		dataHome := os.Getenv("XDG_DATA_HOME")
		if dataHome == "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(dataHome, appName, "logs"), nil
	}
}

// Given the name of a log file, return a scanner that reads from the given file
// in the Rancher Desktop logs directory.
func readRDLogFile(ctx context.Context, name string) (*bufio.Scanner, error) {
	logs, err := logsDirectory()
	if err != nil {
		return nil, err
	}
	logPath := filepath.Join(logs, name)
	logFile, err := os.Open(logPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open log file %s: %w", logPath, err)
	}

	go func() {
		<-ctx.Done()
		_ = logFile.Close()
	}()

	return bufio.NewScanner(logFile), nil
}
