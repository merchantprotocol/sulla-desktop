// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
)

// Guest exec (vsock 1025) runs one command per connection for Desktop's own
// setup work: writing service config into the data disk, preparing mount
// anchors, running docker compose. It replaces the SSH shell of the old VM.
//
// The connection opens with one JSON line:
//
//	{"argv":["sh","-c","..."],"workdir":"/","env":["K=V"]}
//
// after which both directions carry frames of [1-byte stream][4-byte
// big-endian length][payload]. Stream 0 is stdin (client to guest; an empty
// frame closes it), 1 is stdout, 2 is stderr, and 3 carries the exit code as a
// 4-byte big-endian int32 and ends the session. 255 means the command could
// not be started.
const (
	execStdin  = 0
	execStdout = 1
	execStderr = 2
	execExit   = 3

	maxExecFrame = 1 << 20
)

type execRequest struct {
	Argv    []string `json:"argv"`
	Workdir string   `json:"workdir"`
	Env     []string `json:"env"`
}

func (a *agent) execServer() {
	l, err := vsockListener(1025)
	if err != nil {
		a.log.Printf("exec vsock: %v", err)
		return
	}
	defer l.Close()
	a.log.Printf("exec listening on vsock port 1025")
	for {
		c, err := l.Accept()
		if err != nil {
			if a.ctx.Err() != nil {
				return
			}
			continue
		}
		go a.execSession(c)
	}
}

type frameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (f *frameWriter) frame(stream byte, payload []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	header := [5]byte{stream}
	binary.BigEndian.PutUint32(header[1:], uint32(len(payload)))
	if _, err := f.w.Write(header[:]); err != nil {
		return err
	}
	_, err := f.w.Write(payload)
	return err
}

type streamWriter struct {
	out    *frameWriter
	stream byte
}

func (s streamWriter) Write(p []byte) (int, error) {
	for offset := 0; offset < len(p); offset += maxExecFrame {
		end := min(offset+maxExecFrame, len(p))
		if err := s.out.frame(s.stream, p[offset:end]); err != nil {
			return offset, err
		}
	}
	return len(p), nil
}

func exitFrame(code int) []byte {
	payload := make([]byte, 4)
	binary.BigEndian.PutUint32(payload, uint32(int32(code)))
	return payload
}

func (a *agent) execSession(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, maxMessage)
	out := &frameWriter{w: c}
	var req execRequest
	if err := readFrame(r, &req); err != nil || len(req.Argv) == 0 {
		_ = out.frame(execStderr, []byte("invalid exec request\n"))
		_ = out.frame(execExit, exitFrame(255))
		return
	}
	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = req.Workdir
	if cmd.Dir == "" {
		cmd.Dir = "/"
	}
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=/root"}, req.Env...)
	// Own process group, so a dropped connection can stop the whole tree.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout = streamWriter{out, execStdout}
	cmd.Stderr = streamWriter{out, execStderr}
	stdin, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		_ = out.frame(execStderr, []byte(err.Error()+"\n"))
		_ = out.frame(execExit, exitFrame(255))
		return
	}
	var exited atomic.Bool
	go func() {
		err := copyStdinFrames(r, stdin)
		_ = stdin.Close()
		// The client keeps the connection open until the exit frame, so any
		// later EOF means it went away (killed, or the app quit): stop the
		// whole process group it started.
		for err == nil {
			_, err = r.ReadByte()
		}
		if !exited.Load() {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}()
	code := 0
	err = cmd.Wait()
	exited.Store(true)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = 255
		}
	}
	_ = out.frame(execExit, exitFrame(code))
}

// copyStdinFrames forwards stdin frames until the empty frame that closes it.
func copyStdinFrames(r *bufio.Reader, stdin io.Writer) error {
	var header [5]byte
	for {
		if _, err := io.ReadFull(r, header[:]); err != nil {
			return err
		}
		size := binary.BigEndian.Uint32(header[1:])
		if header[0] != execStdin || size > maxExecFrame {
			return errors.New("invalid stdin frame")
		}
		if size == 0 {
			return nil
		}
		if _, err := io.CopyN(stdin, r, int64(size)); err != nil {
			return err
		}
	}
}
