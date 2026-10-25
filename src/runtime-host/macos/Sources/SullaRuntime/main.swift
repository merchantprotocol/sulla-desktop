import Darwin
import Foundation
import Virtualization

private let gib = 1_073_741_824
private let runtimeDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Sulla/runtime", isDirectory: true)
private let dockerSocketURL = runtimeDirectory.appendingPathComponent("docker.sock")
private let controlSocketURL = runtimeDirectory.appendingPathComponent("control.sock")
private let serialLogURL = runtimeDirectory.appendingPathComponent("console.log")

private struct StartOptions {
    let kernel: URL
    let initrd: URL
    let rootfs: URL?
    let dataDisk: URL
    let cpus: Int
    let memoryBytes: UInt64
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
    var index = arguments.startIndex
    while index < arguments.endIndex {
        let key = arguments[index]
        guard key.hasPrefix("--"), arguments.index(after: index) < arguments.endIndex else {
            throw RuntimeError.usage("invalid start argument: \(key)")
        }
        let valueIndex = arguments.index(after: index)
        values[key] = arguments[valueIndex]
        index = arguments.index(after: valueIndex)
    }
    guard let kernel = values["--kernel"], let initrd = values["--initrd"],
          let dataDisk = values["--data-disk"] else {
        throw RuntimeError.usage("start requires --kernel, --initrd, and --data-disk")
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
        rootfs: values["--rootfs"].map(URL.init(fileURLWithPath:)),
        dataDisk: URL(fileURLWithPath: dataDisk), cpus: cpus, memoryBytes: memoryBytes
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
    private let stopped = DispatchSemaphore(value: 0)
    private var helloSeen = false
    private var dockerReady = false

    init(options: StartOptions) { self.options = options }

    func run() throws {
        try ensurePrivateRuntimeDirectory()
        try ensureSparseDataDisk(at: options.dataDisk)
        let configuration = try makeConfiguration()
        try configuration.validate()
        machine = VZVirtualMachine(configuration: configuration, queue: queue)
        machine.delegate = self
        dockerListener = try makeUnixListener(path: dockerSocketURL.path)
        controlListener = try makeUnixListener(path: controlSocketURL.path)
        acceptControlConnections()
        acceptDockerConnections()
        queue.async { [self] in
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
        let loader = VZLinuxBootLoader(kernelURL: options.kernel)
        loader.initialRamdiskURL = options.initrd
        loader.commandLine = "console=hvc0 root=/dev/vda ro"
        config.bootLoader = loader
        var storage: [VZStorageDeviceConfiguration] = []
        if let rootfs = options.rootfs {
            storage.append(VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: rootfs, readOnly: true)))
        } else {
            loader.commandLine = "console=hvc0"
        }
        storage.append(VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: options.dataDisk, readOnly: false)))
        config.storageDevices = storage
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        config.networkDevices = [network]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
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
            config.directorySharingDevices = [fileSystem]
        }
#endif
        return config
    }

    private func findSocketDeviceAndConnectControl() {
        socketDevice = machine.socketDevices.compactMap { $0 as? VZVirtioSocketDevice }.first
        connectGuestControl(attempt: 0)
    }

    private func connectGuestControl(attempt: Int) {
        guard let socketDevice else { return }
        socketDevice.connect(toPort: 1024) { [weak self] result in
            guard let self else { return }
            if case .success(let connection) = result {
                let descriptor = dup(connection.fileDescriptor)
                if descriptor >= 0 { self.readGuestControl(descriptor) }
                return
            }
            if attempt < 200 {
                self.queue.asyncAfter(deadline: .now() + .milliseconds(25)) { self.connectGuestControl(attempt: attempt + 1) }
            } else {
                if case .failure(let error) = result {
                    fputs("guest control unavailable: \(error.localizedDescription)\n", stderr)
                }
            }
        }
    }

    private func readGuestControl(_ descriptor: Int32) {
        workers.async { [weak self] in
            guard let self else { return }
            let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            var pending = Data()
            while true {
                let chunk = file.readData(ofLength: 16_384)
                if chunk.isEmpty { break }
                pending.append(chunk)
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
        }
    }

    private func acceptControlConnections() {
        workers.async { [weak self] in
            guard let self else { return }
            while self.controlListener >= 0 {
                let client = accept(self.controlListener, nil, nil)
                if client >= 0 { self.workers.async { self.handleControl(client) } }
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
            let state = machine.state == .running ? (dockerReady ? "docker-ready" : "starting") : "stopped"
            writeAll(descriptor, Data("{\"state\":\"\(state)\",\"hello\":\(helloSeen),\"uptimeMs\":\(monotonicMilliseconds(since: startedAt))}\n".utf8))
        } else if command == "stop" {
            writeAll(descriptor, Data("{\"ok\":true}\n".utf8))
            requestShutdown()
        } else {
            writeAll(descriptor, Data("{\"error\":\"unknown command\"}\n".utf8))
        }
    }

    private func requestShutdown() {
        guard let socketDevice else { forceStop(); return }
        socketDevice.connect(toPort: 1024) { [weak self] result in
            guard let self else { return }
            if case .success(let connection) = result {
                writeAll(connection.fileDescriptor, Data("{\"id\":1,\"method\":\"shutdown\"}\n".utf8))
            }
            self.queue.asyncAfter(deadline: .now() + 10) { [weak self] in
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
        workers.async { [weak self] in
            guard let self else { return }
            while self.dockerListener >= 0 {
                let client = accept(self.dockerListener, nil, nil)
                if client >= 0 { self.connectDockerClient(client) }
            }
        }
    }

    private func connectDockerClient(_ client: Int32) {
        guard let socketDevice else { close(client); return }
        socketDevice.connect(toPort: 2375) { [weak self] result in
            guard let self else { close(client); return }
            guard case .success(let connection) = result else { close(client); return }
            let guest = dup(connection.fileDescriptor)
            guard guest >= 0 else { close(client); return }
            let transfers = DispatchGroup()
            self.relay(from: client, to: guest, group: transfers)
            self.relay(from: guest, to: client, group: transfers)
            transfers.notify(queue: self.workers) {
                close(client); close(guest)
            }
        }
    }

    private func relay(from source: Int32, to destination: Int32, group: DispatchGroup) {
        group.enter()
        workers.async {
            defer { group.leave() }
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(source, &buffer, buffer.count)
                if count <= 0 { shutdown(destination, SHUT_WR); break }
                var written = 0
                while written < count {
                    let result = buffer.withUnsafeBytes { raw in
                        Darwin.write(destination, raw.baseAddress!.advanced(by: written), count - written)
                    }
                    if result <= 0 { shutdown(destination, SHUT_WR); return }
                    written += result
                }
            }
        }
    }

    private func cleanup() {
        if dockerListener >= 0 { close(dockerListener); dockerListener = -1 }
        if controlListener >= 0 { close(controlListener); controlListener = -1 }
        unlink(dockerSocketURL.path); unlink(controlSocketURL.path)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { stopped.signal() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fputs("VM stopped with error: \(error)\n", stderr); stopped.signal()
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

do {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else { throw RuntimeError.usage("usage: sulla-runtime start|status|stop") }
    switch arguments[1] {
    case "start": try RuntimeDaemon(options: parseStartOptions(arguments.dropFirst(2))).run()
    case "status": try runClientCommand("status")
    case "stop": try runClientCommand("stop")
    default: throw RuntimeError.usage("unknown command: \(arguments[1])")
    }
} catch {
    fputs("sulla-runtime: \(error.localizedDescription)\n", stderr)
    exit(1)
}
