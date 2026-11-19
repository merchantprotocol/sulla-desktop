// SPDX-License-Identifier: GPL-2.0-or-later
package main

import (
	"bytes"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A guest service that rejects an upload part way through (EPIPE on the
// agent's write) but still sends a complete response, like an HTTP 413 or a
// PostgreSQL ErrorResponse followed by close.
type rejectingService struct {
	net.Conn
	limit    int
	mu       sync.Mutex
	accepted int
	rejected chan struct{}
	once     sync.Once
}

func (s *rejectingService) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.limit - s.accepted
	if room <= 0 {
		s.once.Do(func() { close(s.rejected) })
		return 0, syscall.EPIPE
	}
	n := min(room, len(p))
	s.accepted += n
	if n < len(p) {
		s.once.Do(func() { close(s.rejected) })
		return n, syscall.EPIPE
	}
	return n, nil
}

// newRejectingService returns the agent-side application conn. The service
// writes its whole response only after it has rejected the upload, then closes.
func newRejectingService(t *testing.T, limit int, response []byte) *rejectingService {
	t.Helper()
	agentSide, serviceSide := net.Pipe()
	s := &rejectingService{Conn: agentSide, limit: limit, rejected: make(chan struct{})}
	go func() {
		defer serviceSide.Close()
		select {
		case <-s.rejected:
		case <-time.After(5 * time.Second):
			return
		}
		_, _ = serviceSide.Write(response)
	}()
	return s
}

func unixPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	conn := func(fd int) *net.UnixConn {
		f := os.NewFile(uintptr(fd), "unix-pair")
		defer f.Close()
		c, err := net.FileConn(f)
		if err != nil {
			t.Fatal(err)
		}
		return c.(*net.UnixConn)
	}
	a, b := conn(fds[0]), conn(fds[1])
	t.Cleanup(func() { a.Close(); b.Close() })
	return a, b
}

func spliceInBackground(left, right net.Conn) <-chan struct{} {
	finished := make(chan struct{})
	go func() { splice(left, right); close(finished) }()
	return finished
}

func awaitClosed(t *testing.T, finished <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal(what)
	}
}

// Framed: the host keeps uploading past the guest service's rejection. The
// whole response (larger than the flow window) must still reach the host, the
// host's upload and END must complete instead of stalling on credit, and the
// connection must finish both halves.
func TestFlowServiceRejectingUploadStillDeliversWholeResponse(t *testing.T) {
	host, guestWire := flowPair(t)
	response := bytes.Repeat([]byte("response-after-rejection\n"), 4000) // ~98 KiB
	service := newRejectingService(t, 16*1024, response)
	finished := spliceInBackground(guestWire, service)

	uploaded := make(chan error, 1)
	go func() {
		_, err := host.Write(bytes.Repeat([]byte("u"), 4*flowWindow))
		if err == nil {
			err = host.CloseWrite()
		}
		uploaded <- err
	}()
	received, err := io.ReadAll(host)
	if err != nil {
		t.Fatalf("response aborted after %d bytes: %v", len(received), err)
	}
	if !bytes.Equal(received, response) {
		t.Fatalf("response truncated or altered: got %d of %d bytes", len(received), len(response))
	}
	await(t, uploaded)
	awaitClosed(t, finished, "connection did not finish after both halves ended")
	if service.accepted != 16*1024 {
		t.Fatalf("service accepted %d bytes", service.accepted)
	}
}

// Framed: a genuine wire failure while the rejected upload is being drained
// must still cancel the connection promptly.
func TestFlowWireAbortAfterServiceRejectionCancelsSplice(t *testing.T) {
	wire, rawHost := net.Pipe()
	guestWire := newFlowConn(wire, wire)
	service := newRejectingService(t, 1, bytes.Repeat([]byte("r"), 2*flowWindow))
	finished := spliceInBackground(guestWire, service)
	// One DATA frame the service rejects, then the host vanishes mid-stream.
	if err := writeFull(rawHost, append([]byte{flowData, 0, 0, 0, 8}, []byte("rejected")...)); err != nil {
		t.Fatal(err)
	}
	<-service.rejected
	rawHost.Close()
	awaitClosed(t, finished, "wire abort did not cancel a draining connection")
}

// Raw (legacy peer): the same rejection must not close the vsock before the
// service's whole response has been forwarded and half-closed.
func TestRawServiceRejectingUploadStillDeliversWholeResponse(t *testing.T) {
	host, guestWire := unixPair(t)
	response := bytes.Repeat([]byte("legacy-response\n"), 6000) // ~94 KiB
	service := newRejectingService(t, 16*1024, response)
	finished := spliceInBackground(guestWire, service)

	go func() { _, _ = host.Write(bytes.Repeat([]byte("u"), 4*flowWindow)) }()
	_ = host.SetReadDeadline(time.Now().Add(5 * time.Second))
	received, err := io.ReadAll(host)
	if err != nil {
		t.Fatalf("legacy response aborted after %d bytes: %v", len(received), err)
	}
	if !bytes.Equal(received, response) {
		t.Fatalf("legacy response truncated or altered: got %d of %d bytes", len(received), len(response))
	}
	awaitClosed(t, finished, "legacy connection did not finish after the response")
}
