// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Darwin
import Foundation
import Virtualization

private let gib = 1_073_741_824
// SULLA_RUNTIME_DIR lets a test VM run beside the real one with its own sockets.
private let runtimeDirectory = ProcessInfo.processInfo.environment["SULLA_RUNTIME_DIR"]
    .map { URL(fileURLWithPath: $0, isDirectory: true) }
    ?? FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Sulla/runtime", isDirectory: true)
private let dockerSocketURL = runtimeDirectory.appendingPathComponent("docker.sock")
private let controlSocketURL = runtimeDirectory.appendingPathComponent("control.sock")
// One stream per connection to an allowlisted guest vsock port: 1025 guest
// exec, 2376 published-port forwarding. The client writes "<port>\n" first.
private let guestSocketURL = runtimeDirectory.appendingPathComponent("guest.sock")
private let guestStreamPorts: Set<UInt32> = [1025, 2376]
// Guest-initiated streams that reach the Mac's 127.0.0.1 (host.sulla.internal).
private let hostLoopbackVsockPort: UInt32 = 1100
private let serialLogURL = runtimeDirectory.appendingPathComponent("console.log")

private struct StartOptions {
    let kernel: URL
    let initrd: URL
    /// Read-only erofs image of the guest's /usr (Docker, tools, kernel modules).
    let usrImage: URL
    let dataDisk: URL
    let cpus: Int
    let memoryBytes: UInt64
    let kernelArguments: [String]
    let shares: [DirectoryShare]
    /// Saved machine state from `suspend`, restored instead of a cold boot.
    let stateFile: URL?
}

private struct DirectoryShare {
    let tag: String
    let path: URL
    let readOnly: Bool
}

private enum RuntimeError: LocalizedError {
    case usage(String)
    case system(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message), .system(let message): return message
        }
    }
}

private func monotonicMilliseconds(since start: DispatchTime) -> UInt64 {
    (DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}

private func sysctlInt(_ name: String) -> Int? {
    var value: Int = 0
    var size = MemoryLayout<Int>.size
    return sysctlbyname(name, &value, &size, nil, 0) == 0 ? value : nil
}

private func defaultCPUCount() -> Int {
    let performanceCores = sysctlInt("hw.perflevel0.physicalcpu")
        ?? sysctlInt("hw.physicalcpu")
        ?? ProcessInfo.processInfo.activeProcessorCount
    return min(8, max(2, Int(floor(Double(performanceCores) * 0.75))))
}

private func defaultMemoryBytes() -> UInt64 {
    let host = ProcessInfo.processInfo.physicalMemory
    let desired = min(UInt64(12 * gib), max(UInt64(4 * gib), UInt64(Double(host) * 0.375)))
    let hostReserve = UInt64(6 * gib)
    let safe = host > hostReserve ? host - hostReserve : UInt64(512 * 1_048_576)
    return max(UInt64(512 * 1_048_576), min(desired, safe))
}

private func parseStartOptions(_ arguments: ArraySlice<String>) throws -> StartOptions {
    var values: [String: String] = [:]
    var kernelArguments: [String] = []
    var shares: [DirectoryShare] = []
    var index = arguments.startIndex
    while index < arguments.endIndex {
        let key = arguments[index]
        guard key.hasPrefix("--"), arguments.index(after: index) < arguments.endIndex else {
            throw RuntimeError.usage("invalid start argument: \(key)")
        }
        let valueIndex = arguments.index(after: index)
        if key == "--kernel-arg" {
            // Only agent options (sulla.<name>=<value>) may be added; the host
            // owns everything else on the command line.
            let value = arguments[valueIndex]
            guard value.range(of: "^sulla\\.[a-z]+=[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
                throw RuntimeError.usage("--kernel-arg accepts only sulla.<name>=<value>")
            }
            kernelArguments.append(value)
        } else if key == "--share" {
            // tag=/host/path[:ro]. The guest mounts the tag where it wants it.
            let value = arguments[valueIndex]
            guard let separator = value.firstIndex(of: "=") else {
                throw RuntimeError.usage("--share expects tag=/host/path[:ro]")
            }
            let tag = String(value[..<separator])
            var path = String(value[value.index(after: separator)...])
            let readOnly = path.hasSuffix(":ro")
            if readOnly { path.removeLast(3) }
            do {
                try VZVirtioFileSystemDeviceConfiguration.validateTag(tag)
            } catch {
                throw RuntimeError.usage("invalid share tag: \(tag)")
            }
            guard path.hasPrefix("/") else { throw RuntimeError.usage("share path must be absolute: \(path)") }
            shares.append(DirectoryShare(tag: tag, path: URL(fileURLWithPath: path, isDirectory: true), readOnly: readOnly))
        } else {
            values[key] = arguments[valueIndex]
        }
        index = arguments.index(after: valueIndex)
    }
    guard let kernel = values["--kernel"], let initrd = values["--initrd"],
          let usrImage = values["--usr-image"], let dataDisk = values["--data-disk"] else {
        throw RuntimeError.usage("start requires --kernel, --initrd, --usr-image, and --data-disk")
    }
    let cpus = try values["--cpus"].map { value -> Int in
        guard let parsed = Int(value), parsed > 0 else { throw RuntimeError.usage("--cpus must be positive") }
        return parsed
    } ?? defaultCPUCount()
    let memoryMiB = try values["--memory-mib"].map { value -> Int in
        guard let parsed = Int(value), parsed >= 512 else { throw RuntimeError.usage("--memory-mib must be at least 512") }
        return parsed
    }
    let memoryBytes = memoryMiB.map { UInt64($0) * 1_048_576 } ?? defaultMemoryBytes()
    return StartOptions(
        kernel: URL(fileURLWithPath: kernel), initrd: URL(fileURLWithPath: initrd),
        usrImage: URL(fileURLWithPath: usrImage),
        dataDisk: URL(fileURLWithPath: dataDisk), cpus: cpus, memoryBytes: memoryBytes,
        kernelArguments: kernelArguments, shares: shares,
        stateFile: values["--state"].map(URL.init(fileURLWithPath:))
    )
}

private func ensurePrivateRuntimeDirectory() throws {
    try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtimeDirectory.path)
}

