// sulla-runtime-agent is the immutable guest's PID 1, service supervisor, and
// AF_VSOCK endpoint. It deliberately has no general command-execution API.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	version      = "0.1.0"
	afVsock      = 40
	vmaddrCIDAny = 0xffffffff
)

var boot = time.Now()

type agent struct {
	ctx      context.Context
	cancel   context.CancelFunc
	state    *stateStore
	log      *log.Logger
	subsMu   sync.Mutex
	subs     map[chan event]struct{}
	unitsMu  sync.Mutex
	units    map[string]*exec.Cmd
	shutting bool
}

type sockaddrVM struct {
	Family    uint16
	Reserved1 uint16
	Port      uint32
	CID       uint32
	Flags     uint8
	Zero      [3]uint8
}

type vsockAddr string

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return string(a) }

type vsockConn struct{ *os.File }

func (c *vsockConn) LocalAddr() net.Addr                { return vsockAddr("local") }
func (c *vsockConn) RemoteAddr() net.Addr               { return vsockAddr("peer") }
func (c *vsockConn) SetDeadline(t time.Time) error      { return c.File.SetDeadline(t) }
func (c *vsockConn) SetReadDeadline(t time.Time) error  { return c.File.SetReadDeadline(t) }
func (c *vsockConn) SetWriteDeadline(t time.Time) error { return c.File.SetWriteDeadline(t) }
func (c *vsockConn) CloseWrite() error                  { return syscall.Shutdown(int(c.Fd()), syscall.SHUT_WR) }

type vsockRawListener struct {
	fd   int
	port uint32
}

func (l *vsockRawListener) Accept() (net.Conn, error) {
	// syscall.Accept decodes the peer address and has no AF_VSOCK case: it
	// closes the accepted socket and returns EAFNOSUPPORT, so every host
	// connection would see an immediate EOF. Accept without an address.
	fd, _, errno := syscall.Syscall6(syscall.SYS_ACCEPT4, uintptr(l.fd), 0, 0, syscall.SOCK_CLOEXEC, 0, 0)
	if errno != 0 {
		return nil, errno
	}
	return &vsockConn{os.NewFile(fd, "vsock-peer")}, nil
}
func (l *vsockRawListener) Close() error   { return syscall.Close(l.fd) }
func (l *vsockRawListener) Addr() net.Addr { return vsockAddr(fmt.Sprintf("any:%d", l.port)) }

func main() {
	_ = os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	// The root filesystem is the initramfs, which pivot_root cannot leave;
	// this makes runc enter containers with a move mount and chroot instead.
	_ = os.Setenv("DOCKER_RAMDISK", "true")
	ctx, cancel := context.WithCancel(context.Background())
	a := &agent{ctx: ctx, cancel: cancel, state: newStateStore(), subs: map[chan event]struct{}{}, units: map[string]*exec.Cmd{}}
	if os.Getpid() == 1 {
		go a.reapAdopted()
	}
	mustMount("proc", "/proc", "proc", 0, "")
	setClockFromCmdline()
	mustMount("sysfs", "/sys", "sysfs", 0, "")
	// nosuid/nodev are mount flags; passed as option text the kernel rejects
	// the whole mount with EINVAL and /dev never gets device nodes.
	mustMount("devtmpfs", "/dev", "devtmpfs", syscall.MS_NOSUID, "mode=0755")
	ensureDevices()
	loadKernelModules()
	mustMount("cgroup2", "/sys/fs/cgroup", "cgroup2", 0, "")
	mustMount("tmpfs", "/run", "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=0755")
	_ = os.MkdirAll("/var/lib/sulla-data", 0755)
	prepareDataDisk()
	a.log = openLogger()
	a.log.Printf("sulla-runtime-agent %s booting", version)
	for _, e := range moduleErrors {
		a.log.Printf("modprobe %s", e)
	}
	_ = os.WriteFile("/proc/sys/kernel/hostname", []byte("sulla-runtime\n"), 0644)
	go configureNetwork(a.log)
	go a.controlServer()
	go a.dockerProxy()
	go a.supervise("containerd", "/usr/bin/containerd", "--address", "/run/containerd/containerd.sock", "--state", "/run/containerd")
	go a.supervise("dockerd", "/usr/bin/dockerd", "--host=unix:///run/docker.sock", "--data-root=/var/lib/docker", "--exec-root=/run/docker", "--pidfile=/run/docker.pid", "--containerd=/run/containerd/containerd.sock")
	go a.watchDocker()
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGPWR)
	select {
	case <-sigs:
		a.shutdown()
	case <-ctx.Done():
	}
	// PID 1 must not exit: the kernel panics. Flush disks and power off.
	if os.Getpid() == 1 {
		syscall.Sync()
		_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	}
}

