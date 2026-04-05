#!/usr/bin/env swift
//
// test-pipeline.swift — step-by-step audio pipeline diagnostics.
//
// Tests each stage in isolation so we know exactly where it breaks.
//
// Usage:
//   swift test-pipeline.swift          # run all tests
//   swift test-pipeline.swift 3        # run specific test
//

import CoreAudio
import AudioToolbox
import Foundation

// MARK: - Helpers

func getAllDevices() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var devices = [AudioObjectID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices)
    return devices
}

func getUID(_ id: AudioObjectID) -> String? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var uid: CFString = "" as CFString
    var s = UInt32(MemoryLayout<CFString>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &s, &uid) == noErr ? uid as String : nil
}

func getName(_ id: AudioObjectID) -> String? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: CFString = "" as CFString
    var s = UInt32(MemoryLayout<CFString>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &s, &name) == noErr ? name as String : nil
}

func getChannels(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let st = AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size)
    guard st == noErr, size > 0 else { return 0 }
    let ptr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { ptr.deallocate() }
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
    var ch = 0
    let count = Int(ptr.pointee.mNumberBuffers)
    withUnsafePointer(to: ptr.pointee.mBuffers) { p in
        for i in 0..<count { ch += Int(p.advanced(by: i).pointee.mNumberChannels) }
    }
    return ch
}

func findDeviceByUID(_ uid: String) -> AudioObjectID? {
    for d in getAllDevices() {
        if getUID(d) == uid { return d }
    }
    return nil
}

func getDefaultOutputUID() -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var devId: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devId)
    return getUID(devId)
}

// MARK: - Tests

let PASS = "\u{001B}[32mPASS\u{001B}[0m"
let FAIL = "\u{001B}[31mFAIL\u{001B}[0m"
let SKIP = "\u{001B}[33mSKIP\u{001B}[0m"

var results: [(Int, String, Bool)] = []

func test(_ num: Int, _ name: String, _ body: () -> Bool) {
    let only = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) : nil
    if let only = only, only != num {
        return
    }
    print("\n── Test \(num): \(name) ──")
    let ok = body()
    results.append((num, name, ok))
    print(ok ? "  → \(PASS)" : "  → \(FAIL)")
}

// ── Test 1: BlackHole driver loaded ──
test(1, "BlackHole driver loaded in CoreAudio") {
    if let dev = findDeviceByUID("BlackHole2ch_UID") {
        print("  BlackHole 2ch found (ID: \(dev))")
        let inCh = getChannels(dev, scope: kAudioObjectPropertyScopeInput)
        let outCh = getChannels(dev, scope: kAudioObjectPropertyScopeOutput)
        print("  Channels: in=\(inCh) out=\(outCh)")
        return inCh >= 2
    }
    print("  BlackHole2ch_UID not found in device list")
    return false
}

// ── Test 2: Mirror aggregate exists with correct sub-devices ──
test(2, "Mirror aggregate device exists with correct sub-devices") {
    guard let mirrorID = findDeviceByUID("AudioDriverMirror_UID") else {
        print("  Mirror device not found")
        return false
    }
    print("  Mirror found (ID: \(mirrorID))")

    var subAddr = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyActiveSubDeviceList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var subSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(mirrorID, &subAddr, 0, nil, &subSize)
    let subCount = Int(subSize) / MemoryLayout<AudioObjectID>.size
    var subs = [AudioObjectID](repeating: 0, count: subCount)
    AudioObjectGetPropertyData(mirrorID, &subAddr, 0, nil, &subSize, &subs)

    print("  Sub-devices (\(subCount)):")
    var hasPhysical = false
    var hasBlackHole = false
    for s in subs {
        let uid = getUID(s) ?? "?"
        let name = getName(s) ?? "?"
        print("    - \(name) (UID: \(uid))")
        if uid == "BlackHole2ch_UID" { hasBlackHole = true }
        if uid != "BlackHole2ch_UID" && uid != "AudioDriverMirror_UID" { hasPhysical = true }
    }
    return subCount >= 2 && hasPhysical && hasBlackHole
}