private func ensureSparseDataDisk(at url: URL) throws {
    guard !FileManager.default.fileExists(atPath: url.path) else { return }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw RuntimeError.system("could not create data disk at \(url.path)")
    }
    let descriptor = open(url.path, O_WRONLY)
    guard descriptor >= 0 else { throw RuntimeError.system("could not open new data disk") }
    defer { close(descriptor) }
    // A raw 64 GiB sparse file consumes blocks only as the guest writes them.
    guard ftruncate(descriptor, off_t(64 * gib)) == 0 else {
        throw RuntimeError.system("could not size data disk: \(String(cString: strerror(errno)))")
    }
}

private func makeUnixListener(path: String) throws -> Int32 {
    unlink(path)
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw RuntimeError.system("socket: \(String(cString: strerror(errno)))") }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let maximum = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < maximum else { close(descriptor); throw RuntimeError.system("socket path is too long") }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: maximum) { destination in
            _ = path.withCString { strncpy(destination, $0, maximum - 1) }
        }
    }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0, listen(descriptor, 128) == 0 else {
        let message = String(cString: strerror(errno)); close(descriptor)
        throw RuntimeError.system("listen \(path): \(message)")
    }
    chmod(path, 0o600)
    return descriptor
}

private func connectUnix(path: String) throws -> Int32 {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw RuntimeError.system("socket: \(String(cString: strerror(errno)))") }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let maximum = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: maximum) { destination in
            _ = path.withCString { strncpy(destination, $0, maximum - 1) }
        }
    }
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else { let message = String(cString: strerror(errno)); close(descriptor); throw RuntimeError.system(message) }
    return descriptor
}

func connectUnixSocket(path: String) throws -> Int32 { try connectUnix(path: path) }

/// Runs a blocking socket loop on its own thread. On a dispatch queue each idle
/// connection pins a worker for as long as it lives, and libdispatch stops creating
/// workers near 64: after that every new accept, relay and control command waits
/// forever, and a caller blocked on `sulla-runtime exec` hangs with it.
private func runOnThread(_ body: @escaping @Sendable () -> Void) {
    let thread = Thread(block: body)
    thread.stackSize = 256 * 1024
    thread.start()
}