func uptime() int64 { return time.Since(boot).Milliseconds() }
func mustMount(source, target, fs string, flags uintptr, data string) {
	_ = os.MkdirAll(target, 0755)
	if err := syscall.Mount(source, target, fs, flags, data); err != nil && err != syscall.EBUSY {
		fmt.Fprintf(os.Stderr, "mount %s: %v\n", target, err)
	}
}

func ensureDevices() {
	for path, dev := range map[string]uint64{
		"/dev/null": 3, "/dev/zero": 5, "/dev/random": 8, "/dev/urandom": 9,
	} {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			_ = syscall.Mknod(path, syscall.S_IFCHR|0666, int(dev|(1<<8)))
		}
	}
}

func loadKernelModules() {
	// The distribution kernel builds every virtio driver as a module, and
	// Virtualization.framework exposes all devices over virtio-pci. Without
	// virtio_pci the guest has no disk, console, network or vsock.
	for _, module := range []string{
		"virtio_pci", "virtio_blk", "virtio_net", "virtio_console", "virtio_balloon", "virtio-rng",
		"vmw_vsock_virtio_transport",
		"overlay", "nf_tables", "nft_chain_nat", "br_netfilter",
		"x_tables", "ip_tables", "iptable_nat",
	} {
		if out, err := exec.Command("/sbin/modprobe", module).CombinedOutput(); err != nil {
			moduleErrors = append(moduleErrors, fmt.Sprintf("%s: %v %s", module, err, strings.TrimSpace(string(out))))
		}
	}
}

// moduleErrors is filled before the logger exists and reported once it does.
var moduleErrors []string

// setClockFromCmdline sets the wall clock from sulla.time=<unix seconds>,
// which the host passes at boot because the guest has no RTC to read.
func setClockFromCmdline() {
	cmdline, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return
	}
	for _, field := range strings.Fields(string(cmdline)) {
		value, ok := strings.CutPrefix(field, "sulla.time=")
		if !ok {
			continue
		}
		if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds > 0 {
			tv := syscall.Timeval{Sec: seconds}
			_ = syscall.Settimeofday(&tv)
		}
	}
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
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(path); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return path
}

// diskHeadIsZero reports whether the first MiB of the device is all zeros.
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

func prepareDataDisk() {
	disk := dataDiskPath()
	if _, err := os.Stat(disk); err != nil {
		return
	}
	// Format only a provably blank disk. A failed probe (missing binary, I/O
	// error) must never be read as "empty": that would wipe the Docker store.
	out, err := exec.Command("/sbin/blkid", "-p", "-o", "value", "-s", "TYPE", disk).Output()
	fsType := strings.TrimSpace(string(out))
	probeFoundNothing := false
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 2 {
		probeFoundNothing = true
	}
	switch {
	case err == nil && fsType == "ext4":
	case probeFoundNothing && diskHeadIsZero(disk):
		if err := exec.Command("/sbin/mkfs.ext4", "-F", "-L", "sulla-data", disk).Run(); err != nil {
			log.Printf("data disk format failed: %v", err)
			return
		}
	default:
		log.Printf("data disk not mounted: type=%q probe error=%v", fsType, err)
		return
	}
	mustMount(disk, "/var/lib/sulla-data", "ext4", syscall.MS_NOATIME, "")
	for _, d := range []string{"docker", "logs"} {
		_ = os.MkdirAll(filepath.Join("/var/lib/sulla-data", d), 0755)
	}
	_ = os.MkdirAll("/var/lib/docker", 0755)
	_ = syscall.Mount("/var/lib/sulla-data/docker", "/var/lib/docker", "", syscall.MS_BIND, "")
}

