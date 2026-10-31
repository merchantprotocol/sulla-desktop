// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// The data filesystem is mounted at /mnt/data with one layout whether the
// disk is new or carried over from an earlier Sulla VM: persistent state
// lives under /mnt/data/var/lib (Docker at var/lib/docker), git worktrees
// under /mnt/data/worktrees, and what pip and npm install globally under
// /mnt/data/usr/local (the image points both at /usr/local). These trees are
// bind-mounted into place.
const (
	dataMount    = "/mnt/data"
	agentLogPath = "/var/lib/sulla-runtime/logs/sulla-agent.log"
)

var dataBinds = []struct{ source, target string }{
	{"var/lib", "/var/lib"},
	{"worktrees", "/mnt/worktrees"},
	{"home", "/home"},
	{"root", "/root"},
	{"usr/local", "/usr/local"},
}

// dataDiskPath returns the block device the host marked as the data disk with
// sulla.data=<name> on the kernel command line, waiting briefly for devtmpfs
// to create the node after virtio_blk probes.
func dataDiskPath() string {
	name := "vdb"
	if cmdline, err := os.ReadFile("/proc/cmdline"); err == nil {
		for _, field := range strings.Fields(string(cmdline)) {
			if value, ok := strings.CutPrefix(field, "sulla.data="); ok && regexp.MustCompile(`^vd[a-z]$`).MatchString(value) {
				name = value
			}
		}
	}
	path := "/dev/" + name
	waitForDevice(path)
	return path
}

func waitForDevice(path string) {
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// diskHeadIsZero reports whether the first MiB of the device is all zeros.
// A partition table lives there, so a partitioned disk is never "blank".
func diskHeadIsZero(device string) bool {
	f, err := os.Open(device)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 1<<20)
	if _, err := io.ReadFull(f, buf); err != nil {
		return false
	}
	for _, b := range buf {
		if b != 0 {
			return false
		}
	}
	return true
}

// probeFilesystem returns the filesystem type blkid reports for a device.
// found is false only when blkid ran and positively found no filesystem; any
// other failure is returned as an error and must never be read as "empty".
func probeFilesystem(device string) (fsType string, found bool, err error) {
	out, err := exec.Command("/sbin/blkid", "-p", "-o", "value", "-s", "TYPE", device).Output()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(string(out)), true, nil
}

// partitions lists the partition devices of a whole disk, in order.
func partitions(disk string) []string {
	name := filepath.Base(disk)
	entries, err := os.ReadDir(filepath.Join("/sys/block", name))
	if err != nil {
		return nil
	}
	var parts []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), name) {
			if _, err := os.Stat(filepath.Join("/sys/block", name, entry.Name(), "partition")); err == nil {
				parts = append(parts, "/dev/"+entry.Name())
			}
		}
	}
	sort.Strings(parts)
	return parts
}

// dataFilesystem picks the ext4 filesystem to mount: the whole disk, or the
// first ext4 partition of a partitioned disk. It formats only a disk that is
// provably blank.
func dataFilesystem(disk string) (string, error) {
	fsType, found, err := probeFilesystem(disk)
	if err != nil {
		return "", err
	}
	if found && fsType == "ext4" {
		return disk, nil
	}
	for _, part := range partitions(disk) {
		waitForDevice(part)
		if partType, ok, err := probeFilesystem(part); err == nil && ok && partType == "ext4" {
			return part, nil
		}
	}
	if found || !diskHeadIsZero(disk) {
		return "", errors.New("no ext4 filesystem on the data disk and it is not blank; leaving it untouched")
	}
	if err := exec.Command("/sbin/mkfs.ext4", "-F", "-L", "sulla-data", disk).Run(); err != nil {
		return "", err
	}
	return disk, nil
}

