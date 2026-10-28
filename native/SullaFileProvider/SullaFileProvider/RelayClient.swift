// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Darwin
import FileProvider
import Foundation

/// Team-ID-prefixed app group shared with Sulla Desktop main (pkg/sulla-desktop/main/sullaAppGroup.ts).
let sullaAppGroup = "946AF7TL74.io.sulla.desktop"

struct RelayFailure: Error {
    let status: Int
    let message: String
    let code: String?

    /// Maps relay statuses onto the errors fileproviderd understands.
    var fileProviderError: Error {
        switch status {
        case 401: return NSFileProviderError(.notAuthenticated)
        case 404: return NSFileProviderError(.noSuchItem)
        case 409 where code == "directory-not-empty": return NSFileProviderError(.directoryNotEmpty)
        case 410: return NSFileProviderError(.syncAnchorExpired)
        case 403: return CocoaError(.fileWriteNoPermission)
        case 413: return NSFileProviderError(.insufficientQuota)
        case 0, 502, 503, 504: return NSFileProviderError(.serverUnreachable)
        default: return NSFileProviderError(.cannotSynchronize)
        }
    }
}

extension Error {
    var asFileProviderError: Error { (self as? RelayFailure)?.fileProviderError ?? self }
}

/// One framed request per connection to the Unix socket Sulla Desktop main serves
/// inside the app-group container. The extension never holds Files credentials:
/// it presents the short-lived capability token main writes next to the socket.
///   request:  u32be headerBytes · header JSON · body (bodyBytes)
///   response: u32be headerBytes · header JSON · body until EOF
final class RelayClient {
    static let shared = RelayClient()
    private let chunkBytes = 1 << 20

    private var directory: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: sullaAppGroup)?
            .appendingPathComponent("fp", isDirectory: true)
    }

    func call(_ op: String, _ args: [String: Any] = [:], body: URL? = nil, into destination: URL? = nil, progress: Progress? = nil) throws -> [String: Any] {
        guard let directory else { throw RelayFailure(status: 0, message: "app group container unavailable", code: nil) }
        guard let token = try? String(contentsOf: directory.appendingPathComponent("token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty
        else { throw RelayFailure(status: 0, message: "Sulla Desktop is not running", code: nil) }

        var bodyBytes: Int64 = 0
        if let body { bodyBytes = Int64((try body.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        let header = try JSONSerialization.data(withJSONObject: ["v": 1, "token": token, "op": op, "args": args, "bodyBytes": bodyBytes])

        let socketPath = directory.appendingPathComponent("relay.sock").path
        let fd = try connect(socketPath)
        defer { close(fd) }

        var length = UInt32(header.count).bigEndian
        try writeAll(fd, Data(bytes: &length, count: 4))
        try writeAll(fd, header)
        var uploadError: Error?
        if let body {
            do {
                let handle = try FileHandle(forReadingFrom: body)
                defer { try? handle.close() }
                var sent: Int64 = 0
                while sent < bodyBytes {
                    guard let chunk = try handle.read(upToCount: chunkBytes), !chunk.isEmpty else { break }
                    try writeAll(fd, chunk)
                    sent += Int64(chunk.count)
                }
                // The relay waits for the declared length; a file that shrank mid-upload must not commit.
                if sent != bodyBytes { throw RelayFailure(status: 400, message: "file changed while uploading", code: nil) }
            } catch {
                // The relay may have refused the header (token, size) and closed; prefer its answer.
                uploadError = error
                shutdown(fd, SHUT_WR)
            }
        }

        guard let lengthBytes = try? readExactly(fd, 4) else { throw uploadError ?? RelayFailure(status: 503, message: "relay closed early", code: nil) }
        let replyLength = lengthBytes.withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }
        guard replyLength > 1, replyLength <= 16 << 20 else { throw RelayFailure(status: 502, message: "invalid relay reply", code: nil) }
        guard let reply = try JSONSerialization.jsonObject(with: try readExactly(fd, Int(replyLength))) as? [String: Any] else {
            throw RelayFailure(status: 502, message: "invalid relay reply", code: nil)
        }
        guard reply["ok"] as? Bool == true else {
            throw RelayFailure(status: reply["status"] as? Int ?? 502, message: reply["error"] as? String ?? "relay request failed", code: reply["code"] as? String)
        }
        if let uploadError { throw uploadError }
        let result = reply["result"] as? [String: Any] ?? [:]

        if let destination {
            let expected = (result["bytes"] as? NSNumber)?.int64Value ?? -1
            if expected >= 0 { progress?.totalUnitCount = max(expected, 1) }
            FileManager.default.createFile(atPath: destination.path, contents: nil)
            let handle = try FileHandle(forWritingTo: destination)
            defer { try? handle.close() }
            var received: Int64 = 0
            var buffer = [UInt8](repeating: 0, count: chunkBytes)
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count < 0 { if errno == EINTR { continue }; throw RelayFailure(status: 503, message: "relay read failed", code: nil) }
                if count == 0 { break }
                try handle.write(contentsOf: Data(buffer[0..<count]))
                received += Int64(count)
                if expected >= 0 { progress?.completedUnitCount = received }
            }
            // A short stream means main or Files stopped mid-download; never hand back a partial file.
            guard expected < 0 || received == expected else { throw RelayFailure(status: 503, message: "download interrupted", code: nil) }
            progress?.completedUnitCount = progress?.totalUnitCount ?? 0
        }
        return result
    }

    private func connect(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw RelayFailure(status: 0, message: "socket failed", code: nil) }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 300, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { close(fd); throw RelayFailure(status: 0, message: "socket path too long", code: nil) }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else { close(fd); throw RelayFailure(status: 0, message: "Sulla Desktop is not running", code: nil) }
        return fd
    }

    private func writeAll(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < raw.count {
                let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written < 0 { if errno == EINTR { continue }; throw RelayFailure(status: 503, message: "relay write failed", code: nil) }
                offset += written
            }
        }
    }

    private func readExactly(_ fd: Int32, _ count: Int) throws -> Data {
        var data = Data(count: count)
        var offset = 0
        try data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            while offset < count {
                let received = read(fd, raw.baseAddress!.advanced(by: offset), count - offset)
                if received < 0 { if errno == EINTR { continue }; throw RelayFailure(status: 503, message: "relay read failed", code: nil) }
                if received == 0 { throw RelayFailure(status: 503, message: "relay closed early", code: nil) }
                offset += received
            }
        }
        return data
    }
}
