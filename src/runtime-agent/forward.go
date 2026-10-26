package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

// Two forwarding channels connect guest loopback services and the Mac.
//
// Published ports (vsock 2376, host-initiated): the host opens one stream per
// Mac connection and sends {"port":N}. The agent dials 127.0.0.1:N in the
// guest, where dockerd's userland proxy listens for every published port, and
// splices the two. Only guest loopback is reachable this way.
//
// Mac loopback (vsock 1100, guest-initiated): TCP from the guest or any
// container to hostLoopbackIP:N is redirected to the agent on loopbackPort.
// The agent reads the original port and opens a vsock stream to the host,
// sending {"port":N}; the host dials only 127.0.0.1:N on the Mac. This keeps
// the address the old VM gave the Mac, so callers need no change.
const (
	forwardVsockPort  = 2376
	loopbackVsockPort = 1100
	loopbackPort      = 1100
	hostLoopbackIP    = "192.168.5.2"
	vmaddrCIDHost     = 2
	soOriginalDst     = 80
)

var hostAliases = []string{"host.sulla.internal", "host.docker.internal"}

type portHeader struct {
	Port int `json:"port"`
}

func splice(left, right net.Conn) {
	done := make(chan struct{}, 2)
	half := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go half(left, right)
	go half(right, left)
	<-done
	<-done
}

func (a *agent) forwardServer() {
	l, err := vsockListener(forwardVsockPort)
	if err != nil {
		a.log.Printf("forward vsock: %v", err)
		return
	}
	defer l.Close()
	a.log.Printf("port forwarding listening on vsock port %d", forwardVsockPort)
	for {
		c, err := l.Accept()
		if err != nil {
			if a.ctx.Err() != nil {
				return
			}
			continue
		}
		go a.forwardSession(c)
	}
}

func (a *agent) forwardSession(host net.Conn) {
	defer host.Close()
	r := bufio.NewReaderSize(host, 4096)
	var header portHeader
	if err := readFrame(r, &header); err != nil || header.Port < 1 || header.Port > 65535 {
		return
	}
	guest, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(header.Port)))
	if err != nil {
		return
	}
	defer guest.Close()
	// Bytes the client sent right behind the header are already buffered.
	if n := r.Buffered(); n > 0 {
		buffered, _ := r.Peek(n)
		if _, err := guest.Write(buffered); err != nil {
			return
		}
	}
	splice(host, guest)
}

// configureHostLoopback makes hostLoopbackIP reach the Mac. It runs once the
// network is up; Docker adds its own chains later and leaves these alone.
func configureHostLoopback(l interface{ Printf(string, ...any) }) {
	hosts := "127.0.0.1 localhost\n::1 localhost\n"
	for _, alias := range hostAliases {
		hosts += hostLoopbackIP + " " + alias + "\n"
	}
	if err := os.WriteFile("/etc/hosts", []byte(hosts), 0644); err != nil {
		l.Printf("write /etc/hosts: %v", err)
	}
	// A host route keeps the address reachable from the guest itself even when
	// the NAT network is off or not up yet; REDIRECT takes it from there.
	if out, err := exec.Command("/sbin/ip", "route", "replace", hostLoopbackIP+"/32", "dev", "lo").CombinedOutput(); err != nil {
		l.Printf("route %s: %v %s", hostLoopbackIP, err, out)
	}
	for _, chain := range []string{"OUTPUT", "PREROUTING"} {
		args := []string{"-t", "nat", "-I", chain, "1", "-d", hostLoopbackIP + "/32", "-p", "tcp", "-j", "REDIRECT", "--to-ports", strconv.Itoa(loopbackPort)}
		if out, err := exec.Command("iptables", args...).CombinedOutput(); err != nil {
			l.Printf("iptables %s: %v %s", chain, err, out)
		}
	}
}

func (a *agent) hostLoopbackServer() {
	l, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", loopbackPort))
	if err != nil {
		a.log.Printf("host loopback listener: %v", err)
		return
	}
	defer l.Close()
	a.log.Printf("host loopback %s redirected to port %d", hostLoopbackIP, loopbackPort)
	for {
		c, err := l.Accept()
		if err != nil {
			if a.ctx.Err() != nil {
				return
			}
			continue
		}
		go a.hostLoopbackSession(c.(*net.TCPConn))
	}
}

func (a *agent) hostLoopbackSession(c *net.TCPConn) {
	defer c.Close()
	ip, port, err := originalDestination(c)
	// Only redirected traffic for the Mac's address is forwarded; a direct
	// connection to the listener itself is dropped.
	if err != nil || ip != hostLoopbackIP || port == loopbackPort {
		return
	}
	host, err := dialHostVsock(loopbackVsockPort)
	if err != nil {
		a.log.Printf("host loopback vsock: %v", err)
		return
	}
	defer host.Close()
	if err := writeFrame(host, portHeader{Port: port}); err != nil {
		return
	}
	splice(c, host)
}

func originalDestination(c *net.TCPConn) (string, int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return "", 0, err
	}
	var addr *syscall.IPv6Mreq
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		// SO_ORIGINAL_DST returns a sockaddr_in; IPv6Mreq is a 20-byte buffer
		// the standard library can fill, of which the first 8 bytes are used.
		addr, sockErr = syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, soOriginalDst)
	}); err != nil {
		return "", 0, err
	}
	if sockErr != nil {
		return "", 0, sockErr
	}
	b := addr.Multiaddr
	port := int(binary.BigEndian.Uint16(b[2:4]))
	return net.IPv4(b[4], b[5], b[6], b[7]).String(), port, nil
}

func dialHostVsock(port uint32) (net.Conn, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	sa := sockaddrVM{Family: afVsock, Port: port, CID: vmaddrCIDHost}
	_, _, errno := syscall.Syscall(syscall.SYS_CONNECT, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if errno != 0 {
		syscall.Close(fd)
		return nil, errno
	}
	return &vsockConn{os.NewFile(uintptr(fd), "vsock-host")}, nil
}
