// SPDX-License-Identifier: GPL-2.0-or-later
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

func flowPair(t *testing.T) (*flowConn, *flowConn) {
	t.Helper()
	a, b := net.Pipe()
	left, right := newFlowConn(a, a), newFlowConn(b, b)
	t.Cleanup(func() { left.Close(); right.Close() })
	return left, right
}
func await(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("flow did not finish")
	}
}
func TestFlowPausedReaderAndIndependentConnection(t *testing.T) {
	a, b := flowPair(t)
	payload := bytes.Repeat([]byte("bounded-flow\n"), 32768)
	done := make(chan error, 1)
	go func() {
		_, err := a.Write(payload)
		if err == nil {
			err = a.CloseWrite()
		}
		done <- err
	}()
	time.Sleep(30 * time.Millisecond)
	a.mu.Lock()
	credit := a.credit
	a.mu.Unlock()
	b.mu.Lock()
	buffered := len(b.pending)
	b.mu.Unlock()
	if credit != 0 || buffered != flowWindow {
		t.Fatalf("producer not backpressured within bounded window: %d %d", credit, buffered)
	}
	x, y := flowPair(t)
	ping := make(chan error, 1)
	go func() { _, err := x.Write([]byte("healthy")); ping <- err }()
	got := make([]byte, 7)
	if _, err := io.ReadFull(y, got); err != nil || string(got) != "healthy" {
		t.Fatalf("independent connection interrupted: %q %v", got, err)
	}
	await(t, ping)
	data, err := io.ReadAll(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatal("paused reader lost data")
	}
	await(t, done)
}
func TestFlowSlowReaderLargerThanWindow(t *testing.T) {
	a, b := flowPair(t)
	payload := bytes.Repeat([]byte("slow-consumer"), 20000)
	done := make(chan error, 1)
	go func() {
		_, err := a.Write(payload)
		if err == nil {
			err = a.CloseWrite()
		}
		done <- err
	}()
	var got bytes.Buffer
	chunk := make([]byte, 2048)
	for {
		n, err := b.Read(chunk)
		got.Write(chunk[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	if sha256.Sum256(got.Bytes()) != sha256.Sum256(payload) {
		t.Fatal("slow transfer changed bytes")
	}
	await(t, done)
}
func TestFlowHalfCloseStillReceivesResponse(t *testing.T) {
	a, b := flowPair(t)
	done := make(chan error, 1)
	go func() {
		data, err := io.ReadAll(b)
		if err == nil && string(data) != "request" {
			err = io.ErrUnexpectedEOF
		}
		if err == nil {
			_, err = b.Write([]byte("response"))
		}
		if err == nil {
			err = b.CloseWrite()
		}
		done <- err
	}()
	if _, err := a.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := a.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(a)
	if err != nil || string(data) != "response" {
		t.Fatalf("half-close lost response %q %v", data, err)
	}
	await(t, done)
}
func TestFlowCancelWakesBlockedWriter(t *testing.T) {
	a, _ := flowPair(t)
	done := make(chan error, 1)
	go func() { _, err := a.Write(make([]byte, flowWindow*3)); done <- err }()
	time.Sleep(20 * time.Millisecond)
	a.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled write succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not wake writer")
	}
}
func TestFlowRejectsInvalidFrames(t *testing.T) {
	for _, kind := range []byte{flowData, flowCredit, flowEnd, 99} {
		t.Run(string(rune(kind+'0')), func(t *testing.T) {
			wire, peer := net.Pipe()
			c := newFlowConn(wire, wire)
			defer c.Close()
			defer peer.Close()
			header := [5]byte{kind}
			binary.BigEndian.PutUint32(header[1:], flowWindow+1)
			if _, err := peer.Write(header[:]); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { _, err := c.Read(make([]byte, 1)); done <- err }()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("invalid frame accepted")
				}
			case <-time.After(time.Second):
				t.Fatal("invalid frame hung")
			}
		})
	}
}

func TestVsockCloseInterruptsBlockedRead(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	c := &vsockConn{File: os.NewFile(uintptr(fds[0]), "test-blocking-socket")}
	defer syscall.Close(fds[1])
	done := make(chan error, 1)
	go func() { _, err := c.Read(make([]byte, 1)); done <- err }()
	time.Sleep(20 * time.Millisecond)
	c.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("raw Close did not interrupt blocking read")
	}
}
func TestFlowAbortAfterHalfCloseWakesIdleSplice(t *testing.T) {
	wire, rawPeer := net.Pipe()
	flow := newFlowConn(wire, wire)
	application, peer := net.Pipe()
	defer peer.Close()
	done := make(chan struct{})
	go func() { splice(flow, application); close(done) }()
	if err := writeFull(rawPeer, []byte{flowEnd, 0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	rawPeer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("wire abort leaked idle sibling")
	}
}
func TestFlowExecDrainsExitStatus(t *testing.T) {
	for i := 0; i < 25; i++ {
		client, server := flowPair(t)
		a := &agent{}
		go a.execSession(server)
		request, _ := json.Marshal(execRequest{Argv: []string{"/bin/sh", "-c", "printf response; exit 7"}})
		if _, err := client.Write(append(request, '\n')); err != nil {
			t.Fatal(err)
		}
		var stdout bytes.Buffer
		exit := -1
		for exit < 0 {
			var header [5]byte
			if _, err := io.ReadFull(client, header[:]); err != nil {
				t.Fatal("exit frame truncated", err)
			}
			n := binary.BigEndian.Uint32(header[1:])
			payload := make([]byte, n)
			if _, err := io.ReadFull(client, payload); err != nil {
				t.Fatal(err)
			}
			if header[0] == execStdout {
				stdout.Write(payload)
			}
			if header[0] == execExit {
				exit = int(binary.BigEndian.Uint32(payload))
			}
		}
		if stdout.String() != "response" || exit != 7 {
			t.Fatalf("lost response/status %q %d", stdout.String(), exit)
		}
		client.Close()
	}
}

type gatedSink struct {
	entered, release chan struct{}
	data             bytes.Buffer
}

func (s *gatedSink) Write(p []byte) (int, error) {
	select {
	case s.entered <- struct{}{}:
	default:
	}
	<-s.release
	return s.data.Write(p)
}
func TestFlowCopyCreditsOnlyAfterSinkAccepts(t *testing.T) {
	a, b := flowPair(t)
	sink := &gatedSink{entered: make(chan struct{}, 1), release: make(chan struct{})}
	copied := make(chan error, 1)
	go func() { _, err := io.Copy(sink, b); copied <- err }()
	written := make(chan error, 1)
	go func() {
		_, err := a.Write([]byte("last upload chunk"))
		if err == nil {
			err = a.CloseWrite()
		}
		written <- err
	}()
	<-sink.entered
	select {
	case <-written:
		t.Fatal("EOF acknowledged before target accepted data")
	case <-time.After(20 * time.Millisecond):
	}
	close(sink.release)
	await(t, written)
	await(t, copied)
	if sink.data.String() != "last upload chunk" {
		t.Fatal("trailing upload lost")
	}
}
func TestFlowProtocolCompleteEOFIsNotCancellation(t *testing.T) {
	a, b := flowPair(t)
	done := make(chan error, 2)
	go func() { done <- a.CloseWrite() }()
	go func() { done <- b.CloseWrite() }()
	await(t, done)
	await(t, done)
	// Simulate a peer releasing a completed transport without cancelling this
	// side's application consumer while it finishes already accepted work.
	a.Conn.Close()
	time.Sleep(20 * time.Millisecond)
	select {
	case <-b.done:
		t.Fatal("graceful completion reported as abort")
	default:
	}
}
