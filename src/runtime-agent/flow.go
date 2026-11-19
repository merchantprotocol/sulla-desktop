// SPDX-License-Identifier: GPL-2.0-or-later
package main

// Credit-limited framing prevents one unread host socket from filling a VZ
// receive buffer and starving unrelated virtual sockets. Application backpressure
// stays at this connection's TCP producer, rather than the shared device.
import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
)

const flowPort = 1026
const flowWindow = 32 * 1024
const flowChunk = 8 * 1024
const (
	flowData byte = iota
	flowCredit
	flowEnd
)

var hostFlowEnabled atomic.Bool
var hostFlowReady = make(chan struct{})
var hostFlowKnown sync.Once
var flowSupported atomic.Bool

type flowConn struct {
	net.Conn
	reader                    io.Reader
	mu                        sync.Mutex
	changed                   *sync.Cond
	send                      sync.Mutex
	frame                     sync.Mutex
	credit                    int
	pending                   []byte
	readEnd, writeEnd, closed bool
	failure                   error
	done                      chan struct{}
}

func newFlowConn(raw net.Conn, reader io.Reader) *flowConn {
	c := &flowConn{Conn: raw, reader: reader, credit: flowWindow, done: make(chan struct{})}
	c.changed = sync.NewCond(&c.mu)
	go c.receive()
	return c
}
func (c *flowConn) stop(err error) {
	c.mu.Lock()
	if !c.closed {
		close(c.done)
	}
	c.closed = true
	if c.failure == nil {
		c.failure = err
	}
	c.changed.Broadcast()
	c.mu.Unlock()
	_ = c.Conn.Close()
}
func (c *flowConn) Close() error { c.stop(net.ErrClosed); return nil }
func (c *flowConn) sendFrame(kind byte, count int, data []byte) error {
	c.frame.Lock()
	defer c.frame.Unlock()
	header := [5]byte{kind}
	binary.BigEndian.PutUint32(header[1:], uint32(count))
	if err := writeFull(c.Conn, header[:]); err != nil {
		c.stop(err)
		return err
	}
	if err := writeFull(c.Conn, data); err != nil {
		c.stop(err)
		return err
	}
	return nil
}
func writeFull(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}
func (c *flowConn) receive() {
	for {
		var header [5]byte
		if _, err := io.ReadFull(c.reader, header[:]); err != nil {
			if errors.Is(err, io.EOF) {
				c.mu.Lock()
				complete := c.readEnd && c.writeEnd && c.credit == flowWindow
				c.mu.Unlock()
				if complete {
					return
				}
				err = io.ErrUnexpectedEOF
			}
			c.stop(err)
			return
		}
		count := int(binary.BigEndian.Uint32(header[1:]))
		kind := header[0]
		switch kind {
		case flowData:
			if count < 1 || count > flowChunk {
				c.stop(errors.New("invalid flow data size"))
				return
			}
			data := make([]byte, count)
			if _, err := io.ReadFull(c.reader, data); err != nil {
				c.stop(err)
				return
			}
			c.mu.Lock()
			if c.readEnd || len(c.pending)+count > flowWindow {
				c.mu.Unlock()
				c.stop(errors.New("flow window exceeded"))
				return
			}
			c.pending = append(c.pending, data...)
			c.changed.Broadcast()
			c.mu.Unlock()
		case flowCredit:
			c.mu.Lock()
			if count < 1 || c.credit+count > flowWindow {
				c.mu.Unlock()
				c.stop(errors.New("invalid flow credit"))
				return
			}
			c.credit += count
			c.changed.Broadcast()
			c.mu.Unlock()
		case flowEnd:
			c.mu.Lock()
			if count != 0 || c.readEnd {
				c.mu.Unlock()
				c.stop(errors.New("invalid flow end"))
				return
			}
			c.readEnd = true
			c.changed.Broadcast()
			c.mu.Unlock()
		default:
			c.stop(errors.New("invalid flow frame"))
			return
		}
	}
}
func (c *flowConn) Read(p []byte) (int, error) { return c.readBytes(p, true) }
func (c *flowConn) readBytes(p []byte, acknowledge bool) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.mu.Lock()
	for len(c.pending) == 0 && !c.readEnd && !c.closed {
		c.changed.Wait()
	}
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		c.mu.Unlock()
		if acknowledge {
			if err := c.sendFrame(flowCredit, n, nil); err != nil {
				return n, err
			}
		}
		return n, nil
	}
	if c.readEnd {
		c.mu.Unlock()
		return 0, io.EOF
	}
	err := c.failure
	c.mu.Unlock()
	return 0, err
}

