// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"context"
	"log"
	"os/exec"
	"strings"
	"time"
)

const (
	dataTrimBootDelay = 5 * time.Minute
	dataTrimInterval  = 24 * time.Hour
)

type trimCommand interface {
	CombinedOutput(context.Context, string, ...string) ([]byte, error)
}

type execTrimCommand struct{}

func (execTrimCommand) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// dataTrimmer owns the data-disk discard schedule. Trimming is deliberately
// delayed until boot services are running, then repeated daily. Both CPU and
// I/O run at idle priority so reclaiming sparse-file blocks never delays agent
// work. A failed trim is logged and the next scheduled run still happens.
type dataTrimmer struct {
	command      trimCommand
	logger       *log.Logger
	bootDelay    time.Duration
	interval     time.Duration
	newTimer     func(time.Duration) *time.Timer
	newTicker    func(time.Duration) *time.Ticker
}

func newDataTrimmer(logger *log.Logger) *dataTrimmer {
	return &dataTrimmer{
		command:   execTrimCommand{},
		logger:    logger,
		bootDelay: dataTrimBootDelay,
		interval:  dataTrimInterval,
		newTimer:  time.NewTimer,
		newTicker: time.NewTicker,
	}
}

func (trimmer *dataTrimmer) run(ctx context.Context) {
	bootTimer := trimmer.newTimer(trimmer.bootDelay)
	defer bootTimer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-bootTimer.C:
		trimmer.trim(ctx)
	}

	ticker := trimmer.newTicker(trimmer.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			trimmer.trim(ctx)
		}
	}
}

func (trimmer *dataTrimmer) trim(ctx context.Context) {
	output, err := trimmer.command.CombinedOutput(ctx,
		"nice", "-n", "19",
		"ionice", "-c", "3",
		"fstrim", "-v", dataMount,
	)
	message := strings.TrimSpace(string(output))
	if err != nil {
		trimmer.logger.Printf("data trim failed: %v output=%s", err, message)
		return
	}
	trimmer.logger.Printf("data trim complete: %s", message)
}