/// Seconds a relay write may make no progress before its connection is torn down.
private let relayStallSeconds = 30

private func writeAll(_ descriptor: Int32, _ data: Data) {
    data.withUnsafeBytes { raw in
        guard var pointer = raw.baseAddress else { return }
        var remaining = raw.count
        while remaining > 0 {
            let count = Darwin.write(descriptor, pointer, remaining)
            if count <= 0 { return }
            remaining -= count; pointer = pointer.advanced(by: count)
        }
    }
}

private final class RuntimeDaemon: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    private let options: StartOptions
    private let startedAt = DispatchTime.now()
    private let queue = DispatchQueue(label: "com.sulla.runtime.vm")
    private let workers = DispatchQueue(label: "com.sulla.runtime.io", attributes: .concurrent)
    private var machine: VZVirtualMachine!
    private var socketDevice: VZVirtioSocketDevice?
    private var dockerListener: Int32 = -1
    private var controlListener: Int32 = -1
    private var guestListener: Int32 = -1
    private let loopbackListener = VZVirtioSocketListener()
    private let stopped = DispatchSemaphore(value: 0)
    private var helloSeen = false
    private var restored = false
    private var configuration: VZVirtualMachineConfiguration!
    private let controlLock = NSLock()
    private var liveControl: Int32 = -1
    private var dockerReady = false

    init(options: StartOptions) { self.options = options }

    func run() throws {
        try ensurePrivateRuntimeDirectory()
        try ensureSparseDataDisk(at: options.dataDisk)
        let configuration = try makeConfiguration()
        try configuration.validate()
        self.configuration = configuration
        machine = VZVirtualMachine(configuration: configuration, queue: queue)
        machine.delegate = self
        dockerListener = try makeUnixListener(path: dockerSocketURL.path)
        controlListener = try makeUnixListener(path: controlSocketURL.path)
        guestListener = try makeUnixListener(path: guestSocketURL.path)
        loopbackListener.delegate = self
        acceptControlConnections()
        acceptDockerConnections()
        acceptGuestStreamConnections()
        queue.async { [self] in
            if self.restoreSavedState() { return }
            machine.start { result in
                switch result {
                case .success: self.findSocketDeviceAndConnectControl()
                case .failure(let error): fputs("VM start failed: \(error)\n", stderr); self.stopped.signal()
                }
            }
        }
        stopped.wait()
        cleanup()
    }

    private func makeConfiguration() throws -> VZVirtualMachineConfiguration {
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = min(max(options.cpus, VZVirtualMachineConfiguration.minimumAllowedCPUCount),
                              VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        config.memorySize = min(max(options.memoryBytes, VZVirtualMachineConfiguration.minimumAllowedMemorySize),
                                VZVirtualMachineConfiguration.maximumAllowedMemorySize)
        // A saved state restores only into a machine with the same identity.
        let platform = VZGenericPlatformConfiguration()
        let identityURL = runtimeDirectory.appendingPathComponent("machine-identifier")
        if let data = try? Data(contentsOf: identityURL), let identifier = VZGenericMachineIdentifier(dataRepresentation: data) {
            platform.machineIdentifier = identifier
        } else {
            try? platform.machineIdentifier.dataRepresentation.write(to: identityURL)
        }
        config.platform = platform
        let loader = VZLinuxBootLoader(kernelURL: options.kernel)
        loader.initialRamdiskURL = options.initrd
        // Disks appear in the guest in this order (vda, vdb). The agent formats
        // and mounts only the disk named by sulla.data, and mounts the
        // read-only one named by sulla.usr at /usr.
        loader.commandLine = "console=hvc0 sulla.data=vda sulla.usr=vdb"
        config.bootLoader = loader
        config.storageDevices = [
            VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: options.dataDisk, readOnly: false)),
            VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: options.usrImage, readOnly: true)),
        ]
        // The guest has no clock source of its own, and TLS fails at 1970.
        loader.commandLine += " sulla.time=\(Int(Date().timeIntervalSince1970))"
        for argument in options.kernelArguments { loader.commandLine += " \(argument)" }
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        // A random MAC per launch would also make every saved state unrestorable.
        let macURL = runtimeDirectory.appendingPathComponent("mac-address")
        if let text = try? String(contentsOf: macURL, encoding: .utf8),
           let address = VZMACAddress(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) {
            network.macAddress = address
        } else {
            try? network.macAddress.string.write(to: macURL, atomically: true, encoding: .utf8)
        }
        config.networkDevices = [network]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        var directories: [VZDirectorySharingDeviceConfiguration] = []
        for share in options.shares {
            let device = VZVirtioFileSystemDeviceConfiguration(tag: share.tag)
            device.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: share.path, readOnly: share.readOnly))
            directories.append(device)
        }
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        FileManager.default.createFile(atPath: serialLogURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: serialLogURL)
        try log.seekToEnd()
        console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: log)
        config.serialPorts = [console]
