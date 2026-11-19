// SPDX-License-Identifier: GPL-2.0-or-later
import Darwin
import Foundation

/// A negotiated transport envelope, invisible to the application protocol.
/// At most 32 KiB of unconsumed data travels in either direction per stream.
/// The wire reader never waits on the application sink: it must keep draining
/// Virtualization's shared device even when this particular consumer pauses.
final class FlowRelay: @unchecked Sendable {
    private static let window = 32 * 1024
    private static let chunk = 8 * 1024
    private let client: Int32
    private let wire: Int32
    private let label: String
    private let state = NSCondition()
    private let frameLock = NSLock()
    private var credit = window
    private var pending: [[UInt8]] = []
    private var pendingBytes = 0
    private var localEnd = false
    private var remoteEnd = false
    private var stopped = false
    private let started = DispatchTime.now()
    private var received = 0
    private var delivered = 0
    private var firstByteMs: UInt64?
    private var lastProgressMs: UInt64 = 0
    private let trace = ProcessInfo.processInfo.environment["SULLA_RUNTIME_RELAY_DIAGNOSTICS"] == "1"

    init(client: Int32, wire: Int32, label: String) {
        self.client = client; self.wire = wire; self.label = label
    }

    func start() {
        var timeout = timeval(tv_sec: 30, tv_usec: 0)
        var noSignal: Int32 = 1
        for fd in [client, wire] {
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        }
        if trace { fputs("relay open: \(label) flow=1 window=\(Self.window)\n", stderr) }
        let group = DispatchGroup()
        for operation in [readWire, deliverToClient, readClient] {
            group.enter()
            let thread = Thread { operation(); group.leave() }
            thread.stackSize = 256 * 1024
            thread.start()
        }
        group.notify(queue: .global()) { [self] in close(client); close(wire) }
    }

    private func stop(_ reason: String, graceful: Bool = false) {
        state.lock()
        if stopped { state.unlock(); return }
        stopped = true
        let read = received, wrote = delivered, queued = pendingBytes
        let first = firstByteMs.map(String.init) ?? "none", last = lastProgressMs
        pending.removeAll(); state.broadcast(); state.unlock()
        shutdown(client, SHUT_RDWR); shutdown(wire, SHUT_RDWR)
        if trace || !graceful {
            let elapsed = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
            fputs("relay close: \(label) flow=1 reason=\(reason) elapsedMs=\(elapsed) read=\(read) wrote=\(wrote) pending=\(queued) firstByteMs=\(first) lastProgressMs=\(last)\n", stderr)
        }
    }

    private func finishIfComplete() {
        state.lock()
        let complete = localEnd && remoteEnd && pendingBytes == 0 && credit == Self.window
        state.unlock()
        if complete { stop("complete", graceful: true) }
    }

    private func writeAll(_ fd: Int32, _ data: [UInt8]) -> Bool {
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return false }
            offset += count
        }
        return true
    }

    private func send(_ kind: UInt8, count: Int, data: [UInt8] = []) -> Bool {
        let n = UInt32(count)
        let header: [UInt8] = [kind, UInt8(n >> 24), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)]
        frameLock.lock(); defer { frameLock.unlock() }
        return writeAll(wire, header) && writeAll(wire, data)
    }

    private func readExact(_ count: Int) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: count)
        var offset = 0
        while offset < count {
            let n = data.withUnsafeMutableBytes { Darwin.read(wire, $0.baseAddress!.advanced(by: offset), count - offset) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            offset += n
        }
        return data
    }

    private func readWire() {
        while let header = readExact(5) {
            let count = header.dropFirst().reduce(0) { ($0 << 8) | Int($1) }
            switch header[0] {
            case 0:
                guard count > 0 && count <= Self.chunk, let data = readExact(count) else { stop("invalid-data"); return }
                state.lock()
                guard !remoteEnd && pendingBytes + count <= Self.window else { state.unlock(); stop("window-exceeded"); return }
                received += count; pendingBytes += count; pending.append(data)
                let elapsed = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
                if firstByteMs == nil { firstByteMs = elapsed }
                lastProgressMs = elapsed
                state.broadcast(); state.unlock()
            case 1:
                state.lock()
                guard count > 0 && credit + count <= Self.window else { state.unlock(); stop("invalid-credit"); return }
                credit += count; state.broadcast(); state.unlock()
            case 2:
                state.lock()
                guard count == 0 && !remoteEnd else { state.unlock(); stop("invalid-end"); return }
                remoteEnd = true; state.broadcast(); state.unlock()
            default: stop("invalid-frame"); return
            }
            finishIfComplete()
        }
        // A peer that sent END, had every byte delivered here and acknowledged all
        // of ours may release the stream before this client ends (exec exits after
        // its status). Anything still undelivered or unacknowledged is an abort.
        state.lock()
        let complete = stopped
        let peerComplete = remoteEnd && pendingBytes == 0 && credit == Self.window
        state.unlock()
        if !complete { peerComplete ? stop("peer-complete", graceful: true) : stop("wire-closed") }
    }

    private func deliverToClient() {
        while true {
            state.lock()
            while pending.isEmpty && !remoteEnd && !stopped { state.wait() }
            if stopped { state.unlock(); return }
            if pending.isEmpty && remoteEnd {
                state.unlock(); shutdown(client, SHUT_WR); finishIfComplete(); return
            }
            let data = pending.removeFirst()
            state.unlock()
            guard writeAll(client, data) else { stop("client-write-failed"); return }
            state.lock(); pendingBytes -= data.count; delivered += data.count; lastProgressMs = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000; state.unlock()
            guard send(1, count: data.count) else { stop("credit-write-failed"); return }
            finishIfComplete()
        }
    }

    private func readClient() {
        var data = [UInt8](repeating: 0, count: Self.chunk)
        while true {
            let count = Darwin.read(client, &data, data.count)
            if count < 0 && errno == EINTR { continue }
            if count < 0 { stop("client-read-failed"); return }
            if count == 0 {
                state.lock()
                while credit != Self.window && !stopped { state.wait() }
                if stopped { state.unlock(); return }
                state.unlock()
                guard send(2, count: 0) else { stop("end-write-failed"); return }
                state.lock(); localEnd = true; state.unlock(); finishIfComplete(); return
            }
            var offset = 0
            while offset < count {
                state.lock()
                while credit == 0 && !stopped { state.wait() }
                if stopped { state.unlock(); return }
                let n = min(count - offset, credit)
                credit -= n; state.unlock()
                guard send(0, count: n, data: Array(data[offset..<offset + n])) else { stop("data-write-failed"); return }
                offset += n
            }
        }
    }
}