// ── Test 3: Mirror is the default output ──
test(3, "Mirror is the default output device") {
    let uid = getDefaultOutputUID()
    print("  Default output UID: \(uid ?? "nil")")
    return uid == "AudioDriverMirror_UID"
}

// ── Test 4: Can capture from BlackHole (any signal) ──
test(4, "BlackHole input has audio signal (play audio now!)") {
    guard findDeviceByUID("BlackHole2ch_UID") != nil else {
        print("  BlackHole not found")
        return false
    }

    // Use the project's capture script — it already works
    let scriptDir = URL(fileURLWithPath: #file).deletingLastPathComponent().path
    let captureScript = scriptDir + "/capture-loopback.swift"

    print("  Running capture-loopback.swift for 3 seconds...")
    let pipe = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
    task.arguments = [captureScript]
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try! task.run()

    // Read for 3 seconds
    Thread.sleep(forTimeInterval: 3.0)
    task.terminate()
    task.waitUntilExit()

    let data = pipe.fileHandleForReading.availableData
    let output = String(data: data, encoding: .utf8) ?? ""
    let lines = output.split(separator: "\n").filter { $0.contains("rms") }

    if lines.isEmpty {
        print("  No RMS output from capture helper")
        return false
    }

    var maxRMS: Float = 0
    for line in lines {
        if let range = line.range(of: "\"rms\":"),
           let endRange = line.range(of: "}", range: range.upperBound..<line.endIndex) {
            let numStr = String(line[range.upperBound..<endRange.lowerBound])
            if let val = Float(numStr), val > maxRMS {
                maxRMS = val
            }
        }
    }

    print("  Captured \(lines.count) RMS samples, peak: \(maxRMS)")
    if maxRMS > 0.01 {
        print("  Audio detected on BlackHole!")
        return true
    } else {
        print("  Silence on BlackHole. Audio is NOT routing through the aggregate.")
        return false
    }
}

// ── Test 5: Can capture from the physical output device directly ──
test(5, "Physical output device is alive") {
    // Find the physical device in the mirror's sub-devices
    guard let mirrorID = findDeviceByUID("AudioDriverMirror_UID") else {
        print("  Mirror not found")
        return false
    }
    var subAddr = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyActiveSubDeviceList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var subSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(mirrorID, &subAddr, 0, nil, &subSize)
    let subCount = Int(subSize) / MemoryLayout<AudioObjectID>.size
    var subs = [AudioObjectID](repeating: 0, count: subCount)
    AudioObjectGetPropertyData(mirrorID, &subAddr, 0, nil, &subSize, &subs)

    for s in subs {
        let uid = getUID(s) ?? ""
        if uid != "BlackHole2ch_UID" && uid != "AudioDriverMirror_UID" {
            let name = getName(s) ?? "?"
            print("  Physical device: \(name) (ID: \(s))")
            let outCh = getChannels(s, scope: kAudioObjectPropertyScopeOutput)
            print("  Output channels: \(outCh)")

            var aliveAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var alive: UInt32 = 0
            var aliveSize = UInt32(MemoryLayout<UInt32>.size)
            AudioObjectGetPropertyData(s, &aliveAddr, 0, nil, &aliveSize, &alive)
            print("  Alive: \(alive)")

            var runAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunning, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var running: UInt32 = 0
            var runSize = UInt32(MemoryLayout<UInt32>.size)
            AudioObjectGetPropertyData(s, &runAddr, 0, nil, &runSize, &running)
            print("  Running: \(running)")

            return alive == 1
        }
    }
    print("  No physical device found in mirror sub-devices")
    return false
}

// ── Test 6: afplay test tone through mirror → BlackHole picks it up ──
test(6, "afplay test tone through mirror → BlackHole receives it") {
    guard findDeviceByUID("BlackHole2ch_UID") != nil else {
        print("  BlackHole not found")
        return false
    }
    guard getDefaultOutputUID() == "AudioDriverMirror_UID" else {
        print("  Mirror is not default output — skipping")
        return false
    }

    // Generate a short WAV test tone
    let wavPath = "/tmp/test-tone.wav"
    let sampleRate: Double = 44100
    let duration: Double = 3.0
    let frequency: Double = 440.0
    let numSamples = Int(sampleRate * duration)

    var header = Data()
    let dataSize = numSamples * 2
    let fileSize = 36 + dataSize

    header.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // RIFF
    header.append(contentsOf: withUnsafeBytes(of: UInt32(fileSize).littleEndian) { Array($0) })
    header.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // WAVE
    header.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // fmt
    header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt32(44100).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt32(88200).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt16(2).littleEndian) { Array($0) })
    header.append(contentsOf: withUnsafeBytes(of: UInt16(16).littleEndian) { Array($0) })
    header.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // data
    header.append(contentsOf: withUnsafeBytes(of: UInt32(dataSize).littleEndian) { Array($0) })

    var audioData = Data(capacity: dataSize)
    for i in 0..<numSamples {
        let t = Double(i) / sampleRate
        let sample = Int16(sin(2.0 * .pi * frequency * t) * 16000.0)
        audioData.append(contentsOf: withUnsafeBytes(of: sample.littleEndian) { Array($0) })
    }
    try! (header + audioData).write(to: URL(fileURLWithPath: wavPath))
    print("  Generated 440Hz test tone at \(wavPath)")

    // Play via afplay in background
    let playTask = Process()
    playTask.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
    playTask.arguments = [wavPath]
    try! playTask.run()
    print("  Playing test tone through mirror...")

    Thread.sleep(forTimeInterval: 0.5)

    // Use the project's capture script to check
    let scriptDir = URL(fileURLWithPath: #file).deletingLastPathComponent().path
    let captureScript = scriptDir + "/capture-loopback.swift"
    let pipe = Pipe()
    let captureTask = Process()
    captureTask.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
    captureTask.arguments = [captureScript]
    captureTask.standardOutput = pipe
    captureTask.standardError = FileHandle.nullDevice
    try! captureTask.run()

    Thread.sleep(forTimeInterval: 2.0)
    captureTask.terminate()
    captureTask.waitUntilExit()
    playTask.terminate()

    let data = pipe.fileHandleForReading.availableData
    let output = String(data: data, encoding: .utf8) ?? ""
    let lines = output.split(separator: "\n").filter { $0.contains("rms") }

    var maxRMS: Float = 0
    for line in lines {
        if let range = line.range(of: "\"rms\":"),
           let endRange = line.range(of: "}", range: range.upperBound..<line.endIndex) {
            let numStr = String(line[range.upperBound..<endRange.lowerBound])
            if let val = Float(numStr), val > maxRMS { maxRMS = val }
        }
    }

    print("  Captured \(lines.count) samples, peak RMS: \(maxRMS)")
    if maxRMS > 0.01 {
        print("  Test tone detected on BlackHole! Aggregate routing works.")
        return true
    } else {
        print("  Test tone NOT detected. Aggregate is NOT routing to BlackHole.")
        return false
    }
}

// ── Summary ──
print("\n══════════════════════════════════")
print("  PIPELINE TEST RESULTS")
print("══════════════════════════════════")
for (num, name, ok) in results {
    print("  \(ok ? PASS : FAIL)  \(num). \(name)")
}
let failed = results.filter { !$0.2 }
if failed.isEmpty {
    print("\n  All tests passed! Pipeline is healthy.")
} else {
    print("\n  \(failed.count) test(s) failed. First failure: test \(failed[0].0)")
    print("  Fix test \(failed[0].0) before proceeding.")
}
print("")