func openLogger() *log.Logger {
	var writers []io.Writer
	if c, err := os.OpenFile("/dev/hvc0", os.O_WRONLY, 0); err == nil {
		writers = append(writers, c)
	} else {
		writers = append(writers, os.Stderr)
	}
	if f, err := os.OpenFile("/var/lib/sulla-data/logs/sulla-agent.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); err == nil {
		writers = append(writers, f)
	}
	return log.New(io.MultiWriter(writers...), "", log.LstdFlags|log.Lmicroseconds)
}

func configureNetwork(l *log.Logger) {
	_ = exec.Command("/sbin/ip", "link", "set", "lo", "up").Run()
	if err := exec.Command("/sbin/ip", "link", "set", "eth0", "up").Run(); err != nil {
		l.Printf("eth0: %v", err)
		return
	}
	if err := exec.Command("/sbin/udhcpc", "-q", "-n", "-i", "eth0").Run(); err != nil {
		l.Printf("dhcp: %v", err)
	}
}

func (a *agent) reapAdopted() {
	for {
		entries, _ := filepath.Glob("/proc/[0-9]*/stat")
		for _, entry := range entries {
			b, err := os.ReadFile(entry)
			if err != nil {
				continue
			}
			fields := strings.Fields(string(b))
			if len(fields) < 4 || fields[3] != "1" {
				continue
			}
			pid, _ := strconv.Atoi(filepath.Base(filepath.Dir(entry)))
			a.unitsMu.Lock()
			managed := false
			for _, cmd := range a.units {
				if cmd.Process != nil && cmd.Process.Pid == pid {
					managed = true
					break
				}
			}
			a.unitsMu.Unlock()
			if !managed {
				var status syscall.WaitStatus
				_, _ = syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (a *agent) emit(name, unit, detail, state string) {
	e := event{Type: "event", Name: name, UptimeMS: uptime(), Detail: detail}
	if unit != "" {
		e.Unit = &unit
	}
	a.state.record(e, state)
	a.log.Printf("event=%s unit=%s uptime_ms=%d detail=%s", name, unit, e.UptimeMS, detail)
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	for ch := range a.subs {
		select {
		case ch <- e:
		default:
		}
	}
}

func (a *agent) supervise(name, path string, args ...string) {
	backoff := 100 * time.Millisecond
	for a.ctx.Err() == nil {
		a.emit("unit-started", name, "", "starting")
		cmd := exec.CommandContext(a.ctx, path, args...)
		cmd.Stdout = a.log.Writer()
		cmd.Stderr = a.log.Writer()
		a.unitsMu.Lock()
		a.units[name] = cmd
		err := cmd.Start()
		a.unitsMu.Unlock()
		if err == nil {
			a.emit("unit-ready", name, "process started", "ready")
			err = cmd.Wait()
		}
		a.unitsMu.Lock()
		delete(a.units, name)
		stopping := a.shutting
		a.unitsMu.Unlock()
		if stopping || a.ctx.Err() != nil {
			a.emit("unit-failed", name, "stopped", "stopped")
			return
		}
		a.emit("unit-failed", name, fmt.Sprint(err), "failed")
		time.Sleep(backoff)
		if backoff < 5*time.Second {
			backoff *= 2
		}
	}
}

func (a *agent) watchDocker() {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			if dockerPing() == nil {
				a.emit("docker-ready", "", "", "")
				return
			}
		}
	}
}
func dockerPing() error {
	c, e := net.DialTimeout("unix", "/run/docker.sock", 100*time.Millisecond)
	if e != nil {
		return e
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(200 * time.Millisecond))
	_, e = io.WriteString(c, "GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n")
	if e != nil {
		return e
	}
	line, e := bufio.NewReader(c).ReadString('\n')
	if e != nil {
		return e
	}
	if !strings.Contains(line, " 200 ") {
		return fmt.Errorf("docker ping: %s", strings.TrimSpace(line))
	}
	return nil
}

func vsockListener(port uint32) (net.Listener, error) {
	fd, e := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	sa := sockaddrVM{Family: afVsock, Port: port, CID: vmaddrCIDAny}
	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if errno != 0 {
		syscall.Close(fd)
		return nil, errno
	}
	if e = syscall.Listen(fd, 128); e != nil {
		syscall.Close(fd)
		return nil, e
	}
	return &vsockRawListener{fd: fd, port: port}, nil
}

func (a *agent) controlServer() {
	l, e := vsockListener(1024)
	if e != nil {
		a.log.Printf("control vsock: %v", e)
		return
	}
	defer l.Close()
	a.log.Printf("control listening on vsock port 1024")
	for {
		c, e := l.Accept()
		if e != nil {
			if a.ctx.Err() != nil {
				return
			}
			continue
		}
		go a.control(c)
	}
}
func (a *agent) control(c net.Conn) {
	defer c.Close()
	a.log.Printf("control connection accepted")
	_ = writeFrame(c, map[string]any{"type": "hello", "protocol": 1, "agentVersion": version, "bootUptimeMs": uptime()})
	for _, e := range a.state.replay() {
		_ = writeFrame(c, e)
	}
	ch := make(chan event, 16)
	a.subsMu.Lock()
	a.subs[ch] = struct{}{}
	a.subsMu.Unlock()
	defer func() { a.subsMu.Lock(); delete(a.subs, ch); a.subsMu.Unlock() }()
	go func() {
		for e := range ch {
			if writeFrame(c, e) != nil {
				return
			}
		}
	}()
	r := bufio.NewReaderSize(c, maxMessage)
	for {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if readFrame(r, &req) != nil {
			return
		}
		switch req.Method {
		case "status":
			_ = writeFrame(c, map[string]any{"id": req.ID, "result": a.status()})
		case "shutdown":
			_ = writeFrame(c, map[string]any{"id": req.ID, "result": map[string]bool{"ok": true}})
			go a.shutdown()
			return
		default:
			_ = writeFrame(c, map[string]any{"id": req.ID, "error": map[string]string{"code": "unknown_method", "message": "unknown method: " + req.Method}})
		}
	}
}

func (a *agent) status() any {
	a.state.mu.RLock()
	units := make([]map[string]string, 0, len(a.state.units))
	for n, s := range a.state.units {
		units = append(units, map[string]string{"name": n, "state": s})
	}
	a.state.mu.RUnlock()
	var mt, ma uint64
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 1 {
			v, _ := strconv.ParseUint(f[1], 10, 64)
			if f[0] == "MemTotal:" {
				mt = v
			}
			if f[0] == "MemAvailable:" {
				ma = v
			}
		}
	}
	load := 0.0
	if b, e := os.ReadFile("/proc/loadavg"); e == nil {
		fmt.Sscanf(string(b), "%f", &load)
	}
	return map[string]any{"units": units, "memTotalKiB": mt, "memAvailableKiB": ma, "loadAvg1": load}
}

func (a *agent) dockerProxy() {
	l, e := vsockListener(2375)
	if e != nil {
		a.log.Printf("docker vsock: %v", e)
		return
	}
	defer l.Close()
	a.log.Printf("docker proxy listening on vsock port 2375")
	for {
		c, e := l.Accept()
		if e != nil {
			if a.ctx.Err() != nil {
				return
			}
			continue
		}
		go proxyDocker(c)
	}
}
func proxyDocker(host net.Conn) {
	defer host.Close()
	guest, e := net.Dial("unix", "/run/docker.sock")
	if e != nil {
		return
	}
	defer guest.Close()
	done := make(chan struct{}, 2)
	copyHalf := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go copyHalf(guest, host)
	go copyHalf(host, guest)
	<-done
	<-done
}

func (a *agent) shutdown() {
	a.unitsMu.Lock()
	if a.shutting {
		a.unitsMu.Unlock()
		return
	}
	a.shutting = true
	a.unitsMu.Unlock()
	a.emit("shutting-down", "", "", "")
	a.unitsMu.Lock()
	for _, cmd := range a.units {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	a.unitsMu.Unlock()
	time.Sleep(2 * time.Second)
	a.cancel()
	syscall.Sync()
	_ = syscall.Unmount("/var/lib/docker", 0)
	_ = syscall.Unmount("/var/lib/sulla-data", 0)
	if os.Getpid() == 1 {
		_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	}
}

var _ = json.Valid
