// SPDX-License-Identifier: GPL-2.0-or-later
// Deterministic FlowRelay fixture: socketpairs only, no VM, sockets or user data.
// Build: swiftc -o OUT Sources/SullaRuntime/FlowRelay.swift Tests/FlowRelayFixture/main.swift
// Run quiet:       OUT
// Run diagnostics: SULLA_RUNTIME_RELAY_DIAGNOSTICS=1 OUT
// The fixture plays the guest side of the version 1 envelope from
// pkg/sulla-runtime/contracts/agent-protocol.md.
import Darwin
import Foundation

let window = 32 * 1024
let chunk = 8 * 1024
let diagnostics = ProcessInfo.processInfo.environment["SULLA_RUNTIME_RELAY_DIAGNOSTICS"] == "1"
let logPath = NSTemporaryDirectory() + "flow-relay-fixture-\(getpid()).log"
var failures = 0

func pair() -> (Int32, Int32) {
    var fds: [Int32] = [0, 0]
    precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    var noSignal: Int32 = 1
    for fd in fds {
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    }
    return (fds[0], fds[1])
}

func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
    var offset = 0
    while offset < bytes.count {
        let n = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
        if n <= 0 { return false }
        offset += n
    }
    return true
}

func readExact(_ fd: Int32, _ count: Int) -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: count)
    var offset = 0
    while offset < count {
        let n = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: offset), count - offset) }
        if n <= 0 { return nil }
        offset += n
    }
    return bytes
}

func readToEOF(_ fd: Int32) -> [UInt8] {
    var out = [UInt8](), buffer = [UInt8](repeating: 0, count: 16_384)
    while true {
        let n = Darwin.read(fd, &buffer, buffer.count)
        if n <= 0 { return out }
        out += buffer[0..<n]
    }
}

func frame(_ fd: Int32, _ kind: UInt8, _ payload: [UInt8] = [], count: Int? = nil) -> Bool {
    let n = UInt32(count ?? payload.count)
    return writeAll(fd, [kind, UInt8(n >> 24), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)] + payload)
}

func nextFrame(_ fd: Int32) -> (UInt8, [UInt8])? {
    guard let header = readExact(fd, 5) else { return nil }
    let count = header.dropFirst().reduce(0) { ($0 << 8) | Int($1) }
    if header[0] != 0 { return (header[0], [UInt8](repeating: 0, count: count)) }
    guard let data = readExact(fd, count) else { return nil }
    return (0, data)
}

/// Guest producer: DATA within credit, then (optionally) wait for the host
/// application to accept everything, exactly as the guest agent's CloseWrite does.
func guestSend(_ wire: Int32, _ payload: [UInt8], awaitCredit: Bool) {
    var credit = window, offset = 0
    while offset < payload.count {
        while credit == 0 {
            guard let (kind, body) = nextFrame(wire), kind == 1 else { return }
            credit += body.count
        }
        let n = min(chunk, credit, payload.count - offset)
        guard frame(wire, 0, Array(payload[offset..<offset + n])) else { return }
        credit -= n; offset += n
    }
    while awaitCredit && credit < window {
        guard let (kind, body) = nextFrame(wire), kind == 1 else { return }
        credit += body.count
    }
}

func pattern(_ size: Int, _ seed: UInt8) -> [UInt8] { (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31) ^ seed } }