// io.Copy uses this path for forwarding: return credit only after the real
// TCP/Unix consumer accepts the bytes, not when a temporary copy buffer reads.
func (c *flowConn) WriteTo(dst io.Writer) (int64, error) {
	var total int64
	buffer := make([]byte, flowChunk)
	for {
		n, err := c.readBytes(buffer, false)
		if n > 0 {
			if err := writeFull(dst, buffer[:n]); err != nil {
				// These bytes already left the receive window and are now dropped:
				// release that window, or a caller that discards the rest cannot
				// let the peer's END (which waits for full credit) complete.
				_ = c.sendFrame(flowCredit, n, nil)
				return total, err
			}
			total += int64(n)
			if err := c.sendFrame(flowCredit, n, nil); err != nil {
				return total, err
			}
		}
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			return total, err
		}
	}
}
func (c *flowConn) Write(p []byte) (int, error) {
	c.send.Lock()
	defer c.send.Unlock()
	written := 0
	for len(p) > 0 {
		c.mu.Lock()
		for c.credit == 0 && !c.closed && !c.writeEnd {
			c.changed.Wait()
		}
		if c.closed || c.writeEnd {
			err := c.failure
			if err == nil {
				err = net.ErrClosed
			}
			c.mu.Unlock()
			return written, err
		}
		n := min(len(p), flowChunk, c.credit)
		c.credit -= n
		c.mu.Unlock()
		if err := c.sendFrame(flowData, n, p[:n]); err != nil {
			return written, err
		}
		written += n
		p = p[n:]
	}
	return written, nil
}

// Do not announce EOF until every preceding byte reached the peer's consumer.
// This lets existing io.Copy/CloseWrite handlers preserve trailing responses.
func (c *flowConn) CloseWrite() error {
	c.send.Lock()
	defer c.send.Unlock()
	c.mu.Lock()
	for c.credit != flowWindow && !c.closed {
		c.changed.Wait()
	}
	if c.closed {
		err := c.failure
		c.mu.Unlock()
		return err
	}
	if c.writeEnd {
		c.mu.Unlock()
		return nil
	}
	c.writeEnd = true
	c.mu.Unlock()
	return c.sendFrame(flowEnd, 0, nil)
}
func (a *agent) startFlowServer() bool {
	l, err := vsockListener(flowPort)
	if err != nil {
		a.log.Printf("flow listener unavailable: %v", err)
		return false
	}
	go func() {
		defer l.Close()
		for {
			c, err := l.Accept()
			if err != nil {
				if a.ctx.Err() != nil {
					return
				}
				continue
			}
			go a.flowSession(c)
		}
	}()
	return true
}
func (a *agent) flowSession(raw net.Conn) {
	r := bufio.NewReaderSize(raw, 4096)
	var request struct {
		Version int `json:"version"`
		Port    int `json:"port"`
	}
	if readFrame(r, &request) != nil || request.Version != 1 {
		raw.Close()
		return
	}
	if request.Port != 1025 && request.Port != 2375 && request.Port != 2376 {
		raw.Close()
		return
	}
	if writeFrame(raw, map[string]int{"flowControl": 1}) != nil {
		raw.Close()
		return
	}
	c := newFlowConn(raw, r)
	switch request.Port {
	case 1025:
		a.execSession(c)
	case 2375:
		proxyDocker(c)
	case 2376:
		a.forwardSession(c)
	}
}