// prepareDataDisk mounts the data disk and binds its trees into place. An
// error means it is not mounted: Docker must then not start, or it would run
// on the RAM-backed root and everything set up would vanish on the next boot.
func prepareDataDisk() error {
	disk := dataDiskPath()
	if _, err := os.Stat(disk); err != nil {
		log.Printf("data disk %s missing", disk)
		return fmt.Errorf("data disk %s missing", disk)
	}
	device, err := dataFilesystem(disk)
	if err != nil {
		log.Printf("data disk not mounted: %v", err)
		return err
	}
	if err := checkDataFilesystem(device); err != nil {
		log.Printf("data disk not mounted: %v", err)
		return err
	}
	_ = os.MkdirAll(dataMount, 0755)
	if err := syscall.Mount(device, dataMount, "ext4", syscall.MS_NOATIME, ""); err != nil {
		log.Printf("mount %s on %s: %v", device, dataMount, err)
		return fmt.Errorf("mount %s: %w", device, err)
	}
	adoptEarlyLayout()
	for _, bind := range dataBinds {
		source := filepath.Join(dataMount, bind.source)
		_ = os.MkdirAll(source, 0755)
		_ = os.MkdirAll(bind.target, 0755)
		if err := syscall.Mount(source, bind.target, "", syscall.MS_BIND, ""); err != nil {
			log.Printf("bind %s on %s: %v", source, bind.target, err)
		}
	}
	_ = os.MkdirAll("/var/lib/docker", 0710)
	_ = os.MkdirAll(filepath.Dir(agentLogPath), 0755)
	return nil
}

// checkDataFilesystem repairs what an unclean shutdown left behind before the
// mount. e2fsck -p fixes the safe problems on its own; exit status 4 means it
// needs answers, and -y gives them. 8 and above is an operational error
// (e.g. it could not read the disk).
func checkDataFilesystem(device string) error {
	started := time.Now()
	status := func(err error) int {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		if err != nil {
			return 8
		}
		return 0
	}
	out, err := exec.Command("/sbin/e2fsck", "-p", device).CombinedOutput()
	code := status(err)
	if code >= 4 && code < 8 {
		log.Printf("e2fsck -p %s exited %d; repairing with -y: %s", device, code, strings.TrimSpace(string(out)))
		out, err = exec.Command("/sbin/e2fsck", "-y", device).CombinedOutput()
		code = status(err)
	}
	log.Printf("e2fsck %s exited %d in %s", device, code, time.Since(started).Round(time.Millisecond))
	if code >= 4 {
		return fmt.Errorf("e2fsck %s exited %d: %s", device, code, lastLine(string(out)))
	}
	return nil
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return lines[len(lines)-1]
}

// adoptEarlyLayout moves Docker's store from the first runtime builds, which
// kept it at the top of the disk, into var/lib/docker. Same filesystem, so
// the rename is atomic and nothing is copied.
func adoptEarlyLayout() {
	old := filepath.Join(dataMount, "docker")
	current := filepath.Join(dataMount, "var/lib/docker")
	if _, err := os.Stat(old); err != nil {
		return
	}
	if _, err := os.Stat(current); err == nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(current), 0755)
	if err := os.Rename(old, current); err != nil {
		log.Printf("move %s to %s: %v", old, current, err)
	}
}

// unmountDataDisk runs after the daemons stopped and the disks were synced.
// If something still holds a file open (the agent log), the filesystem is
// remounted read-only instead, which leaves it just as clean.
func unmountDataDisk() {
	for i := len(dataBinds) - 1; i >= 0; i-- {
		_ = syscall.Unmount(dataBinds[i].target, 0)
	}
	if err := syscall.Unmount(dataMount, 0); err != nil {
		_ = syscall.Mount("", dataMount, "", syscall.MS_REMOUNT|syscall.MS_RDONLY, "")
	}
}

// configureUser adds the account Desktop's files on the data disk belong to,
// named by sulla.user=<name> and sulla.uid=<uid> on the kernel command line,
// so ownership and home directories match what the earlier VM created.
func configureUser(l interface{ Printf(string, ...any) }) {
	name, uid := kernelArg("sulla.user"), kernelArg("sulla.uid")
	if name == "" || uid == "" || !regexp.MustCompile(`^[a-z_][a-z0-9._-]{0,31}$`).MatchString(name) ||
		!regexp.MustCompile(`^[1-9][0-9]{2,5}$`).MatchString(uid) {
		return
	}
	// The earlier VM used /home/<name>.linux; keep it when it is there.
	home := filepath.Join("/home", name+".linux")
	if _, err := os.Stat(home); err != nil {
		home = filepath.Join("/home", name)
		_ = os.MkdirAll(home, 0755)
	}
	appendLine := func(path, line string) {
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0644)
		if err != nil {
			l.Printf("%s: %v", path, err)
			return
		}
		defer f.Close()
		_, _ = f.WriteString(line + "\n")
	}
	appendLine("/etc/group", name+":x:"+uid+":")
	appendLine("/etc/passwd", name+":x:"+uid+":"+uid+"::"+home+":/bin/sh")
}