#if arch(arm64)
        if #available(macOS 13.0, *), VZLinuxRosettaDirectoryShare.availability == .installed {
            let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
            fileSystem.share = try VZLinuxRosettaDirectoryShare()
            directories.append(fileSystem)
        }
#endif
        config.directorySharingDevices = directories
        return config
    }

    /// A fingerprint of everything the saved state depends on. A state saved
    /// with other guest files or another machine shape is never restored.
    private func stateFingerprint() -> String {
        func stamp(_ url: URL) -> String {
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
            let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1
            return "\(url.path):\(size):\(Int64(modified))"
        }
        let shares = options.shares.map { "\($0.tag)=\($0.path.path):\($0.readOnly)" }.joined(separator: ",")
        // The data disk's stamp is taken after the VM stopped: if anything wrote
        // the disk since, the saved memory no longer matches it.
        return [stamp(options.kernel), stamp(options.initrd), stamp(options.usrImage), stamp(options.dataDisk), "\(options.cpus)",
                "\(options.memoryBytes)", shares, options.kernelArguments.joined(separator: " ")].joined(separator: "|")
    }

    private var stateFingerprintURL: URL? { options.stateFile?.appendingPathExtension("id") }

    /// Restores the saved state when it matches this configuration. Runs on
    /// the VM queue; returns false to fall through to a cold boot.
    private func restoreSavedState() -> Bool {
#if arch(arm64)
        guard #available(macOS 14.0, *), let stateFile = options.stateFile, let fingerprintURL = stateFingerprintURL,
              FileManager.default.fileExists(atPath: stateFile.path) else { return false }
        let saved = try? String(contentsOf: fingerprintURL, encoding: .utf8)
        guard saved == stateFingerprint() else {
            print("state-discarded configuration changed"); fflush(stdout)
            try? FileManager.default.removeItem(at: stateFile); try? FileManager.default.removeItem(at: fingerprintURL)
            return false
        }
        machine.restoreMachineStateFrom(url: stateFile) { error in
            // The state is used once: the guest writes the data disk from here
            // on, so a second restore of the same state would corrupt it.
            try? FileManager.default.removeItem(at: stateFile); try? FileManager.default.removeItem(at: fingerprintURL)
            if let error {
                print("state-restore-failed \(error.localizedDescription)"); fflush(stdout)
                self.machine.start { result in
                    switch result {
                    case .success: self.findSocketDeviceAndConnectControl()
                    case .failure(let error): fputs("VM start failed: \(error)\n", stderr); self.stopped.signal()
                    }
                }
                return
            }
            self.machine.resume { result in
                if case .failure(let error) = result {
                    fputs("VM resume failed: \(error)\n", stderr); self.stopped.signal(); return
                }
                self.restored = true
                print("restored \(monotonicMilliseconds(since: self.startedAt))"); fflush(stdout)
                self.findSocketDeviceAndConnectControl()
            }
        }
        return true
#else
        // Virtualization.framework saves and restores machine state on Apple
        // silicon only.
        return false
#endif
    }

    /// Asks the guest to drop clean caches, waiting at most five seconds.
    private func prepareGuestForSuspend() {
        let done = DispatchSemaphore(value: 0)
        queue.async { [self] in
            guard let socketDevice else { done.signal(); return }
            socketDevice.connect(toPort: 1024) { result in
                guard case .success(let connection) = result else { done.signal(); return }
                let descriptor = dup(connection.fileDescriptor)
                runOnThread {
                    defer { close(descriptor); done.signal() }
                    writeAll(descriptor, Data("{\"id\":7,\"method\":\"prepare-suspend\"}\n".utf8))
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    var seen = Data()
                    while !seen.contains("\"id\":7".data(using: .utf8)!) {
                        let count = read(descriptor, &buffer, buffer.count)
                        if count <= 0 { return }
                        seen.append(contentsOf: buffer[0..<count])
                    }
                }
            }
        }
        _ = done.wait(timeout: .now() + 5)
    }

    /// Pauses the VM, saves its state for the next start and stops it.
    private func suspend() -> String {
#if arch(arm64)
        guard #available(macOS 14.0, *), let stateFile = options.stateFile, let fingerprintURL = stateFingerprintURL else {
            return "{\"error\":\"suspend needs macOS 14 and --state\"}"
        }
        do {
            try configuration.validateSaveRestoreSupport()
        } catch {
            return "{\"error\":\"save/restore unsupported: \(error.localizedDescription)\"}\n"
        }
        // The saved state can be as large as the guest's memory. Running the
        // Mac's disk out of space mid-save is worse than a normal shutdown, so
        // the caller falls back to one unless there is room with headroom.
        let headroom: Int64 = 4 * Int64(gib)
        let values = try? stateFile.deletingLastPathComponent()
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        let available = values?.volumeAvailableCapacityForImportantUsage ?? 0
        guard available >= Int64(options.memoryBytes) + headroom else {
            return "{\"error\":\"not enough free disk space to save the VM state\"}\n"
        }
        prepareGuestForSuspend()
        let done = DispatchSemaphore(value: 0)
        var reply = "{\"ok\":true}"
        queue.async { [self] in
            guard machine.state == .running else { reply = "{\"error\":\"not running\"}"; done.signal(); return }
            machine.pause { result in
                if case .failure(let error) = result {
                    reply = "{\"error\":\"pause failed: \(error.localizedDescription)\"}"; done.signal(); return
                }
                self.machine.saveMachineStateTo(url: stateFile) { error in
                    if let error {
                        try? FileManager.default.removeItem(at: stateFile)
                        reply = "{\"error\":\"save failed: \(error.localizedDescription)\"}"
                        // Nothing was saved: let the guest shut down cleanly instead.
                        self.machine.resume { _ in self.sendGuestShutdown() }
                        done.signal(); return
                    }
                    self.machine.stop { _ in
                        try? self.stateFingerprint().write(to: fingerprintURL, atomically: true, encoding: .utf8)
                        done.signal()
                        // Let the control reply reach the caller before the daemon exits.
                        self.queue.asyncAfter(deadline: .now() + 0.2) { self.stopped.signal() }
                    }
                }
            }
        }
        done.wait()
        return reply + "\n"