func logText() -> String { (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "" }

/// Waits for this relay's close line. Graceful closes print only with diagnostics.
func closeReason(_ label: String, expectLine: Bool) -> String? {
    let deadline = Date().addingTimeInterval(expectLine ? 5 : 1)
    while Date() < deadline {
        for line in logText().split(separator: "\n") where line.hasPrefix("relay close: \(label) ") {
            return line.split(separator: " ").first { $0.hasPrefix("reason=") }.map { String($0.dropFirst(7)) }
        }
        usleep(10_000)
    }
    return nil
}

func check(_ name: String, _ ok: Bool, _ detail: String) {
    print("\(ok ? "PASS" : "FAIL") \(name): \(detail)")
    if !ok { failures += 1 }
}

func expectClose(_ name: String, _ label: String, graceful: Bool) {
    let reason = closeReason(label, expectLine: diagnostics || !graceful)
    if graceful {
        let ok = diagnostics ? (reason == "complete" || reason == "peer-complete") : reason == nil
        check(name, ok, "graceful close reported as \(reason ?? "<quiet>")")
    } else {
        let ok = reason != nil && reason != "complete" && reason != "peer-complete"
        check(name, ok, "abnormal close reported as \(reason ?? "<quiet>")")
    }
}

func start(_ label: String) -> (client: Int32, guest: Int32, relayClient: Int32, relayWire: Int32) {
    let (client, relayClient) = pair()
    let (relayWire, guest) = pair()
    FlowRelay(client: relayClient, wire: relayWire, label: label).start()
    return (client, guest, relayClient, relayWire)
}

// Capture FlowRelay's stderr for assertions.
let logFd = open(logPath, O_CREAT | O_TRUNC | O_WRONLY, 0o600)
precondition(logFd >= 0 && dup2(logFd, STDERR_FILENO) >= 0)
print("mode \(diagnostics ? "diagnostics" : "quiet") log \(logPath)")

// 1. Normal exec: the guest ends its response, waits for host acceptance, then
// closes the stream while the host client still holds its own side open.
do {
    let s = start("exec-eof")
    let response = pattern(96 * 1024, 1)
    let guest = Thread { guestSend(s.guest, response, awaitCredit: true); _ = frame(s.guest, 2); close(s.guest) }
    guest.start()
    let received = readToEOF(s.client)
    check("exec response", received == response, "received \(received.count) of \(response.count) bytes")
    expectClose("exec close", "exec-eof", graceful: true)
}

// 2. Upload after the guest's response half-close still arrives intact.
do {
    let s = start("upload-after-end")
    let response = pattern(40 * 1024, 2), upload = pattern(96 * 1024, 3)
    var uploaded = [UInt8]()
    let done = DispatchSemaphore(value: 0)
    Thread {
        guestSend(s.guest, response, awaitCredit: true)
        _ = frame(s.guest, 2)
        while let (kind, body) = nextFrame(s.guest) {
            if kind == 2 { break }
            if kind == 0 { uploaded += body; _ = frame(s.guest, 1, count: body.count) }
        }
        close(s.guest); done.signal()
    }.start()
    let received = readToEOF(s.client)
    _ = writeAll(s.client, upload); shutdown(s.client, SHUT_WR)
    _ = done.wait(timeout: .now() + 5)
    check("half-closed response", received == response, "received \(received.count) of \(response.count) bytes")
    check("upload after response END", uploaded == upload, "guest accepted \(uploaded.count) of \(upload.count) bytes")
    expectClose("upload close", "upload-after-end", graceful: true)
}

// 3. Wire EOF while response bytes are still undelivered is truncation, not success.
do {
    let s = start("pending-truncated")
    var small: Int32 = 2048
    setsockopt(s.relayClient, SOL_SOCKET, SO_SNDBUF, &small, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(s.client, SOL_SOCKET, SO_RCVBUF, &small, socklen_t(MemoryLayout<Int32>.size))
    guestSend(s.guest, pattern(window, 4), awaitCredit: false)
    _ = frame(s.guest, 2); close(s.guest)
    expectClose("undelivered response", "pending-truncated", graceful: false)
}

// 4. Wire EOF while host upload bytes were never acknowledged is not success.
do {
    let s = start("upload-unacknowledged")
    _ = writeAll(s.client, pattern(16 * 1024, 5))
    var read = 0
    while read < 16 * 1024, let (kind, body) = nextFrame(s.guest), kind == 0 { read += body.count }
    _ = frame(s.guest, 2); close(s.guest)
    expectClose("unacknowledged upload", "upload-unacknowledged", graceful: false)
}

// 5. Wire EOF before END is a genuine wire failure.
do {
    let s = start("wire-abort")
    guestSend(s.guest, pattern(10 * 1024, 6), awaitCredit: false)
    close(s.guest)
    expectClose("wire abort", "wire-abort", graceful: false)
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