#else
        return "{\"error\":\"suspend needs Apple silicon\"}\n"
#endif
    }

    private func findSocketDeviceAndConnectControl() {
        socketDevice = machine.socketDevices.compactMap { $0 as? VZVirtioSocketDevice }.first
        socketDevice?.setSocketListener(loopbackListener, forPort: hostLoopbackVsockPort)
        connectGuestControl(attempt: 0)
    }

    private func connectGuestControl(attempt: Int) {
        guard let socketDevice else { return }
        socketDevice.connect(toPort: 1024) { [weak self] result in
            guard let self else { return }
            if case .success(let connection) = result {
                let descriptor = dup(connection.fileDescriptor)
                if descriptor >= 0 {
                    self.controlLock.lock(); self.liveControl = descriptor; self.controlLock.unlock()
                    self.syncGuestClock(descriptor)
                    self.readGuestControl(descriptor)
                }
                return
            }
            // The agent listens only after the kernel unpacks the initramfs,
            // loads the vsock modules and mounts the data disk. A disk that
            // wasn't shut down cleanly replays its journal first, which can
            // take a minute, so keep trying for five.
            if attempt < 12_000 {
                self.queue.asyncAfter(deadline: .now() + .milliseconds(25)) { self.connectGuestControl(attempt: attempt + 1) }
            } else {
                if case .failure(let error) = result {
                    fputs("guest control unavailable: \(error.localizedDescription)\n", stderr)
                }
            }
        }
    }

    /// Sets the guest clock now and every minute while the control stream is
    /// open. It matters most after a restore, when the guest's clock is as
    /// old as the saved state.
    private func syncGuestClock(_ descriptor: Int32) {
        // The descriptor number is reused once the stream closes, so only
        // write while it is still the live control stream.
        controlLock.lock(); defer { controlLock.unlock() }
        guard liveControl == descriptor else { return }
        let unixMs = Int64(Date().timeIntervalSince1970 * 1000)
        writeAll(descriptor, Data("{\"id\":0,\"method\":\"set-time\",\"unixMs\":\(unixMs)}\n".utf8))
        workers.asyncAfter(deadline: .now() + 60) { [weak self] in self?.syncGuestClock(descriptor) }
    }

    private func readGuestControl(_ descriptor: Int32) {
        runOnThread { [weak self] in
            guard let self else { return }
            defer {
                self.controlLock.lock()
                if self.liveControl == descriptor { self.liveControl = -1 }
                close(descriptor)
                self.controlLock.unlock()
            }
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 16_384)
            while true {
                // read(2) returns as soon as any bytes arrive. FileHandle.readData(ofLength:)
                // waits for the full length or EOF, which held every event until shutdown.
                let count = read(descriptor, &buffer, buffer.count)
                if count <= 0 { break }
                pending.append(contentsOf: buffer[0..<count])
                while let newline = pending.firstIndex(of: 0x0a) {
                    let line = pending.prefix(upTo: newline); pending.removeSubrange(...newline)
                    guard line.count <= 65_536,
                          let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          let type = object["type"] as? String else { continue }
                    let elapsed = monotonicMilliseconds(since: self.startedAt)
                    if type == "hello" {
                        self.helloSeen = true; print("hello \(elapsed)")
                    } else if type == "event", let name = object["name"] as? String {
                        print("event \(name) \(elapsed)")
                        if name == "docker-ready", !self.dockerReady {
                            self.dockerReady = true; print("docker-ready \(elapsed)")
                        }
                    }
                    fflush(stdout)
                }
            }
            // The guest closed the control stream (agent restart, or a connection
            // made before it was ready). Reconnect while the VM is still running.
            self.queue.async {
                guard self.machine.state == .running else { return }
                self.connectGuestControl(attempt: 0)
            }
        }
    }

    private func acceptControlConnections() {
        runOnThread { [weak self] in
            guard let self else { return }
            while self.controlListener >= 0 {
                let client = accept(self.controlListener, nil, nil)
                if client >= 0 { runOnThread { self.handleControl(client) } }
            }
        }
    }

    private func handleControl(_ descriptor: Int32) {
        defer { close(descriptor) }
        var buffer = [UInt8](repeating: 0, count: 256)
        let count = read(descriptor, &buffer, buffer.count)
        guard count > 0 else { return }
        let command = String(decoding: buffer.prefix(count), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if command == "status" {
            // VZVirtualMachine may only be touched on its own queue.
            let running = queue.sync { machine.state == .running }
            let state = running ? (dockerReady ? "docker-ready" : "starting") : "stopped"
            writeAll(descriptor, Data("{\"state\":\"\(state)\",\"hello\":\(helloSeen),\"uptimeMs\":\(monotonicMilliseconds(since: startedAt))}\n".utf8))
        } else if command == "suspend" {
            writeAll(descriptor, Data(suspend().utf8))
        } else if command == "stop" {
            writeAll(descriptor, Data("{\"ok\":true}\n".utf8))
            requestShutdown()
        } else {
            writeAll(descriptor, Data("{\"error\":\"unknown command\"}\n".utf8))
        }
    }

    private func requestShutdown() {
        queue.async { [weak self] in self?.sendGuestShutdown() }
    }

    private func sendGuestShutdown() {
        guard let socketDevice else { forceStop(); return }
        socketDevice.connect(toPort: 1024) { [weak self] result in
            guard let self else { return }
            if case .success(let connection) = result {
                writeAll(connection.fileDescriptor, Data("{\"id\":1,\"method\":\"shutdown\"}\n".utf8))
            }
            // The guest stops dockerd (up to 45 s, it stops containers first)
            // and then containerd (up to 10 s) before it powers off.
            self.queue.asyncAfter(deadline: .now() + 60) { [weak self] in
                guard let self, self.machine.state != .stopped else { return }
                self.forceStop()
            }
        }
    }

    private func forceStop() {
        queue.async { [weak self] in
            guard let self else { return }
            if self.machine.state == .running || self.machine.state == .paused {
                self.machine.stop { _ in self.stopped.signal() }
            } else { self.stopped.signal() }
        }
    }

    private func acceptDockerConnections() {
        runOnThread { [weak self] in
            guard let self else { return }
            while self.dockerListener >= 0 {
                let client = accept(self.dockerListener, nil, nil)
                if client >= 0 { self.connectDockerClient(client) }
            }
        }
    }

    private func connectDockerClient(_ client: Int32) {
        queue.async { [weak self] in
            guard let self else { close(client); return }
            self.connectDockerGuest(client)
        }
    }

    private func connectDockerGuest(_ client: Int32) {
        guard let socketDevice else { close(client); return }
        socketDevice.connect(toPort: 2375) { [weak self] result in
            guard let self else { close(client); return }
            guard case .success(let connection) = result else {
                if case .failure(let error) = result { fputs("docker vsock connect failed: \(error)\n", stderr) }
                close(client); return
            }
            let guest = dup(connection.fileDescriptor)
            guard guest >= 0 else { close(client); return }
            let transfers = DispatchGroup()
            self.relay(from: client, to: guest, group: transfers, label: "docker client->guest")
            self.relay(from: guest, to: client, group: transfers, label: "docker guest->client")
            transfers.notify(queue: self.workers) {
                close(client); close(guest)
            }
        }
    }

    private func acceptGuestStreamConnections() {
        runOnThread { [weak self] in
            guard let self else { return }
            while self.guestListener >= 0 {
                let client = accept(self.guestListener, nil, nil)
                if client >= 0 { runOnThread { self.openGuestStream(client) } }
            }
        }
    }

    /// Reads "<port>\n" one byte at a time, so nothing after it is consumed,
    /// then splices the client with that guest vsock port.
    private func openGuestStream(_ client: Int32) {
        var line = [UInt8]()
        var byte: UInt8 = 0
        while line.count < 8, read(client, &byte, 1) == 1, byte != 0x0a { line.append(byte) }
        guard byte == 0x0a, let port = UInt32(String(decoding: line, as: UTF8.self)), guestStreamPorts.contains(port) else {
            close(client); return
        }
        queue.async { [weak self] in
            guard let self, let socketDevice = self.socketDevice else { close(client); return }
            socketDevice.connect(toPort: port) { result in
                guard case .success(let connection) = result else { close(client); return }
                let guest = dup(connection.fileDescriptor)
                guard guest >= 0 else { close(client); return }
                self.splice(client, guest, label: "guest-stream:\(port)")
            }
        }
    }

    private func splice(_ left: Int32, _ right: Int32, label: String = "stream") {
        let transfers = DispatchGroup()
        relay(from: left, to: right, group: transfers, label: "\(label) a->b")
        relay(from: right, to: left, group: transfers, label: "\(label) b->a")
        transfers.notify(queue: workers) { close(left); close(right) }
    }

    /// A guest stream to the Mac's loopback: one {"port":N} line, then bytes.
    /// The host dials only 127.0.0.1, never anything the guest names.
    fileprivate func acceptLoopbackStream(_ connection: VZVirtioSocketConnection) {
        let guest = dup(connection.fileDescriptor)
        guard guest >= 0 else { return }
        runOnThread { [weak self] in
            guard let self else { close(guest); return }
            var line = [UInt8]()
            var byte: UInt8 = 0
            while line.count < 64, read(guest, &byte, 1) == 1, byte != 0x0a { line.append(byte) }
            guard byte == 0x0a,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let port = object["port"] as? Int, (1...65535).contains(port) else {
                close(guest); return
            }
            let local = socket(AF_INET, SOCK_STREAM, 0)
            guard local >= 0 else { close(guest); return }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(UInt16(port).bigEndian)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(local, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard connected == 0 else { close(local); close(guest); return }
            self.splice(guest, local, label: "loopback:\(port)")
        }
    }

    /// Copies source to destination on its own thread. Reads may block indefinitely
    /// (an idle connection is normal), but a write that makes no progress for
    /// `relayStallSeconds` means the peer stopped reading: that one connection is torn
    /// down in both directions so its blocked thread, and whatever Virtualization is
    /// holding for the shared vsock descriptor, are released instead of wedging every
    /// other stream behind it.
    private func relay(from source: Int32, to destination: Int32, group: DispatchGroup, label: String = "relay") {
        group.enter()
        var timeout = timeval(tv_sec: relayStallSeconds, tv_usec: 0)
        setsockopt(destination, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(destination, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        runOnThread {
            defer { group.leave() }
            var buffer = [UInt8](repeating: 0, count: 65_536)
            var totalRead = 0, totalWritten = 0
            while true {
                let count = read(source, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { shutdown(destination, SHUT_WR); break }
                totalRead += count
                var written = 0
                while written < count {
                    let result = buffer.withUnsafeBytes { raw in
                        Darwin.write(destination, raw.baseAddress!.advanced(by: written), count - written)
                    }
                    if result < 0 && errno == EINTR { continue }
                    if result <= 0 {
                        let err = errno
                        if result < 0 && (err == EAGAIN || err == EWOULDBLOCK) {
                            fputs("relay stalled: \(label) peer not reading for \(relayStallSeconds)s, tearing down connection (read \(totalRead) bytes, wrote \(totalWritten + written) bytes, pending \(count - written))\n", stderr)
                        }
                        // Wake the sibling relay thread and fail the peer promptly.
                        shutdown(source, SHUT_RDWR); shutdown(destination, SHUT_RDWR)
                        return
                    }
                    written += result
                    totalWritten += result
                }
            }
        }
    }

    private func cleanup() {
        if dockerListener >= 0 { close(dockerListener); dockerListener = -1 }
        if controlListener >= 0 { close(controlListener); controlListener = -1 }
        if guestListener >= 0 { close(guestListener); guestListener = -1 }
        unlink(dockerSocketURL.path); unlink(controlSocketURL.path); unlink(guestSocketURL.path)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { stopped.signal() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fputs("VM stopped with error: \(error)\n", stderr); stopped.signal()
    }
}

extension RuntimeDaemon: VZVirtioSocketListenerDelegate {
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        acceptLoopbackStream(connection)
        return true
    }
}

private func runClientCommand(_ command: String) throws {
    let descriptor = try connectUnix(path: controlSocketURL.path)
    defer { close(descriptor) }
    writeAll(descriptor, Data("\(command)\n".utf8))
    var buffer = [UInt8](repeating: 0, count: 4096)
    let count = read(descriptor, &buffer, buffer.count)
    if count > 0 { print(String(decoding: buffer.prefix(count), as: UTF8.self), terminator: "") }
}

// A client closing a docker or forwarded connection mid-write must fail that
// write with EPIPE, not kill the process and the VM with it.
signal(SIGPIPE, SIG_IGN)

do {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else { throw RuntimeError.usage("usage: sulla-runtime start|status|stop|exec|copy") }
    switch arguments[1] {
    case "start": try RuntimeDaemon(options: parseStartOptions(arguments.dropFirst(2))).run()
    case "exec": exit(runExecCommand(socketPath: guestSocketURL.path, arguments.dropFirst(2)))
    case "copy": exit(runCopyCommand(socketPath: guestSocketURL.path, Array(arguments.dropFirst(2))))
    case "status": try runClientCommand("status")
    case "stop": try runClientCommand("stop")
    case "suspend": try runClientCommand("suspend")
    default: throw RuntimeError.usage("unknown command: \(arguments[1])")
    }
} catch {
    fputs("sulla-runtime: \(error.localizedDescription)\n", stderr)
    exit(1)
}
